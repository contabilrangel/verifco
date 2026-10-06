/**
 * Regressões do lote "cálculos tributários e leitura de valores": DARF (mínimo, 31/12, juros das
 * quotas), IR estimado do IRPFM com deduções legais, resultado rural e importação de orçamentos
 * por CSV do Excel (Windows-1252, "R$ 1.500", data inexistente) e por .xlsx com células numéricas
 * e fórmulas (o texto "104.895" de uma célula numérica é R$ 104,90, não R$ 104.895,00).
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAYMENT_HEADERS, compareTaxation, type DeclarationItem } from '@verifco/shared';
import { normalizeDate } from '../src/modules/ecac/util';
import { readImportFile } from '../src/modules/imports/sheet';
import { decodeCsvText, readSheet } from '../src/services/xlsx';
import { VALID_CPFS, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';
import { FAKE_PDF, upload } from './upload-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

async function customerWithDeclaration(api: Api, year: number, body: Record<string, unknown> = {}, cpf = VALID_CPFS[0]) {
  const c = await api.post('/api/customers', { name: 'João Pereira', cpfCnpj: cpf, email: 'joao@ex.com' });
  const d = await api.put(`/api/customers/${c.body.id}/declarations/${year}`, body);
  return { customerId: c.body.id as string, declarationId: d.body.id as string };
}

describe('DARF', () => {
  it('saldo abaixo de R$ 10,00 não gera nem aceita DARF', async () => {
    const { api } = await registerOffice(env);
    const { declarationId } = await customerWithDeclaration(api, 2026, { taxDueCents: 999 });
    const gen = await api.post(`/api/declarations/${declarationId}/darfs/generate`, { quotas: 1, firstDueDate: '2026-05-29' });
    expect(gen.status).toBe(400);
    expect(gen.body.error).toMatch(/abaixo de R\$ 10,00 não gera DARF/);
    const manual = await api.post(`/api/declarations/${declarationId}/darfs`, { valueCents: 999, dueDate: '2026-05-29' });
    expect(manual.status).toBe(400);
    expect(JSON.stringify(manual.body)).toMatch(/R\$ 10,00/);
    expect((await api.post(`/api/declarations/${declarationId}/darfs`, { valueCents: 1_000, dueDate: '2026-05-29' })).status).toBe(201);
  });

  it('8ª quota vence em 30/12 e as quotas a partir da 2ª mostram os juros', async () => {
    const { api, token } = await registerOffice(env);
    const { declarationId } = await customerWithDeclaration(api, 2026, { taxDueCents: 800_000 });
    const gen = await api.post(`/api/declarations/${declarationId}/darfs/generate`, { quotas: 8, firstDueDate: '2026-05-29' });
    expect(gen.status).toBe(201);
    const darfs = gen.body.darfs as any[];
    expect(darfs.at(-1).dueDate).toBe('2026-12-30');
    expect(darfs[0].amount).toBeNull();
    expect(darfs[1].amount).toMatchObject({ principalCents: 100_000, interestPercent: 1, totalCents: 101_000 });
    // 3ª quota: Selic de junho/2026 (1,12%) + 1%
    expect(darfs[2].amount).toMatchObject({ interestPercent: 2.12, totalCents: 102_120 });
    // 8ª quota: Selic de junho a novembro, ainda não publicada inteira → só o principal, com aviso
    expect(darfs[7].amount).toMatchObject({ principalCents: 100_000, totalCents: null });
    expect(darfs[7].amount.note).toMatch(/A guia soma juros/);

    // e-mail ao cliente: valor com os juros
    await upload(env, token, `/api/darfs/${darfs[1].id}/file`, [{ name: 'quota-2.pdf', content: FAKE_PDF, type: 'application/pdf' }]);
    expect((await api.post(`/api/darfs/${darfs[1].id}/send`, { channel: 'email' })).status).toBe(200);
    await upload(env, token, `/api/darfs/${darfs[7].id}/file`, [{ name: 'quota-8.pdf', content: FAKE_PDF, type: 'application/pdf' }]);
    expect((await api.post(`/api/darfs/${darfs[7].id}/send`, { channel: 'email' })).status).toBe(200);
    await env.ctx.jobs.drain();
    const mails = env.providers.sentEmails.filter((m) => m.to === 'joao@ex.com').map((m) => m.html ?? '');
    expect(mails.some((h) => /1\.010,00/.test(h) && /juros de 1,00%/.test(h))).toBe(true);
    expect(mails.some((h) => /1\.000,00/.test(h) && /mais juros/.test(h))).toBe(true);

    // valor editado é o da guia: deixa de ser só o principal
    const edited = await api.put(`/api/darfs/${darfs[2].id}`, { valueCents: 102_200 });
    expect(edited.body).toMatchObject({ valueCents: 102_200, source: 'edited', amount: null });
    // editar só o vencimento mantém a quota como principal gerado
    const moved = await api.put(`/api/darfs/${darfs[3].id}`, { dueDate: '2026-08-31', valueCents: 100_000 });
    expect(moved.body.source).toBe('generated');
  });
});

describe('IRPFM — IR da declaração estimado (dedução I)', () => {
  const items: Record<string, unknown>[] = [
    { kind: 'income_pj', valueCents: 30_000_000, counterpartyDoc: '11222333000181', extra: { officialPensionCents: 1_000_000 } },
    { kind: 'income_exempt', valueCents: 150_000_000, counterpartyDoc: '11222333000181', extra: { nature: 'dividends' } },
    { kind: 'payment', valueCents: 12_000_000, extra: { nature: 'other' } },
    { kind: 'payment', valueCents: 2_000_000, extra: { nature: 'education' } },
    { kind: 'dependent', ownerName: 'Filho', counterpartyDoc: VALID_CPFS[3], extra: { relationship: 'child' } },
  ];

  it('usa as deduções legais (aluguel/outros não deduzem) e a melhor opção', async () => {
    const { api } = await registerOffice(env);
    const { customerId, declarationId } = await customerWithDeclaration(api, 2027);
    for (const it of items) expect((await api.post(`/api/declarations/${declarationId}/items`, it)).status).toBe(201);
    const res = await api.get(`/api/customers/${customerId}/irpfm?year=2027`);
    expect(res.status).toBe(200);
    expect(res.body.regularTaxSource).toBe('estimated');
    // simplificada: (300.000 − 17.640) × 27,5% − 10.904,66 = 66.744,34 (antes: R$ 33.095,24, com o aluguel como dedução)
    expect(res.body.result.deductions.regularTaxDueCents).toBe(6_674_434);
    const expected = compareTaxation({ exerciseYear: 2027, items: items as unknown as DeclarationItem[] });
    expect(res.body.result.deductions.regularTaxDueCents).toBe(expected.simplified.taxCents);
  });

  it('declaração na completa usa INSS, dependente e instrução limitada', async () => {
    const { api } = await registerOffice(env);
    const { customerId, declarationId } = await customerWithDeclaration(api, 2027, { taxation: 'complete' }, VALID_CPFS[1]);
    for (const it of items) await api.post(`/api/declarations/${declarationId}/items`, it);
    const res = await api.get(`/api/customers/${customerId}/irpfm?year=2027`);
    // base 300.000 − 15.836,58 = 284.163,42 → 27,5% − 10.904,66 = 67.240,28
    expect(res.body.result.deductions.regularTaxDueCents).toBe(6_724_028);
  });

  it('resultado rural: parcela isenta sai da base e o tributável pode ser informado', async () => {
    const { api } = await registerOffice(env);
    const { customerId, declarationId } = await customerWithDeclaration(api, 2027, {}, VALID_CPFS[2]);
    await api.post(`/api/declarations/${declarationId}/items`, { kind: 'income_pj', valueCents: 10_000_000 });
    await api.post(`/api/declarations/${declarationId}/items`, { kind: 'rural_income', valueCents: 200_000_000 });
    await api.post(`/api/declarations/${declarationId}/items`, { kind: 'rural_expense', valueCents: 100_000_000 });
    const gross = (await api.get(`/api/customers/${customerId}/irpfm?year=2027`)).body.result;
    expect(gross.baseCents).toBe(110_000_000);
    expect(gross.warnings.join(' ')).toMatch(/20% da receita bruta/);
    const informed = await api.post(`/api/customers/${customerId}/irpfm`, { year: 2027, adjustments: { ruralTaxableResultCents: 40_000_000 } });
    expect(informed.status).toBe(200);
    expect(informed.body.result).toMatchObject({ baseCents: 50_000_000, exclusionsCents: 60_000_000, ratePercent: 0, dueCents: 0 });
    // parcela isenta lançada nos isentos (natureza rural) tem o mesmo efeito
    await api.post(`/api/declarations/${declarationId}/items`, { kind: 'income_exempt', valueCents: 60_000_000, extra: { nature: 'rural' } });
    const withExempt = (await api.get(`/api/customers/${customerId}/irpfm?year=2027`)).body.result;
    expect(withExempt).toMatchObject({ baseCents: 50_000_000, totalIncomeCents: 110_000_000, dueCents: 0 });
  });
});

describe('orçamentos em lote por CSV do Excel', () => {
  it('lê Windows-1252, "R$ 1.500" como R$ 1.500,00 e recusa data inexistente', async () => {
    const { api, token } = await registerOffice(env);
    const maria = await api.post('/api/customers', { name: 'Maria Cliente', cpfCnpj: VALID_CPFS[0] });
    await api.post('/api/customers', { name: 'Carlos Lote', cpfCnpj: VALID_CPFS[4] });
    const csv = [
      'CPF/CNPJ;Cliente;Categoria;Descrição;Valor;Início da cobrança;Observação interna',
      `${VALID_CPFS[0]};Maria Cliente;Declaração IRPF;Declaração completa;R$ 1.500;10/11/2026;Cliente antigo`,
      `${VALID_CPFS[4]};Carlos Lote;Declaração IRPF;;1.500,50;31/02/2026;`,
      `${VALID_CPFS[4]};Carlos Lote;Ganho de capital;;1,500;;`,
    ].join('\r\n');
    const res = await upload(env, token, '/api/finance/budget-import', [{ name: 'orcamentos.csv', content: Buffer.from(csv, 'latin1'), type: 'text/csv' }], { year: '2026' });
    expect(res.status).toBe(200);
    // a importação roda no job; o resultado fica no lote
    await env.ctx.jobs.drain();
    const batch = (await api.get(`/api/finance/budget-import/batches/${res.body.id}`)).body;
    expect(batch).toMatchObject({ total: 3, succeeded: 1, failed: 2 });
    expect(batch.results[1].message).toBe('Início da cobrança "31/02/2026" inválido: use uma data que exista, no formato DD/MM/AAAA.');
    expect(batch.results[2].message).toMatch(/Valor "1,500" inválido/);
    const list = (await api.get(`/api/finance/customers/${maria.body.id}/budgets?year=2026`)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amountCents: 150_000, description: 'Declaração completa', internalNote: 'Cliente antigo', billingStartDate: '2026-11-10', category: 'irpf' });
  });
});

describe('importações por .xlsx com células numéricas', () => {
  const MONEY = '"R$" #,##0.00';

  it('orçamentos: valor numérico ou de fórmula pelo número da célula, texto pelo parser de reais', async () => {
    const { api, token } = await registerOffice(env);
    const ids: string[] = [];
    for (const [i, cpf] of [VALID_CPFS[0], VALID_CPFS[1], VALID_CPFS[2], VALID_CPFS[4], VALID_CPFS[5]].entries()) {
      ids.push((await api.post('/api/customers', { name: `Cliente ${i + 1}`, cpfCnpj: cpf })).body.id);
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Orçamentos 2026');
    ws.addRow(['CPF/CNPJ', 'Cliente', 'Categoria', 'Valor', 'Status']);
    ws.addRow([VALID_CPFS[0], 'Cliente 1', 'Declaração IRPF', 1500]);
    // CPF digitado como número continua sendo lido pelo texto da célula
    ws.addRow([Number(VALID_CPFS[1]), 'Cliente 2', 'Declaração IRPF', 1500.5]);
    // =99,9*1,05 → o Excel mostra R$ 104,90; o texto da célula é "104.895"
    ws.addRow([VALID_CPFS[2], 'Cliente 3', 'Declaração IRPF', { formula: '99.9*1.05', result: 104.895 }, 'Aprovado']);
    ws.addRow([VALID_CPFS[4], 'Cliente 4', 'Declaração IRPF', 0.125]);
    // valor digitado como texto: milhar brasileiro
    ws.addRow([VALID_CPFS[5], 'Cliente 5', 'Declaração IRPF', '1.500']);
    ws.getColumn(4).numFmt = MONEY;
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await upload(env, token, '/api/finance/budget-import', [{ name: 'orcamentos.xlsx', content: xlsx }], { year: '2026' });
    expect(res.status).toBe(200);
    // a importação roda no job; o resultado fica no lote
    await env.ctx.jobs.drain();
    expect((await api.get(`/api/finance/budget-import/batches/${res.body.id}`)).body).toMatchObject({ total: 5, succeeded: 5, failed: 0 });
    const amounts: number[] = [];
    for (const id of ids) {
      const list = (await api.get(`/api/finance/customers/${id}/budgets?year=2026`)).body.data;
      expect(list).toHaveLength(1);
      amounts.push(list[0].amountCents);
    }
    expect(amounts).toEqual([150_000, 150_050, 10_490, 13, 150_000]);
    // aprovado: o faturamento sai com o valor que o Excel mostra
    const approved = (await api.get(`/api/finance/customers/${ids[2]}/budgets?year=2026`)).body.data[0];
    expect(approved).toMatchObject({ status: 'approved', amountCents: 10_490, totalCents: 10_490, billing: { totalCents: 10_490 } });
    expect(approved.billing.installments.map((i: any) => i.amountCents)).toEqual([10_490]);
  });

  it('livro caixa: valor e multa numéricos pelo número da célula', async () => {
    const { api, token } = await registerOffice(env);
    const c = await api.post('/api/customers', { name: 'Ana Caixa', cpfCnpj: VALID_CPFS[6] });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pagamentos');
    ws.addRow(PAYMENT_HEADERS);
    ws.addRow(['20/01/2025', 'P10.01.00002', { formula: '99.9*1.05', result: 104.895 }, 'Aluguel do consultório']);
    ws.addRow(['20/02/2025', 'P20.01.00001', 500.125, 'INSS', 0.125, '', '01/2025']);
    ws.getColumn(3).numFmt = MONEY;
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await upload(env, token, `/api/customers/${c.body.id}/cashbook/import?year=2025`, [{ name: 'pagamentos.xlsx', content: xlsx }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    const entries = (await api.get(`/api/customers/${c.body.id}/cashbook?year=2025`)).body.entries;
    expect(entries.map((e: any) => e.valueCents)).toEqual([10_490, 50_013]);
    expect(entries[1].extra).toMatchObject({ fineCents: 13 });
  });
});

describe('leitores únicos de CSV e de data (OBS-1)', () => {
  // "Aluguel – sala “2” € 10 ação" em Windows-1252: 0x96 (–), 0x93/0x94 (“ ”) e 0x80 (€) são caracteres, não controles
  const latin1 = (s: string) => Buffer.from(s, 'latin1');
  const cp1252 = Buffer.concat([latin1('Aluguel '), Buffer.from([0x96]), latin1(' sala '), Buffer.from([0x93]), latin1('2'), Buffer.from([0x94]), latin1(' '), Buffer.from([0x80]), latin1(' 10 ação')]);
  const text = 'Aluguel – sala “2” € 10 ação';

  it('decodeCsvText decodifica os bytes 0x80–0x9F do Windows-1252 e mantém UTF-8 e BOM', () => {
    expect(decodeCsvText(cp1252)).toBe(text);
    expect(decodeCsvText(Buffer.from(`﻿${text}`, 'utf8'))).toBe(text);
    // bytes sem caractere no Windows-1252 ficam como estão (norma WHATWG)
    expect(decodeCsvText(Buffer.from([0x41, 0x81, 0x8d, 0x8f, 0x90, 0x9d]))).toBe('A\u0081\u008d\u008f\u0090\u009d');
  });

  it('importações e livro caixa leem o CSV pelo mesmo decodificador', async () => {
    const csv = Buffer.concat([latin1('Nome;CPF\r\n'), cp1252, latin1(`;${VALID_CPFS[0]}\r\n`)]);
    const imported = await readImportFile(csv, 'clientes.csv');
    expect(imported).toEqual(await readSheet(csv, 'clientes.csv'));
    expect(imported[0].values.nome).toBe(text);

    const { api, token } = await registerOffice(env);
    const c = await api.post('/api/customers', { name: 'Rita Caixa', cpfCnpj: VALID_CPFS[7] });
    const payments = Buffer.concat([latin1(`${PAYMENT_HEADERS.join(';')}\r\n20/01/2025;P10.01.00002;1500,00;`), cp1252, latin1('\r\n')]);
    const res = await upload(env, token, `/api/customers/${c.body.id}/cashbook/import?year=2025`, [{ name: 'pagamentos.csv', content: payments, type: 'text/csv' }]);
    expect(res.body).toMatchObject({ total: 1, succeeded: 1 });
    const [entry] = (await api.get(`/api/customers/${c.body.id}/cashbook?year=2025`)).body.entries;
    expect(entry.description).toBe(text);
  });

  it('normalizeDate (dados do eCAC) usa o parser único e recusa datas que não existem', () => {
    expect(normalizeDate('31/01/2026')).toBe('2026-01-31');
    expect(normalizeDate('2026-01-31')).toBe('2026-01-31');
    expect(normalizeDate('2026-01-31T10:20:00Z')).toBe('2026-01-31');
    expect(normalizeDate('20260131')).toBe('2026-01-31');
    expect(normalizeDate(20260131)).toBe('2026-01-31');
    expect(normalizeDate('31/02/2026')).toBeNull();
    expect(normalizeDate('20260231')).toBeNull();
    expect(normalizeDate('2026-02-30')).toBeNull();
    expect(normalizeDate('amanhã')).toBeNull();
    expect(normalizeDate(null)).toBeNull();
  });
});
