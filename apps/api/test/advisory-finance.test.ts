import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INCOME_HEADERS, PAYMENT_HEADERS } from '@verifco/shared';
import { contracts } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { R, seedDeclaration, seedDocument, upload } from './advisory-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

async function officeWithCustomer(cpf = VALID_CPFS[0], name = 'Carlos Lima') {
  const office = await registerOffice(env);
  const c = await office.api.post('/api/customers', { name, cpfCnpj: cpf, email: 'carlos@ex.com' });
  return { ...office, customerId: c.body.id as string };
}

const csv = (headers: string[], rows: string[][]) => [headers.join(';'), ...rows.map((r) => r.join(';'))].join('\r\n');

describe('livro caixa', () => {
  it('converte CSV e XLSX, valida por linha, acrescenta sem sobrescrever e exporta para o Carnê-Leão Web', async () => {
    const o = await officeWithCustomer();
    const url = `/api/customers/${o.customerId}/cashbook/import?year=2025`;
    const incomes = csv(INCOME_HEADERS, [
      ['10/01/2025', 'R01.003.001', '', '2.500,00', '200,00', 'Aluguel janeiro', 'PF', '529.982.247-25'],
      ['10/02/2025', 'R01.003.001', '', '2.500,00', '', 'Aluguel fevereiro', 'PF', ''],
      ['99/99/9999', 'R01.004.001', '', '0,00', '', 'Modelo', 'PF'],
      ['15/02/2025', 'R01.001.001', '225', '3.000,00', '', 'Consulta empresa', 'PJ', '', '', '', '11.222.333/0001-81', 'S', '45,00'],
    ]);
    // CSV salvo pelo Excel em Windows-1252
    const r1 = await upload(env, o.token, url, [{ filename: 'rendimentos.csv', content: Buffer.from(incomes, 'latin1'), type: 'text/csv' }]);
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ total: 4, succeeded: 2, failed: 2 });
    expect(r1.body.results.find((r: any) => r.row === 3).message).toMatch(/CPF do titular/);
    expect(r1.body.results.find((r: any) => r.row === 4).message).toMatch(/Linha do modelo/);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pagamentos');
    ws.addRow(PAYMENT_HEADERS);
    ws.addRow(['20/01/2025', 'P10.01.00002', '1200,50', 'Aluguel do consultório']);
    ws.addRow(['20/01/2025', 'P20.01.00001', '500', 'INSS', '10,00', '', '01/2025']);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const r2 = await upload(env, o.token, url, [{ filename: 'pagamentos.xlsx', content: xlsx }]);
    expect(r2.body).toMatchObject({ total: 2, succeeded: 2, failed: 0 });

    const list = await o.api.get(`/api/customers/${o.customerId}/cashbook?year=2025`);
    expect(list.body.entries).toHaveLength(4);
    expect(list.body.totals).toMatchObject({ incomeCents: R(5_500), deductionCents: R(200), irrfCents: R(45), deductibleCents: R(1_200.5), generalPaymentsCents: R(500) });
    expect(list.body.months[0]).toMatchObject({ incomeCents: R(2_500), count: 3 });
    expect(list.body.batches).toHaveLength(2);

    const exp = await o.api.get(`/api/customers/${o.customerId}/cashbook/export?year=2025`);
    expect(exp.raw.headers['content-type']).toContain('text/csv');
    const lines = exp.raw.payload.trim().split('\r\n');
    expect(lines).toEqual([
      '10/01/2025;R01.003.001;;2500,00;200,00;Aluguel janeiro;PF;52998224725',
      '20/01/2025;P10.01.00002;1200,50;Aluguel do consultório',
      '20/01/2025;P20.01.00001;500,00;INSS;10,00;;01/2025',
      '15/02/2025;R01.001.001;225;3000,00;;Consulta empresa;PJ;;;;11222333000181;S;45,00',
    ]);
    const onlyIncome = await o.api.get(`/api/customers/${o.customerId}/cashbook/export?year=2025&kind=income&month=2`);
    expect(onlyIncome.raw.payload.trim().split('\r\n')).toHaveLength(1);

    // desfazer o envio de pagamentos
    const undo = await o.api.del(`/api/customers/${o.customerId}/cashbook/batches/${r2.body.batchId}`);
    expect(undo.body.removed).toBe(2);
    const entry = (await o.api.get(`/api/customers/${o.customerId}/cashbook?year=2025`)).body.entries[0];
    expect((await o.api.del(`/api/cashbook/entries/${entry.id}`)).body.ok).toBe(true);
    expect((await o.api.get(`/api/customers/${o.customerId}/cashbook?year=2025`)).body.entries).toHaveLength(1);
  });

  it('rejeita arquivo fora do layout e envios acima de 1.000 linhas; exporta ZIP acima de 1.000', async () => {
    const o = await officeWithCustomer(VALID_CPFS[1]);
    const url = `/api/customers/${o.customerId}/cashbook/import?year=2025`;
    const bad = await upload(env, o.token, url, [{ filename: 'x.csv', content: 'nome;cpf\nA;1', type: 'text/csv' }]);
    expect(bad.status).toBe(400);
    const many = csv(
      PAYMENT_HEADERS,
      Array.from({ length: 1001 }, () => ['05/03/2025', 'P10.01.00012', '10,00', 'Material']),
    );
    const big = await upload(env, o.token, url, [{ filename: 'p.csv', content: many, type: 'text/csv' }]);
    expect(big.status).toBe(400);
    expect(big.body.error).toMatch(/máximo é 1000/);

    const half = csv(PAYMENT_HEADERS, Array.from({ length: 600 }, () => ['05/03/2025', 'P10.01.00012', '10,00', 'Material']));
    await upload(env, o.token, url, [{ filename: 'a.csv', content: half, type: 'text/csv' }]);
    await upload(env, o.token, url, [{ filename: 'b.csv', content: half, type: 'text/csv' }]);
    const exp = await o.api.get(`/api/customers/${o.customerId}/cashbook/export?year=2025`);
    expect(exp.raw.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(exp.raw.rawPayload);
    expect(Object.keys(zip.files).sort()).toEqual(['carne-leao-2025-parte-1.csv', 'carne-leao-2025-parte-2.csv']);
  });

  it('exige cashbook.use e isola escritórios', async () => {
    const o = await officeWithCustomer(VALID_CPFS[2]);
    const emp = await createEmployee(env, o.api, ['customer.list']);
    expect((await emp.api.get(`/api/customers/${o.customerId}/cashbook?year=2025`)).status).toBe(403);
    const other = await registerOffice(env);
    expect((await other.api.get(`/api/customers/${o.customerId}/cashbook?year=2025`)).status).toBe(404);
    const r = await upload(env, other.token, `/api/customers/${o.customerId}/cashbook/import?year=2025`, [
      { filename: 'p.csv', content: csv(PAYMENT_HEADERS, [['05/03/2025', 'P10.01.00012', '10,00', 'Material']]), type: 'text/csv' },
    ]);
    expect(r.status).toBe(404);
  });
});

describe('copiloto financeiro', () => {
  it('administração respeita o limite do plano', async () => {
    const o = await registerOffice(env);
    const ids: string[] = [];
    for (const cpf of VALID_CPFS.slice(0, 6)) ids.push((await o.api.post('/api/customers', { name: `Cliente ${cpf}`, cpfCnpj: cpf })).body.id);
    for (const id of ids.slice(0, 5)) expect((await o.api.post('/api/copilot/enrollments', { customerId: id })).status).toBe(201);
    const full = await o.api.post('/api/copilot/enrollments', { customerId: ids[5] });
    expect(full.status).toBe(409);
    expect(full.body.error).toMatch(/Limite do plano/);
    expect((await o.api.post('/api/copilot/enrollments', { customerId: ids[0] })).status).toBe(409);

    const list = await o.api.get('/api/copilot/enrollments');
    expect(list.body).toMatchObject({ limit: 5, used: 5 });
    await o.api.put(`/api/copilot/enrollments/${list.body.enrollments[0].id}`, { status: 'inactive' });
    expect((await o.api.post('/api/copilot/enrollments', { customerId: ids[5] })).status).toBe(201);

    // contrato "pro" vigente amplia o limite
    const today = new Date().toISOString().slice(0, 10);
    await env.ctx.db.insert(contracts).values({ officeId: o.officeId, name: 'Pacote Pro', plan: 'pro', year: 2026, startsAt: '2020-01-01', expiresAt: '2099-12-31' });
    expect((await o.api.get('/api/copilot/enrollments')).body.limit).toBe(25);
    expect(today).toBeTruthy();
    expect((await o.api.put(`/api/copilot/enrollments/${list.body.enrollments[0].id}`, { status: 'active' })).body.status).toBe('active');
  });

  it('bloqueia cliente não habilitado; CRUD de lançamentos, visão geral e projeção do IRPFM', async () => {
    const o = await officeWithCustomer(VALID_CPFS[3]);
    const locked = await o.api.get(`/api/customers/${o.customerId}/copilot?year=2026`);
    expect(locked.body.enrolled).toBe(false);
    expect((await o.api.post(`/api/customers/${o.customerId}/copilot/entries`, { kind: 'income', year: 2026, month: 1, description: 'x', amountCents: 1 })).status).toBe(403);

    await o.api.post('/api/copilot/enrollments', { customerId: o.customerId });
    const add = (body: Record<string, unknown>) => o.api.post(`/api/customers/${o.customerId}/copilot/entries`, { year: 2026, ...body });
    for (const month of [1, 2, 3]) {
      await add({ kind: 'income', month, category: 'salary', description: 'Pró-labore', amountCents: R(20_000) });
      await add({ kind: 'income', month, category: 'dividends', description: 'Lucros', amountCents: R(60_000) });
    }
    const exp = await add({ kind: 'expense', month: 1, category: 'housing', description: 'Aluguel', amountCents: R(8_000) });
    expect(exp.status).toBe(201);
    await add({ kind: 'budget', category: 'housing', description: 'Moradia', amountCents: R(10_000) });
    await add({ kind: 'bill', description: 'IPVA', amountCents: R(3_000), dueDate: '2026-01-20', data: { paid: false } });
    await add({ kind: 'insurance', description: 'Seguro de vida', amountCents: R(1_200), data: { insurer: 'Segura SA' } });
    await add({ kind: 'foreign', description: 'Conta nos EUA', amountCents: R(50_000), data: { country: 'EUA', currency: 'USD' } });
    expect((await add({ kind: 'income', description: 'sem mês', amountCents: 1 })).status).toBe(400);
    expect((await add({ kind: 'income', month: 1, category: 'invalida', description: 'x', amountCents: 1 })).status).toBe(400);

    const ov = await o.api.get(`/api/customers/${o.customerId}/copilot?year=2026&month=1`);
    expect(ov.body.enrolled).toBe(true);
    expect(ov.body.overview.months[0]).toMatchObject({ incomeCents: R(80_000), expenseCents: R(8_000) });
    expect(ov.body.budget[0]).toMatchObject({ category: 'housing', limitCents: R(10_000), spentCents: R(8_000) });
    expect(ov.body.bills[0].overdue).toBe(true);
    expect(ov.body.insurances).toHaveLength(1);
    expect(ov.body.foreign).toHaveLength(1);
    expect(ov.body.projection.result.baseCents).toBe(R(960_000));
    expect(ov.body.projection.declarationYear).toBe(2027);

    const upd = await o.api.put(`/api/copilot/entries/${exp.body.id}`, { kind: 'expense', year: 2026, month: 1, category: 'housing', description: 'Aluguel', amountCents: R(9_000) });
    expect(upd.body.amountCents).toBe(R(9_000));
    expect((await o.api.del(`/api/copilot/entries/${exp.body.id}`)).body.ok).toBe(true);

    const doc = await upload(env, o.token, `/api/customers/${o.customerId}/copilot/documents`, [{ filename: 'apolice.pdf', content: '%PDF', type: 'application/pdf' }]);
    expect(doc.status).toBe(201);
    expect((await o.api.get(`/api/customers/${o.customerId}/copilot?year=2026`)).body.documents).toHaveLength(1);
  });

  it('permissões e isolamento', async () => {
    const o = await officeWithCustomer(VALID_CPFS[4]);
    await o.api.post('/api/copilot/enrollments', { customerId: o.customerId });
    const user = await createEmployee(env, o.api, ['customer.list', 'copilot.use']);
    expect((await user.api.get('/api/copilot/enrollments')).status).toBe(403);
    expect((await user.api.get(`/api/customers/${o.customerId}/copilot?year=2026`)).body.enrolled).toBe(true);
    const none = await createEmployee(env, o.api, ['customer.list']);
    expect((await none.api.get(`/api/customers/${o.customerId}/copilot?year=2026`)).status).toBe(403);
    const other = await registerOffice(env);
    expect((await other.api.post('/api/copilot/enrollments', { customerId: o.customerId })).status).toBe(404);
    expect((await other.api.get('/api/copilot/enrollments')).body.enrollments).toHaveLength(0);
  });
});

describe('backup', () => {
  it('gera o .zip com os dados do escritório e arquivos, sem segredos', async () => {
    const o = await officeWithCustomer(VALID_CPFS[5], 'Paula Reis');
    await o.api.put(`/api/customers/${o.customerId}/credentials`, { ecacLogin: VALID_CPFS[5], ecacPassword: 'senha-ecac-secreta' });
    await seedDeclaration(env, o.officeId, o.customerId, 2026, [{ kind: 'asset', groupCode: '01', description: 'Casa', valueCents: R(400_000) }]);
    await seedDocument(env, o.officeId, o.customerId, 'informe.pdf', '%PDF-informe', 'application/pdf');
    env.providers.aiReplies.push('resposta');
    await o.api.post(`/api/customers/${o.customerId}/ai/ir/messages`, { content: 'Pergunta', year: 2026 });
    // outro escritório não pode vazar para o backup
    const other = await officeWithCustomer(VALID_CPFS[6], 'Cliente de Outro');

    const gen = await o.api.post('/api/backups');
    expect(gen.status).toBe(202);
    expect((await o.api.post('/api/backups')).body.alreadyRunning).toBe(true);
    await env.ctx.jobs.drain();
    const list = await o.api.get('/api/backups');
    expect(list.body[0].status).toBe('done');
    expect(list.body[0].result.tables.customers).toBe(1);

    const dl = await o.api.get(`/api/backups/${list.body[0].id}/download`);
    expect(dl.raw.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(dl.raw.rawPayload);
    const names = Object.keys(zip.files);
    expect(names).toContain('LEIAME.txt');
    expect(names).toContain('dados/customers.json');
    expect(names).toContain('dados/declaration_items.json');
    expect(names).toContain('dados/ai_messages.json');
    expect(names.some((n) => n.startsWith('arquivos/') && n.endsWith('informe.pdf'))).toBe(true);
    const customers = JSON.parse(await zip.file('dados/customers.json')!.async('string'));
    expect(customers.map((c: any) => c.name)).toEqual(['Paula Reis']);
    expect(customers[0].ecacPasswordEnc).toBeUndefined();
    const users = JSON.parse(await zip.file('dados/users.json')!.async('string'));
    expect(users[0].passwordHash).toBeUndefined();
    const all = await Promise.all(names.filter((n) => n.startsWith('dados/') && n.endsWith('.json')).map((n) => zip.file(n)!.async('string')));
    const blob = all.join('\n');
    expect(blob).not.toContain('Cliente de Outro');
    expect(blob).not.toContain('senha-ecac-secreta');
    expect(blob).not.toMatch(/"v1\.[A-Za-z0-9_-]+\./);
    const msgs = JSON.parse(await zip.file('dados/ai_messages.json')!.async('string'));
    expect(msgs).toHaveLength(2);

    expect((await other.api.get(`/api/backups/${list.body[0].id}/download`)).status).toBe(404);
    const emp = await createEmployee(env, o.api, ['customer.list']);
    expect((await emp.api.post('/api/backups')).status).toBe(403);

    // o segundo backup não inclui o primeiro
    await o.api.post('/api/backups');
    await env.ctx.jobs.drain();
    const second = (await o.api.get('/api/backups')).body[0];
    const zip2 = await JSZip.loadAsync((await o.api.get(`/api/backups/${second.id}/download`)).raw.rawPayload);
    expect(Object.keys(zip2.files).some((n) => n.includes('backup-verifco'))).toBe(false);
  });
});
