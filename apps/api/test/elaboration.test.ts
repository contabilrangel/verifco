import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, ilike, isNull, or, type SQL } from 'drizzle-orm';
import JSZip from 'jszip';
import { ELABORATION_STATUS, onlyDigits } from '@verifco/shared';
import { customers, declarationItems, declarations, documents, files } from '../src/db/schema';
import { computeElaborationStatus, docCounts, loadDocStats } from '../src/modules/elaboration/service';
import { getOrCreateDeclaration } from '../src/services/declarations';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { fakePdf, multipart, send } from './robot-helpers';
import { FAKE_PDF, upload as uploadFiles } from './upload-helpers';
import { PDF, upload as uploadChecklist } from './portal-helpers';

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

type Query = (sql: string, ...rest: unknown[]) => Promise<unknown>;
type PgliteLike = { query: Query; transaction: (cb: (tx: { query: Query }) => Promise<unknown>) => Promise<unknown> };

/**
 * Sobrepõe duas validações no PGlite (que atende uma consulta por vez): a primeira inclusão de
 * linha da declaração espera, por até 500 ms, outra leitura das linhas da declaração. Sem
 * transação, a segunda validação lê nesse intervalo o mesmo estado da primeira e as duas incluem as
 * mesmas linhas. Com a validação numa transação, a segunda só consulta depois que a primeira
 * termina (no PGlite, a transação aberta segura as demais consultas; no PostgreSQL, a trava
 * `for update` da declaração). Devolve a função que desfaz a interceptação.
 */
function overlapValidations(env: TestEnv) {
  const client = (env.ctx.db as unknown as { $client: PgliteLike }).$client;
  const { query, transaction } = client;
  let reads = 0;
  let paused = false;
  let release = () => {};
  const secondRead = new Promise<void>((resolve) => (release = resolve));
  const watch =
    (run: Query): Query =>
    async (sql, ...rest) => {
      const q = sql.trimStart().toLowerCase();
      if (q.startsWith('select') && q.includes('from "declaration_items"') && ++reads >= 2) release();
      if (!paused && q.startsWith('insert into "declaration_items"')) {
        paused = true;
        await Promise.race([secondRead, new Promise((resolve) => setTimeout(resolve, 500))]);
      }
      return run(sql, ...rest);
    };
  client.query = watch(query.bind(client));
  client.transaction = (cb) => transaction.call(client, (tx) => cb(new Proxy(tx, { get: (t, p) => (p === 'query' ? watch(t.query) : Reflect.get(t, p)) })));
  return () => {
    delete (client as Partial<PgliteLike>).query;
    delete (client as Partial<PgliteLike>).transaction;
  };
}

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

  it('baixa os pacotes em stream: um sai como está, vários num .zip sem recomprimir, com limite de 1 GB (DAD-10)', async () => {
    const office = await registerOffice(env);
    const pkgs: { customerId: string; fileId: string; content: Buffer; filename: string }[] = [];
    for (const [i, name] of ['Ana Costa', 'Bruno Lima'].entries()) {
      const c = await office.api.post('/api/customers', { name, cpfCnpj: VALID_CPFS[i + 4] });
      const content = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(20_000 + i, i + 1)]);
      const filename = `conferencia-${name.split(' ')[0].toLowerCase()}-2026.zip`;
      const f = await env.ctx.files.save({ officeId: office.officeId, data: content, filename, mimeType: 'application/zip' });
      const d = await getOrCreateDeclaration(env.ctx.db, office.officeId, c.body.id, 2026);
      await env.ctx.db.update(declarations).set({ exportedFileId: f.id }).where(eq(declarations.id, d.id));
      pkgs.push({ customerId: c.body.id, fileId: f.id, content, filename });
    }
    const download = (customerIds: string[]) =>
      env.app.inject({ method: 'POST', url: '/api/elaboration/download', headers: { authorization: `Bearer ${office.token}` }, payload: { year: 2026, customerIds } });

    const one = await download([pkgs[0].customerId]);
    expect(one.statusCode).toBe(200);
    expect(one.headers['content-length']).toBe(String(pkgs[0].content.length));
    expect(one.headers['content-disposition']).toContain(pkgs[0].filename);
    expect(one.rawPayload.equals(pkgs[0].content)).toBe(true);

    const both = await download(pkgs.map((p) => p.customerId));
    expect(both.statusCode).toBe(200);
    expect(both.headers['content-type']).toBe('application/zip');
    expect(both.headers['content-disposition']).toContain('conferencia-2026.zip');
    const zip = await JSZip.loadAsync(both.rawPayload);
    for (const p of pkgs) expect((await zip.file(p.filename)!.async('nodebuffer')).equals(p.content)).toBe(true);
    // os pacotes já são .zip: entram sem recomprimir (os bytes aparecem como estão)
    for (const p of pkgs) expect(both.rawPayload.includes(p.content)).toBe(true);

    await env.ctx.db.update(files).set({ size: 1100 * 1024 * 1024 }).where(eq(files.id, pkgs[1].fileId));
    const tooBig = await download(pkgs.map((p) => p.customerId));
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error).toBe('Os pacotes passam de 1 GB. Selecione menos clientes.');
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

  it('validar atualiza o saldo de caixa gravado (alerta do dashboard)', async () => {
    const o = await setup(4);
    await o.upload('informe.pdf', fakePdf('informe'));
    env.providers.aiReplies.push(informe(5_000_000, 400_000));
    await o.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] });
    await env.ctx.jobs.drain();
    const stored = async () => (await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, o.customerId) }))!;
    expect((await stored()).cashBalanceCents).toBeNull();

    await o.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] });
    const after = await stored();
    expect(after.cashBalanceCents).not.toBeNull();
    // é o saldo da análise de caixa das linhas validadas
    const cash = await o.api.get(`/api/declarations/${after.id}/cash-analysis`);
    expect(after.cashBalanceCents).toBe(cash.body.balanceCents);
  });

  it('duas validações simultâneas da mesma declaração não duplicam as linhas', async () => {
    const o = await setup(5);
    for (const n of [1, 2, 3]) {
      await o.upload(`informe-${n}.pdf`, fakePdf(`informe ${n}`));
      env.providers.aiReplies.push(
        JSON.stringify({ items: [{ kind: 'income_pj', code: String(n), counterpartyDoc: '11.222.333/0001-81', counterpartyName: `Fonte ${n}`, valueCents: n * 1_000_000, withheldCents: 0 }], notes: null }),
      );
    }
    await o.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] });
    await env.ctx.jobs.drain();

    const restore = overlapValidations(env);
    const validate = () => o.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] });
    let both: Awaited<ReturnType<typeof validate>>[];
    try {
      both = await Promise.all([validate(), validate()]);
    } finally {
      restore();
    }
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both.map((r) => r.body.results[0].inserted).sort()).toEqual([0, 3]);
    const decl = (await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, o.customerId) }))!;
    expect(await env.ctx.db.select().from(declarationItems).where(eq(declarationItems.declarationId, decl.id))).toHaveLength(3);
    expect(decl.taxableIncomeCents).toBe(6_000_000);
    expect((await o.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`)).body.status).toBe('ok');
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

  it('pre_declaration.create processa e valida; pre_declaration.edit decide as linhas (COB-13)', async () => {
    const o = await setup(4);
    await o.upload('informe.pdf', fakePdf('informe'));
    const creator = await createEmployee(env, o.api, ['customer.list', 'pre_declaration.view', 'pre_declaration.create']);
    const editor = await createEmployee(env, o.api, ['customer.list', 'pre_declaration.view', 'pre_declaration.edit']);
    const viewer = await createEmployee(env, o.api, ['customer.list', 'pre_declaration.view']);
    const selection = { year: 2026, customerIds: [o.customerId] };
    for (const u of [creator, editor, viewer]) expect((await u.api.get('/api/elaboration?year=2026')).status).toBe(200);
    expect((await editor.api.post('/api/elaboration/process', selection)).status).toBe(403);
    expect((await viewer.api.post('/api/elaboration/process', selection)).status).toBe(403);
    env.providers.aiReplies.push(informe(1_000_000, 0));
    expect((await creator.api.post('/api/elaboration/process', selection)).status).toBe(202);
    await env.ctx.jobs.drain();
    const docId = (await editor.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`)).body.documents[0].id as string;
    expect((await creator.api.put(`/api/elaboration/documents/${docId}/lines/0`, { decision: 'accept' })).status).toBe(403);
    expect((await viewer.api.put(`/api/elaboration/documents/${docId}/lines/0`, { decision: 'accept' })).status).toBe(403);
    expect((await editor.api.put(`/api/elaboration/documents/${docId}/lines/0`, { decision: 'accept' })).status).toBe(200);
    expect((await editor.api.post('/api/elaboration/validate', selection)).status).toBe(403);
    expect((await viewer.api.post('/api/elaboration/validate', selection)).status).toBe(403);
    expect((await creator.api.post('/api/elaboration/validate', selection)).body.results[0]).toMatchObject({ inserted: 1 });
  });

  it('permissões e isolamento entre escritórios', async () => {
    const o = await setup(3);
    const viewer = await createEmployee(env, o.api, ['customer.list', 'elaboration.export']);
    expect((await viewer.api.get('/api/elaboration?year=2026')).status).toBe(200);
    expect((await viewer.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] })).status).toBe(403);
    expect((await viewer.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] })).status).toBe(403);
    // quem só cria ou só edita a pré-declaração (sem visualizar) também abre a lista, o detalhe e os jobs,
    // como no menu; continua sem as ações das outras permissões
    const creatorOnly = await createEmployee(env, o.api, ['customer.list', 'pre_declaration.create']);
    const editorOnly = await createEmployee(env, o.api, ['customer.list', 'pre_declaration.edit']);
    for (const u of [creatorOnly, editorOnly]) {
      expect((await u.api.get('/api/elaboration?year=2026')).status).toBe(200);
      expect((await u.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`)).status).toBe(200);
      expect((await u.api.get('/api/elaboration/jobs')).status).toBe(200);
      expect((await u.api.post('/api/elaboration/export', { year: 2026, customerIds: [o.customerId] })).status).toBe(403);
    }
    expect((await editorOnly.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] })).status).toBe(403);
    expect((await editorOnly.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] })).status).toBe(403);
    const nobody = await createEmployee(env, o.api, ['customer.list']);
    expect((await nobody.api.get('/api/elaboration?year=2026')).status).toBe(403);
    expect((await nobody.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`)).status).toBe(403);
    expect((await nobody.api.get('/api/elaboration/jobs')).status).toBe(403);
    expect((await nobody.api.post('/api/elaboration/export', { year: 2026, customerIds: [o.customerId] })).status).toBe(403);

    const other = await registerOffice(env);
    expect((await other.api.get('/api/elaboration?year=2026')).body.total).toBe(0);
    expect((await other.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] })).status).toBe(404);
    expect((await other.api.post('/api/elaboration/download', { year: 2026, customerIds: [o.customerId] })).status).toBe(404);
    expect((await other.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`)).status).toBe(404);
    expect((await o.api.post('/api/elaboration/download', { year: 2026, customerIds: [o.customerId] })).status).toBe(404);
  });
});

/** CPF válido a partir de um número de 9 dígitos (calcula os verificadores). */
function cpfOf(n: number) {
  const base = String(n).padStart(9, '0').split('').map(Number);
  const dv = (digits: number[]) => {
    const r = (digits.reduce((acc, d, i) => acc + d * (digits.length + 1 - i), 0) * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join('');
}

type ListParams = { search?: string; status?: string; page?: number; pageSize?: number };

/** A listagem como era antes (DAD-6): lê a carteira e os documentos, calcula e pagina em memória. */
async function listingBefore(officeId: string, year: number, p: ListParams) {
  const db = env.ctx.db;
  const conds: SQL[] = [eq(customers.officeId, officeId), isNull(customers.deletedAt), eq(customers.status, 'active')];
  if (p.search) {
    const digits = onlyDigits(p.search);
    const byText: SQL[] = [ilike(customers.name, `%${p.search}%`)];
    if (digits.length >= 3) byText.push(ilike(customers.cpfCnpj, `%${digits}%`));
    conds.push(or(...byText)!);
  }
  const rows = await db
    .select({ id: customers.id, name: customers.name, cpfCnpj: customers.cpfCnpj, decl: declarations, exportedAt: files.createdAt })
    .from(customers)
    .leftJoin(declarations, and(eq(declarations.customerId, customers.id), eq(declarations.exerciseYear, year)))
    .leftJoin(files, eq(files.id, declarations.exportedFileId))
    .where(and(...conds))
    .orderBy(asc(customers.name));
  const docs = await loadDocStats(db, rows.flatMap((r) => (r.decl ? [r.decl.id] : [])));
  const all = rows.map((r) => {
    const list = r.decl ? (docs.get(r.decl.id) ?? []) : [];
    return {
      customerId: r.id,
      name: r.name,
      cpfCnpj: r.cpfCnpj,
      declarationId: r.decl?.id ?? null,
      status: computeElaborationStatus(r.decl?.elaborationStatus ?? 'no_files', list),
      counts: docCounts(list),
      sourceFileId: r.decl?.sourceFileId ?? null,
      exported: r.decl?.exportedFileId ? { fileId: r.decl.exportedFileId, at: r.exportedAt } : null,
    };
  });
  const statusCounts = Object.fromEntries(Object.keys(ELABORATION_STATUS).map((s) => [s, all.filter((r) => r.status === s).length]));
  const filtered = p.status ? all.filter((r) => r.status === p.status) : all;
  const page = p.page ?? 1;
  const pageSize = p.pageSize ?? 25;
  const start = (page - 1) * pageSize;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  return JSON.parse(JSON.stringify({ data: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize, pages, statusCounts }));
}

const listUrl = (p: ListParams) => `/api/elaboration?${new URLSearchParams({ year: '2026', ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])) })}`;

describe('central de elaboração com situação e contadores gravados (DAD-6)', () => {
  it('pagina, filtra e pesquisa no banco com a mesma resposta do cálculo em memória, sem ler os documentos', async () => {
    const o = await registerOffice(env);
    const tok = (await o.api.post('/api/robot/tokens', { name: 'Sync', scope: 'sync' })).body.token as string;
    const names = ['Ana Lima', 'Bruno Costa', 'Carla Dias', 'Diego Alves', 'Elisa Rocha', 'Fábio Nunes', 'Gabriela Pinto', 'Hugo Prado'];
    const ids: Record<string, string> = {};
    const cpfs: Record<string, string> = {};
    for (const [i, name] of names.entries()) {
      cpfs[name] = cpfOf(318_402_115 + i * 1_013);
      const c = await o.api.post('/api/customers', { name, cpfCnpj: cpfs[name] });
      expect(c.status).toBe(201);
      ids[name] = c.body.id;
    }
    const sync = (name: string, file: string, content: Buffer, type = 'application/pdf') =>
      send(env, tok, 'POST', '/api/sync/files', { multipart: multipart({ cpf: cpfs[name], ano: '2026' }, { name: file, content, type }) });
    const declOf = (name: string) => getOrCreateDeclaration(env.ctx.db, o.officeId, ids[name], 2026);

    // Ana: sem declaração; Bruno: declaração sem documento (contadores ainda vazios)
    await declOf('Bruno Costa');
    // Carla: PDF não processado; Diego e Elisa: processados (Elisa já tinha a linha com outro valor)
    await env.ctx.db.insert(declarationItems).values({
      officeId: o.officeId,
      declarationId: (await declOf('Elisa Rocha')).id,
      kind: 'income_pj',
      counterpartyDoc: '11222333000181',
      counterpartyName: 'Empresa Exemplo',
      valueCents: 4_000_000,
      withheldCents: 300_000,
    });
    for (const name of ['Carla Dias', 'Diego Alves', 'Elisa Rocha', 'Gabriela Pinto']) expect((await sync(name, `informe-${name}.pdf`, fakePdf(name))).status).toBe(201);
    env.providers.aiReplies.push(informe(5_000_000, 400_000), informe(5_000_000, 400_000));
    await o.api.post('/api/elaboration/process', { year: 2026, customerIds: [ids['Diego Alves'], ids['Elisa Rocha']] });
    await env.ctx.jobs.drain();
    // Fábio e Hugo: documentos gravados direto no banco, sem atualizar a declaração (como os de antes dos contadores)
    const line = (decision: string | null) => ({ item: { kind: 'payment', valueCents: 100 }, match: 'new', existingItemId: null, existing: null, decision, appliedAt: null });
    const saveFile = (name: string, mimeType: string) => env.ctx.files.save({ officeId: o.officeId, data: Buffer.from(name), filename: name, mimeType });
    const fabio = await declOf('Fábio Nunes');
    const hugo = await declOf('Hugo Prado');
    const exportedZip = await saveFile('conferencia.zip', 'application/zip');
    await env.ctx.db.update(declarations).set({ elaborationStatus: 'exported', exportedFileId: exportedZip.id }).where(eq(declarations.id, hugo.id));
    await env.ctx.db.insert(documents).values([
      {
        officeId: o.officeId,
        customerId: ids['Fábio Nunes'],
        declarationId: fabio.id,
        fileId: (await saveFile('recibo.pdf', 'application/pdf')).id,
        category: 'health',
        processingStatus: 'processed',
        extracted: { elaboration: { version: 1, processedAt: '2026-03-01T00:00:00Z', lines: [line('reject'), line(null)], notes: null, discarded: 0, error: null } },
      },
      { officeId: o.officeId, customerId: ids['Fábio Nunes'], declarationId: fabio.id, fileId: (await saveFile('fabio.DEC', 'application/octet-stream')).id, category: 'irpf_declaration', processingStatus: 'not_applicable' },
      { officeId: o.officeId, customerId: ids['Hugo Prado'], declarationId: hugo.id, fileId: (await saveFile('hugo.DEC', 'application/octet-stream')).id, category: 'irpf_declaration', processingStatus: 'not_applicable' },
    ]);
    // Gabriela: inativa, fica fora da central
    await env.ctx.db.update(customers).set({ status: 'inactive' }).where(eq(customers.id, ids['Gabriela Pinto']));

    // a primeira listagem calcula os contadores que faltavam
    const first = await o.api.get(listUrl({}));
    expect(first.body.statusCounts).toEqual({ no_files: 2, not_processed: 1, conflict: 1, awaiting_validation: 2, ok: 0, exported: 1 });
    expect(first.body.data.find((r: any) => r.name === 'Fábio Nunes')).toMatchObject({
      status: 'awaiting_validation',
      counts: { total: 2, eligible: 1, processed: 1, errors: 0, programFiles: 1, lines: 2, conflicts: 0, pendingLines: 1 },
    });
    const stored = await env.ctx.db.select({ counts: declarations.elaborationCounts }).from(declarations).where(eq(declarations.officeId, o.officeId));
    expect(stored.every((d) => d.counts !== null)).toBe(true);

    const queries: ListParams[] = [
      {},
      { pageSize: 3 },
      { pageSize: 3, page: 2 },
      { pageSize: 3, page: 3 },
      { pageSize: 3, page: 9 },
      ...Object.keys(ELABORATION_STATUS).map((status) => ({ status })),
      { status: 'no_files', pageSize: 1, page: 2 },
      { search: 'a' },
      { search: 'ROCHA' },
      { search: cpfs['Diego Alves'].slice(2, 8) },
      { search: 'zz' },
      { search: 'a', status: 'awaiting_validation' },
    ];
    for (const q of queries) {
      const res = await o.api.get(listUrl(q));
      expect(res.status).toBe(200);
      expect(res.body, JSON.stringify(q)).toEqual(await listingBefore(o.officeId, 2026, q));
    }

    // a página sai do banco com LIMIT, sem ler os documentos nem o JSON extraído pela IA
    const client = (env.ctx.db as unknown as { $client: { query: (...args: unknown[]) => unknown } }).$client;
    const spy = vi.spyOn(client, 'query');
    let sqls: string[] = [];
    try {
      expect((await o.api.get(listUrl({ status: 'awaiting_validation', pageSize: 1 }))).body.total).toBe(2);
      expect((await o.api.get(listUrl({ search: 'rocha' }))).body.data[0].status).toBe('conflict');
      sqls = spy.mock.calls.map((c) => String(c[0]));
    } finally {
      spy.mockRestore();
    }
    expect(sqls.some((s) => s.includes('"declarations"') && /\blimit\b/i.test(s))).toBe(true);
    expect(sqls.filter((s) => s.includes('"documents"') || s.includes('extracted'))).toEqual([]);
  });

  it('grava situação e contadores ao processar, decidir e validar', async () => {
    const o = await setup(5);
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
    const stored = async () => {
      const d = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.id, decl.id) });
      const live = (await loadDocStats(env.ctx.db, [decl.id])).get(decl.id) ?? [];
      // o gravado é sempre igual ao calculado a partir dos documentos
      expect(d!.elaborationCounts).toEqual(docCounts(live));
      expect(d!.elaborationStatus).toBe(computeElaborationStatus(d!.elaborationStatus, live));
      return { status: d!.elaborationStatus, counts: d!.elaborationCounts };
    };

    await o.upload('informe.pdf', fakePdf('informe'));
    expect(await stored()).toMatchObject({ status: 'not_processed', counts: { total: 1, eligible: 1, processed: 0 } });

    env.providers.aiReplies.push(informe(5_000_000, 400_000));
    await o.api.post('/api/elaboration/process', { year: 2026, customerIds: [o.customerId] });
    await env.ctx.jobs.drain();
    expect(await stored()).toMatchObject({ status: 'conflict', counts: { processed: 1, lines: 1, conflicts: 1, pendingLines: 1 } });

    const doc = (await o.api.get(`/api/elaboration/customers/${o.customerId}?year=2026`)).body.documents[0];
    await o.api.put(`/api/elaboration/documents/${doc.id}/lines/0`, { decision: 'accept' });
    expect(await stored()).toMatchObject({ status: 'awaiting_validation', counts: { conflicts: 0, pendingLines: 1 } });

    await o.api.post('/api/elaboration/validate', { year: 2026, customerIds: [o.customerId] });
    const done = await stored();
    expect(done).toMatchObject({ status: 'ok', counts: { conflicts: 0, pendingLines: 0 } });
    expect((await o.api.get(listUrl({}))).body.data[0]).toMatchObject({ status: 'ok', counts: done.counts });
  });

  it('envio, categoria e exclusão de documentos (documentação e checklist) atualizam a central', async () => {
    const o = await setup(6);
    const row = async () => (await o.api.get(listUrl({}))).body.data[0];
    // declaração com os contadores já gravados (zerados): daqui em diante só as atualizações os mudam
    await getOrCreateDeclaration(env.ctx.db, o.officeId, o.customerId, 2026);
    expect(await row()).toMatchObject({ status: 'no_files', counts: { total: 0 } });

    const up = await uploadFiles(env, o.token, `/api/customers/${o.customerId}/documents?year=2026`, [{ name: 'informe.pdf', content: FAKE_PDF, type: 'application/pdf' }]);
    expect(up.status).toBe(201);
    expect(await row()).toMatchObject({ status: 'not_processed', counts: { total: 1, eligible: 1 } });
    expect((await o.api.del(`/api/documents/${up.body[0].id}`)).status).toBe(200);
    expect(await row()).toMatchObject({ status: 'no_files', counts: { total: 0, eligible: 0 } });

    // arquivo do programa IRPF que muda de categoria deixa de contar como tal
    const dec = await o.upload('declaracao.DEC', Buffer.from('conteudo-dec'), 'application/octet-stream');
    expect(await row()).toMatchObject({ status: 'ok', counts: { total: 1, programFiles: 1 } });
    expect((await o.api.patch(`/api/documents/${dec.body.documentId}`, { category: 'previous_declaration' })).status).toBe(200);
    expect((await row()).counts).toMatchObject({ total: 1, programFiles: 0 });
    await o.api.del(`/api/documents/${dec.body.documentId}`);

    const checklist = (await o.api.post(`/api/customers/${o.customerId}/checklist`, { year: 2026 })).body;
    const item = checklist.sections.flatMap((s: any) => s.items)[0];
    expect((await uploadChecklist(env, o.token, `/api/checklists/${checklist.id}/items/${item.id}/files`, [{ name: 'rg.pdf', data: PDF }])).status).toBe(201);
    expect(await row()).toMatchObject({ status: 'not_processed', counts: { total: 1 } });
    const sent = await env.ctx.db.query.documents.findFirst({ where: eq(documents.checklistItemId, item.id) });
    expect((await o.api.del(`/api/checklists/${checklist.id}/files/${sent!.id}`)).status).toBe(200);
    expect(await row()).toMatchObject({ status: 'no_files', counts: { total: 0 } });
  });

  it('arquivos enviados ao mesmo tempo terminam com a contagem certa', async () => {
    const o = await setup(7);
    const sent = await Promise.all(Array.from({ length: 5 }, (_, i) => o.upload(`informe-${i}.pdf`, fakePdf(`informe ${i}`))));
    expect(sent.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const d = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, o.customerId) });
    expect(d).toMatchObject({ elaborationStatus: 'not_processed', elaborationCounts: { total: 5, eligible: 5 } });
  });
});
