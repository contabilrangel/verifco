import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { files, prefilledStatements } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { multipart, send } from './robot-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const zipNames = async (raw: { rawPayload: Buffer }) => Object.keys((await JSZip.loadAsync(raw.rawPayload)).files).filter((n) => !n.endsWith('/')).sort();

describe('pré-preenchidas', () => {
  it('recebe do robô, lista por cliente, baixa novos e todos', async () => {
    const office = await registerOffice(env);
    const { api } = office;
    const tok = (await api.post('/api/robot/tokens', { name: 'Sync', scope: 'sync' })).body.token as string;
    const p = await api.post('/api/procurators', { name: 'Procurador', cpfCnpj: '11.222.333/0001-81' });
    const ana = await api.post('/api/customers', { name: 'Ana', cpfCnpj: VALID_CPFS[0] });
    const bruno = await api.post('/api/customers', { name: 'Bruno', cpfCnpj: VALID_CPFS[1] });
    await api.post('/api/customers', { name: 'Caio sem procurador', cpfCnpj: VALID_CPFS[2] });
    await api.post('/api/customers/bulk', { ids: [ana.body.id, bruno.body.id], action: 'procurator', value: p.body.id });

    const upA = await send(env, tok, 'POST', '/api/sync/prefilled', { multipart: multipart({}, { name: `${VALID_CPFS[0]}-IRPF-A-2026-2025-ORIGI.DEC`, content: 'pre-ana' }) });
    expect(upA.status).toBe(201);
    expect(upA.body).toMatchObject({ year: 2026, customer: { id: ana.body.id } });
    const upB = await send(env, tok, 'POST', '/api/sync/prefilled', { multipart: multipart({ cpf: VALID_CPFS[1], ano: '2026' }, { name: 'pre.dec', content: 'pre-bruno' }) });
    expect(upB.status).toBe(201);
    // repetido não duplica
    const dup = await send(env, tok, 'POST', '/api/sync/prefilled', { multipart: multipart({ cpf: VALID_CPFS[1], ano: '2026' }, { name: 'pre.dec', content: 'pre-bruno' }) });
    expect(dup.body.duplicate).toBe(true);

    const list = await api.get('/api/prefilled?year=2026');
    expect(list.status).toBe(200);
    expect(list.body.summary).toEqual({ customers: 3, withFiles: 2, newFiles: 2, withoutProcurator: 1 });
    const caio = list.body.data.find((r: any) => r.name === 'Caio sem procurador');
    expect(caio.procuratorName).toBeNull();
    expect(caio.documents).toEqual([]);
    expect((await api.get('/api/prefilled?year=2026&filter=without_procurator')).body.total).toBe(1);
    expect((await api.get('/api/prefilled?year=2025')).body.summary.withFiles).toBe(0);

    // baixar novos: os dois e marca downloadedAt
    const novos = await env.app.inject({ method: 'POST', url: '/api/prefilled/download', headers: { authorization: `Bearer ${office.token}` }, payload: { year: 2026, mode: 'new' } });
    expect(novos.statusCode).toBe(200);
    expect(novos.headers['content-type']).toContain('zip');
    expect(await zipNames(novos)).toEqual(['111.444.777-35 - Bruno/pre.dec', `529.982.247-25 - Ana/${VALID_CPFS[0]}-IRPF-A-2026-2025-ORIGI.DEC`]);
    const marked = await env.ctx.db.select().from(prefilledStatements).where(eq(prefilledStatements.officeId, office.officeId));
    expect(marked.every((s) => s.downloadedAt)).toBe(true);
    expect((await api.post('/api/prefilled/download', { year: 2026, mode: 'new' })).status).toBe(404);

    // novo arquivo: "novos" traz só ele; "todos" inclui os anteriores
    await send(env, tok, 'POST', '/api/sync/prefilled', { multipart: multipart({ cpf: VALID_CPFS[0], ano: '2026' }, { name: 'pre-v2.dec', content: 'pre-ana-v2' }) });
    expect((await api.get('/api/prefilled?year=2026&filter=new')).body.total).toBe(1);
    const novos2 = await env.app.inject({ method: 'POST', url: '/api/prefilled/download', headers: { authorization: `Bearer ${office.token}` }, payload: { year: 2026, mode: 'new' } });
    expect(await zipNames(novos2)).toEqual(['529.982.247-25 - Ana/pre-v2.dec']);
    const todos = await env.app.inject({ method: 'POST', url: '/api/prefilled/download', headers: { authorization: `Bearer ${office.token}` }, payload: { year: 2026, mode: 'all' } });
    expect(await zipNames(todos)).toHaveLength(3);
  });

  it('o .zip sai em stream com o conteúdo de cada arquivo e respeita o limite de 1 GB (DAD-10)', async () => {
    const office = await registerOffice(env);
    const c = await office.api.post('/api/customers', { name: 'Elisa', cpfCnpj: VALID_CPFS[4] });
    const content = Buffer.concat([Buffer.from('pre-elisa '), Buffer.alloc(200_000, 3)]);
    const up = await send(env, office.token, 'POST', '/api/prefilled/upload', { multipart: multipart({ customerId: c.body.id, year: '2026' }, { name: 'pre-elisa.dec', content }) });
    expect(up.status).toBe(201);
    const generateAsync = vi.spyOn(JSZip.prototype, 'generateAsync');
    try {
      const res = await env.app.inject({ method: 'POST', url: '/api/prefilled/download', headers: { authorization: `Bearer ${office.token}` }, payload: { year: 2026, mode: 'all' } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toContain('pre-preenchidas-2026-todas.zip');
      expect(generateAsync).not.toHaveBeenCalled();
      const zip = await JSZip.loadAsync(res.rawPayload);
      expect((await zip.file('123.456.789-09 - Elisa/pre-elisa.dec')!.async('nodebuffer')).equals(content)).toBe(true);
    } finally {
      generateAsync.mockRestore();
    }
    const st = await env.ctx.db.query.prefilledStatements.findFirst({ where: eq(prefilledStatements.id, up.body.id) });
    await env.ctx.db.update(files).set({ size: 1100 * 1024 * 1024 }).where(eq(files.id, st!.fileId));
    const tooBig = await office.api.post('/api/prefilled/download', { year: 2026, mode: 'all' });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toBe('Os arquivos passam de 1 GB. Selecione menos clientes ou baixe só os novos.');
  });

  it('download individual, envio manual, permissões e isolamento', async () => {
    const office = await registerOffice(env);
    const c = await office.api.post('/api/customers', { name: 'Davi', cpfCnpj: VALID_CPFS[3] });
    const up = await send(env, office.token, 'POST', '/api/prefilled/upload', { multipart: multipart({ customerId: c.body.id, year: '2026' }, { name: 'pre-davi.dec', content: 'pre-davi' }) });
    expect(up.status).toBe(201);
    const one = await env.app.inject({ method: 'GET', url: `/api/prefilled/${up.body.id}/download`, headers: { authorization: `Bearer ${office.token}` } });
    expect(one.statusCode).toBe(200);
    expect(one.body).toBe('pre-davi');
    const st = await env.ctx.db.query.prefilledStatements.findFirst({ where: eq(prefilledStatements.id, up.body.id) });
    expect(st!.downloadedAt).not.toBeNull();

    const emp = await createEmployee(env, office.api, ['customer.list']);
    expect((await emp.api.get('/api/prefilled?year=2026')).status).toBe(403);
    expect((await emp.api.post('/api/prefilled/download', { year: 2026, mode: 'all' })).status).toBe(403);

    const other = await registerOffice(env);
    expect((await other.api.get(`/api/prefilled/${up.body.id}/download`)).status).toBe(404);
    expect((await other.api.get('/api/prefilled?year=2026')).body.total).toBe(0);
    expect((await other.api.post('/api/prefilled/download', { year: 2026, mode: 'all' })).status).toBe(404);
    const cross = await send(env, other.token, 'POST', '/api/prefilled/upload', { multipart: multipart({ customerId: c.body.id, year: '2026' }, { name: 'x.dec', content: 'x' }) });
    expect(cross.status).toBe(404);
  });
});
