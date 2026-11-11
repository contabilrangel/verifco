/**
 * Cobrança do começo ao fim: o cliente recebe e vê o link de pagamento (link público, portal e
 * e-mail), e o que o escritório muda na parcela (vencimento, valor, recebimento, desfazer,
 * cancelar) vai primeiro ao Asaas. Se o Asaas recusa, nada muda no Verifco.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { todayIso } from '@verifco/shared';
import { billings, budgets, installments, jobs } from '../src/db/schema';
import { signCustomerToken } from '../src/plugins/auth';
import { ASAAS_ON, chargeMails, fakeAsaas } from './billing-helpers';
import { VALID_CPFS, client, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

let env: TestEnv;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(() => {
  env.providers.fetch = realFetch;
});

let seq = 0;
async function setup(opts: { asaas?: Record<string, unknown> | false; email?: boolean } = {}) {
  seq += 1;
  const office = await registerOffice(env, `Escritório Cobrança ${seq}`);
  const method = await office.api.post('/api/finance/payment-methods', { type: 'asaas', name: 'Boleto Asaas', maxInstallments: 6 });
  const email = `cliente${seq}@cobranca.com`;
  const c = await office.api.post('/api/customers', { name: 'Maria Cobrança', cpfCnpj: VALID_CPFS[0], ...(opts.email === false ? {} : { email }) });
  expect(c.status).toBe(201);
  if (opts.asaas !== false) expect((await office.api.put('/api/integrations/asaas', opts.asaas ?? ASAAS_ON)).status).toBe(200);
  return { ...office, methodId: method.body.id as string, customerId: c.body.id as string, email };
}

type PanelInstallment = { id: string; number: number; dueDate: string; amountCents: number; status: string; externalId: string | null; externalUrl: string | null; chargeSentAt: string | null; canceledAt: string | null; cancelReason: string | null };

/** Orçamento integrado aprovado pelo escritório, com a cobrança já emitida no Asaas simulado. */
async function billed(o: Awaited<ReturnType<typeof setup>>, count = 2, amountCents = 60_000) {
  const b = await o.api.post('/api/finance/budgets', { customerId: o.customerId, exerciseYear: 2026, type: 'integration', category: 'irpf', amountCents, paymentMethodId: o.methodId, installments: count, status: 'approved', billingStartDate: '2031-01-10' });
  expect(b.status).toBe(201);
  await env.ctx.jobs.drain();
  return { budgetId: b.body.id as string, billingId: b.body.billing.id as string };
}

const panel = async (api: Api, customerId: string) => (await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`)).body.data[0];
const parcels = async (api: Api, customerId: string) => (await panel(api, customerId)).billing.installments as PanelInstallment[];
const row = async (id: string) => (await env.ctx.db.query.installments.findFirst({ where: eq(installments.id, id) }))!;

describe('o cliente recebe e vê o link de pagamento', () => {
  it('link público e portal mostram as parcelas com o link depois de aprovar e faturar; o e-mail da cobrança sai uma vez', async () => {
    const o = await setup();
    const asaas = fakeAsaas();
    env.providers.fetch = asaas.fn;
    const b = await o.api.post('/api/finance/budgets', { customerId: o.customerId, exerciseYear: 2026, type: 'integration', category: 'irpf', amountCents: 60_000, paymentMethodId: o.methodId, installments: 2, billingStartDate: '2031-01-10' });
    const sent = await o.api.post(`/api/finance/budgets/${b.body.id}/send`, { channels: ['email'] });
    const token = new URL(sent.body.link).pathname.split('/').pop()!;
    const pub = async () => (await env.app.inject({ method: 'GET', url: `/api/public/budgets/${token}` })).json();
    const portal = client(env, signCustomerToken(env.app, { id: o.customerId, officeId: o.officeId }, 'portal'));

    // enviada, ainda sem faturamento: só o plano
    expect((await pub()).budget.payments).toBeNull();
    expect((await portal.get('/api/portal/budgets')).body[0]).toMatchObject({ id: b.body.id, status: 'sent', payments: null });

    // aprovada pelo cliente: as parcelas aparecem; o link chega quando a cobrança é emitida
    const ok = await env.app.inject({ method: 'POST', url: `/api/public/budgets/${token}/approve` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().budget.payments).toEqual([
      { number: 1, dueDate: '2031-01-10', amountCents: 30_000, status: 'open', paidAt: null, payUrl: null },
      { number: 2, dueDate: '2031-02-10', amountCents: 30_000, status: 'open', paidAt: null, payUrl: null },
    ]);
    await env.ctx.jobs.drain();
    const summary = (await pub()).budget;
    expect(summary.payments.map((p: { payUrl: string }) => p.payUrl)).toEqual(['https://sandbox.asaas.com/i/1', 'https://sandbox.asaas.com/i/2']);
    // nada de ids internos nem dados do recibo para o cliente
    expect(Object.keys(summary.payments[0]).sort()).toEqual(['amountCents', 'dueDate', 'number', 'paidAt', 'payUrl', 'status']);

    // o orçamento aprovado continua no portal, com a situação do pagamento
    const list = await portal.get('/api/portal/budgets');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: b.body.id, status: 'approved' });
    expect(list.body[0].payments[0]).toMatchObject({ number: 1, status: 'open', payUrl: 'https://sandbox.asaas.com/i/1' });

    // e-mail da cobrança: só a 1ª parcela, uma vez
    const mails = chargeMails(env, o.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Cobrança dos honorários — vencimento 10/01/2031');
    expect(mails[0].html).toContain('https://sandbox.asaas.com/i/1');
    expect(mails[0].html).toContain('parcela 1/2');
    expect(mails[0].html).toMatch(/R\$\s300,00/);
    const [p1, p2] = await parcels(o.api, o.customerId);
    expect(p1.chargeSentAt).toBeTruthy();
    expect(p2.chargeSentAt).toBeNull();

    // a emissão executada de novo não reenvia
    const billingId = (await panel(o.api, o.customerId)).billing.id as string;
    await env.ctx.jobs.retryNow('billing.sync_external', [{ idempotencyKey: billingId, payload: { billingId }, officeId: o.officeId }]);
    await env.ctx.jobs.drain();
    expect(chargeMails(env, o.email)).toHaveLength(1);
    // mesmo com a marca de envio apagada, a chave de idempotência segura o segundo e-mail
    await env.ctx.db.update(installments).set({ chargeSentAt: null }).where(eq(installments.id, p1.id));
    await env.ctx.jobs.retryNow('billing.sync_external', [{ idempotencyKey: billingId, payload: { billingId }, officeId: o.officeId }]);
    await env.ctx.jobs.drain();
    expect(chargeMails(env, o.email)).toHaveLength(1);

    // paga: o link some para o cliente e a situação muda
    await env.ctx.db.update(installments).set({ status: 'paid', paidAt: '2031-01-09', paidAmountCents: 30_000 }).where(eq(installments.id, p1.id));
    expect((await pub()).budget.payments[0]).toMatchObject({ status: 'paid', paidAt: '2031-01-09', payUrl: null });
    // outro cliente não vê este orçamento no portal
    const other = await o.api.post('/api/customers', { name: 'Outro', cpfCnpj: VALID_CPFS[1] });
    expect((await client(env, signCustomerToken(env.app, { id: other.body.id, officeId: o.officeId }, 'portal')).get('/api/portal/budgets')).body).toEqual([]);
  });

  it('não envia o e-mail quando o Asaas já avisa o cliente, com a preferência desligada ou sem e-mail', async () => {
    const notified = await setup({ asaas: { ...ASAAS_ON, config: { environment: 'sandbox', notifyCustomer: true } } });
    env.providers.fetch = fakeAsaas().fn;
    await billed(notified);
    expect(chargeMails(env, notified.email)).toHaveLength(0);
    expect((await parcels(notified.api, notified.customerId))[0]).toMatchObject({ externalUrl: 'https://sandbox.asaas.com/i/1', chargeSentAt: null });

    const off = await setup();
    expect((await off.api.put('/api/office/settings', { chargeLinkAutoSend: false })).status).toBe(200);
    env.providers.fetch = fakeAsaas().fn;
    await billed(off);
    expect(chargeMails(env, off.email)).toHaveLength(0);
    expect((await parcels(off.api, off.customerId))[0].chargeSentAt).toBeNull();

    const noEmail = await setup({ email: false });
    env.providers.fetch = fakeAsaas().fn;
    const { billingId } = await billed(noEmail);
    expect((await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'billing.sync_external'), eq(jobs.idempotencyKey, billingId)) }))!.status).toBe('done');
    expect((await parcels(noEmail.api, noEmail.customerId))[0]).toMatchObject({ externalUrl: 'https://sandbox.asaas.com/i/1', chargeSentAt: null });
  });

  it('"Enviar cobrança": reenvia o link por e-mail ou WhatsApp, com permissão budget.send e só para parcela em aberto com link', async () => {
    const o = await setup();
    env.providers.fetch = fakeAsaas().fn;
    await billed(o);
    await o.api.put(`/api/customers/${o.customerId}/identification`, { name: 'Maria Cobrança', email: o.email, mobile: '11987654321' });
    const [p1, p2] = await parcels(o.api, o.customerId);
    expect(chargeMails(env, o.email)).toHaveLength(1);

    // pode reenviar quantas vezes precisar, e a 2ª parcela também
    expect((await o.api.post(`/api/finance/installments/${p1.id}/charge/send`, { channel: 'email' })).status).toBe(200);
    const second = await o.api.post(`/api/finance/installments/${p2.id}/charge/send`, { channel: 'email' });
    expect(second.body).toMatchObject({ ok: true });
    await env.ctx.jobs.drain();
    const mails = chargeMails(env, o.email);
    expect(mails).toHaveLength(3);
    expect(mails[2].html).toContain('https://sandbox.asaas.com/i/2');
    expect(mails[2].html).toContain('parcela 2/2');
    expect((await row(p2.id)).chargeSentAt).toBeTruthy();
    const before = env.providers.sentWhatsApp.length;
    expect((await o.api.post(`/api/finance/installments/${p1.id}/charge/send`, { channel: 'whatsapp' })).status).toBe(200);
    await env.ctx.jobs.drain();
    expect(env.providers.sentWhatsApp).toHaveLength(before + 1);
    expect(env.providers.sentWhatsApp.at(-1)!.text).toContain('https://sandbox.asaas.com/i/1');
    expect((await o.api.post(`/api/finance/installments/${p1.id}/charge/send`, { channel: 'sms' })).status).toBe(400);

    // permissão: quem só envia recibo não envia cobrança
    const { api: receiptOnly } = await createEmployee(env, o.api, ['billing.receipt_send', 'budget.list']);
    expect((await receiptOnly.post(`/api/finance/installments/${p1.id}/charge/send`, { channel: 'email' })).status).toBe(403);
    const { api: sender } = await createEmployee(env, o.api, ['budget.send']);
    expect((await sender.post(`/api/finance/installments/${p1.id}/charge/send`, { channel: 'email' })).status).toBe(200);
    // outro escritório não alcança a parcela
    const stranger = await registerOffice(env, 'Outro Escritório');
    expect((await stranger.api.post(`/api/finance/installments/${p1.id}/charge/send`, { channel: 'email' })).status).toBe(404);

    // sem link, paga ou cancelada: nada a enviar
    await env.ctx.db.update(installments).set({ externalUrl: null }).where(eq(installments.id, p2.id));
    const noLink = await o.api.post(`/api/finance/installments/${p2.id}/charge/send`, { channel: 'email' });
    expect(noLink.status).toBe(409);
    expect(noLink.body.error).toContain('ainda não tem link de pagamento');
    await env.ctx.db.update(installments).set({ status: 'paid', paidAt: '2031-01-09' }).where(eq(installments.id, p1.id));
    expect((await o.api.post(`/api/finance/installments/${p1.id}/charge/send`, { channel: 'email' })).status).toBe(409);
  });
});

describe('alterações na parcela vão primeiro ao Asaas', () => {
  it('vencimento e valor: atualiza a cobrança e só então a parcela; se o Asaas recusa ou cai, nada muda', async () => {
    const o = await setup();
    const asaas = fakeAsaas();
    env.providers.fetch = asaas.fn;
    const { billingId } = await billed(o);
    const [p1] = await parcels(o.api, o.customerId);

    let mark = asaas.calls.length;
    const ok = await o.api.put(`/api/finance/installments/${p1.id}`, { dueDate: '2031-03-15', amountCents: 35_000 });
    expect(ok.body).toEqual({ ok: true, provider: 'asaas' });
    expect(asaas.since(mark)).toEqual(['GET /payments/pay_1', 'PUT /payments/pay_1']);
    expect(asaas.calls.at(-1)!.body).toEqual({ billingType: 'UNDEFINED', dueDate: '2031-03-15', value: 350 });
    expect(asaas.payments.get('pay_1')).toMatchObject({ dueDate: '2031-03-15', value: 350 });
    expect(await row(p1.id)).toMatchObject({ dueDate: '2031-03-15', amountCents: 35_000 });
    expect((await env.ctx.db.query.billings.findFirst({ where: eq(billings.id, billingId) }))!.totalCents).toBe(65_000);

    // só o valor muda: o vencimento enviado é o que está no Asaas
    await o.api.put(`/api/finance/installments/${p1.id}`, { amountCents: 36_000 });
    expect(asaas.calls.at(-1)!.body).toEqual({ billingType: 'UNDEFINED', dueDate: '2031-03-15', value: 360 });
    // o mesmo vencimento e valor (a tela manda os dois) não chama o Asaas
    mark = asaas.calls.length;
    expect((await o.api.put(`/api/finance/installments/${p1.id}`, { dueDate: '2031-03-15', amountCents: 36_000 })).body).toEqual({ ok: true, provider: null });
    expect(asaas.since(mark)).toEqual([]);

    // recusa do Asaas (4xx): 409 com a mensagem dele e a parcela fica como estava
    asaas.failNext((c) => c.method === 'PUT', { status: 400, json: { errors: [{ description: 'O valor mínimo da cobrança é R$ 5,00.' }] } });
    const refused = await o.api.put(`/api/finance/installments/${p1.id}`, { amountCents: 100 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('Asaas respondeu com erro (HTTP 400): O valor mínimo da cobrança é R$ 5,00. Nada foi alterado no Verifco.');
    expect(await row(p1.id)).toMatchObject({ dueDate: '2031-03-15', amountCents: 36_000 });
    // Asaas fora do ar: 502, nada muda
    asaas.failNext((c) => c.method === 'GET', { status: 503, json: {} });
    const down = await o.api.put(`/api/finance/installments/${p1.id}`, { dueDate: '2031-04-10' });
    expect(down.status).toBe(502);
    expect(down.body.error).toContain('HTTP 503');
    expect((await row(p1.id)).dueDate).toBe('2031-03-15');
    // vencimento no passado: recusado antes de chamar a alteração
    mark = asaas.calls.length;
    const past = await o.api.put(`/api/finance/installments/${p1.id}`, { dueDate: '2020-01-10' });
    expect(past.status).toBe(409);
    expect(past.body.error).toContain('não aceita vencimento no passado');
    expect(asaas.since(mark)).toEqual(['GET /payments/pay_1']);
    // cobrança já paga no Asaas (aviso ainda não chegou): não altera
    asaas.payments.get('pay_1')!.status = 'RECEIVED';
    const paid = await o.api.put(`/api/finance/installments/${p1.id}`, { amountCents: 40_000 });
    expect(paid.status).toBe(409);
    expect(paid.body.error).toContain('já consta como paga no Asaas');
    expect((await row(p1.id)).amountCents).toBe(36_000);
  });

  it('receber registra recebimento em dinheiro no Asaas; desfazer só o que foi recebido em dinheiro', async () => {
    const o = await setup();
    const asaas = fakeAsaas();
    env.providers.fetch = asaas.fn;
    await billed(o);
    const [p1, p2] = await parcels(o.api, o.customerId);

    // recusa do Asaas: a parcela continua em aberto
    asaas.failNext((c) => c.path.endsWith('/receiveInCash'), { status: 400, json: { errors: [{ description: 'A data de pagamento é inválida.' }] } });
    const refused = await o.api.post(`/api/finance/installments/${p1.id}/receive`, { paidAt: '2026-01-05' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('A data de pagamento é inválida');
    expect((await row(p1.id)).status).toBe('open');

    let mark = asaas.calls.length;
    const recv = await o.api.post(`/api/finance/installments/${p1.id}/receive`, { paidAt: '2026-01-05', paidAmountCents: 29_000 });
    expect(recv.body).toEqual({ ok: true, provider: 'asaas' });
    expect(asaas.since(mark)).toEqual(['POST /payments/pay_1/receiveInCash']);
    expect(asaas.calls.at(-1)!.body).toEqual({ paymentDate: '2026-01-05', value: 290, notifyCustomer: false });
    expect(await row(p1.id)).toMatchObject({ status: 'paid', paidAt: '2026-01-05', paidAmountCents: 29_000 });
    // o aviso do Asaas que chega depois não muda nada nem duplica a notificação
    const hook = new URL((await o.api.get('/api/integrations')).body.find((i: { provider: string }) => i.provider === 'asaas').webhookUrl).pathname;
    const evt = await env.app.inject({ method: 'POST', url: hook, payload: { id: 'evt_cash', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', status: 'RECEIVED_IN_CASH', value: 290 } } });
    expect(evt.json()).toMatchObject({ matched: true, action: 'unchanged' });

    // desfazer: confere o status no Asaas e desfaz o recebimento em dinheiro
    mark = asaas.calls.length;
    const undo = await o.api.post(`/api/finance/installments/${p1.id}/reopen`);
    expect(undo.body).toEqual({ ok: true, provider: 'asaas' });
    expect(asaas.since(mark)).toEqual(['GET /payments/pay_1', 'POST /payments/pay_1/undoReceivedInCash']);
    expect(asaas.payments.get('pay_1')!.status).toBe('PENDING');
    expect(await row(p1.id)).toMatchObject({ status: 'open', paidAt: null, paidAmountCents: null });

    // pagamento de verdade (boleto/Pix/cartão): não se desfaz aqui, é estorno no Asaas
    asaas.payments.get('pay_2')!.status = 'RECEIVED';
    await env.app.inject({ method: 'POST', url: hook, payload: { id: 'evt_pix', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_2', status: 'RECEIVED', value: 300, paymentDate: '2026-01-06' } } });
    expect((await row(p2.id)).status).toBe('paid');
    mark = asaas.calls.length;
    const real = await o.api.post(`/api/finance/installments/${p2.id}/reopen`);
    expect(real.status).toBe(409);
    expect(real.body.error).toContain('estorne a cobrança no Asaas');
    expect(asaas.since(mark)).toEqual(['GET /payments/pay_2']);
    expect((await row(p2.id)).status).toBe('paid');

    // falha ao desfazer no Asaas: continua paga
    await o.api.post(`/api/finance/installments/${p1.id}/receive`, {});
    asaas.failNext((c) => c.path.endsWith('/undoReceivedInCash'), { status: 500, json: {} });
    expect((await o.api.post(`/api/finance/installments/${p1.id}/reopen`)).status).toBe(502);
    expect((await row(p1.id)).status).toBe('paid');
    expect((await row(p1.id)).paidAt).toBe(todayIso());
  });

  it('cancelar a parcela remove a cobrança no Asaas, grava motivo e data e recalcula o faturamento', async () => {
    const o = await setup();
    const asaas = fakeAsaas();
    env.providers.fetch = asaas.fn;
    const { billingId } = await billed(o);
    const [p1, p2] = await parcels(o.api, o.customerId);

    // permissão billing.edit
    const { api: viewer } = await createEmployee(env, o.api, ['budget.list', 'billing.receive']);
    expect((await viewer.post(`/api/finance/installments/${p1.id}/cancel`, {})).status).toBe(403);
    // o Asaas recusa: nada muda
    asaas.failNext((c) => c.method === 'DELETE', { status: 400, json: { errors: [{ description: 'Cobrança em processamento.' }] } });
    const refused = await o.api.post(`/api/finance/installments/${p1.id}/cancel`, { reason: 'Cliente desistiu' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('Cobrança em processamento');
    expect(await row(p1.id)).toMatchObject({ status: 'open', canceledAt: null, cancelReason: null });

    const mark = asaas.calls.length;
    const ok = await o.api.post(`/api/finance/installments/${p1.id}/cancel`, { reason: 'Cliente desistiu' });
    expect(ok.body).toEqual({ ok: true, provider: 'asaas' });
    expect(asaas.since(mark)).toEqual(['DELETE /payments/pay_1']);
    expect(asaas.payments.get('pay_1')!.deleted).toBe(true);
    const canceled = await row(p1.id);
    expect(canceled).toMatchObject({ status: 'canceled', cancelReason: 'Cliente desistiu' });
    expect(canceled.canceledAt).toBeInstanceOf(Date);
    expect((await env.ctx.db.query.billings.findFirst({ where: eq(billings.id, billingId) }))!.totalCents).toBe(30_000);
    const shown = (await parcels(o.api, o.customerId))[0];
    expect(shown).toMatchObject({ status: 'canceled', cancelReason: 'Cliente desistiu' });
    expect(shown.canceledAt).toBeTruthy();
    // o cliente não vê mais o link desta parcela
    const portal = client(env, signCustomerToken(env.app, { id: o.customerId, officeId: o.officeId }, 'portal'));
    expect((await portal.get('/api/portal/budgets')).body[0].payments[0]).toMatchObject({ status: 'canceled', payUrl: null });

    // cancelada de novo, paga ou de outro escritório
    expect((await o.api.post(`/api/finance/installments/${p1.id}/cancel`, {})).status).toBe(409);
    await o.api.post(`/api/finance/installments/${p2.id}/receive`, {});
    const paid = await o.api.post(`/api/finance/installments/${p2.id}/cancel`, {});
    expect(paid.status).toBe(409);
    expect(paid.body.error).toContain('Parcela paga não pode ser cancelada');
    const stranger = await registerOffice(env, 'Escritório Alheio');
    expect((await stranger.api.post(`/api/finance/installments/${p2.id}/cancel`, {})).status).toBe(404);
  });

  it('com a integração desativada, o controle volta a ser local (sem chamar o Asaas)', async () => {
    const o = await setup();
    const asaas = fakeAsaas();
    env.providers.fetch = asaas.fn;
    await billed(o);
    const [p1, p2] = await parcels(o.api, o.customerId);
    await o.api.put('/api/integrations/asaas', { enabled: false });
    const mark = asaas.calls.length;
    expect((await o.api.put(`/api/finance/installments/${p1.id}`, { dueDate: '2031-06-10' })).body).toEqual({ ok: true, provider: null });
    expect((await o.api.post(`/api/finance/installments/${p1.id}/receive`, {})).body).toEqual({ ok: true, provider: null });
    expect((await o.api.post(`/api/finance/installments/${p1.id}/reopen`)).body).toEqual({ ok: true, provider: null });
    expect((await o.api.post(`/api/finance/installments/${p2.id}/cancel`, {})).body).toEqual({ ok: true, provider: null });
    expect(asaas.since(mark)).toEqual([]);
    expect(await row(p1.id)).toMatchObject({ status: 'open', dueDate: '2031-06-10' });
    expect((await row(p2.id)).status).toBe('canceled');
  });
});

describe('cancelar orçamento aprovado', () => {
  it('cancela as parcelas em aberto no Asaas, mantém as pagas e para na primeira recusa dizendo o que foi cancelado', async () => {
    const o = await setup();
    const asaas = fakeAsaas();
    env.providers.fetch = asaas.fn;
    const { budgetId, billingId } = await billed(o, 4, 120_000);
    const [p1, p2, p3, p4] = await parcels(o.api, o.customerId);
    await o.api.post(`/api/finance/installments/${p1.id}/receive`, {});

    // permissão budget.approve
    const { api: editor } = await createEmployee(env, o.api, ['budget.list', 'budget.edit', 'billing.edit']);
    expect((await editor.post(`/api/finance/budgets/${budgetId}/cancel`, {})).status).toBe(403);

    // o Asaas recusa a 3ª parcela: a 2ª já foi cancelada, o orçamento continua aprovado
    asaas.failNext((c) => c.method === 'DELETE' && c.path === '/payments/pay_3', { status: 400, json: { errors: [{ description: 'Cobrança em processamento.' }] } });
    const partial = await o.api.post(`/api/finance/budgets/${budgetId}/cancel`, { reason: 'Contrato encerrado' });
    expect(partial.status).toBe(409);
    expect(partial.body.error).toBe('Parcela(s) 2 cancelada(s). A parcela 3 não foi cancelada: Asaas respondeu com erro (HTTP 400): Cobrança em processamento. O orçamento continua aprovado; tente de novo.');
    expect(partial.body.details).toEqual({ canceled: [2], failed: 3 });
    expect((await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, budgetId) }))!.status).toBe('approved');
    expect([(await row(p2.id)).status, (await row(p3.id)).status, (await row(p4.id)).status]).toEqual(['canceled', 'open', 'open']);
    expect((await env.ctx.db.query.billings.findFirst({ where: eq(billings.id, billingId) }))!.totalCents).toBe(90_000);

    // de novo: cancela o que faltava e o orçamento passa a cancelado; a paga fica como histórico
    const mark = asaas.calls.length;
    const done = await o.api.post(`/api/finance/budgets/${budgetId}/cancel`, { reason: 'Contrato encerrado' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'canceled', canceledInstallments: [3, 4] });
    expect(asaas.since(mark)).toEqual(['DELETE /payments/pay_3', 'DELETE /payments/pay_4']);
    expect(done.body.billing.installments.map((i: PanelInstallment) => i.status)).toEqual(['paid', 'canceled', 'canceled', 'canceled']);
    expect(done.body.billing).toMatchObject({ totalCents: 30_000, paidCents: 30_000, openCents: 0 });
    expect((await row(p3.id)).cancelReason).toBe('Contrato encerrado');
    expect((await row(p1.id)).status).toBe('paid');
    // cancelado some do portal e o link público avisa
    const portal = client(env, signCustomerToken(env.app, { id: o.customerId, officeId: o.officeId }, 'portal'));
    expect((await portal.get('/api/portal/budgets')).body).toEqual([]);

    expect((await o.api.post(`/api/finance/budgets/${budgetId}/cancel`, {})).status).toBe(409);
    // só o aprovado é cancelado por esta rota; outro escritório não alcança
    const draft = await o.api.post('/api/finance/budgets', { customerId: o.customerId, exerciseYear: 2026, category: 'consulting', amountCents: 10_000 });
    const notApproved = await o.api.post(`/api/finance/budgets/${draft.body.id}/cancel`, {});
    expect(notApproved.status).toBe(409);
    expect(notApproved.body.error).toContain('Só o orçamento aprovado');
    const stranger = await registerOffice(env, 'Escritório de Fora');
    expect((await stranger.api.post(`/api/finance/budgets/${draft.body.id}/cancel`, {})).status).toBe(404);
  });

  it('orçamento com cobrança manual (sem provedor) é cancelado só no Verifco', async () => {
    const o = await setup({ asaas: false });
    const pix = ((await o.api.get('/api/finance/payment-methods')).body as { id: string; type: string }[]).find((m) => m.type === 'pix')!;
    const b = await o.api.post('/api/finance/budgets', { customerId: o.customerId, exerciseYear: 2026, category: 'irpf', amountCents: 50_000, paymentMethodId: pix.id, status: 'approved' });
    const done = await o.api.post(`/api/finance/budgets/${b.body.id}/cancel`, {});
    expect(done.body).toMatchObject({ status: 'canceled', canceledInstallments: [1] });
    expect(done.body.billing.installments[0]).toMatchObject({ status: 'canceled', cancelReason: 'Orçamento cancelado' });
  });
});
