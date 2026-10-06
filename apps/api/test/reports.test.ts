import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { backlogs, declarationItems, declarations } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const uuid = () => crypto.randomUUID();
type Item = typeof declarationItems.$inferInsert;

async function newCustomer(api: Api, i: number, name: string, email: string | null = `c${i}@ex.com`) {
  const c = await api.post('/api/customers', { name, cpfCnpj: VALID_CPFS[i], email });
  expect(c.status).toBe(201);
  return c.body.id as string;
}

async function declaration(officeId: string, customerId: string, year: number, data: Partial<typeof declarations.$inferInsert> = {}, items: Omit<Item, 'officeId' | 'declarationId'>[] = []) {
  const [d] = await env.ctx.db.insert(declarations).values({ officeId, customerId, exerciseYear: year, stage: 'transmitted', substatus: 'ecac_processed', taxation: 'complete', ...data }).returning();
  if (items.length) await env.ctx.db.insert(declarationItems).values(items.map((i) => ({ ...i, officeId, declarationId: d.id })));
  return d;
}

/** Linhas de um ano: salário, aplicação, despesa médica, imóvel e conta crescendo ano a ano. */
const yearItems = (k: number): Omit<Item, 'officeId' | 'declarationId'>[] => [
  { kind: 'income_pj', counterpartyName: 'Empresa Alfa Ltda', counterpartyDoc: '11222333000181', valueCents: 10_000_000 + k * 500_000, withheldCents: 1_200_000, extra: { officialPensionCents: 900_000 } },
  { kind: 'income_exempt', description: 'Rendimento de poupança', valueCents: 150_000 },
  { kind: 'payment', counterpartyName: 'Clínica Saúde', counterpartyDoc: '11144477735', valueCents: 600_000, extra: { nature: 'health' } },
  { kind: 'asset', groupCode: '01', description: 'Apartamento em BH', prevValueCents: 40_000_000, valueCents: 40_000_000 },
  { kind: 'asset', groupCode: '06', description: 'Conta corrente Banco X', prevValueCents: 1_000_000 + k * 2_000_000, valueCents: 3_000_000 + k * 2_000_000 },
  { kind: 'debt', description: 'Financiamento imobiliário', prevValueCents: 12_000_000 - k * 1_000_000, valueCents: 11_000_000 - k * 1_000_000 },
];

async function readXlsx(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe('relatórios individuais', () => {
  it('avisa sem linhas, salva outros gastos e gera PDF e Excel com histórico de 5 anos', async () => {
    const { api, officeId } = await registerOffice(env, 'Contábil Relatórios');
    const cid = await newCustomer(api, 0, 'Marcos Andrade');
    const resolved = await api.get(`/api/reports/declaration?customerId=${cid}&year=2026`);
    expect(resolved.status).toBe(200);
    const id = resolved.body.declarationId;
    const ctx0 = await api.get(`/api/declarations/${id}/reports`);
    expect(ctx0.body.itemsCount).toBe(0);
    expect(ctx0.body.spouse.available).toBe(false);
    expect(ctx0.body.reports).toHaveLength(7);
    const empty = await api.post(`/api/declarations/${id}/reports/generate`, { reports: ['cash_analysis'], format: 'pdf' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/não tem linhas/);

    // 4 anos anteriores + o atual
    for (let y = 2022; y <= 2025; y++) await declaration(officeId, cid, y, {}, yearItems(y - 2022));
    await env.ctx.db.insert(declarationItems).values(yearItems(4).map((i) => ({ ...i, officeId, declarationId: id })));

    const saved = await api.put(`/api/declarations/${id}/other-expenses`, { annualPaymentCents: 120_000, interestCents: 30_000, creditCardCents: 0 });
    expect(saved.status).toBe(200);
    expect(saved.body.otherExpenses).toEqual({ annualPaymentCents: 120_000, interestCents: 30_000 });
    expect((await api.get(`/api/declarations/${id}/reports`)).body.declaration.otherExpenses.interestCents).toBe(30_000);

    const all = ['cash_analysis', 'cash_details', 'patrimony_history', 'cash_history', 'fine_mesh', 'tax_planning', 'assets'];
    const pdf = await api.post(`/api/declarations/${id}/reports/generate`, { reports: all, format: 'pdf' });
    expect(pdf.status).toBe(200);
    expect(pdf.raw.headers['content-type']).toBe('application/pdf');
    expect(pdf.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(String(pdf.raw.headers['content-disposition'])).toContain('relatorios-irpf-2026-marcos-andrade.pdf');

    const xlsx = await api.post(`/api/declarations/${id}/reports/generate`, { reports: ['patrimony_history', 'cash_analysis'], format: 'xlsx' });
    expect(xlsx.status).toBe(200);
    const wb = await readXlsx(xlsx.raw.rawPayload);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Análise de caixa', 'Histórico patrimonial']);
    const values = (name: string) => {
      const out: unknown[][] = [];
      wb.getWorksheet(name)!.eachRow((r) => out.push((r.values as unknown[]).slice(1)));
      return out;
    };
    const hist = values('Histórico patrimonial');
    const table = hist.filter((r) => typeof r[0] === 'string' && /^20\d\d$/.test(r[0] as string) && r.length >= 4);
    expect(table.map((r) => r[0])).toEqual(['2022', '2023', '2024', '2025', '2026']);
    // patrimônio líquido de 2026: 400k + 110k - 70k = 440k
    expect(table[4][3]).toBe(440_000);
    const cash = values('Análise de caixa');
    expect(cash.find((r) => r[0] === 'Outros gastos (juros de financiamentos, cartão, perdas)')![1]).toBe(300);
  });

  it('exige a permissão de cada relatório e isola por escritório', async () => {
    const a = await registerOffice(env);
    const cid = await newCustomer(a.api, 1, 'Nadia Costa');
    const d = await declaration(a.officeId, cid, 2026, {}, yearItems(0));
    const emp = await createEmployee(env, a.api, ['report.cash_analysis']);
    expect((await emp.api.post(`/api/declarations/${d.id}/reports/generate`, { reports: ['cash_analysis'] })).status).toBe(200);
    const denied = await emp.api.post(`/api/declarations/${d.id}/reports/generate`, { reports: ['cash_analysis', 'fine_mesh'] });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/malha fina/);
    const ctx = await emp.api.get(`/api/declarations/${d.id}/reports`);
    expect(ctx.body.reports.find((r: any) => r.key === 'fine_mesh').allowed).toBe(false);
    expect((await emp.api.get(`/api/declarations/${d.id}/kit.pdf`)).status).toBe(403);
    const none = await createEmployee(env, a.api, ['customer.list']);
    expect((await none.api.get(`/api/declarations/${d.id}/reports`)).status).toBe(403);
    expect((await none.api.put(`/api/declarations/${d.id}/other-expenses`, { interestCents: 1 })).status).toBe(403);

    const b = await registerOffice(env);
    expect((await b.api.get(`/api/declarations/${d.id}/reports`)).status).toBe(404);
    expect((await b.api.post(`/api/declarations/${d.id}/reports/generate`, { reports: ['cash_analysis'] })).status).toBe(404);
    expect((await b.api.get(`/api/declarations/${d.id}/kit.pdf`)).status).toBe(404);
    expect((await b.api.get(`/api/reports/declaration?customerId=${cid}&year=2026`)).status).toBe(404);
  });

  it('salvar outros gastos atualiza o saldo de caixa gravado (alerta do dashboard)', async () => {
    const { api, officeId } = await registerOffice(env);
    const cid = await newCustomer(api, 4, 'Olga Prado');
    const d = await declaration(officeId, cid, 2026, {}, yearItems(0));
    const stored = async () => (await env.ctx.db.query.declarations.findFirst({ where: (t, { eq }) => eq(t.id, d.id) }))!.cashBalanceCents;
    expect(await stored()).toBeNull();

    const one = await api.put(`/api/declarations/${d.id}/other-expenses`, { creditCardCents: 100_000 });
    expect(one.status).toBe(200);
    expect(one.body.cashBalanceCents).not.toBeNull();
    expect(await stored()).toBe(one.body.cashBalanceCents);
    // mais outros gastos (aplicações) baixam o saldo na mesma medida
    const two = await api.put(`/api/declarations/${d.id}/other-expenses`, { creditCardCents: 300_000 });
    expect(two.body.cashBalanceCents).toBe(one.body.cashBalanceCents - 200_000);
    expect(await stored()).toBe(two.body.cashBalanceCents);
    expect((await api.get(`/api/declarations/${d.id}/cash-analysis`)).body.balanceCents).toBe(two.body.cashBalanceCents);
  });

  it('inclui o cônjuge quando ele também é cliente', async () => {
    const { api, officeId } = await registerOffice(env);
    const holder = await newCustomer(api, 2, 'Otávio Prado');
    const spouse = await newCustomer(api, 3, 'Paula Prado');
    const d = await declaration(officeId, holder, 2026, {}, [...yearItems(1), { kind: 'dependent', counterpartyName: 'Paula Prado', counterpartyDoc: VALID_CPFS[3], extra: { relationship: 'spouse' } }]);
    const ctx = await api.get(`/api/declarations/${d.id}/reports`);
    expect(ctx.body.spouse.available).toBe(false);
    expect(ctx.body.spouse.reason).toMatch(/não tem declaração/);
    expect((await api.post(`/api/declarations/${d.id}/reports/generate`, { reports: ['cash_analysis'], includeSpouse: true })).status).toBe(400);

    const sd = await declaration(officeId, spouse, 2026, {}, yearItems(2));
    const ctx2 = await api.get(`/api/declarations/${d.id}/reports`);
    expect(ctx2.body.spouse).toMatchObject({ available: true, name: 'Paula Prado' });
    // o vínculo vale também a partir da declaração da cônjuge
    expect((await api.get(`/api/declarations/${sd.id}/reports`)).body.spouse).toMatchObject({ available: true, name: 'Otávio Prado' });

    const x = await api.post(`/api/declarations/${d.id}/reports/generate`, { reports: ['cash_analysis', 'patrimony_history'], includeSpouse: true, format: 'xlsx' });
    expect(x.status).toBe(200);
    const wb = await readXlsx(x.raw.rawPayload);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Análise de caixa',
      'Análise de caixa (cônjuge)',
      'Caixa do casal',
      'Histórico patrimonial',
      'Hist. patrimonial (cônjuge)',
      'Patrimônio do casal',
    ]);
    const pdf = await api.post(`/api/declarations/${d.id}/reports/generate`, { reports: ['cash_analysis', 'fine_mesh'], includeSpouse: true });
    expect(pdf.status).toBe(200);
  });

  it('envia os relatórios por e-mail com anexo, sem duplicar', async () => {
    const { api, officeId } = await registerOffice(env);
    const cid = await newCustomer(api, 4, 'Quésia Lopes');
    const noMail = await newCustomer(api, 5, 'Rafael Sem', null);
    const d = await declaration(officeId, cid, 2026, {}, yearItems(0));
    const d2 = await declaration(officeId, noMail, 2026, {}, yearItems(0));
    const requestId = uuid();
    const body = { reports: ['cash_analysis', 'fine_mesh'], format: 'pdf', channels: ['email', 'whatsapp'], requestId };
    const sent = await api.post(`/api/declarations/${d.id}/reports/send`, body);
    expect(sent.status).toBe(200);
    expect(sent.body.queued).toBe(1);
    expect(sent.body.skipped).toEqual([{ channel: 'whatsapp', reason: 'O cliente não tem celular cadastrado.' }]);
    const again = await api.post(`/api/declarations/${d.id}/reports/send`, body);
    expect(again.body).toMatchObject({ queued: 0, alreadyQueued: 1 });
    await env.ctx.jobs.drain();
    const emails = env.providers.sentEmails.filter((e) => e.officeId === officeId);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe('c4@ex.com');
    expect(emails[0].attachments?.[0].filename).toBe('relatorios-irpf-2026-quesia-lopes.pdf');
    expect((await api.post(`/api/declarations/${d2.id}/reports/send`, { ...body, channels: ['email'], requestId: uuid() })).status).toBe(400);
  });

  it('baixa o kit pós-declaração em PDF', async () => {
    const { api, officeId } = await registerOffice(env);
    const cid = await newCustomer(api, 6, 'Sílvia Kit');
    const d = await declaration(officeId, cid, 2026, { refundCents: 250_000, refundLotDate: '2026-07-31', receiptNumber: '11.22.33.44.55-66' }, yearItems(3));
    const res = await api.get(`/api/declarations/${d.id}/kit.pdf`);
    expect(res.status).toBe(200);
    expect(res.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(String(res.raw.headers['content-disposition'])).toContain('kit-pos-declaracao-2026-silvia-kit.pdf');
    const viewer = await createEmployee(env, api, ['declaration.view']);
    expect((await viewer.api.get(`/api/declarations/${d.id}/kit.pdf`)).status).toBe(200);
  });
});

describe('relatórios gerais', () => {
  it('resultados: filtra a pagar/restituir/sem saldo, soma e exporta', async () => {
    const { api, officeId } = await registerOffice(env);
    const a = await newCustomer(api, 0, 'Alice Paga');
    const b = await newCustomer(api, 1, 'Beto Restitui');
    const c = await newCustomer(api, 2, 'Caio Zero');
    const n = await newCustomer(api, 3, 'Davi Não Iniciado');
    await declaration(officeId, a, 2026, { taxDueCents: 100_000 });
    await declaration(officeId, b, 2026, { refundCents: 250_000 });
    await declaration(officeId, c, 2026, {});
    await declaration(officeId, n, 2026, { stage: 'not_started', substatus: 'not_started' });
    await declaration(officeId, a, 2025, { taxDueCents: 999_999 });

    const all = await api.get('/api/reports/results?year=2026');
    expect(all.body.totals).toMatchObject({ count: 3, taxDueCents: 100_000, refundCents: 250_000, payable: 1, refundable: 1, neutral: 1 });
    expect((await api.get('/api/reports/results?year=2026&payable=true')).body.rows.map((r: any) => r.name)).toEqual(['Alice Paga']);
    expect((await api.get('/api/reports/results?year=2026&refundable=true&neutral=true')).body.rows.map((r: any) => r.name)).toEqual(['Beto Restitui', 'Caio Zero']);
    const x = await api.get('/api/reports/results?year=2026&format=xlsx');
    const wb = await readXlsx(x.raw.rawPayload);
    expect(wb.worksheets[0].rowCount).toBe(5);

    const other = await registerOffice(env);
    expect((await other.api.get('/api/reports/results?year=2026')).body.totals.count).toBe(0);
    const emp = await createEmployee(env, api, ['report.refund']);
    expect((await emp.api.get('/api/reports/results?year=2026')).status).toBe(403);
  });

  it('documentos faltantes: só abertos, vencidos opcionais, agrupados por cliente', async () => {
    const { api, officeId, userId } = await registerOffice(env);
    const a = await newCustomer(api, 4, 'Eva Pendente');
    const b = await newCustomer(api, 5, 'Fábio Pendente');
    const da = await declaration(officeId, a, 2026, { stage: 'filling', substatus: 'missing_documents' });
    const db2 = await declaration(officeId, b, 2026, { stage: 'filling', substatus: 'missing_documents' });
    await env.ctx.db.insert(backlogs).values([
      { officeId, customerId: a, declarationId: da.id, description: 'Informe do banco', dueDate: '2020-01-10', createdByUserId: userId },
      { officeId, customerId: a, declarationId: da.id, description: 'Recibo médico', dueDate: '2099-12-31' },
      { officeId, customerId: a, declarationId: da.id, description: 'Já entregue', dueDate: '2020-01-10', resolvedAt: new Date() },
      { officeId, customerId: b, declarationId: db2.id, description: 'Escritura', dueDate: '2021-03-01' },
    ]);
    const all = await api.get('/api/reports/backlogs?year=2026');
    expect(all.body.totals).toMatchObject({ customers: 2, items: 3, overdue: 2 });
    expect(all.body.groups[0].name).toBe('Eva Pendente');
    expect(all.body.groups[0].items).toHaveLength(2);
    const overdue = await api.get('/api/reports/backlogs?overdueOnly=true');
    expect(overdue.body.totals.items).toBe(2);
    expect(overdue.body.groups.map((g: any) => g.items.length)).toEqual([1, 1]);
    expect(overdue.body.groups[0].items[0].overdueDays).toBeGreaterThan(1000);
    const x = await api.get('/api/reports/backlogs?overdueOnly=true&format=xlsx');
    expect(x.status).toBe(200);
    expect((await readXlsx(x.raw.rawPayload)).worksheets[0].rowCount).toBe(3);
    const emp = await createEmployee(env, api, ['report.results']);
    expect((await emp.api.get('/api/reports/backlogs')).status).toBe(403);
  });

  it('restituição: só futuras e ordenação por data ou nome', async () => {
    const { api, officeId } = await registerOffice(env);
    const ids = [await newCustomer(api, 6, 'Zeca Futuro'), await newCustomer(api, 7, 'Ana Paga'), await newCustomer(api, 0, 'Bia Sem Lote'), await newCustomer(api, 1, 'Caio Cedo')];
    await declaration(officeId, ids[0], 2026, { refundCents: 100_000, refundLotDate: '2099-06-30' });
    await declaration(officeId, ids[1], 2026, { refundCents: 200_000, refundLotDate: '2026-05-30', refundPaidAt: '2026-05-30' });
    await declaration(officeId, ids[2], 2026, { refundCents: 300_000 });
    await declaration(officeId, ids[3], 2026, { refundCents: 400_000, refundLotDate: '2098-05-30' });
    const byDate = await api.get('/api/reports/refunds?year=2026');
    expect(byDate.body.rows.map((r: any) => r.name)).toEqual(['Ana Paga', 'Caio Cedo', 'Zeca Futuro', 'Bia Sem Lote']);
    expect(byDate.body.totals).toMatchObject({ count: 4, refundCents: 1_000_000, paid: 1 });
    const future = await api.get('/api/reports/refunds?year=2026&futureOnly=true&sort=name');
    expect(future.body.rows.map((r: any) => r.name)).toEqual(['Bia Sem Lote', 'Caio Cedo', 'Zeca Futuro']);
    expect(future.body.rows[0].situation).toBe('waiting');
    const x = await api.get('/api/reports/refunds?year=2026&format=xlsx');
    expect(String(x.raw.headers['content-disposition'])).toContain('restituicoes-2026.xlsx');
    const emp = await createEmployee(env, api, ['report.results']);
    expect((await emp.api.get('/api/reports/refunds?year=2026')).status).toBe(403);
  });
});
