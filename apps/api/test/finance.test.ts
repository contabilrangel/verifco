import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { addMonthsIso, todayIso } from '@verifco/shared';
import { billings, budgets, contracts, customers, declarations, importBatches, installments, jobs } from '../src/db/schema';
import { signCustomerToken } from '../src/plugins/auth';
import { buildWorkbook } from '../src/services/xlsx';
import { VALID_CPFS, client, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const today = () => todayIso();

async function setup(name = 'Escritório Financeiro') {
  const office = await registerOffice(env, name);
  const { api } = office;
  const methods = (await api.get('/api/finance/payment-methods')).body as { id: string; type: string; name: string; maxInstallments: number; isDefault: boolean }[];
  const pix = methods.find((m) => m.type === 'pix')!;
  const boleto = methods.find((m) => m.type === 'boleto')!;
  const c = await api.post('/api/customers', { name: 'Maria Cliente', cpfCnpj: VALID_CPFS[0], email: 'maria@cliente.com' });
  await api.put(`/api/customers/${c.body.id}/identification`, { name: 'Maria Cliente', email: 'maria@cliente.com', mobile: '11987654321' });
  return { ...office, pix, boleto, customerId: c.body.id as string };
}

async function createBudget(api: Api, customerId: string, extra: Record<string, unknown> = {}) {
  return api.post('/api/finance/budgets', { customerId, exerciseYear: 2026, type: 'fixed', category: 'irpf', amountCents: 60_000, ...extra });
}

/** Envia por e-mail e devolve o token do link de aprovação. */
async function sendAndGetToken(api: Api, budgetId: string) {
  const res = await api.post(`/api/finance/budgets/${budgetId}/send`, { channels: ['email'] });
  expect(res.status).toBe(200);
  return { token: new URL(res.body.link).pathname.split('/').pop()!, res };
}

const pub = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  env.app.inject({ method, url, payload: payload as never }).then((r) => ({ status: r.statusCode, body: r.json() }));

function multipart(fields: Record<string, string>, file: { name: string; data: Buffer; type: string }) {
  const boundary = `----vf${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('métodos de pagamento', () => {
  it('CRUD com um único padrão e exclusão bloqueada quando em uso', async () => {
    const { api, pix, customerId } = await setup();
    const created = await api.post('/api/finance/payment-methods', { type: 'credit_card', name: 'Cartão 12x', maxInstallments: 12, isDefault: true });
    expect(created.status).toBe(201);
    let list = (await api.get('/api/finance/payment-methods')).body as { id: string; isDefault: boolean }[];
    expect(list.filter((m) => m.isDefault).map((m) => m.id)).toEqual([created.body.id]);

    await api.put(`/api/finance/payment-methods/${pix.id}`, { type: 'pix', name: 'Pix', maxInstallments: 1, active: true, isDefault: true });
    list = (await api.get('/api/finance/payment-methods')).body;
    expect(list.filter((m) => m.isDefault).map((m) => m.id)).toEqual([pix.id]);

    expect((await api.post('/api/finance/payment-methods', { type: 'pix', name: 'X', maxInstallments: 0 })).status).toBe(400);
    expect((await api.post('/api/finance/payment-methods', { type: 'pix', name: 'Inativo', maxInstallments: 1, active: false, isDefault: true })).status).toBe(400);

    await createBudget(api, customerId, { paymentMethodId: created.body.id, installments: 10 });
    expect((await api.del(`/api/finance/payment-methods/${created.body.id}`)).status).toBe(409);
    const other = await api.post('/api/finance/payment-methods', { type: 'cash', name: 'Dinheiro', maxInstallments: 1 });
    expect((await api.del(`/api/finance/payment-methods/${other.body.id}`)).status).toBe(200);
  });
});

describe('tabelas de cobrança', () => {
  it('valida os campos de cada tipo e mantém uma única padrão', async () => {
    const { api } = await setup();
    const base = { name: 'Tabela', validFrom: '2026-01-01' };
    expect((await api.post('/api/finance/price-tables', { ...base, type: 'fixed', config: {} })).status).toBe(400);
    expect((await api.post('/api/finance/price-tables', { ...base, type: 'percentage', config: { percent: 5 } })).status).toBe(400);
    expect((await api.post('/api/finance/price-tables', { ...base, type: 'items', config: { items: [] } })).status).toBe(400);
    expect((await api.post('/api/finance/price-tables', { ...base, type: 'fixed', validUntil: '2025-12-31', config: { amountCents: 100 } })).status).toBe(400);

    const pct = await api.post('/api/finance/price-tables', {
      ...base,
      type: 'percentage',
      isDefault: true,
      config: { percent: 2, base: 'tax_due', minCents: 30_000, maxCents: 200_000, amountCents: 999 },
    });
    expect(pct.status).toBe(201);
    expect(pct.body.config).toEqual({ percent: 2, base: 'tax_due', minCents: 30_000, maxCents: 200_000 });
    const list = (await api.get('/api/finance/price-tables')).body as { id: string; isDefault: boolean; validNow: boolean }[];
    expect(list.filter((t) => t.isDefault).map((t) => t.id)).toEqual([pct.body.id]);

    const sim = await api.post(`/api/finance/price-tables/${pct.body.id}/simulate`, { totals: { taxDueCents: 5_000_000 } });
    expect(sim.body).toMatchObject({ ok: true, amountCents: 100_000 });

    const items = await api.post('/api/finance/price-tables', {
      ...base,
      type: 'items',
      config: { items: [{ code: 'dep', label: 'Dependente', unitPriceCents: 5_000 }, { code: 'DEP', label: 'Repetido', unitPriceCents: 1 }] },
    });
    expect(items.status).toBe(400);
  });
});

describe('orçamentos', () => {
  it('calcula total com desconto, limita parcelas ao método e mostra o ano anterior', async () => {
    const { api, customerId, pix, boleto } = await setup();
    const prev = await api.post('/api/finance/budgets', { customerId, exerciseYear: 2025, amountCents: 45_000, status: 'approved' });
    expect(prev.status).toBe(201);
    expect(prev.body.billing.installments).toHaveLength(1);

    expect((await createBudget(api, customerId, { paymentMethodId: pix.id, installments: 2 })).status).toBe(400);
    expect((await createBudget(api, customerId, { amountCents: 0 })).status).toBe(400);
    const b = await createBudget(api, customerId, { paymentMethodId: boleto.id, installments: 3, discountPercent: 12.5, internalNote: 'cliente antigo' });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ amountCents: 60_000, discountPercent: 12.5, totalCents: 52_500, status: 'draft', paymentMethodName: 'Boleto' });

    const list = await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.previous).toMatchObject({ exerciseYear: 2025, totalCents: 45_000, status: 'approved' });

    // orçamento integrado exige método Asaas/Omie
    expect((await createBudget(api, customerId, { type: 'integration', paymentMethodId: boleto.id })).status).toBe(400);
  });

  it('variável usa a tabela vigente e os dados da declaração do ano', async () => {
    const { api, customerId, officeId } = await setup();
    const table = await api.post('/api/finance/price-tables', {
      name: 'Percentual do imposto',
      type: 'percentage',
      validFrom: '2026-01-01',
      config: { percent: 3, base: 'tax_due', minCents: 25_000 },
    });
    const quoteMin = await api.post('/api/finance/budgets/quote', { customerId, exerciseYear: 2026, priceTableId: table.body.id });
    expect(quoteMin.body).toMatchObject({ ok: true, amountCents: 25_000, adjustment: 'min' });

    await env.ctx.db
      .update(declarations)
      .set({ taxDueCents: 1_234_567 })
      .where(and(eq(declarations.customerId, customerId), eq(declarations.officeId, officeId)));
    const quote = await api.post('/api/finance/budgets/quote', { customerId, exerciseYear: 2026, priceTableId: table.body.id });
    expect(quote.body).toMatchObject({ ok: true, amountCents: 37_037, baseCents: 1_234_567 });

    // o valor enviado pelo navegador é ignorado no orçamento variável
    const b = await createBudget(api, customerId, { type: 'variable', priceTableId: table.body.id, amountCents: 1 });
    expect(b.status).toBe(201);
    expect(b.body.amountCents).toBe(37_037);
    expect(b.body.priceTableName).toBe('Percentual do imposto');

    const expired = await api.post('/api/finance/price-tables', { name: 'Antiga', type: 'fixed', validFrom: '2024-01-01', validUntil: '2024-12-31', config: { amountCents: 100 } });
    const r = await createBudget(api, customerId, { type: 'variable', priceTableId: expired.body.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('venceu');
    expect((await createBudget(api, customerId, { type: 'variable' })).status).toBe(400);
  });

  it('envio, aprovação pelo link e faturamento único com parcelas mensais', async () => {
    const { api, customerId, boleto, officeId } = await setup();
    const start = addMonthsIso(today(), 1);
    const b = await createBudget(api, customerId, { paymentMethodId: boleto.id, installments: 3, billingStartDate: start, amountCents: 100_000, description: 'Declaração completa', internalNote: 'segredo interno' });
    const { token } = await sendAndGetToken(api, b.body.id);

    const decl = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, customerId) });
    expect(decl?.substatus).toBe('budget_sent');
    await env.ctx.jobs.drain();
    const mail = env.providers.sentEmails.find((m) => m.to === 'maria@cliente.com' && m.html.includes(token));
    expect(mail?.html).toContain(`/orcamento/${token}`);

    const view = await pub('GET', `/api/public/budgets/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.budget).toMatchObject({ status: 'sent', totalCents: 100_000, installments: 3, paymentMethod: 'Boleto', categoryLabel: 'Declaração IRPF' });
    expect(view.body.budget.installmentAmounts).toEqual([33_334, 33_333, 33_333]);
    expect(JSON.stringify(view.body)).not.toContain('segredo interno');
    expect((await pub('GET', '/api/public/budgets/token-que-nao-existe-123456')).status).toBe(404);

    // aprovações concorrentes geram um único faturamento
    const [a1, a2] = await Promise.all([pub('POST', `/api/public/budgets/${token}/approve`), pub('POST', `/api/public/budgets/${token}/approve`)]);
    expect([a1.status, a2.status]).toEqual([200, 200]);
    expect((await pub('POST', `/api/public/budgets/${token}/approve`)).status).toBe(200);
    const bills = await env.ctx.db.select().from(billings).where(eq(billings.budgetId, b.body.id));
    expect(bills).toHaveLength(1);
    const insts = await env.ctx.db.select().from(installments).where(eq(installments.billingId, bills[0].id));
    expect(insts.map((i) => [i.number, i.dueDate, i.amountCents]).sort()).toEqual([
      [1, start, 33_334],
      [2, addMonthsIso(start, 1), 33_333],
      [3, addMonthsIso(start, 2), 33_333],
    ]);

    const after = await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`);
    expect(after.body.data[0]).toMatchObject({ status: 'approved', approvedBy: 'Cliente (link de aprovação)', paymentStatus: 'open' });
    expect(after.body.data[0].billing.openCents).toBe(100_000);
    const decl2 = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, customerId) });
    expect(decl2?.substatus).toBe('budget_approved');
    const notes = await env.ctx.db.query.notifications.findMany({ where: (t, { eq: e }) => e(t.officeId, officeId) });
    expect(notes.some((n) => n.title.includes('aprovado'))).toBe(true);

    expect((await pub('POST', `/api/public/budgets/${token}/reject`)).status).toBe(409);
    expect((await api.del(`/api/finance/budgets/${b.body.id}`)).status).toBe(409);
    expect((await api.put(`/api/finance/budgets/${b.body.id}`, { status: 'draft', amountCents: 1 })).status).toBe(409);
    const note = await api.put(`/api/finance/budgets/${b.body.id}`, { status: 'approved', internalNote: 'nova observação', amountCents: 1 });
    expect(note.body).toMatchObject({ internalNote: 'nova observação', amountCents: 100_000 });
  });

  it('recusa pelo link, novo envio invalida o link anterior e o link expira em 30 dias', async () => {
    const { api, customerId } = await setup();
    const b = await createBudget(api, customerId);
    const first = await sendAndGetToken(api, b.body.id);
    const second = await sendAndGetToken(api, b.body.id);
    expect((await pub('GET', `/api/public/budgets/${first.token}`)).status).toBe(404);

    const rej = await pub('POST', `/api/public/budgets/${second.token}/reject`, { reason: 'Achei caro' });
    expect(rej.status).toBe(200);
    expect(rej.body.budget.status).toBe('rejected');
    expect((await pub('POST', `/api/public/budgets/${second.token}/approve`)).status).toBe(409);

    const third = await sendAndGetToken(api, b.body.id);
    await env.ctx.db.update(budgets).set({ sentAt: new Date(Date.now() - 31 * 86400_000) }).where(eq(budgets.id, b.body.id));
    expect((await pub('GET', `/api/public/budgets/${third.token}`)).status).toBe(410);
    expect((await pub('POST', `/api/public/budgets/${third.token}/approve`)).status).toBe(410);

    // rascunho pode ser excluído
    expect((await api.del(`/api/finance/budgets/${b.body.id}`)).status).toBe(200);
  });

  it('só o orçamento IRPF move a declaração; recusa, cancelamento e exclusão voltam a etapa', async () => {
    const { api, customerId } = await setup();
    const substatus = async () => (await api.get(`/api/customers/${customerId}/declarations/2026`)).body.substatus;

    // consultoria enviada e aprovada não tira a declaração IRPF de "Não iniciado"
    const consulting = await createBudget(api, customerId, { category: 'consulting' });
    await sendAndGetToken(api, consulting.body.id);
    expect(await substatus()).toBe('not_started');
    expect((await api.post(`/api/finance/budgets/${consulting.body.id}/approve`)).status).toBe(200);
    expect(await substatus()).toBe('not_started');

    // IRPF enviado → "Orçamento enviado"; recusado pelo cliente → volta para "Não iniciado"
    const irpf = await createBudget(api, customerId);
    const { token } = await sendAndGetToken(api, irpf.body.id);
    expect(await substatus()).toBe('budget_sent');
    expect((await pub('POST', `/api/public/budgets/${token}/reject`)).status).toBe(200);
    expect(await substatus()).toBe('not_started');

    // com outro orçamento IRPF enviado, cancelar um mantém a etapa; excluir o último a volta
    const rectification = await createBudget(api, customerId, { category: 'irpf_rectification' });
    const again = await createBudget(api, customerId);
    await sendAndGetToken(api, rectification.body.id);
    await sendAndGetToken(api, again.body.id);
    expect(await substatus()).toBe('budget_sent');
    const canceled = await api.put(`/api/finance/budgets/${rectification.body.id}`, { category: 'irpf_rectification', amountCents: 60_000, status: 'canceled' });
    expect(canceled.body.status).toBe('canceled');
    expect(await substatus()).toBe('budget_sent');
    expect((await api.del(`/api/finance/budgets/${again.body.id}`)).status).toBe(200);
    expect(await substatus()).toBe('not_started');
  });

  it('enviar ao salvar exige contato do cliente e permissão de envio', async () => {
    const { api } = await setup();
    const semEmail = await api.post('/api/customers', { name: 'Sem Email', cpfCnpj: VALID_CPFS[1] });
    const r = await createBudget(api, semEmail.body.id, { sendEmail: true });
    expect(r.status).toBe(400);
    expect((await api.get(`/api/finance/customers/${semEmail.body.id}/budgets?year=2026`)).body.data).toHaveLength(0);
  });

  it('marcar como enviado sem envio devolve o link de aprovação', async () => {
    const { api, customerId } = await setup();
    const b = await createBudget(api, customerId, { status: 'sent' });
    expect(b.status).toBe(201);
    expect(b.body.status).toBe('sent');
    const token = new URL(b.body.link).pathname.split('/').pop()!;
    expect((await pub('GET', `/api/public/budgets/${token}`)).body.budget.status).toBe('sent');
    expect(env.providers.sentEmails.some((m) => m.html.includes(token))).toBe(false);
  });

  it('método Asaas enfileira a sincronização externa do faturamento', async () => {
    const { api, customerId } = await setup();
    const asaas = await api.post('/api/finance/payment-methods', { type: 'asaas', name: 'Boleto Asaas', maxInstallments: 6 });
    const b = await createBudget(api, customerId, { type: 'integration', paymentMethodId: asaas.body.id, installments: 2 });
    expect(b.status).toBe(201);
    const ok = await api.post(`/api/finance/budgets/${b.body.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.billing.provider).toBe('asaas');
    const job = await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'billing.sync_external'), eq(jobs.idempotencyKey, ok.body.billing.id)) });
    expect(job?.payload).toEqual({ billingId: ok.body.billing.id });
    // aprovar de novo não duplica nada
    await api.post(`/api/finance/budgets/${b.body.id}/approve`);
    const all = await env.ctx.db.select().from(jobs).where(eq(jobs.type, 'billing.sync_external'));
    expect(all.filter((j) => j.idempotencyKey === ok.body.billing.id)).toHaveLength(1);
    // link externo aparece na parcela quando o módulo de integrações grava
    await env.ctx.db.update(installments).set({ externalId: 'pay_1', externalUrl: 'https://pagar.exemplo/1' }).where(eq(installments.billingId, ok.body.billing.id));
    const list = await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`);
    expect(list.body.data[0].billing.installments[0].externalUrl).toBe('https://pagar.exemplo/1');
    const inst = list.body.data[0].billing.installments[0];
    // com a integração ativa, o valor da cobrança emitida só muda no provedor (INT-10)
    await api.put('/api/integrations/asaas', { enabled: true, config: { environment: 'sandbox' }, secrets: { apiKey: '$aact_hmlg_abc123456789' } });
    expect((await api.put(`/api/finance/installments/${inst.id}`, { amountCents: 1 })).status).toBe(409);
  });
});

describe('faturamento e recibos', () => {
  it('edita parcelas, registra recebimento, calcula vencidas e numera recibos', async () => {
    const { api, customerId, boleto } = await setup();
    const start = addMonthsIso(today(), -2);
    const b = await createBudget(api, customerId, { paymentMethodId: boleto.id, installments: 3, billingStartDate: start, amountCents: 90_000, status: 'approved' });
    expect(b.status).toBe(201);
    const [p1, p2, p3] = b.body.billing.installments;
    expect([p1.status, p2.status, p3.status]).toEqual(['overdue', 'overdue', 'open']);
    expect(b.body.billing.overdueCents).toBe(60_000);
    expect(b.body.paymentStatus).toBe('overdue');

    const edit = await api.put(`/api/finance/installments/${p3.id}`, { amountCents: 35_000, dueDate: addMonthsIso(today(), 2) });
    expect(edit.status).toBe(200);
    let list = (await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`)).body.data[0];
    expect(list.billing.totalCents).toBe(95_000);

    expect((await api.post(`/api/finance/installments/${p1.id}/receipt`)).status).toBe(400);
    expect((await api.post(`/api/finance/installments/${p1.id}/receive`, { paidAt: addMonthsIso(today(), 1) })).status).toBe(400);
    expect((await api.post(`/api/finance/installments/${p1.id}/receive`, {})).status).toBe(200);
    expect((await api.post(`/api/finance/installments/${p1.id}/receive`, {})).status).toBe(409);
    expect((await api.put(`/api/finance/installments/${p1.id}`, { amountCents: 1 })).status).toBe(409);
    await api.post(`/api/finance/installments/${p2.id}/receive`, { paidAt: today(), paidAmountCents: 29_000 });

    const r1 = await api.post(`/api/finance/installments/${p1.id}/receipt`);
    expect(r1.body.receiptNumber).toBe(1);
    const r2 = await api.post(`/api/finance/installments/${p2.id}/receipt`);
    expect(r2.body.receiptNumber).toBe(2);
    const again = await api.post(`/api/finance/installments/${p1.id}/receipt`);
    expect(again.body.receiptNumber).toBe(1);
    // o recibo gerado de novo substitui o arquivo; /files só entrega o recibo atual da parcela
    const pdf = await api.get(`/api/files/${again.body.fileId}`);
    expect(pdf.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect((await api.post(`/api/finance/installments/${p1.id}/reopen`)).status).toBe(409);

    list = (await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`)).body.data[0];
    expect(list.billing).toMatchObject({ paidCents: 59_000, overdueCents: 0, openCents: 35_000 });
    expect(list.paymentStatus).toBe('open');

    // duas vias e sem detalhamento continuam gerando o PDF com o mesmo número
    await api.put('/api/office/settings', { receiptTwoCopies: true, receiptShowDetails: false });
    expect((await api.post(`/api/finance/installments/${p2.id}/receipt`)).body.receiptNumber).toBe(2);

    // numeração é por escritório
    const other = await setup('Outro escritório');
    const ob = await createBudget(other.api, other.customerId, { status: 'approved' });
    const oi = ob.body.billing.installments[0];
    await other.api.post(`/api/finance/installments/${oi.id}/receive`, {});
    expect((await other.api.post(`/api/finance/installments/${oi.id}/receipt`)).body.receiptNumber).toBe(1);
  });

  it('envia o recibo por e-mail com o PDF anexo', async () => {
    const { api, customerId } = await setup();
    const b = await createBudget(api, customerId, { status: 'approved', amountCents: 123_456 });
    const inst = b.body.billing.installments[0];
    expect((await api.post(`/api/finance/installments/${inst.id}/receipt/send`, { channel: 'email' })).status).toBe(400);
    await api.post(`/api/finance/installments/${inst.id}/receive`, {});
    const sent = await api.post(`/api/finance/installments/${inst.id}/receipt/send`, { channel: 'email' });
    expect(sent.status).toBe(200);
    expect(sent.body.receiptNumber).toBe(1);
    await env.ctx.jobs.drain();
    const mail = env.providers.sentEmails.filter((m) => m.to === 'maria@cliente.com').at(-1)!;
    expect(mail.attachments?.[0].filename).toBe('recibo-1.pdf');
    expect(mail.html).toContain('mil duzentos e trinta e quatro reais e cinquenta e seis centavos');
    const wa = await api.post(`/api/finance/installments/${inst.id}/receipt/send`, { channel: 'whatsapp' });
    expect(wa.status).toBe(200);
    await env.ctx.jobs.drain();
    expect(env.providers.sentWhatsApp.at(-1)?.document?.filename).toBe('recibo-1.pdf');
    const list = (await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`)).body.data[0];
    expect(list.billing.installments[0].receiptSentAt).toBeTruthy();
  });

  it('documento de autorização respeita a preferência de orçamento obrigatório', async () => {
    const { api, customerId } = await setup();
    const url = `/api/finance/customers/${customerId}/authorization?year=2026`;
    expect((await api.get(url)).status).toBe(400);
    await api.put('/api/office/settings', { allowAuthorizationWithoutBudget: true });
    const ok = await api.get(url);
    expect(ok.status).toBe(200);
    expect(ok.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    await api.put('/api/office/settings', { allowAuthorizationWithoutBudget: false });
    await createBudget(api, customerId);
    expect((await api.get(url)).status).toBe(200);
    const send = await api.post(`/api/finance/customers/${customerId}/authorization/send`, { year: 2026, channel: 'email' });
    expect(send.status).toBe(200);
    await env.ctx.jobs.drain();
    expect(env.providers.sentEmails.at(-1)?.attachments?.[0].filename).toBe('autorizacao-2026.pdf');
  });
});

describe('portal do cliente', () => {
  it('lista e aprova só os orçamentos enviados do próprio cliente', async () => {
    const { api, customerId, officeId } = await setup();
    const other = await api.post('/api/customers', { name: 'Outro Cliente', cpfCnpj: VALID_CPFS[2], email: 'outro@cliente.com' });
    const draft = await createBudget(api, customerId, { category: 'capital_gain' });
    const sent = await createBudget(api, customerId);
    await sendAndGetToken(api, sent.body.id);
    const otherBudget = await createBudget(api, other.body.id);
    await sendAndGetToken(api, otherBudget.body.id);

    const token = signCustomerToken(env.app, { id: customerId, officeId }, 'portal');
    const portal = client(env, token);
    const list = await portal.get('/api/portal/budgets');
    expect(list.status).toBe(200);
    expect(list.body.map((b: { id: string }) => b.id)).toEqual([sent.body.id]);

    expect((await portal.post(`/api/portal/budgets/${draft.body.id}/approve`)).status).toBe(404);
    expect((await portal.post(`/api/portal/budgets/${otherBudget.body.id}/approve`)).status).toBe(404);
    const ok = await portal.post(`/api/portal/budgets/${sent.body.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect((await portal.post(`/api/portal/budgets/${sent.body.id}/reject`)).status).toBe(409);
    const bills = await env.ctx.db.select().from(billings).where(eq(billings.budgetId, sent.body.id));
    expect(bills).toHaveLength(1);

    const checklistToken = signCustomerToken(env.app, { id: customerId, officeId }, 'checklist');
    expect((await client(env, checklistToken).get('/api/portal/budgets')).status).toBe(401);
    expect((await api.get('/api/portal/budgets')).status).toBe(401);
  });
});

describe('relatório de faturamento', () => {
  it('totaliza e filtra por status de pagamento e parcelas vencidas', async () => {
    const { api, customerId, boleto } = await setup();
    const c2 = await api.post('/api/customers', { name: 'Bruno Pago', cpfCnpj: VALID_CPFS[3] });
    await createBudget(api, customerId, { amountCents: 50_000 });
    const overdue = await createBudget(api, customerId, { category: 'capital_gain', amountCents: 40_000, paymentMethodId: boleto.id, installments: 2, billingStartDate: addMonthsIso(today(), -1), status: 'approved' });
    const paid = await createBudget(api, c2.body.id, { amountCents: 30_000, status: 'approved' });
    await api.post(`/api/finance/installments/${paid.body.billing.installments[0].id}/receive`, {});

    const all = await api.get('/api/finance/reports/billing?year=2026');
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(3);
    expect(all.body.totals).toEqual({ budgetedCents: 120_000, billedCents: 70_000, receivedCents: 30_000, openCents: 40_000, overdueCents: 20_000 });

    expect((await api.get('/api/finance/reports/billing?year=2026&approvedOnly=true')).body.data).toHaveLength(2);
    const od = await api.get('/api/finance/reports/billing?year=2026&overdueOnly=true');
    expect(od.body.data.map((r: { budgetId: string }) => r.budgetId)).toEqual([overdue.body.id]);
    expect((await api.get('/api/finance/reports/billing?year=2026&paymentStatus=paid')).body.data[0].customerName).toBe('Bruno Pago');
    expect((await api.get('/api/finance/reports/billing?year=2026&category=capital_gain')).body.data).toHaveLength(1);

    const x = await api.get('/api/finance/reports/billing.xlsx?year=2026');
    expect(x.status).toBe(200);
    expect(x.raw.headers['content-type']).toContain('spreadsheetml');
  });
});

describe('serialização com índices (DAD-12)', () => {
  it('cada orçamento recebe o próprio faturamento e as próprias parcelas, em ordem, com vários por cliente', async () => {
    const { api, customerId, boleto, pix } = await setup();
    const other = await api.post('/api/customers', { name: 'Olga Outra', cpfCnpj: VALID_CPFS[5] });
    const a = await createBudget(api, customerId, { amountCents: 90_000, paymentMethodId: boleto.id, installments: 3, status: 'approved' });
    const b = await createBudget(api, customerId, { category: 'capital_gain', amountCents: 20_000, paymentMethodId: pix.id, status: 'approved' });
    const c = await createBudget(api, other.body.id, { amountCents: 40_000, paymentMethodId: boleto.id, installments: 2, status: 'approved' });
    await createBudget(api, other.body.id, { amountCents: 10_000 });
    const report = await api.get('/api/finance/reports/billing?year=2026');
    const byId = new Map(report.body.data.map((r: any) => [r.budgetId, r]));
    expect(report.body.data).toHaveLength(4);
    const list = (await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`)).body.data as any[];
    const own = new Map(list.map((x) => [x.id, x]));
    expect(own.get(a.body.id).paymentMethodName).toBe(boleto.name);
    expect(own.get(a.body.id).billing.installments.map((i: any) => [i.number, i.amountCents])).toEqual([
      [1, 30_000],
      [2, 30_000],
      [3, 30_000],
    ]);
    expect(own.get(b.body.id).paymentMethodName).toBe(pix.name);
    expect(own.get(b.body.id).billing.installments.map((i: any) => i.number)).toEqual([1]);
    expect(byId.has(c.body.id)).toBe(true);
    const tpl = await api.get('/api/finance/budget-import/template?year=2026');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.raw.rawPayload as unknown as ArrayBuffer);
    const rows: string[][] = [];
    wb.worksheets[0].eachRow((row, n) => n > 1 && rows.push([String(row.getCell(2).value), String(row.getCell(5).value), String(row.getCell(7).value ?? '')]));
    expect(rows).toEqual([
      ['Maria Cliente', '900', boleto.name],
      ['Maria Cliente', '200', pix.name],
      ['Olga Outra', '400', boleto.name],
      ['Olga Outra', '100', ''],
    ]);
  });
});

describe('orçamentos em lote', () => {
  it('baixa modelo pré-preenchido e importa criando e atualizando por CPF', async () => {
    const { api, customerId, token } = await setup();
    const c2 = await api.post('/api/customers', { name: 'Carlos Lote', cpfCnpj: VALID_CPFS[4] });
    await createBudget(api, customerId, { amountCents: 50_000 });

    const tpl = await api.get('/api/finance/budget-import/template?year=2026');
    expect(tpl.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.raw.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const names: string[] = [];
    ws.eachRow((row, n) => n > 1 && names.push(String(row.getCell(2).value)));
    expect(names).toEqual(['Carlos Lote', 'Maria Cliente']);

    const sheet = await buildWorkbook([
      {
        name: 'Orçamentos',
        columns: ['CPF/CNPJ', 'Cliente', 'Categoria', 'Descrição', 'Valor', 'Desconto (%)', 'Forma de pagamento', 'Parcelas', 'Início da cobrança', 'Status'].map((h, i) => ({ header: h, key: `c${i}` })),
        rows: [
          { c0: VALID_CPFS[0], c2: 'Declaração IRPF', c4: '700,00', c5: '10', c6: 'Boleto', c7: '2', c8: '10/11/2026' },
          { c0: VALID_CPFS[4], c2: 'Ganho de capital', c4: '300', c6: 'pix', c9: 'Aprovado' },
          { c0: VALID_CPFS[5], c4: '100,00' },
          { c0: VALID_CPFS[4], c4: '100,00', c6: 'Pix', c7: '3' },
          { c0: VALID_CPFS[4], c2: 'Mágica', c4: '100,00' },
          { c0: VALID_CPFS[4] },
        ],
      },
    ]);
    const mp = multipart({ year: '2026' }, { name: 'orcamentos.xlsx', data: sheet, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const res = await env.app.inject({ method: 'POST', url: '/api/finance/budget-import', payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    // a requisição só guarda a planilha e registra o lote; o job grava as linhas
    const queued = res.json();
    expect(queued).toMatchObject({ status: 'processing', total: 5, succeeded: 0, failed: 0, skipped: 1 });
    expect((await api.get(`/api/finance/customers/${c2.body.id}/budgets?year=2026`)).body.data).toHaveLength(0);
    await env.ctx.jobs.drain();
    const body = (await api.get(`/api/finance/budget-import/batches/${queued.id}`)).body;
    expect(body).toMatchObject({ status: 'done', total: 5, succeeded: 2, failed: 3 });
    expect(body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, false, false, false]);
    expect(body.results[2].message).toContain('não encontrado');
    expect(body.results[3].message).toContain('parcela');

    const maria = (await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`)).body.data;
    expect(maria).toHaveLength(1);
    expect(maria[0]).toMatchObject({ amountCents: 70_000, totalCents: 63_000, installments: 2, billingStartDate: '2026-11-10', paymentMethodName: 'Boleto' });
    const carlos = (await api.get(`/api/finance/customers/${c2.body.id}/budgets?year=2026`)).body.data;
    expect(carlos[0]).toMatchObject({ category: 'capital_gain', status: 'approved', totalCents: 30_000 });
    expect(carlos[0].billing.installments).toHaveLength(1);

    const batches = await env.ctx.db.select().from(importBatches).where(eq(importBatches.kind, 'budget'));
    expect(batches.some((b) => b.id === body.id && b.failed === 3)).toBe(true);
    expect((await api.get('/api/finance/budget-import/batches')).body[0].id).toBe(body.id);
    // o resultado chega também pelo sino de quem importou
    const notes = await env.ctx.db.query.notifications.findMany({ where: (t, { eq: e }) => e(t.officeId, queued.officeId) });
    expect(notes.some((n) => n.title === 'Importação de orçamentos concluída' && n.body === '2 linha(s) gravada(s), 3 com erro.')).toBe(true);
    // outro escritório não vê o lote
    expect((await (await registerOffice(env)).api.get(`/api/finance/budget-import/batches/${body.id}`)).status).toBe(404);
  });

  it('importação grande roda no job, lê clientes e orçamentos de uma vez e atualiza a mesma linha repetida (DAD-5)', async () => {
    const { api, token, officeId, userId } = await setup('Escritório Lote');
    // Este teste verifica 300 importações; a avaliação padrão só permite 30 declarações (COB-12).
    await env.ctx.db.update(contracts).set({ declarationLimit: 500 }).where(eq(contracts.officeId, officeId));
    // 300 clientes cadastrados direto no banco, um orçamento por linha
    const valid = Array.from({ length: 300 }, (_, i) => validCpf(String(123_456_000 + i)));
    await env.ctx.db.insert(customers).values(valid.map((cpf, i) => ({ officeId, name: `Lote ${i}`, cpfCnpj: cpf, responsibleUserId: userId })));
    const rows = valid.map((cpf) => ({ c0: cpf, c4: '100,00' }));
    // a mesma pessoa duas vezes na planilha: a segunda linha atualiza o orçamento criado pela primeira
    rows.push({ c0: valid[0], c4: '150,00' });
    const sheet = await buildWorkbook([{ name: 'Orçamentos', columns: ['CPF/CNPJ', 'Cliente', 'Categoria', 'Descrição', 'Valor'].map((h, i) => ({ header: h, key: `c${i}` })), rows }]);
    const mp = multipart({ year: '2026' }, { name: 'orcamentos.xlsx', data: sheet, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const res = await env.app.inject({ method: 'POST', url: '/api/finance/budget-import', payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${token}` } });
    expect(res.json()).toMatchObject({ status: 'processing', total: 301 });
    const before = await env.ctx.db.select({ id: budgets.id }).from(budgets).where(eq(budgets.officeId, officeId));
    expect(before).toHaveLength(0);
    const job = await env.ctx.db.query.jobs.findFirst({ where: (t, { and: a, eq: e }) => a(e(t.type, 'finance.budget_import'), e(t.idempotencyKey, res.json().id)) });
    expect(job).toMatchObject({ status: 'queued', maxAttempts: 1 });

    await env.ctx.jobs.drain();
    const batch = (await api.get(`/api/finance/budget-import/batches/${res.json().id}`)).body;
    expect(batch).toMatchObject({ status: 'done', total: 301, succeeded: 301, failed: 0 });
    expect(batch.results.at(-1)).toMatchObject({ ok: true, message: 'Orçamento atualizado.' });
    const after = await env.ctx.db.select().from(budgets).where(eq(budgets.officeId, officeId));
    expect(after).toHaveLength(300);
    const first = (await env.ctx.db.select().from(customers).where(and(eq(customers.officeId, officeId), eq(customers.cpfCnpj, valid[0]))))[0];
    expect(after.find((b) => b.customerId === first.id)?.amountCents).toBe(15_000);
  });
});

/** CPF válido: os 9 dígitos informados mais os dígitos verificadores. */
function validCpf(seed: string): string {
  const base = seed.slice(0, 9).split('').map(Number);
  const digit = (nums: number[]) => {
    const sum = nums.reduce((acc, n, i) => acc + n * (nums.length + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = digit(base);
  const d2 = digit([...base, d1]);
  return [...base, d1, d2].join('');
}

describe('permissões e isolamento', () => {
  it('bloqueia sem permissão (403) e esconde dados de outro escritório (404)', async () => {
    const a = await setup('Escritório A');
    const b = await setup('Escritório B');
    const budget = await createBudget(a.api, a.customerId, { status: 'approved' });
    const inst = budget.body.billing.installments[0];
    const draft = await createBudget(a.api, a.customerId, { category: 'consulting' });
    const table = (await a.api.get('/api/finance/price-tables')).body[0];

    // outro escritório
    expect((await b.api.get(`/api/finance/customers/${a.customerId}/budgets?year=2026`)).status).toBe(404);
    expect((await b.api.put(`/api/finance/budgets/${draft.body.id}`, { amountCents: 1 })).status).toBe(404);
    expect((await b.api.del(`/api/finance/budgets/${draft.body.id}`)).status).toBe(404);
    expect((await b.api.post(`/api/finance/budgets/${draft.body.id}/approve`)).status).toBe(404);
    expect((await b.api.post(`/api/finance/budgets/${draft.body.id}/send`, { channels: ['email'] })).status).toBe(404);
    expect((await b.api.post(`/api/finance/installments/${inst.id}/receive`, {})).status).toBe(404);
    expect((await b.api.post(`/api/finance/installments/${inst.id}/receipt`)).status).toBe(404);
    expect((await b.api.put(`/api/finance/payment-methods/${a.pix.id}`, { type: 'pix', name: 'Hack', maxInstallments: 1 })).status).toBe(404);
    expect((await b.api.del(`/api/finance/price-tables/${table.id}`)).status).toBe(404);
    expect((await b.api.post('/api/finance/budgets/quote', { customerId: a.customerId, exerciseYear: 2026, priceTableId: table.id })).status).toBe(404);
    expect((await createBudget(b.api, b.customerId, { paymentMethodId: a.pix.id })).status).toBe(400);
    expect((await b.api.get('/api/finance/reports/billing?year=2026')).body.data).toHaveLength(0);

    // colaborador só com listagem
    const viewer = await createEmployee(env, a.api, ['budget.list']);
    expect((await viewer.api.get(`/api/finance/customers/${a.customerId}/budgets?year=2026`)).status).toBe(200);
    expect((await createBudget(viewer.api, a.customerId)).status).toBe(403);
    expect((await viewer.api.post(`/api/finance/budgets/${draft.body.id}/approve`)).status).toBe(403);
    expect((await viewer.api.post(`/api/finance/budgets/${draft.body.id}/send`, { channels: ['email'] })).status).toBe(403);
    expect((await viewer.api.del(`/api/finance/budgets/${draft.body.id}`)).status).toBe(403);
    expect((await viewer.api.post(`/api/finance/installments/${inst.id}/receive`, {})).status).toBe(403);
    expect((await viewer.api.post(`/api/finance/installments/${inst.id}/receipt`)).status).toBe(403);
    expect((await viewer.api.put(`/api/finance/installments/${inst.id}`, { amountCents: 10 })).status).toBe(403);
    expect((await viewer.api.post('/api/finance/payment-methods', { type: 'pix', name: 'Novo', maxInstallments: 1 })).status).toBe(403);
    expect((await viewer.api.post('/api/finance/price-tables', { name: 'T', type: 'fixed', validFrom: '2026-01-01', config: { amountCents: 1 } })).status).toBe(403);
    expect((await viewer.api.get('/api/finance/reports/billing?year=2026')).status).toBe(403);
    expect((await viewer.api.get('/api/finance/budget-import/template?year=2026')).status).toBe(403);

    // pode criar mas não aprovar nem enviar
    const creator = await createEmployee(env, a.api, ['budget.list', 'budget.create', 'customer.list']);
    expect((await createBudget(creator.api, a.customerId)).status).toBe(201);
    expect((await createBudget(creator.api, a.customerId, { status: 'approved' })).status).toBe(403);
    expect((await createBudget(creator.api, a.customerId, { sendEmail: true })).status).toBe(403);

    // contador restrito aos próprios clientes não vê orçamento de cliente alheio
    await a.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    expect((await viewer.api.get(`/api/finance/customers/${a.customerId}/budgets?year=2026`)).status).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: '/api/finance/payment-methods' })).statusCode).toBe(401);
  });
});
