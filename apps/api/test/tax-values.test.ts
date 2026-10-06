/**
 * Regressões do lote "cálculos tributários e leitura de valores": DARF (mínimo, 31/12, juros das
 * quotas), IR estimado do IRPFM com deduções legais, resultado rural e importação de orçamentos
 * por CSV do Excel (Windows-1252, "R$ 1.500", data inexistente).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareTaxation, type DeclarationItem } from '@verifco/shared';
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
    expect(res.body).toMatchObject({ total: 3, succeeded: 1, failed: 2 });
    expect(res.body.results[1].message).toBe('Início da cobrança "31/02/2026" inválido: use uma data que exista, no formato DD/MM/AAAA.');
    expect(res.body.results[2].message).toMatch(/Valor "1,500" inválido/);
    const list = (await api.get(`/api/finance/customers/${maria.body.id}/budgets?year=2026`)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amountCents: 150_000, description: 'Declaração completa', internalNote: 'Cliente antigo', billingStartDate: '2026-11-10', category: 'irpf' });
  });
});
