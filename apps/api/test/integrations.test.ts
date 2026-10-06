import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { sanitizeHtml } from '@verifco/shared';
import type { AppContext } from '../src/context';
import { billings, budgets, customers, installments, integrations, jobs, notifications, procurators } from '../src/db/schema';
import { createProviders } from '../src/integrations';
import { IntegrationError, httpRequest } from '../src/integrations/http';
import { pollOmiePayments } from '../src/integrations/omie';
import type { Providers } from '../src/integrations/providers';
import type { MailTransport, SmtpTransportOptions } from '../src/integrations/email';
import { SERPRO_GATEWAY_URL, clearSerproTokens, getSerproClient, type MtlsRequest } from '../src/integrations/serpro';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

// ---------------------------------------------------------------------------
// fetch simulado
// ---------------------------------------------------------------------------
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  rawBody: unknown;
}
type Reply = { status?: number; json?: unknown; text?: string };

function mockFetch(handler: (c: Call, n: number) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: any = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* texto */
      }
    }
    const call = { url, method: init?.method ?? 'GET', headers, body, rawBody: init?.body };
    calls.push(call);
    const r = await handler(call, calls.length);
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

let env: TestEnv;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(() => {
  env.providers.fetch = realFetch;
  const p = env.ctx.providers as Providers;
  p.smtpTransport = undefined;
  p.mtlsRequest = undefined;
});

/** Contexto com a configuração da plataforma alterada (sem tocar no compartilhado). */
const withConfig = (patch: Partial<AppContext['config']>): AppContext => ({ ...env.ctx, config: { ...env.ctx.config, ...patch } });

async function setupBilling(officeId: string, api: Awaited<ReturnType<typeof registerOffice>>['api'], provider: 'asaas' | 'omie', cpf: string, amounts = [15050, 14950]) {
  const c = await api.post('/api/customers', { name: 'Maria Cliente', cpfCnpj: cpf, email: 'maria@cliente.com' });
  expect(c.status).toBe(201);
  await env.ctx.db.update(customers).set({ mobile: '11987654321' }).where(eq(customers.id, c.body.id));
  const total = amounts.reduce((a, b) => a + b, 0);
  const [budget] = await env.ctx.db
    .insert(budgets)
    .values({ officeId, customerId: c.body.id, exerciseYear: 2026, status: 'approved', amountCents: total, totalCents: total, installments: amounts.length })
    .returning();
  const [billing] = await env.ctx.db.insert(billings).values({ officeId, budgetId: budget.id, customerId: c.body.id, totalCents: total, provider }).returning();
  const rows = await env.ctx.db
    .insert(installments)
    .values(amounts.map((amountCents, i) => ({ officeId, billingId: billing.id, number: i + 1, dueDate: `2030-0${i + 1}-10`, amountCents })))
    .returning();
  return { customerId: c.body.id as string, billing, installments: rows.sort((a, b) => a.number - b.number) };
}

const getInstallment = (id: string) => env.ctx.db.query.installments.findFirst({ where: eq(installments.id, id) });

// ---------------------------------------------------------------------------
describe('configuração das integrações', () => {
  it('lista os provedores, guarda segredos cifrados e nunca os devolve', async () => {
    const { api, officeId } = await registerOffice(env);
    const list = await api.get('/api/integrations');
    expect(list.status).toBe(200);
    expect(list.body.map((i: any) => i.provider).sort()).toEqual(['asaas', 'omie', 'serpro', 'smtp', 'whatsapp']);
    expect(list.body.every((i: any) => i.status === 'not_configured' && !i.enabled)).toBe(true);

    const apiKey = '$aact_hmlg_000MzkwODA2MWY2OGM3MWRlNTZjYTI5ZjQ6OjAwMDAwMDAwMDAwMDAwNjY1Nzc6OiRhYWNoX2Y0ZGFiMWI4';
    const res = await api.put('/api/integrations/asaas', {
      enabled: true,
      config: { environment: 'sandbox', billingType: 'PIX' },
      secrets: { apiKey, webhookAuthToken: 'token-do-webhook-asaas-123' },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('configured');
    expect(res.body.secrets.apiKey).toEqual({ configured: true, last4: apiKey.slice(-4) });
    expect(res.body.webhookUrl).toMatch(/\/api\/webhooks\/asaas\/[\w-]{24,}$/);

    const again = await api.get('/api/integrations');
    const raw = JSON.stringify(again.body);
    expect(raw).not.toContain(apiKey);
    expect(raw).not.toContain('token-do-webhook-asaas-123');
    const row = await env.ctx.db.query.integrations.findFirst({ where: and(eq(integrations.officeId, officeId), eq(integrations.provider, 'asaas')) });
    expect(row!.secretsEnc).not.toContain(apiKey.slice(10));
    expect(env.ctx.secrets.decryptJson<Record<string, string>>(row!.secretsEnc)!.apiKey).toBe(apiKey);

    // campo vazio mantém o segredo; outro campo pode mudar
    await api.put('/api/integrations/asaas', { config: { billingType: 'BOLETO' }, secrets: { apiKey: '' } });
    const after = await env.ctx.db.query.integrations.findFirst({ where: eq(integrations.id, row!.id) });
    expect(env.ctx.secrets.decryptJson<Record<string, string>>(after!.secretsEnc)!.apiKey).toBe(apiKey);
    expect(after!.publicConfig.billingType).toBe('BOLETO');

    // outro escritório não enxerga a configuração
    const other = await registerOffice(env, 'Outro Escritório');
    const otherList = await other.api.get('/api/integrations');
    expect(otherList.body.find((i: any) => i.provider === 'asaas').saved).toBe(false);

    expect((await api.del('/api/integrations/asaas')).status).toBe(204);
    expect((await api.get('/api/integrations')).body.find((i: any) => i.provider === 'asaas').saved).toBe(false);
  });

  it('valida campos e exige os obrigatórios para ativar', async () => {
    const { api } = await registerOffice(env);
    const noKey = await api.put('/api/integrations/asaas', { enabled: true, config: { environment: 'sandbox' } });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error).toContain('Chave de API');
    expect((await api.put('/api/integrations/asaas', { config: { environment: 'teste' } })).status).toBe(400);
    expect((await api.put('/api/integrations/whatsapp', { config: { mode: 'evolution', baseUrl: 'ftp://x' } })).status).toBe(400);
    expect((await api.put('/api/integrations/nada', {})).status).toBe(400);
    // rascunho desativado pode ficar incompleto
    const draft = await api.put('/api/integrations/omie', { enabled: false, config: { categoryCode: '1.01.02' } });
    expect(draft.status).toBe(200);
    expect(draft.body.status).toBe('not_configured');
    expect(draft.body.missing).toEqual(expect.arrayContaining(['App Key', 'App Secret', 'ID da conta corrente']));
  });

  it('bloqueia quem não tem integrations.manage (403)', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['customer.list', 'settings.view']);
    expect((await emp.api.get('/api/integrations')).status).toBe(403);
    expect((await emp.api.put('/api/integrations/asaas', { config: { environment: 'sandbox' } })).status).toBe(403);
    expect((await emp.api.post('/api/integrations/asaas/test')).status).toBe(403);
    expect((await emp.api.del('/api/integrations/asaas')).status).toBe(403);
    const allowed = await createEmployee(env, office.api, ['integrations.manage']);
    expect((await allowed.api.get('/api/integrations')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('HTTP comum', () => {
  it('aborta por timeout com mensagem clara', async () => {
    const slow = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    await expect(httpRequest(slow, 'asaas', 'https://exemplo.test', { timeoutMs: 30 })).rejects.toThrow(/não respondeu em/);
    const broken = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as typeof fetch;
    await expect(httpRequest(broken, 'omie', 'https://exemplo.test')).rejects.toThrow(/Não foi possível conectar ao Omie \(ENOTFOUND\)/);
  });
});

// ---------------------------------------------------------------------------
describe('Asaas', () => {
  it('testa a chave com a requisição certa e grava o erro', async () => {
    const { api } = await registerOffice(env);
    await api.put('/api/integrations/asaas', { enabled: true, config: { environment: 'sandbox' }, secrets: { apiKey: '$aact_hmlg_chave-de-teste-123' } });
    const ok = mockFetch(() => ({ json: { object: 'list', hasMore: false, totalCount: 0, data: [] } }));
    env.providers.fetch = ok.fn;
    const r = await api.post('/api/integrations/asaas/test');
    expect(r.body.ok).toBe(true);
    expect(r.body.integration.status).toBe('connected');
    expect(ok.calls[0].url).toBe('https://api-sandbox.asaas.com/v3/customers?limit=1');
    expect(ok.calls[0].headers.access_token).toBe('$aact_hmlg_chave-de-teste-123');
    expect(ok.calls[0].headers['user-agent']).toContain('Verifco');

    await api.put('/api/integrations/asaas', { config: { environment: 'production' } });
    const denied = mockFetch(() => ({ status: 401, json: { errors: [{ code: 'invalid_access_token', description: 'A chave de API informada não pertence a este ambiente' }] } }));
    env.providers.fetch = denied.fn;
    const bad = await api.post('/api/integrations/asaas/test');
    expect(bad.body.ok).toBe(false);
    expect(denied.calls[0].url).toBe('https://api.asaas.com/v3/customers?limit=1');
    expect(bad.body.message).toContain('não pertence a este ambiente');
    expect(bad.body.message).toContain('A chave é de sandbox');
    expect(bad.body.integration.status).toBe('error');
    expect(bad.body.integration.lastError).toContain('Credenciais recusadas');
  });

  it('billing.sync_external cria cliente e cobranças e grava externalId/externalUrl', async () => {
    const { api, officeId } = await registerOffice(env);
    await api.put('/api/integrations/asaas', { enabled: true, config: { environment: 'sandbox', billingType: 'BOLETO' }, secrets: { apiKey: '$aact_hmlg_abc123456789' } });
    const { billing, installments: list, customerId } = await setupBilling(officeId, api, 'asaas', VALID_CPFS[0]);
    let pay = 0;
    const m = mockFetch((c) => {
      if (c.url.includes('/customers?cpfCnpj=')) return { json: { data: [] } };
      if (c.url.endsWith('/customers') && c.method === 'POST') return { json: { id: 'cus_000001', name: c.body.name, cpfCnpj: c.body.cpfCnpj } };
      if (c.url.includes('/payments?externalReference=')) return { json: { data: [] } };
      if (c.url.endsWith('/payments') && c.method === 'POST') {
        pay += 1;
        return { json: { id: `pay_${pay}`, status: 'PENDING', invoiceUrl: `https://sandbox.asaas.com/i/${pay}`, bankSlipUrl: `https://sandbox.asaas.com/b/pdf/${pay}`, ...c.body } };
      }
      return { status: 404, json: { errors: [{ description: `rota inesperada ${c.method} ${c.url}` }] } };
    });
    env.providers.fetch = m.fn;
    await env.ctx.jobs.enqueue('billing.sync_external', { billingId: billing.id }, { officeId, idempotencyKey: billing.id });
    await env.ctx.jobs.drain();
    const job = await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'billing.sync_external'), eq(jobs.idempotencyKey, billing.id)) });
    expect(job!.error).toBeNull();
    expect(job!.status).toBe('done');

    const created = m.calls.find((c) => c.url.endsWith('/customers') && c.method === 'POST')!;
    expect(created.body).toMatchObject({ name: 'Maria Cliente', cpfCnpj: VALID_CPFS[0], email: 'maria@cliente.com', mobilePhone: '11987654321', externalReference: customerId });
    const payments = m.calls.filter((c) => c.url.endsWith('/payments') && c.method === 'POST');
    expect(payments).toHaveLength(2);
    expect(payments[0].body).toMatchObject({ customer: 'cus_000001', billingType: 'BOLETO', value: 150.5, dueDate: '2030-01-10', externalReference: list[0].id });
    expect(payments[0].body.description).toContain('parcela 1/2');
    expect(payments[1].body).toMatchObject({ value: 149.5, dueDate: '2030-02-10', externalReference: list[1].id });

    const i1 = await getInstallment(list[0].id);
    expect(i1!.externalId).toBe('pay_1');
    expect(i1!.externalUrl).toBe('https://sandbox.asaas.com/i/1');
    const cust = await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, customerId) });
    expect(cust!.externalRefs.asaasId).toBe('cus_000001');

    // repetir não cria cobranças de novo
    await env.ctx.jobs.enqueue('billing.sync_external', { billingId: billing.id }, { officeId, idempotencyKey: `${billing.id}:2` });
    await env.ctx.jobs.drain();
    expect(m.calls.filter((c) => c.url.endsWith('/payments') && c.method === 'POST')).toHaveLength(2);
  });

  it('reaproveita a cobrança já criada (referência externa) e falha com mensagem clara', async () => {
    const { api, officeId } = await registerOffice(env);
    await api.put('/api/integrations/asaas', { enabled: true, config: { environment: 'sandbox' }, secrets: { apiKey: '$aact_hmlg_abc123456789' } });
    const { billing, installments: list } = await setupBilling(officeId, api, 'asaas', VALID_CPFS[1], [10000]);
    await env.ctx.db.update(customers).set({ externalRefs: { asaasId: 'cus_existente' } }).where(eq(customers.officeId, officeId));
    const m = mockFetch((c) => {
      if (c.url.includes('/customers/cus_existente') && c.method === 'PUT') return { json: { id: 'cus_existente' } };
      if (c.url.includes('/payments?externalReference=')) return { json: { data: [{ id: 'pay_antigo', invoiceUrl: 'https://asaas/i/antigo', externalReference: list[0].id }] } };
      return { status: 400, json: { errors: [{ description: 'não deveria criar' }] } };
    });
    env.providers.fetch = m.fn;
    const { syncBillingExternal } = await import('../src/integrations/billing-sync');
    const r = await syncBillingExternal(env.ctx, billing.id);
    expect(r).toMatchObject({ provider: 'asaas', created: 0, reused: 1 });
    expect((await getInstallment(list[0].id))!.externalId).toBe('pay_antigo');

    // erro do Asaas chega legível
    await env.ctx.db.update(installments).set({ externalId: null }).where(eq(installments.id, list[0].id));
    env.providers.fetch = mockFetch((c) =>
      c.method === 'PUT' ? { json: { id: 'cus_existente' } } : c.method === 'GET' ? { json: { data: [] } } : { status: 400, json: { errors: [{ code: 'invalid_value', description: 'O valor da cobrança é inválido.' }] } },
    ).fn;
    await expect(syncBillingExternal(env.ctx, billing.id)).rejects.toThrow('O valor da cobrança é inválido.');
  });

  it('webhook marca a parcela paga, é idempotente e recusa token errado', async () => {
    const { api, officeId } = await registerOffice(env);
    const saved = await api.put('/api/integrations/asaas', {
      enabled: true,
      config: { environment: 'sandbox' },
      secrets: { apiKey: '$aact_hmlg_abc123456789', webhookAuthToken: 'segredo-do-webhook-asaas' },
    });
    const path = new URL(saved.body.webhookUrl).pathname;
    const { installments: list } = await setupBilling(officeId, api, 'asaas', VALID_CPFS[2], [20000, 20000, 20000]);
    await env.ctx.db.update(installments).set({ externalId: 'pay_web_1' }).where(eq(installments.id, list[0].id));
    await env.ctx.db.update(installments).set({ externalId: 'pay_web_2' }).where(eq(installments.id, list[1].id));

    const post = (url: string, payload: unknown, token = 'segredo-do-webhook-asaas') =>
      env.app.inject({ method: 'POST', url, payload: payload as object, headers: { 'asaas-access-token': token } });
    const received = {
      id: 'evt_1',
      event: 'PAYMENT_RECEIVED',
      dateCreated: '2030-01-05 10:00:00',
      payment: { id: 'pay_web_1', customer: 'cus_1', value: 200, netValue: 195.01, status: 'RECEIVED', dueDate: '2030-01-10', paymentDate: '2030-01-05', clientPaymentDate: '2030-01-04', invoiceUrl: 'https://asaas/i/1' },
    };

    expect((await post(path.replace(/[^/]+$/, 'token-invalido-0000000000'), received)).statusCode).toBe(401);
    expect((await post(path, received, 'outro-token')).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: path, payload: received })).statusCode).toBe(401);

    const first = await post(path, received);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, matched: true, action: 'paid' });
    const paid = await getInstallment(list[0].id);
    expect(paid).toMatchObject({ status: 'paid', paidAt: '2030-01-04', paidAmountCents: 20000, externalUrl: 'https://asaas/i/1' });

    const second = await post(path, received);
    expect(second.json()).toMatchObject({ action: 'unchanged' });
    // evento atrasado depois do pagamento não volta o status
    await post(path, { ...received, id: 'evt_2', event: 'PAYMENT_OVERDUE' });
    expect((await getInstallment(list[0].id))!.status).toBe('paid');
    const notes = await env.ctx.db.query.notifications.findMany({ where: eq(notifications.officeId, officeId) });
    expect(notes.filter((n) => n.title.includes('Asaas'))).toHaveLength(1);

    // vencida, removida, restaurada e estornada
    const p2 = { ...received.payment, id: 'pay_web_2' };
    expect((await post(path, { id: 'evt_3', event: 'PAYMENT_OVERDUE', payment: p2 })).json().action).toBe('overdue');
    expect((await post(path, { id: 'evt_4', event: 'PAYMENT_DELETED', payment: p2 })).json().action).toBe('canceled');
    expect((await post(path, { id: 'evt_5', event: 'PAYMENT_RESTORED', payment: p2 })).json().action).toBe('restored');
    expect((await post(path, { id: 'evt_6', event: 'PAYMENT_REFUNDED', payment: received.payment })).json().action).toBe('canceled');
    expect((await getInstallment(list[0].id))!.status).toBe('canceled');

    // parcela sem externalId é encontrada pela referência externa
    const p3 = { ...received.payment, id: 'pay_web_3', externalReference: list[2].id };
    expect((await post(path, { id: 'evt_7', event: 'PAYMENT_CONFIRMED', payment: p3 })).json().action).toBe('paid');
    expect((await getInstallment(list[2].id))!.externalId).toBe('pay_web_3');

    // evento desconhecido: 200 sem efeito
    expect((await post(path, { id: 'evt_8', event: 'PAYMENT_BANK_SLIP_VIEWED', payment: p2 })).json()).toMatchObject({ action: 'ignored' });

    // token novo invalida a URL antiga
    const rotated = await api.post('/api/integrations/asaas/webhook-token');
    expect(rotated.body.webhookUrl).not.toBe(saved.body.webhookUrl);
    expect((await post(path, received)).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('Omie', () => {
  const omieConfig = { enabled: true, config: { categoryCode: '1.01.02', bankAccountId: 4242, pollHours: '6' }, secrets: { appKey: '1234567890123', appSecret: 'abcdef0123456789' } };

  it('lança contas a receber por parcela e agenda a consulta de pagamentos', async () => {
    const { api, officeId } = await registerOffice(env);
    expect((await api.put('/api/integrations/omie', omieConfig)).status).toBe(200);
    const scheduled = await env.ctx.db.query.jobs.findMany({ where: and(eq(jobs.type, 'omie.poll_payments'), eq(jobs.officeId, officeId)) });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].runAt.getTime()).toBeGreaterThan(Date.now());
    // mudar o intervalo não cria uma segunda cadeia de consultas
    await api.put('/api/integrations/omie', { config: { pollHours: '12' } });
    expect(await env.ctx.db.query.jobs.findMany({ where: and(eq(jobs.type, 'omie.poll_payments'), eq(jobs.officeId, officeId)) })).toHaveLength(1);

    const { billing, installments: list, customerId } = await setupBilling(officeId, api, 'omie', VALID_CPFS[3]);
    const m = mockFetch((c) => {
      if (c.body.call === 'UpsertCliente') return { json: { codigo_cliente_omie: 777, codigo_cliente_integracao: customerId, codigo_status: '0', descricao_status: 'Cliente cadastrado com sucesso!' } };
      if (c.body.call === 'UpsertContaReceber') {
        const n = list.findIndex((i) => i.id === c.body.param[0].codigo_lancamento_integracao) + 1;
        return { json: { codigo_lancamento_omie: 9000 + n, codigo_lancamento_integracao: c.body.param[0].codigo_lancamento_integracao, codigo_status: '0', descricao_status: 'ok' } };
      }
      return { status: 500, json: { faultstring: 'chamada inesperada', faultcode: 'SOAP-ENV:Client' } };
    });
    env.providers.fetch = m.fn;
    await env.ctx.jobs.enqueue('billing.sync_external', { billingId: billing.id }, { officeId, idempotencyKey: billing.id });
    await env.ctx.jobs.drain();

    const cli = m.calls[0];
    expect(cli.url).toBe('https://app.omie.com.br/api/v1/geral/clientes/');
    expect(cli.body).toMatchObject({ call: 'UpsertCliente', app_key: '1234567890123', app_secret: 'abcdef0123456789' });
    expect(cli.body.param[0]).toMatchObject({ codigo_cliente_integracao: customerId, razao_social: 'Maria Cliente', telefone1_ddd: '11', telefone1_numero: '987654321' });
    const contas = m.calls.filter((c) => c.body.call === 'UpsertContaReceber');
    expect(contas).toHaveLength(2);
    expect(contas[0].url).toBe('https://app.omie.com.br/api/v1/financas/contareceber/');
    expect(contas[0].body.param[0]).toMatchObject({
      codigo_lancamento_integracao: list[0].id,
      codigo_cliente_fornecedor: 777,
      data_vencimento: '10/01/2030',
      data_previsao: '10/01/2030',
      valor_documento: 150.5,
      codigo_categoria: '1.01.02',
      id_conta_corrente: 4242,
    });
    expect((await getInstallment(list[0].id))!.externalId).toBe('9001');
    expect((await getInstallment(list[1].id))!.externalId).toBe('9002');
    expect((await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, customerId) }))!.externalRefs.omieId).toBe('777');

    // consulta periódica: a primeira foi recebida, a segunda segue a vencer
    const poll = mockFetch((c) => {
      const ref = c.body.param[0].codigo_lancamento_integracao;
      if (c.body.call !== 'ConsultarContaReceber') return { status: 500, json: { faultstring: 'inesperado' } };
      return ref === list[0].id
        ? { json: { codigo_lancamento_omie: 9001, status_titulo: 'RECEBIDO', valor_documento: 150.5, recebimento: [{ valor: 150.5, data: '15/01/2030' }] } }
        : { json: { codigo_lancamento_omie: 9002, status_titulo: 'A VENCER', valor_documento: 149.5 } };
    });
    env.providers.fetch = poll.fn;
    const r = await pollOmiePayments(env.ctx, officeId);
    expect(r).toMatchObject({ checked: 2, paid: 1 });
    expect(await getInstallment(list[0].id)).toMatchObject({ status: 'paid', paidAt: '2030-01-15', paidAmountCents: 15050 });
    expect((await getInstallment(list[1].id))!.status).toBe('open');
    const next = await env.ctx.db.query.jobs.findMany({ where: and(eq(jobs.type, 'omie.poll_payments'), eq(jobs.officeId, officeId), eq(jobs.status, 'queued')) });
    expect(next.length).toBeGreaterThanOrEqual(1);
    expect(next.every((j) => j.runAt.getTime() > Date.now())).toBe(true);
  });

  it('mostra o erro do Omie (faultstring) no teste', async () => {
    const { api } = await registerOffice(env);
    await api.put('/api/integrations/omie', omieConfig);
    const m = mockFetch(() => ({ status: 500, json: { faultstring: 'ERROR: A chave de acesso não é válida (APP_KEY).', faultcode: 'SOAP-ENV:Client-5113' } }));
    env.providers.fetch = m.fn;
    const r = await api.post('/api/integrations/omie/test');
    expect(m.calls[0].body).toMatchObject({ call: 'ListarClientes', param: [{ pagina: 1, registros_por_pagina: 1 }] });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toContain('Credenciais recusadas pelo Omie');
    expect(r.body.integration.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
describe('WhatsApp', () => {
  it('Evolution API: texto, documento e teste de conexão', async () => {
    const { api, officeId } = await registerOffice(env);
    await api.put('/api/integrations/whatsapp', {
      enabled: true,
      config: { mode: 'evolution', baseUrl: 'https://evo.exemplo.com.br/', instance: 'escritorio' },
      secrets: { apiKey: 'evo-api-key-12345' },
    });
    const m = mockFetch((c) => (c.url.includes('/instance/connectionState/') ? { json: { instance: { instanceName: 'escritorio', state: 'open' } } } : { status: 201, json: { key: { id: `MSG${c.url.length}` } } }));
    const providers = createProviders(env.ctx, { fetch: m.fn });
    const sent = await providers.whatsapp.send(officeId, { to: '+55 (11) 98765-4321', text: 'Olá!' });
    expect(sent.messageId).toMatch(/^MSG/);
    expect(m.calls[0].url).toBe('https://evo.exemplo.com.br/message/sendText/escritorio');
    expect(m.calls[0].headers.apikey).toBe('evo-api-key-12345');
    expect(m.calls[0].body).toEqual({ number: '5511987654321', text: 'Olá!' });

    const pdf = Buffer.from('%PDF-1.4 conteúdo');
    await providers.whatsapp.send(officeId, { to: '5511987654321', text: 'Segue o DARF', document: { filename: 'darf.pdf', content: pdf, contentType: 'application/pdf' } });
    expect(m.calls[1].url).toBe('https://evo.exemplo.com.br/message/sendMedia/escritorio');
    expect(m.calls[1].body).toMatchObject({ number: '5511987654321', mediatype: 'document', mimetype: 'application/pdf', fileName: 'darf.pdf', caption: 'Segue o DARF', media: pdf.toString('base64') });

    env.providers.fetch = m.fn;
    const t = await api.post('/api/integrations/whatsapp/test');
    expect(t.body).toMatchObject({ ok: true });
    expect(m.calls.at(-1)!.url).toBe('https://evo.exemplo.com.br/instance/connectionState/escritorio');
  });

  it('Cloud API da Meta: envia documento com upload de mídia e explica erros', async () => {
    const { api, officeId } = await registerOffice(env);
    await api.put('/api/integrations/whatsapp', { enabled: true, config: { mode: 'meta', phoneNumberId: '1098765432' }, secrets: { accessToken: 'EAAG-token-permanente' } });
    const m = mockFetch((c) => (c.url.endsWith('/media') ? { json: { id: 'media-123' } } : { json: { messaging_product: 'whatsapp', contacts: [{ wa_id: '5511987654321' }], messages: [{ id: 'wamid.ABC' }] } }));
    const providers = createProviders(env.ctx, { fetch: m.fn });
    const r = await providers.whatsapp.send(officeId, { to: '5511987654321', text: 'Recibo em anexo', document: { filename: 'recibo.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' } });
    expect(r.messageId).toBe('wamid.ABC');
    expect(m.calls[0].url).toBe('https://graph.facebook.com/v25.0/1098765432/media');
    expect(m.calls[0].headers.authorization).toBe('Bearer EAAG-token-permanente');
    const form = m.calls[0].rawBody as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect((form.get('file') as File).name).toBe('recibo.pdf');
    expect(m.calls[1].url).toBe('https://graph.facebook.com/v25.0/1098765432/messages');
    expect(m.calls[1].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511987654321',
      type: 'document',
      document: { id: 'media-123', filename: 'recibo.pdf', caption: 'Recibo em anexo' },
    });

    const err = mockFetch(() => ({ status: 400, json: { error: { message: 'Re-engagement message', code: 131047, error_data: { details: 'Mais de 24 horas desde a última resposta' } } } }));
    const p2 = createProviders(env.ctx, { fetch: err.fn });
    await expect(p2.whatsapp.send(officeId, { to: '5511987654321', text: 'oi' })).rejects.toThrow(/Mais de 24 horas/);
  });

  it('sem configuração dá erro claro', async () => {
    const { officeId } = await registerOffice(env);
    await expect(createProviders(env.ctx).whatsapp.send(officeId, { to: '5511987654321', text: 'oi' })).rejects.toThrow('Configure o WhatsApp em Administração › Integrações.');
  });
});

// ---------------------------------------------------------------------------
describe('E-mail (SMTP)', () => {
  function fakeTransport(opts: { verifyError?: unknown } = {}) {
    const created: SmtpTransportOptions[] = [];
    const mails: Record<string, any>[] = [];
    const factory = (o: SmtpTransportOptions): MailTransport => {
      created.push(o);
      return {
        verify: async () => {
          if (opts.verifyError) throw opts.verifyError;
          return true;
        },
        sendMail: async (m) => {
          mails.push(m);
          return { messageId: `<id-${mails.length}@smtp>` };
        },
      };
    };
    return { factory, created, mails };
  }

  it('usa o SMTP do escritório, cai no da plataforma e avisa quando não há nenhum', async () => {
    const { api, officeId } = await registerOffice(env, 'Contábil Alfa');
    const noSmtp = withConfig({ SMTP_URL: undefined });
    await expect(createProviders(noSmtp).email.send(officeId, { to: 'a@b.com', subject: 'x', html: 'y' })).rejects.toThrow('Configure o envio de e-mail em Administração › Integrações.');

    const platform = fakeTransport();
    const withPlatform = withConfig({ SMTP_URL: 'smtps://envio%40verifco.com:s%40nha@smtp.verifco.com:465', SMTP_FROM: 'Verifco <nao-responda@verifco.com.br>' });
    await createProviders(withPlatform, { createTransport: platform.factory }).email.send(officeId, { to: 'a@b.com', subject: 'Assunto', html: '<p>oi</p>' });
    expect(platform.created[0]).toMatchObject({ host: 'smtp.verifco.com', port: 465, secure: true, auth: { user: 'envio@verifco.com', pass: 's@nha' } });
    expect(platform.mails[0].from).toEqual({ name: 'Verifco', address: 'nao-responda@verifco.com.br' });

    await api.put('/api/integrations/smtp', {
      enabled: true,
      config: { host: 'smtp.alfa.com.br', port: 587, security: 'starttls', username: 'contato@alfa.com.br', fromEmail: 'contato@alfa.com.br' },
      secrets: { password: 'senha-smtp-forte' },
    });
    const office = fakeTransport();
    const res = await createProviders(noSmtp, { createTransport: office.factory }).email.send(officeId, {
      to: 'cliente@ex.com',
      toName: 'Cliente',
      subject: 'Seu checklist',
      html: '<p>Olá</p>',
      replyTo: 'contato@alfa.com.br',
      attachments: [{ filename: 'checklist.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' }],
    });
    expect(res.messageId).toBe('<id-1@smtp>');
    expect(office.created[0]).toMatchObject({ host: 'smtp.alfa.com.br', port: 587, secure: false, requireTLS: true, auth: { user: 'contato@alfa.com.br', pass: 'senha-smtp-forte' } });
    expect(office.created[0].connectionTimeout).toBeGreaterThan(0);
    expect(office.mails[0]).toMatchObject({ from: { name: 'Contábil Alfa', address: 'contato@alfa.com.br' }, to: { name: 'Cliente', address: 'cliente@ex.com' }, subject: 'Seu checklist' });
    expect(office.mails[0].attachments[0].filename).toBe('checklist.pdf');
  });

  it('imagem enviada do computador (data: URI) sai como anexo inline referenciado por cid:', async () => {
    const { officeId } = await registerOffice(env, 'Contábil Beta');
    // transporte real do nodemailer, mas gravando a mensagem montada em vez de abrir conexão SMTP
    const raw: string[] = [];
    const factory = (): MailTransport => {
      const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
      return {
        verify: async () => true,
        sendMail: async (m) => {
          const info = await t.sendMail(m as never);
          raw.push((info.message as Buffer).toString('utf8'));
          return { messageId: info.messageId };
        },
      };
    };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const ctx = withConfig({ SMTP_URL: 'smtp://smtp.verifco.com:587', SMTP_FROM: 'Verifco <nao-responda@verifco.com.br>' });
    await createProviders(ctx, { createTransport: factory }).email.send(officeId, {
      to: 'cliente@ex.com',
      subject: 'Comunicado com logo',
      // mesmo caminho do envio real: corpo do template passa pelo sanitizeHtml (que preserva data:image)
      html: sanitizeHtml(`<p>Olá</p><p><img alt="Logo do escritório" src="data:image/png;base64,${png}" style="max-width:100%"></p>`),
    });
    expect(raw).toHaveLength(1);
    const message = raw[0];
    // nada de data: URI no e-mail que sai
    expect(message).not.toContain('data:image');
    const cid = /^Content-ID: <([^>]+)>$/im.exec(message)?.[1];
    expect(cid).toBeTruthy();
    expect(message).toMatch(/^Content-Type: multipart\/related/im);
    // a parte da imagem é inline, PNG, com o conteúdo original
    const part = message.split(/^--/m).find((p) => p.includes(`<${cid}>`))!;
    expect(part).toMatch(/^Content-Type: image\/png/im);
    expect(part).toMatch(/^Content-Disposition: inline/im);
    const body = part.split(/\n\n/).slice(1).join('').replace(/\s+/g, '');
    expect(Buffer.from(body, 'base64').equals(Buffer.from(png, 'base64'))).toBe(true);
    // e o HTML aponta para o anexo (decodifica o quoted-printable da parte HTML)
    const htmlPart = message.split(/^--/m).find((p) => /^Content-Type: text\/html/im.test(p))!;
    const html = htmlPart.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    expect(html).toContain(`src="cid:${cid}"`);
    expect(html).toMatch(/<img alt="Logo do escrit[^"]*" src="cid:/);
  });

  it('teste de conexão envia mensagem e traduz falha de autenticação', async () => {
    const { api } = await registerOffice(env);
    await api.put('/api/integrations/smtp', { enabled: true, config: { host: 'smtp.x.com', port: 465, security: 'tls', username: 'u@x.com', fromEmail: 'u@x.com' }, secrets: { password: 'senha-123' } });
    const ok = fakeTransport();
    (env.ctx.providers as Providers).smtpTransport = ok.factory;
    const r = await api.post('/api/integrations/smtp/test', { sendTo: 'eu@x.com' });
    expect(r.body.ok).toBe(true);
    expect(r.body.message).toContain('eu@x.com');
    expect(ok.created[0]).toMatchObject({ port: 465, secure: true });
    expect(ok.mails[0].to).toBe('eu@x.com');

    (env.ctx.providers as Providers).smtpTransport = fakeTransport({ verifyError: Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH' }) }).factory;
    const bad = await api.post('/api/integrations/smtp/test');
    expect(bad.body).toMatchObject({ ok: false });
    expect(bad.body.message).toContain('recusou o usuário ou a senha');
    expect(bad.body.integration.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
describe('IA (Anthropic)', () => {
  const message = (text: string) => ({
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 8 },
  });

  it('envia PDF como documento e imagem como imagem, com a chave da plataforma', async () => {
    const { api, officeId } = await registerOffice(env);
    expect((await api.put('/api/integrations/ai', { secrets: { apiKey: 'chave-do-escritorio' } })).status).toBe(403);
    const m = mockFetch(() => ({ json: message('Documento lido.') }));
    const providers = createProviders(withConfig({ ANTHROPIC_API_KEY: 'sk-ant-api03-chave-da-plataforma', AI_MODEL: 'claude-opus-5-5' }), { fetch: m.fn });
    const pdf = Buffer.from('%PDF-1.7 informe de rendimentos');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const r = await providers.ai.complete(officeId, {
      system: 'Você confere documentos de IRPF.',
      messages: [{ role: 'user', content: 'Resuma os documentos.', files: [{ filename: 'informe.pdf', mimeType: 'application/pdf', data: pdf }, { filename: 'recibo.png', mimeType: 'image/png', data: png }] }],
    });
    expect(r).toEqual({ text: 'Documento lido.', inputTokens: 120, outputTokens: 8 });
    const call = m.calls[0];
    expect(call.url).toContain('/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-api03-chave-da-plataforma');
    expect(call.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(call.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, system: 'Você confere documentos de IRPF.', fallbacks: 'default', output_config: { effort: 'high' } });
    const content = call.body.messages[0].content;
    expect(content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
    expect(content[2]).toEqual({ type: 'text', text: 'Resuma os documentos.' });
  });

  it('traduz erros e exige uma chave', async () => {
    const { api, officeId } = await registerOffice(env);
    const noKey = withConfig({ ANTHROPIC_API_KEY: undefined });
    await expect(createProviders(noKey).ai.complete(officeId, { system: 's', messages: [{ role: 'user', content: 'oi' }] })).rejects.toThrow('A IA da plataforma não está configurada. Contate o suporte do Verifco.');

    const platformConfig = withConfig({ ANTHROPIC_API_KEY: 'sk-ant-api03-chave-invalida', AI_MODEL: 'claude-haiku-4-5' });
    const denied = mockFetch(() => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
    await expect(createProviders(platformConfig, { fetch: denied.fn }).ai.complete(officeId, { system: 's', messages: [{ role: 'user', content: 'oi' }] })).rejects.toThrow(
      'Chave de API da Anthropic inválida ou revogada.',
    );
    // Haiku não recebe effort nem fallback
    expect(denied.calls[0].body.model).toBe('claude-haiku-4-5');
    expect(denied.calls[0].body.output_config).toBeUndefined();
    expect(denied.calls[0].body.fallbacks).toBeUndefined();

    const refused = mockFetch(() => ({ json: { ...message(''), content: [], stop_reason: 'refusal' } }));
    await expect(createProviders(platformConfig, { fetch: refused.fn }).ai.complete(officeId, { system: 's', messages: [{ role: 'user', content: 'oi' }] })).rejects.toThrow(/não pôde atender/);

    await expect(
      createProviders(platformConfig, { fetch: refused.fn }).ai.complete(officeId, { system: 's', messages: [{ role: 'user', content: 'x', files: [{ filename: 'a.zip', mimeType: 'application/zip', data: Buffer.from('z') }] }] }),
    ).rejects.toThrow(/não lê este anexo/);
  });

  it('o contador não pode testar a conexão global pelo endpoint antigo', async () => {
    const { api } = await registerOffice(env);
    expect((await api.post('/api/integrations/ai/test')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('SERPRO Integra Contador', () => {
  async function setupSerpro() {
    const office = await registerOffice(env);
    const file = await env.ctx.files.save({ officeId: office.officeId, data: Buffer.from('conteudo-pfx-falso'), filename: 'escritorio.pfx', mimeType: 'application/x-pkcs12' });
    const [proc] = await env.ctx.db
      .insert(procurators)
      .values({ officeId: office.officeId, name: 'Escritório (e-CNPJ)', cpfCnpj: '11222333000181', certificateFileId: file.id, certificatePasswordEnc: env.ctx.secrets.encrypt('senha-do-pfx'), certificateExpiresAt: '2099-12-31' })
      .returning();
    const saved = await office.api.put('/api/integrations/serpro', {
      enabled: true,
      config: { contractorCnpj: '11.222.333/0001-81', procuratorId: proc.id },
      secrets: { consumerKey: 'consumer-key-abc', consumerSecret: 'consumer-secret-xyz' },
    });
    expect(saved.status).toBe(200);
    clearSerproTokens();
    const auth: { url: string; init: Parameters<MtlsRequest>[1] }[] = [];
    let tokenN = 0;
    const mtls: MtlsRequest = async (url, init) => {
      auth.push({ url, init });
      tokenN += 1;
      return { status: 200, body: JSON.stringify({ access_token: `access-${tokenN}`, jwt_token: `jwt-${tokenN}`, expires_in: 2008, token_type: 'Bearer', scope: 'default' }) };
    };
    (env.ctx.providers as Providers).mtlsRequest = mtls;
    return { ...office, proc, auth };
  }

  it('autentica com OAuth2 + certificado e lista os certificados disponíveis', async () => {
    const { api, auth, proc } = await setupSerpro();
    const certs = await api.get('/api/integrations/serpro/certificates');
    expect(certs.body).toEqual([expect.objectContaining({ id: proc.id, hasCertificate: true })]);
    const r = await api.post('/api/integrations/serpro/test');
    expect(r.body.ok).toBe(true);
    expect(r.body.message).toContain('Autenticado no SERPRO');
    expect(auth[0].url).toBe('https://autenticacao.sapi.serpro.gov.br/authenticate');
    expect(auth[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('consumer-key-abc:consumer-secret-xyz').toString('base64')}`);
    expect(auth[0].init.headers['Role-Type']).toBe('TERCEIROS');
    expect(auth[0].init.body).toBe('grant_type=client_credentials');
    expect(auth[0].init.pfx.toString()).toBe('conteudo-pfx-falso');
    expect(auth[0].init.passphrase).toBe('senha-do-pfx');
  });

  it('call monta o corpo do Integra Contador, reaproveita o token e reautentica em 401', async () => {
    const { officeId, auth } = await setupSerpro();
    let n = 0;
    const m = mockFetch(() => {
      n += 1;
      if (n === 2) return { status: 401, json: { message: 'token expirado' } };
      return {
        json: {
          status: 200,
          dados: JSON.stringify([{ dtexpiracao: '20301231', nrsistemas: 1, sistemas: ['Declarações - DIRPF'] }]),
          mensagens: [{ codigo: '[Sucesso-PROCURACOES]', texto: 'Requisição efetuada com sucesso.' }],
        },
      };
    });
    env.providers.fetch = m.fn;
    const serpro = await getSerproClient(env.ctx, officeId);
    const dados = { outorgante: VALID_CPFS[0], tipoOutorgante: '1', outorgado: '11222333000181', tipoOutorgado: '2' };
    const r = await serpro.callService<{ sistemas: string[] }[]>('procuracoes', VALID_CPFS[0], dados);
    expect(r.status).toBe(200);
    expect((r.dados as { sistemas: string[] }[])[0].sistemas).toContain('Declarações - DIRPF');
    const call = m.calls[0];
    expect(call.url).toBe(`${SERPRO_GATEWAY_URL}/Consultar`);
    expect(call.headers.authorization).toBe('Bearer access-1');
    expect(call.headers.jwt_token).toBe('jwt-1');
    expect(call.body).toEqual({
      contratante: { numero: '11222333000181', tipo: 2 },
      autorPedidoDados: { numero: '11222333000181', tipo: 2 },
      contribuinte: { numero: VALID_CPFS[0], tipo: 1 },
      pedidoDados: { idSistema: 'PROCURACOES', idServico: 'OBTERPROCURACAO41', versaoSistema: '1', dados: JSON.stringify(dados) },
    });
    expect(auth).toHaveLength(1);

    // chamada genérica com dados vazios; o 401 força nova autenticação
    const r2 = await serpro.call('Monitorar', '11.222.333/0001-81', 'CAIXAPOSTAL', 'INNOVAMSG63');
    expect(r2.status).toBe(200);
    expect(auth).toHaveLength(2);
    expect(m.calls[2].headers.authorization).toBe('Bearer access-2');
    expect(m.calls[2].body.pedidoDados).toEqual({ idSistema: 'CAIXAPOSTAL', idServico: 'INNOVAMSG63', versaoSistema: '1.0', dados: '' });
    expect(m.calls[2].body.contribuinte).toEqual({ numero: '11222333000181', tipo: 2 });

    env.providers.fetch = mockFetch(() => ({ status: 403, json: { status: 403, mensagens: [{ codigo: '[AcessoNegado-ICGERENCIADOR-022]', texto: 'Procuração não encontrada.' }] } })).fn;
    const again = await getSerproClient(env.ctx, officeId);
    await expect(again.callService('caixaPostalNovas', VALID_CPFS[0])).rejects.toThrow(/procuração eletrônica no e-CAC.*Procuração não encontrada/);
  });

  it('erros de configuração do certificado são claros', async () => {
    const { officeId, api, proc } = await setupSerpro();
    await env.ctx.db.update(procurators).set({ certificateExpiresAt: '2020-01-31' }).where(eq(procurators.id, proc.id));
    const r = await api.post('/api/integrations/serpro/test');
    expect(r.body).toMatchObject({ ok: false });
    expect(r.body.message).toContain('venceu em 31/01/2020');
    await env.ctx.db.update(procurators).set({ certificateExpiresAt: null }).where(eq(procurators.id, proc.id));
    (env.ctx.providers as Providers).mtlsRequest = async () => {
      throw Object.assign(new Error('mac verify failure'), { code: 'ERR_CRYPTO' });
    };
    const bad = await api.post('/api/integrations/serpro/test');
    expect(bad.body.message).toBe('A senha do certificado digital está incorreta.');
    await api.put('/api/integrations/serpro', { enabled: false });
    await expect(getSerproClient(env.ctx, officeId)).rejects.toBeInstanceOf(IntegrationError);
  });
});
