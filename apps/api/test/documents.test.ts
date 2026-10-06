import JSZip from 'jszip';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { files } from '../src/db/schema';
import type { MemoryBlobStore } from '../src/storage';
import { MISSING_FILES_NAME } from '../src/storage/zip';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { FAKE_PDF, upload } from './upload-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

describe('documentos do cliente', () => {
  it('envia vários arquivos, lista por exercício, baixa e exclui', async () => {
    const { api, token } = await registerOffice(env);
    const c = (await api.post('/api/customers', { name: 'Paula Reis', cpfCnpj: VALID_CPFS[0] })).body;
    const up = await upload(
      env,
      token,
      `/api/customers/${c.id}/documents?year=2026`,
      [
        { name: 'informe-banco.pdf', content: FAKE_PDF, type: 'application/pdf' },
        { name: 'recibo.jpg', content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), type: 'image/jpeg' },
      ],
      { category: 'income_report' },
    );
    expect(up.status).toBe(201);
    expect(up.body).toHaveLength(2);
    expect(up.body[0]).toMatchObject({ category: 'income_report', uploadedBy: 'office', filename: 'informe-banco.pdf' });
    await upload(env, token, `/api/customers/${c.id}/documents?year=2025`, [{ name: 'informe-2025.pdf', content: FAKE_PDF, type: 'application/pdf' }]);

    expect((await upload(env, token, `/api/customers/${c.id}/documents?year=2026`, [{ name: 'a.pdf', content: FAKE_PDF }], { category: 'invalida' })).status).toBe(400);
    expect((await upload(env, token, `/api/customers/${c.id}/documents?year=2026`, [])).status).toBe(400);

    const list2026 = await api.get(`/api/customers/${c.id}/documents?year=2026`);
    expect(list2026.body).toHaveLength(2);
    expect(list2026.body.every((d: any) => d.exerciseYear === 2026)).toBe(true);
    expect((await api.get(`/api/customers/${c.id}/documents`)).body).toHaveLength(3);
    // o upload cria a declaração do exercício
    expect((await api.get(`/api/customers/${c.id}/declarations/2025`)).body.exists).toBe(true);

    const doc = list2026.body.find((d: any) => d.filename === 'informe-banco.pdf');
    const file = await api.get(`/api/documents/${doc.id}/file`);
    expect(file.status).toBe(200);
    expect(file.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(file.raw.headers['content-disposition']).toContain('informe-banco.pdf');

    const patched = await api.patch(`/api/documents/${doc.id}`, { category: 'bank_statement' });
    expect(patched.body.category).toBe('bank_statement');
    expect((await api.del(`/api/documents/${doc.id}`)).status).toBe(200);
    expect((await api.get(`/api/customers/${c.id}/documents?year=2026`)).body).toHaveLength(1);
    expect((await api.get(`/api/documents/${doc.id}/file`)).status).toBe(404);
  });

  it('gera o .zip com uma pasta por cliente', async () => {
    const { api, token } = await registerOffice(env);
    const a = (await api.post('/api/customers', { name: 'Ana / Lima', cpfCnpj: VALID_CPFS[1] })).body;
    const b = (await api.post('/api/customers', { name: 'Bruno Melo', cpfCnpj: VALID_CPFS[2] })).body;
    const empty = (await api.post('/api/customers', { name: 'Sem Arquivos', cpfCnpj: VALID_CPFS[3] })).body;
    await upload(env, token, `/api/customers/${a.id}/documents?year=2026`, [
      { name: 'informe.pdf', content: FAKE_PDF },
      { name: 'informe.pdf', content: FAKE_PDF },
    ]);
    await upload(env, token, `/api/customers/${b.id}/documents?year=2026`, [{ name: 'extrato.pdf', content: FAKE_PDF }]);
    await upload(env, token, `/api/customers/${b.id}/documents?year=2025`, [{ name: 'antigo.pdf', content: FAKE_PDF }]);

    const res = await api.post('/api/documents/zip', { customerIds: [a.id, b.id, empty.id], year: 2026 });
    expect(res.status).toBe(200);
    expect(res.raw.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(res.raw.rawPayload);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual(['Ana Lima - 111.444.777-35/informe (2).pdf', 'Ana Lima - 111.444.777-35/informe.pdf', 'Bruno Melo - 390.533.447-05/extrato.pdf']);

    const all = await JSZip.loadAsync((await api.post('/api/documents/zip', { customerIds: [b.id] })).raw.rawPayload);
    expect(Object.keys(all.files).filter((n) => !all.files[n].dir).sort()).toEqual(['Bruno Melo - 390.533.447-05/2025/antigo.pdf', 'Bruno Melo - 390.533.447-05/2026/extrato.pdf']);

    expect((await api.post('/api/documents/zip', { customerIds: [empty.id] })).status).toBe(400);
    expect((await api.post('/api/documents/zip', { customerIds: [] })).status).toBe(400);
  });

  it('o .zip sai em stream, lendo cada arquivo na sua vez, e respeita o limite de 1 GB (DAD-10)', async () => {
    const { api, token } = await registerOffice(env);
    const c = (await api.post('/api/customers', { name: 'Davi Souza', cpfCnpj: VALID_CPFS[5] })).body;
    const big = Buffer.concat([FAKE_PDF, Buffer.alloc(300_000, 9)]);
    const up = await upload(env, token, `/api/customers/${c.id}/documents?year=2026`, [
      { name: 'grande.pdf', content: big },
      { name: 'sumiu.pdf', content: FAKE_PDF },
    ]);
    const store = (env.ctx.files as unknown as { store: MemoryBlobStore }).store;
    const lost = await env.ctx.db.query.files.findFirst({ where: eq(files.id, up.body[1].fileId) });
    await store.delete(lost!.storageKey);
    const get = vi.spyOn(store, 'get');
    const generateAsync = vi.spyOn(JSZip.prototype, 'generateAsync');
    try {
      const res = await api.post('/api/documents/zip', { customerIds: [c.id], year: 2026 });
      expect(res.status).toBe(200);
      expect(res.raw.headers['content-type']).toBe('application/zip');
      expect(res.raw.headers['x-content-type-options']).toBe('nosniff');
      expect(get).not.toHaveBeenCalled();
      expect(generateAsync).not.toHaveBeenCalled();
      const zip = await JSZip.loadAsync(res.raw.rawPayload);
      expect((await zip.file('Davi Souza - 987.654.321-00/grande.pdf')!.async('nodebuffer')).equals(big)).toBe(true);
      // o que sumiu do armazenamento não derruba o download: fica listado
      expect(zip.file('Davi Souza - 987.654.321-00/sumiu.pdf')).toBeNull();
      expect(await zip.file(MISSING_FILES_NAME)!.async('string')).toContain('Davi Souza - 987.654.321-00/sumiu.pdf');
    } finally {
      get.mockRestore();
      generateAsync.mockRestore();
    }
    await env.ctx.db.update(files).set({ size: 1100 * 1024 * 1024 }).where(eq(files.id, up.body[0].fileId));
    const tooBig = await api.post('/api/documents/zip', { customerIds: [c.id] });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toBe('Os arquivos passam de 1 GB. Selecione menos clientes.');
  });

  it('permissões e isolamento', async () => {
    const office = await registerOffice(env);
    const c = (await office.api.post('/api/customers', { name: 'Carlos Dias', cpfCnpj: VALID_CPFS[4] })).body;
    const up = await upload(env, office.token, `/api/customers/${c.id}/documents?year=2026`, [{ name: 'a.pdf', content: FAKE_PDF }]);
    const docId = up.body[0].id;
    const viewer = await createEmployee(env, office.api, ['customer.list', 'declaration.view']);
    expect((await viewer.api.get(`/api/customers/${c.id}/documents?year=2026`)).status).toBe(200);
    expect((await viewer.api.post(`/api/customers/${c.id}/documents?year=2026`, {})).status).toBe(403);
    expect((await viewer.api.del(`/api/documents/${docId}`)).status).toBe(403);
    expect((await viewer.api.post('/api/documents/zip', { customerIds: [c.id] })).status).toBe(403);

    const other = await registerOffice(env);
    expect((await other.api.get(`/api/customers/${c.id}/documents`)).status).toBe(404);
    expect((await upload(env, other.token, `/api/customers/${c.id}/documents?year=2026`, [{ name: 'x.pdf', content: FAKE_PDF }])).status).toBe(404);
    expect((await other.api.get(`/api/documents/${docId}/file`)).status).toBe(404);
    expect((await other.api.patch(`/api/documents/${docId}`, { category: 'other' })).status).toBe(404);
    expect((await other.api.del(`/api/documents/${docId}`)).status).toBe(404);
    expect((await other.api.post('/api/documents/zip', { customerIds: [c.id] })).status).toBe(404);
  });
});
