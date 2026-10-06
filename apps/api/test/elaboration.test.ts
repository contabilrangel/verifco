import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { declarationItems, declarations } from '../src/db/schema';
import { getOrCreateDeclaration } from '../src/services/declarations';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { fakePdf, multipart, send } from './robot-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const informe = (valueCents: number, withheldCents: number) =>
  JSON.stringify({
    items: [{ kind: 'income_pj', counterpartyDoc: '11.222.333/0001-81', counterpartyName: 'Empresa Exemplo', valueCents, withheldCents, description: 'Salários' }],
    notes: null,
  });

async function setup(cpfIndex: number) {
  const office = await registerOffice(env);
  const tok = (await office.api.post('/api/robot/tokens', { name: 'Sync', scope: 'sync' })).body.token as string;
  const c = await office.api.post('/api/customers', { name: `Cliente ${cpfIndex}`, cpfCnpj: VALID_CPFS[cpfIndex] });
  const upload = (name: string, content: Buffer, type = 'application/pdf') =>
    send(env, tok, 'POST', '/api/sync/files', { multipart: multipart({ cpf: VALID_CPFS[cpfIndex], ano: '2026' }, { name, content, type }) });
  return { ...office, customerId: c.body.id as string, upload };
}

describe('elaboração', () => {
  it('processa com IA, valida, exporta o pacote de conferência e baixa', async () => {
    const o = await setup(0);
    let list = await o.api.get('/api/elaboration?year=2026');
    expect(list.body.data[0]).toMatchObject({ customerId: o.customerId, status: 'no_files', declarationId: null });

    await o.upload('informe-empresa.pdf', fakePdf('informe'));
    list = await o.api.get('/api/elaboration?year=2026');
    expect(list.body.data[0].status).toBe('not_processed');
    expect(list.body.data[0].counts).toMatchObject({ eligible: 1, processed: 0 });
    expect(list.body.statusCounts.not_processed).toBe(1);

    env.providers.aiReplies.push('Segue o JSON:\n```json\n' + informe(5_000_000, 400_000) + '\n```');
    const proc = await o.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] });
    expect(proc.status).toBe(202);
    await env.ctx.jobs.drain();
    const jobs = await o.api.get('/api/elaboration/jobs');
    expect(jobs.body[0]).toMatchObject({ type: 'elaboration.process', status: 'done' });
    expect(jobs.body[0].result).toMatchObject({ processed: 1, failed: 0 });

    let detail = await o.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`);
    expect(detail.body.status).toBe('awaiting_validation');
    expect(detail.body.documents[0].lines[0]).toMatchObject({ match: 'new', item: { kind: 'income_pj', counterpartyDoc: '11222333000181', valueCents: 5_000_000, withheldCents: 400_000 } });

    const val = await o.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] });
    expect(val.body.results[0]).toMatchObject({ inserted: 1, updated: 0, pendingConflicts: 0, status: 'ok' });
    const decl = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, o.customerId) });
    const items = await env.ctx.db.select().from(declarationItems).where(eq(declarationItems.declarationId, decl!.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'document', valueCents: 5_000_000, withheldCents: 400_000 });
    expect(decl!.totalIncomeCents).toBeGreaterThan(0);
    // validar de novo não duplica
    await o.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] });
    expect(await env.ctx.db.select().from(declarationItems).where(eq(declarationItems.declarationId, decl!.id))).toHaveLength(1);

    const exp = await o.api.post('/api/elaboration/export', { year: 2026, customerIds: [o.customerId] });
    expect(exp.status).toBe(202);
    await env.ctx.jobs.drain();
    list = await o.api.get('/api/elaboration?year=2026&status=exported');
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].exported.fileId).toBeTruthy();
    const after = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, o.customerId) });
    expect(after).toMatchObject({ elaborationStatus: 'exported', exportedFileId: list.body.data[0].exported.fileId });

    const dl = await env.app.inject({ method: 'POST', url: '/api/elaboration/download', headers: { authorization: `Bearer ${o.token}` }, payload: { year: 2026, customerIds: [o.customerId] } });
    expect(dl.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(dl.rawPayload);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['LEIA-ME.txt', 'linhas.csv', 'linhas.json', 'documentos/informe-empresa.pdf']));
    expect(await zip.file('LEIA-ME.txt')!.async('string')).toContain('NÃO é um arquivo para restaurar');
    const csv = await zip.file('linhas.csv')!.async('string');
    expect(csv).toContain('11.222.333/0001-81');
    expect(csv).toContain('50000,00');
    const json = JSON.parse(await zip.file('linhas.json')!.async('string'));
    expect(json.items[0]).toMatchObject({ kind: 'income_pj', valueCents: 5_000_000 });

    // novo documento depois da exportação volta para "não processado"
    await o.upload('recibo-medico.pdf', fakePdf('medico'));
    expect((await o.api.get('/api/elaboration?year=2026')).body.data[0].status).toBe('not_processed');
  });

  it('marca conflito quando o documento diverge das linhas lançadas e resolve pela decisão', async () => {
    const o = await setup(1);
    const decl = await getOrCreateDeclaration(env.ctx.db, o.officeId, o.customerId, 2026);
    await env.ctx.db.insert(declarationItems).values({
      officeId: o.officeId,
      declarationId: decl.id,
      kind: 'income_pj',
      counterpartyDoc: '11222333000181',
      counterpartyName: 'Empresa Exemplo',
      valueCents: 4_000_000,
      withheldCents: 300_000,
    });
    await o.upload('informe.pdf', fakePdf('informe'));
    env.providers.aiReplies.push(informe(5_000_000, 400_000));
    await o.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] });
    await env.ctx.jobs.drain();

    let detail = await o.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`);
    expect(detail.body.status).toBe('conflict');
    const doc = detail.body.documents[0];
    expect(doc.lines[0]).toMatchObject({ match: 'conflict', existing: { valueCents: 4_000_000 } });

    // validar sem decisão não aplica o conflito
    let val = await o.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] });
    expect(val.body.results[0]).toMatchObject({ pendingConflicts: 1, status: 'conflict' });

    expect((await o.api.put(`/api/elaboration/documents/${doc.id}/lines/0`, { decision: 'accept' })).body.status).toBe('awaiting_validation');
    val = await o.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] });
    expect(val.body.results[0]).toMatchObject({ updated: 1, inserted: 0, status: 'ok' });
    const items = await env.ctx.db.select().from(declarationItems).where(eq(declarationItems.declarationId, decl.id));
    expect(items).toHaveLength(1);
    expect(items[0].valueCents).toBe(5_000_000);
    detail = await o.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`);
    expect(detail.body.documents[0].lines[0].appliedAt).toBeTruthy();
    expect((await o.api.put(`/api/elaboration/documents/${doc.id}/lines/0`, { decision: 'reject' })).status).toBe(400);
  });

  it('erro claro quando a IA não está configurada ou responde fora do formato', async () => {
    const o = await setup(2);
    await o.upload('a.pdf', fakePdf('a'));
    const original = env.providers.ai.complete;
    env.providers.ai.complete = async () => {
      throw new Error('Integração de IA não configurada para este escritório');
    };
    try {
      await o.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] });
      await env.ctx.jobs.drain();
    } finally {
      env.providers.ai.complete = original;
    }
    const jobs = await o.api.get('/api/elaboration/jobs');
    expect(jobs.body[0]).toMatchObject({ type: 'elaboration.process', status: 'failed' });
    expect(jobs.body[0].error).toMatch(/IA indisponível ou não configurada/);
    let detail = await o.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`);
    expect(detail.body.documents[0]).toMatchObject({ processingStatus: 'error' });
    expect(detail.body.status).toBe('not_processed');

    // resposta que não é JSON: documento com erro, job concluído
    env.providers.aiReplies.push('Não consegui ler o documento.');
    await o.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] });
    await env.ctx.jobs.drain();
    detail = await o.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`);
    expect(detail.body.documents[0].error).toContain('JSON');
    expect((await o.api.get('/api/elaboration/jobs')).body[0].result).toMatchObject({ processed: 0, failed: 1 });
  });

  it('permissões e isolamento entre escritórios', async () => {
    const o = await setup(3);
    const viewer = await createEmployee(env, o.api, ['customer.list', 'elaboration.export']);
    expect((await viewer.api.get('/api/elaboration?year=2026')).status).toBe(200);
    expect((await viewer.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] })).status).toBe(403);
    expect((await viewer.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] })).status).toBe(403);
    const nobody = await createEmployee(env, o.api, ['customer.list']);
    expect((await nobody.api.get('/api/elaboration?year=2026')).status).toBe(403);
    expect((await nobody.api.post('/api/elaboration/export', { year: 2026, customerIds: [o.customerId] })).status).toBe(403);

    const other = await registerOffice(env);
    expect((await other.api.get('/api/elaboration?year=2026')).body.total).toBe(0);
    expect((await other.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] })).status).toBe(404);
    expect((await other.api.post('/api/elaboration/download', { year: 2026, customerIds: [o.customerId] })).status).toBe(404);
    expect((await other.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`)).status).toBe(404);
    expect((await o.api.post('/api/elaboration/download', { year: 2026, customerIds: [o.customerId] })).status).toBe(404);
  });
});
