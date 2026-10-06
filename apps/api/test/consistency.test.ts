import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { INCOME_HEADERS, PAYMENT_HEADERS } from '@verifco/shared';
import { backlogs, billings, budgets, contracts, darfs, declarations, files, importBatches } from '../src/db/schema';
import { decodeCsvText, decodeWindows1252, readSheet } from '../src/services/xlsx';
import { readImportFile } from '../src/modules/imports/sheet';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { FAKE_PDF, upload } from './upload-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const pub = (method: 'GET' | 'POST', url: string) => env.app.inject({ method, url }).then((r) => ({ status: r.statusCode, body: r.json() }));

/** Falha simulada do banco no meio de uma escrita (gatilho que recusa o INSERT). */
async function failInsertsOn(table: string) {
  await env.ctx.db.execute(sql.raw(`create or replace function verifco_falha() returns trigger language plpgsql as $$ begin raise exception 'falha simulada'; end $$`));
  await env.ctx.db.execute(sql.raw(`create trigger verifco_falha before insert on ${table} for each statement execute function verifco_falha()`));
  return () => env.ctx.db.execute(sql.raw(`drop trigger verifco_falha on ${table}`));
}

describe('cliente excluído (soft delete) (DAD-9)', () => {
  it('libera a vaga do Copiloto', async () => {
    const o = await registerOffice(env);
    const ids: string[] = [];
    for (const cpf of VALID_CPFS.slice(0, 6)) ids.push((await o.api.post('/api/customers', { name: `Cliente ${cpf}`, cpfCnpj: cpf })).body.id);
    for (const id of ids.slice(0, 5)) expect((await o.api.post('/api/copilot/enrollments', { customerId: id })).status).toBe(201);
    expect((await o.api.post('/api/copilot/enrollments', { customerId: ids[5] })).status).toBe(409);

    // a habilitação do excluído some da lista e deixa de ocupar vaga
    expect((await o.api.del(`/api/customers/${ids[0]}`)).status).toBe(200);
    expect((await o.api.get('/api/copilot/enrollments')).body).toMatchObject({ limit: 5, used: 4 });
    expect((await o.api.post('/api/copilot/enrollments', { customerId: ids[5] })).status).toBe(201);
    expect((await o.api.get('/api/copilot/enrollments')).body).toMatchObject({ used: 5 });
  });

  it('invalida o link público do orçamento: sem aprovação nem faturamento', async () => {
    const o = await registerOffice(env);
    const c = await o.api.post('/api/customers', { name: 'Ana Excluída', cpfCnpj: VALID_CPFS[1], email: 'ana@ex.com' });
    const b = await o.api.post('/api/finance/budgets', { customerId: c.body.id, exerciseYear: 2026, type: 'fixed', category: 'irpf', amountCents: 50_000 });
    const sent = await o.api.post(`/api/finance/budgets/${b.body.id}/send`, { channels: ['email'] });
    const token = new URL(sent.body.link).pathname.split('/').pop()!;
    expect((await pub('GET', `/api/public/budgets/${token}`)).status).toBe(200);

    await o.api.del(`/api/customers/${c.body.id}`);
    const view = await pub('GET', `/api/public/budgets/${token}`);
    expect(view.status).toBe(410);
    expect(view.body.error).toMatch(/não está mais disponível/);
    expect((await pub('POST', `/api/public/budgets/${token}/approve`)).status).toBe(410);
    expect((await pub('POST', `/api/public/budgets/${token}/reject`)).status).toBe(410);
    expect(await env.ctx.db.select().from(billings).where(eq(billings.budgetId, b.body.id))).toHaveLength(0);
    expect((await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, b.body.id) }))!.status).toBe('sent');
  });
});

describe('escritas dependentes em transação (DAD-16)', () => {
  it('regerar DARF: falha no meio mantém as quotas e o PDF anteriores', async () => {
    const o = await registerOffice(env);
    const c = await o.api.post('/api/customers', { name: 'João DARF', cpfCnpj: VALID_CPFS[2] });
    const d = await o.api.put(`/api/customers/${c.body.id}/declarations/2026`, { taxDueCents: 300_000 });
    const gen = await o.api.post(`/api/declarations/${d.body.id}/darfs/generate`, { quotas: 3, firstDueDate: '2026-05-29' });
    expect(gen.status).toBe(201);
    const first = gen.body.darfs[0];
    expect((await upload(env, o.token, `/api/darfs/${first.id}/file`, [{ name: 'darf-1.pdf', content: FAKE_PDF, type: 'application/pdf' }])).status).toBe(200);
    const pdf = (await env.ctx.db.query.darfs.findFirst({ where: eq(darfs.id, first.id) }))!.fileId!;

    const restore = await failInsertsOn('darfs');
    const failed = await o.api.post(`/api/declarations/${d.body.id}/darfs/generate`, { quotas: 2, firstDueDate: '2026-05-29', replace: true });
    await restore();
    expect(failed.status).toBe(500);
    const after = await o.api.get(`/api/declarations/${d.body.id}/darfs`);
    expect(after.body.darfs.map((x: any) => x.id)).toEqual(gen.body.darfs.map((x: any) => x.id));
    expect(after.body.darfs[0].file?.filename).toBe('darf-1.pdf');
    expect((await env.ctx.files.get(o.officeId, pdf)).data.equals(FAKE_PDF)).toBe(true);

    // sem a falha, troca as quotas e só então apaga o PDF antigo
    const ok = await o.api.post(`/api/declarations/${d.body.id}/darfs/generate`, { quotas: 2, firstDueDate: '2026-05-29', replace: true });
    expect(ok.status).toBe(201);
    expect(ok.body.darfs).toHaveLength(2);
    expect(await env.ctx.db.select().from(files).where(eq(files.id, pdf))).toHaveLength(0);
    await expect(env.ctx.files.get(o.officeId, pdf)).rejects.toThrow();
  });

  it('importar livro caixa: falha ao gravar os lançamentos não deixa lote "com sucesso" vazio', async () => {
    const o = await registerOffice(env);
    const c = await o.api.post('/api/customers', { name: 'Paula Caixa', cpfCnpj: VALID_CPFS[3] });
    const csv = [PAYMENT_HEADERS.join(';'), '05/03/2025;P10.01.00012;10,00;Material de escritório'].join('\r\n');
    const url = `/api/customers/${c.body.id}/cashbook/import?year=2025`;
    const kind = `cashbook:${c.body.id}:2025`;

    const restore = await failInsertsOn('cashbook_entries');
    const failed = await upload(env, o.token, url, [{ name: 'pagamentos.csv', content: csv, type: 'text/csv' }]);
    await restore();
    expect(failed.status).toBe(500);
    expect(await env.ctx.db.select().from(importBatches).where(and(eq(importBatches.officeId, o.officeId), eq(importBatches.kind, kind)))).toHaveLength(0);

    const ok = await upload(env, o.token, url, [{ name: 'pagamentos.csv', content: csv, type: 'text/csv' }]);
    expect(ok.body).toMatchObject({ total: 1, succeeded: 1 });
    const [batch] = await env.ctx.db.select().from(importBatches).where(eq(importBatches.id, ok.body.batchId));
    expect(batch).toMatchObject({ succeeded: 1, results: [{ row: 2, ok: true, message: expect.stringContaining('pagamentos.csv') }] });
  });
});

describe('leitor único de planilhas e Windows-1252 de verdade (OBS-1)', () => {
  const cp1252 = (text: string) => {
    const map: Record<string, number> = { '€': 0x80, '–': 0x96, '—': 0x97, '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92, '…': 0x85, '•': 0x95, 'œ': 0x9c, 'Š': 0x8a };
    return Buffer.from([...text].map((ch) => map[ch] ?? ch.charCodeAt(0)));
  };

  it('decodifica os bytes 0x80–0x9F (aspas curvas, travessão, €) e o resto como Latin-1', () => {
    const text = 'Aluguel – março “sala 2” € 1.500 — ok… José';
    expect(decodeWindows1252(cp1252(text))).toBe(text);
    expect(decodeCsvText(cp1252(text))).toBe(text);
    // UTF-8 (com BOM) continua UTF-8
    expect(decodeCsvText(Buffer.from(`﻿${text}`, 'utf8'))).toBe(text);
    // bytes sem caractere no cp1252 viram o controle de mesmo código (padrão WHATWG)
    expect(decodeWindows1252(Buffer.from([0x81, 0x8d]))).toBe('\u0081\u008d');
  });

  it('importações e livro caixa passam pelo mesmo leitor', async () => {
    const sheet = cp1252('Nome;CPF;Observação\nJosé – Filho;529.982.247-25;“VIP”\n');
    const rows = await readImportFile(sheet, 'clientes.csv');
    expect(rows[0].values).toMatchObject({ nome: 'José – Filho', observacao: '“VIP”' });
    expect(await readSheet(sheet, 'clientes.csv')).toEqual(rows);

    const o = await registerOffice(env);
    const c = await o.api.post('/api/customers', { name: 'Rui Caixa', cpfCnpj: VALID_CPFS[4] });
    const csv = cp1252([PAYMENT_HEADERS.join(';'), '05/03/2025;P10.01.00012;10,00;Aluguel – março “sala 2”'].join('\r\n'));
    const res = await upload(env, o.token, `/api/customers/${c.body.id}/cashbook/import?year=2025`, [{ name: 'pagamentos.csv', content: csv, type: 'text/csv' }]);
    expect(res.body).toMatchObject({ succeeded: 1 });
    const book = await o.api.get(`/api/customers/${c.body.id}/cashbook?year=2025`);
    expect(book.body.entries[0].description).toBe('Aluguel – março “sala 2”');
    // cabeçalho sem nenhuma linha: o erro é de "sem linhas", não de layout
    const empty = await upload(env, o.token, `/api/customers/${c.body.id}/cashbook/import?year=2025`, [{ name: 'vazio.csv', content: INCOME_HEADERS.join(';'), type: 'text/csv' }]);
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/não têm linhas/);
  });
});

describe('"hoje" no horário de Brasília (CON-7/DAD-13)', () => {
  afterEach(() => vi.useRealTimers());

  it('às 22h30 de Brasília (já 01h30 do dia seguinte em UTC) o que vence hoje não aparece vencido', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T01:30:00Z')); // 05/10/2026 22:30 em Brasília
    const o = await registerOffice(env);
    const c = await o.api.post('/api/customers', { name: 'Eva Prazo', cpfCnpj: VALID_CPFS[5] });
    const [decl] = await env.ctx.db.insert(declarations).values({ officeId: o.officeId, customerId: c.body.id, exerciseYear: 2026 }).returning();
    await env.ctx.db.insert(backlogs).values([
      { officeId: o.officeId, customerId: c.body.id, declarationId: decl.id, description: 'Vence hoje', dueDate: '2026-10-05' },
      { officeId: o.officeId, customerId: c.body.id, declarationId: decl.id, description: 'Venceu ontem', dueDate: '2026-10-04' },
    ]);
    const report = await o.api.get('/api/reports/backlogs?year=2026');
    const items = report.body.groups[0].items as { description: string; overdueDays: number }[];
    expect(items.find((i) => i.description === 'Vence hoje')!.overdueDays).toBe(0);
    expect(items.find((i) => i.description === 'Venceu ontem')!.overdueDays).toBe(1);
    expect((await o.api.get('/api/reports/backlogs?year=2026&overdueOnly=true')).body.totals.items).toBe(1);

    // o contrato de avaliação começa no dia de Brasília e vale 30 dias
    const [trial] = await env.ctx.db.select().from(contracts).where(eq(contracts.officeId, o.officeId));
    expect(trial).toMatchObject({ plan: 'trial', year: 2026, startsAt: '2026-10-05', expiresAt: '2026-11-04' });
  });
});
