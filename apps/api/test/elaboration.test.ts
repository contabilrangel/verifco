import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { declarationTotals, type ItemKind } from '@verifco/shared';
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
    // INT-11: validar também regrava o saldo de caixa (alerta do dashboard)
    expect(decl!.cashBalanceCents).not.toBeNull();
    const cash = await o.api.get(`/api/declarations/${decl!.id}/cash-analysis`);
    expect(decl!.cashBalanceCents).toBe(cash.body.balanceCents);
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

  // DAD-6: a central filtra, conta e pagina no banco, com as mesmas regras do detalhe
  it('lista paginada e filtrada no banco com as mesmas situações e contagens do detalhe', async () => {
    const office = await registerOffice(env);
    const tok = (await office.api.post('/api/robot/tokens', { name: 'Sync', scope: 'sync' })).body.token as string;
    const names = ['Ana', 'Bruno', 'Carla', 'Davi', 'Eva'];
    const ids: string[] = [];
    for (const [i, name] of names.entries()) ids.push((await office.api.post('/api/customers', { name, cpfCnpj: VALID_CPFS[i] })).body.id);
    const up = (i: number, name: string, content: Buffer, type = 'application/pdf') =>
      send(env, tok, 'POST', '/api/sync/files', { multipart: multipart({ cpf: VALID_CPFS[i], ano: '2026' }, { name, content, type }) });
    const process = async (i: number, reply: string) => {
      env.providers.aiReplies.push(reply);
      await office.api.post('/api/elaboration/process', { year: 2026, customerIds: [ids[i]] });
      await env.ctx.jobs.drain();
    };
    // Ana: sem arquivos · Bruno: PDF não processado · Carla: aguardando validação (2 linhas)
    // Davi: conflito com linha lançada · Eva: só o .DEC do programa (não vai para a IA)
    await up(1, 'informe.pdf', fakePdf('bruno'));
    await up(2, 'informe.pdf', fakePdf('carla'));
    await process(2, JSON.stringify({ items: [{ kind: 'income_pj', counterpartyDoc: '11222333000181', valueCents: 100 }, { kind: 'payment', description: 'Clínica', valueCents: 50, extra: { nature: 'health' } }] }));
    const davi = await getOrCreateDeclaration(env.ctx.db, office.officeId, ids[3], 2026);
    await env.ctx.db.insert(declarationItems).values({ officeId: office.officeId, declarationId: davi.id, kind: 'income_pj', counterpartyDoc: '11222333000181', valueCents: 4_000_000 });
    await up(3, 'informe.pdf', fakePdf('davi'));
    await process(3, informe(5_000_000, 400_000));
    await up(4, `${VALID_CPFS[4]}-IRPF-A-2026-2025-ORIGI.DEC`, Buffer.from('dec'), 'application/octet-stream');

    const expected = { Ana: 'no_files', Bruno: 'not_processed', Carla: 'awaiting_validation', Davi: 'conflict', Eva: 'ok' };
    const all = await office.api.get('/api/elaboration?year=2026&pageSize=200');
    expect(all.body.total).toBe(5);
    expect(Object.fromEntries(all.body.data.map((r: { name: string; status: string }) => [r.name, r.status]))).toEqual(expected);
    expect(all.body.statusCounts).toMatchObject({ no_files: 1, not_processed: 1, awaiting_validation: 1, conflict: 1, ok: 1, exported: 0 });
    // contagens calculadas no banco = contagens do detalhe (que lê as extrações)
    for (const row of all.body.data) {
      const detail = await office.api.get(`/api/elaboration/customers/${row.customerId}?year=2026`);
      expect(row.counts).toEqual(detail.body.counts);
      expect(row.status).toBe(detail.body.status);
    }
    expect(all.body.data.find((r: { name: string }) => r.name === 'Carla').counts).toMatchObject({ total: 1, eligible: 1, processed: 1, lines: 2, pendingLines: 2, conflicts: 0 });
    expect(all.body.data.find((r: { name: string }) => r.name === 'Eva').counts).toMatchObject({ total: 1, eligible: 0, programFiles: 1 });

    // paginação em ordem alfabética e filtro por situação com o total do filtro
    const p2 = await office.api.get('/api/elaboration?year=2026&pageSize=2&page=2');
    expect(p2.body).toMatchObject({ total: 5, page: 2, pages: 3 });
    expect(p2.body.data.map((r: { name: string }) => r.name)).toEqual(['Carla', 'Davi']);
    const conflicts = await office.api.get('/api/elaboration?year=2026&status=conflict');
    expect(conflicts.body).toMatchObject({ total: 1, pages: 1 });
    expect(conflicts.body.data.map((r: { name: string }) => r.name)).toEqual(['Davi']);
    expect(conflicts.body.statusCounts.no_files).toBe(1);
    const byCpf = await office.api.get(`/api/elaboration?year=2026&search=${VALID_CPFS[2].slice(0, 6)}`);
    expect(byCpf.body.data.map((r: { name: string }) => r.name)).toEqual(['Carla']);
  });

  // DAD-8: validações simultâneas da mesma declaração não duplicam linhas nem inflam totais
  it('validações simultâneas aplicam cada linha uma vez só', async () => {
    const o = await setup(5);
    await o.upload('a.pdf', fakePdf('a'));
    await o.upload('b.pdf', fakePdf('b'));
    env.providers.aiReplies.push(informe(1_000_000, 0), JSON.stringify({ items: [{ kind: 'income_exempt', description: 'Poupança', valueCents: 20_000, extra: { nature: 'financial_exempt' } }] }));
    await o.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] });
    await env.ctx.jobs.drain();
    const body = { year: 2026, customerIds: [o.customerId] };
    const results = await Promise.all([o.api.post('/api/elaboration/validate', body), o.api.post('/api/elaboration/validate', body), o.api.post('/api/elaboration/validate', body)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.reduce((a, r) => a + r.body.results[0].inserted, 0)).toBe(2);
    const decl = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, o.customerId) });
    const items = await env.ctx.db.select().from(declarationItems).where(eq(declarationItems.declarationId, decl!.id));
    expect(items).toHaveLength(2);
    // totais gravados batem com as linhas (nada contado em dobro)
    expect(decl!.totalIncomeCents).toBe(declarationTotals(items.map((i) => ({ ...i, kind: i.kind as ItemKind }))).totalIncomeCents);
    expect(decl!.totalIncomeCents).toBeGreaterThanOrEqual(1_000_000);
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
