/**
 * Cobrança integrada (Asaas) depois de falha (DAD-4, INT-9): repetição com espera, erro permanente,
 * aviso ao escritório, situação no painel, "Emitir novamente" e emissão ao ativar a integração.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { installments, jobs } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

type Reply = { status?: number; json?: unknown };
interface Call {
  url: string;
  method: string;
  body: any;
}

function mockFetch(handler: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const call = { url, method: init?.method ?? 'GET', body };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

/** Asaas que funciona: cria o cliente e uma cobrança por parcela. */
function asaasOk() {
  let pay = 0;
  return mockFetch((c) => {
    if (c.url.includes('/customers?cpfCnpj=') || c.url.includes('/payments?externalReference=')) return { json: { data: [] } };
    if (c.url.includes('/customers/') && c.method === 'PUT') return { json: { id: 'cus_1' } };
    if (c.url.endsWith('/customers') && c.method === 'POST') return { json: { id: 'cus_1', name: c.body.name } };
    if (c.url.endsWith('/payments') && c.method === 'POST') {
      pay += 1;
      return { json: { id: `pay_${pay}`, invoiceUrl: `https://sandbox.asaas.com/i/${pay}` } };
    }
    return { status: 404, json: { errors: [{ description: 'rota inesperada' }] } };
  });
}

let env: TestEnv;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(() => {
  env.providers.fetch = realFetch;
});

const ASAAS_ON = { enabled: true, config: { environment: 'sandbox' }, secrets: { apiKey: '$aact_hmlg_abc123456789' } };

async function setup(name = 'Escritório Cobrança') {
  const office = await registerOffice(env, name);
  const asaas = await office.api.post('/api/finance/payment-methods', { type: 'asaas', name: 'Boleto Asaas', maxInstallments: 6 });
  const c = await office.api.post('/api/customers', { name: 'Maria Cobrança', cpfCnpj: VALID_CPFS[0], email: 'maria@cliente.com' });
  return { ...office, methodId: asaas.body.id as string, customerId: c.body.id as string };
}

/** Orçamento integrado aprovado pelo escritório; devolve o faturamento criado. */
async function approved(api: Api, customerId: string, methodId: string, category = 'irpf') {
  const b = await api.post('/api/finance/budgets', { customerId, exerciseYear: 2026, type: 'integration', category, amountCents: 60_000, paymentMethodId: methodId, installments: 2, status: 'approved' });
  expect(b.status).toBe(201);
  return b.body.billing.id as string;
}

const syncJob = async (billingId: string) => (await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'billing.sync_external'), eq(jobs.idempotencyKey, billingId)) }))!;
const panel = async (api: Api, customerId: string) => (await api.get(`/api/finance/customers/${customerId}/budgets?year=2026`)).body;
const failureNotes = async (api: Api) => (await api.get('/api/notifications')).body.filter((n: { title: string }) => n.title === 'Cobrança não emitida no Asaas');

describe('cobrança integrada depois de falha (DAD-4, INT-9)', () => {
  it('aprovação pelo link com a integração desligada: falha sem repetir, avisa e emite ao ativar a integração', async () => {
    const o = await setup();
    expect((await panel(o.api, o.customerId)).integrations).toEqual({ asaas: false, omie: false });
    const b = await o.api.post('/api/finance/budgets', { customerId: o.customerId, exerciseYear: 2026, type: 'integration', category: 'irpf', amountCents: 60_000, paymentMethodId: o.methodId, installments: 2 });
    const sent = await o.api.post(`/api/finance/budgets/${b.body.id}/send`, { channels: ['email'] });
    const token = new URL(sent.body.link).pathname.split('/').pop()!;
    // o cliente aprova normalmente: a aprovação não depende da configuração do escritório
    const ok = await env.app.inject({ method: 'POST', url: `/api/public/budgets/${token}/approve` });
    expect(ok.statusCode).toBe(200);
    const billingId = (await panel(o.api, o.customerId)).data[0].billing.id as string;
    await env.ctx.jobs.drain();

    const job = await syncJob(billingId);
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    expect(job.error).toMatch(/Asaas não está configurada/);
    const state = (await panel(o.api, o.customerId)).data[0].billing.externalSync;
    expect(state).toMatchObject({ status: 'failed', integrationReady: false, nextAttemptAt: null });
    expect(state.error).toMatch(/não está configurada/);
    // integração desligada: um aviso do escritório (sem repetir a cada aprovação), com o caminho para ativar
    const notes = await failureNotes(o.api);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ customerId: null, link: '/admin/integracoes' });
    expect(notes[0].body).toMatch(/A integração Asaas não está ativa/);
    const otherBilling = await approved(o.api, o.customerId, o.methodId, 'consulting');
    await env.ctx.jobs.drain();
    expect((await syncJob(otherBilling)).status).toBe('failed');
    expect(await failureNotes(o.api)).toHaveLength(1);

    // salvar a integração ativa emite o que ficou pendente
    const asaas = asaasOk();
    env.providers.fetch = asaas.fn;
    expect((await o.api.put('/api/integrations/asaas', ASAAS_ON)).status).toBe(200);
    expect(await syncJob(billingId)).toMatchObject({ id: job.id, status: 'queued', attempts: 0, error: null });
    await env.ctx.jobs.drain();
    expect((await syncJob(billingId)).status).toBe('done');
    const after = (await panel(o.api, o.customerId)).data[0].billing;
    expect(after.externalSync).toMatchObject({ status: 'done', integrationReady: true });
    expect(after.installments.every((i: { externalUrl: string | null }) => i.externalUrl?.startsWith('https://sandbox.asaas.com/i/'))).toBe(true);
    expect((await syncJob(otherBilling)).status).toBe('done');
    // salvar de novo não emite outra vez
    await o.api.put('/api/integrations/asaas', { config: { billingType: 'PIX' } });
    await env.ctx.jobs.drain();
    expect(asaas.calls.filter((c) => c.url.endsWith('/payments') && c.method === 'POST')).toHaveLength(4);
    expect(await failureNotes(o.api)).toHaveLength(1);
  });

  it('instabilidade tenta de novo com espera; credencial recusada para e avisa uma vez', async () => {
    const o = await setup();
    await o.api.put('/api/integrations/asaas', ASAAS_ON);
    env.providers.fetch = mockFetch(() => ({ status: 503, json: { errors: [{ description: 'Serviço indisponível' }] } })).fn;
    const billingId = await approved(o.api, o.customerId, o.methodId);
    await env.ctx.jobs.drain();
    let job = await syncJob(billingId);
    expect(job).toMatchObject({ status: 'queued', attempts: 1, maxAttempts: 8, priority: 10 });
    expect(job.error).toMatch(/HTTP 503/);
    expect(job.runAt.getTime() - Date.now()).toBeGreaterThan(50_000);
    const retrying = (await panel(o.api, o.customerId)).data[0].billing.externalSync;
    expect(retrying).toMatchObject({ status: 'queued', attempts: 1, maxAttempts: 8, integrationReady: true });
    expect(retrying.nextAttemptAt).toBeTruthy();
    expect(await failureNotes(o.api)).toHaveLength(0);

    // a 2ª tentativa recebe 401: não adianta repetir
    env.providers.fetch = mockFetch(() => ({ status: 401, json: { errors: [{ description: 'Chave inválida' }] } })).fn;
    await env.ctx.db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, job.id));
    await env.ctx.jobs.drain();
    job = await syncJob(billingId);
    expect(job).toMatchObject({ status: 'failed', attempts: 2 });
    expect(job.error).toMatch(/Credenciais recusadas/);
    // integração ativa, falha do faturamento: aviso ligado ao cliente
    const notes = await failureNotes(o.api);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ customerId: o.customerId, link: `/clientes/${o.customerId}/irpf/orcamento` });
    expect(notes[0].body).toMatch(/^Maria Cobrança: Credenciais recusadas/);
    await env.ctx.jobs.drain();
    expect((await syncJob(billingId)).attempts).toBe(2);
  });

  it('POST /finance/billings/:id/sync emite de novo, sem duplicar, com permissão e no escopo do cliente', async () => {
    const o = await setup();
    await o.api.put('/api/integrations/asaas', ASAAS_ON);
    env.providers.fetch = mockFetch(() => ({ status: 401, json: { errors: [{ description: 'Chave inválida' }] } })).fn;
    const billingId = await approved(o.api, o.customerId, o.methodId);
    await env.ctx.jobs.drain();
    expect((await syncJob(billingId)).status).toBe('failed');

    // permissões e isolamento
    const other = await setup('Outro Escritório');
    expect((await other.api.post(`/api/finance/billings/${billingId}/sync`)).status).toBe(404);
    const viewer = await createEmployee(env, o.api, ['budget.list', 'customer.list']);
    expect((await viewer.api.post(`/api/finance/billings/${billingId}/sync`)).status).toBe(403);
    const editor = await createEmployee(env, o.api, ['budget.list', 'customer.list', 'billing.edit']);
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    expect((await editor.api.post(`/api/finance/billings/${billingId}/sync`)).status).toBe(404);
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: false });

    const asaas = asaasOk();
    env.providers.fetch = asaas.fn;
    const res = await editor.api.post(`/api/finance/billings/${billingId}/sync`);
    expect(res.status).toBe(200);
    expect(res.body.externalSync).toMatchObject({ status: 'queued', attempts: 0, error: null });
    await env.ctx.jobs.drain();
    const rows = await env.ctx.db.select().from(installments).where(eq(installments.billingId, billingId));
    expect(rows.every((i) => i.externalId?.startsWith('pay_'))).toBe(true);
    expect((await o.api.post(`/api/finance/billings/${billingId}/sync`)).status).toBe(409);
    expect(asaas.calls.filter((c) => c.url.endsWith('/payments') && c.method === 'POST')).toHaveLength(2);
    // um job só por faturamento (reaberto, não duplicado)
    expect(await env.ctx.db.select().from(jobs).where(and(eq(jobs.type, 'billing.sync_external'), eq(jobs.officeId, o.officeId)))).toHaveLength(1);

    // faturamento sem cobrança integrada
    const methods = (await o.api.get('/api/finance/payment-methods')).body as { id: string; type: string }[];
    const pix = methods.find((m) => m.type === 'pix')!;
    const manual = await o.api.post('/api/finance/budgets', { customerId: o.customerId, exerciseYear: 2026, category: 'consulting', amountCents: 10_000, paymentMethodId: pix.id, status: 'approved' });
    expect((await o.api.post(`/api/finance/billings/${manual.body.billing.id}/sync`)).status).toBe(400);
  });
});

describe('parcela com cobrança emitida no provedor (INT-10)', () => {
  const inst = async (id: string) => (await env.ctx.db.query.installments.findFirst({ where: eq(installments.id, id) }))!;

  it('vencimento, valor, baixa manual e desfazer recebimento só pelo provedor; o aviso do Asaas segue atualizando a parcela', async () => {
    const o = await setup('Escritório Parcelas Asaas');
    const saved = await o.api.put('/api/integrations/asaas', ASAAS_ON);
    const hook = new URL(saved.body.webhookUrl).pathname;
    const webhook = (event: string, paymentId: string, extra: Record<string, unknown> = {}) =>
      env.app.inject({ method: 'POST', url: hook, payload: { id: `evt_${event}_${paymentId}`, event, payment: { id: paymentId, value: 300, ...extra } } }).then((r) => r.json());
    env.providers.fetch = asaasOk().fn;
    const billingId = await approved(o.api, o.customerId, o.methodId);
    await env.ctx.jobs.drain();
    const [i1, i2] = (await panel(o.api, o.customerId)).data[0].billing.installments as { id: string; dueDate: string; amountCents: number; externalId: string }[];
    expect([i1.externalId, i2.externalId]).toEqual(['pay_1', 'pay_2']);

    // troca de vencimento ou valor: recusada com a orientação de fazer no Asaas
    const due = await o.api.put(`/api/finance/installments/${i1.id}`, { dueDate: '2031-01-10' });
    expect(due.status).toBe(409);
    expect(due.body.error).toContain('cobrança emitida no Asaas');
    expect(due.body.error).toContain('cobrado em dobro');
    expect((await o.api.put(`/api/finance/installments/${i1.id}`, { amountCents: 100 })).status).toBe(409);
    // o mesmo vencimento e valor (a tela manda os dois) não muda nada e passa
    expect((await o.api.put(`/api/finance/installments/${i1.id}`, { dueDate: i1.dueDate, amountCents: i1.amountCents })).status).toBe(200);
    expect(await inst(i1.id)).toMatchObject({ dueDate: i1.dueDate, amountCents: i1.amountCents });

    // baixa manual: recusada, a parcela continua em aberto
    const recv = await o.api.post(`/api/finance/installments/${i1.id}/receive`, {});
    expect(recv.status).toBe(409);
    expect(recv.body.error).toContain('Confirmar recebimento em dinheiro');
    expect((await inst(i1.id)).status).toBe('open');

    // o aviso do Asaas continua valendo: vencida, paga e estornada
    expect(await webhook('PAYMENT_OVERDUE', 'pay_1')).toMatchObject({ matched: true, action: 'overdue' });
    expect((await inst(i1.id)).status).toBe('overdue');
    expect((await o.api.post(`/api/finance/installments/${i1.id}/receive`, {})).status).toBe(409);
    expect(await webhook('PAYMENT_RECEIVED', 'pay_2', { paymentDate: '2030-01-05' })).toMatchObject({ matched: true, action: 'paid' });
    expect(await inst(i2.id)).toMatchObject({ status: 'paid', paidAt: '2030-01-05', paidAmountCents: 30_000 });

    // desfazer o recebimento que veio do Asaas: só lá (estorno), senão a parcela reabre e é cobrada de novo
    const reopen = await o.api.post(`/api/finance/installments/${i2.id}/reopen`);
    expect(reopen.status).toBe(409);
    expect(reopen.body.error).toContain('desfeito pelo Asaas');
    expect((await inst(i2.id)).status).toBe('paid');
    expect(await webhook('PAYMENT_REFUNDED', 'pay_2')).toMatchObject({ action: 'canceled' });
    expect((await inst(i2.id)).status).toBe('canceled');

    // integração desativada: o Verifco deixa de acompanhar a cobrança e o controle volta a ser manual
    await o.api.put('/api/integrations/asaas', { enabled: false });
    expect((await o.api.put(`/api/finance/installments/${i1.id}`, { dueDate: '2031-01-10' })).status).toBe(200);
    expect((await o.api.post(`/api/finance/installments/${i1.id}/receive`, {})).status).toBe(200);
    expect((await o.api.post(`/api/finance/installments/${i1.id}/reopen`)).status).toBe(200);
    expect(await inst(i1.id)).toMatchObject({ status: 'open', dueDate: '2031-01-10', paidAt: null });
    expect((await env.ctx.db.select().from(installments).where(eq(installments.billingId, billingId))).every((i) => i.externalId)).toBe(true);
  });

  it('parcela sem cobrança no provedor (emissão que falhou ou Pix manual) segue livre com a integração ativa', async () => {
    const o = await setup('Escritório Parcelas Livres');
    await o.api.put('/api/integrations/asaas', ASAAS_ON);
    env.providers.fetch = mockFetch(() => ({ status: 401, json: { errors: [{ description: 'Chave inválida' }] } })).fn;
    const billingId = await approved(o.api, o.customerId, o.methodId);
    await env.ctx.jobs.drain();
    expect((await syncJob(billingId)).status).toBe('failed');
    const [p1] = (await panel(o.api, o.customerId)).data[0].billing.installments as { id: string; externalId: string | null }[];
    expect(p1.externalId).toBeNull();
    expect((await o.api.put(`/api/finance/installments/${p1.id}`, { dueDate: '2031-03-10', amountCents: 31_000 })).status).toBe(200);
    expect((await o.api.post(`/api/finance/installments/${p1.id}/receive`, {})).status).toBe(200);
    expect((await o.api.post(`/api/finance/installments/${p1.id}/reopen`)).status).toBe(200);

    const methods = (await o.api.get('/api/finance/payment-methods')).body as { id: string; type: string }[];
    const pix = methods.find((m) => m.type === 'pix')!;
    const manual = await o.api.post('/api/finance/budgets', { customerId: o.customerId, exerciseYear: 2026, category: 'consulting', amountCents: 10_000, paymentMethodId: pix.id, status: 'approved' });
    const m1 = manual.body.billing.installments[0] as { id: string };
    expect((await o.api.put(`/api/finance/installments/${m1.id}`, { dueDate: '2031-02-10' })).status).toBe(200);
    expect((await o.api.post(`/api/finance/installments/${m1.id}/receive`, {})).status).toBe(200);
    expect((await o.api.post(`/api/finance/installments/${m1.id}/reopen`)).status).toBe(200);
  });
});
