/**
 * Conciliação das cobranças: o job `asaas.reconcile_payments` confere as parcelas em aberto mesmo
 * sem webhook, em rodízio; a consulta do Omie usa o mesmo rodízio; as duas cadeias são agendadas ao
 * subir a API. E os eventos do webhook do Asaas que antes eram ignorados.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { auditLogs, billings, budgets, installments, jobs, notifications } from '../src/db/schema';
import { ASAAS_RECONCILE_JOB, applyAsaasPaymentState, asaasPaymentState, reconcileAsaasPayments, type AsaasPayment } from '../src/integrations/asaas';
import { OMIE_POLL_JOB, pollOmiePayments } from '../src/integrations/omie';
import { ensureBillingSchedules } from '../src/modules/integrations/jobs';
import { ASAAS_ON, fakeAsaas, mockFetch } from './billing-helpers';
import { VALID_CPFS, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

let env: TestEnv;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(() => {
  env.providers.fetch = realFetch;
});

const OMIE_ON = { enabled: true, config: { categoryCode: '1.01.02', bankAccountId: 4242, pollHours: '6' }, secrets: { appKey: '1234567890123', appSecret: 'abcdef0123456789' } };
const pad = (n: number) => String(n).padStart(2, '0');

/** Faturamento gravado direto no banco, com as parcelas já emitidas no provedor (`externalId` = prefixo + número). */
async function issued(officeId: string, api: Api, provider: 'asaas' | 'omie', count: number, prefix: string) {
  const c = await api.post('/api/customers', { name: 'Maria Conciliação', cpfCnpj: VALID_CPFS[0], email: 'maria@conciliacao.com' });
  const customerId = (c.status === 201 ? c.body.id : (await api.get('/api/customers')).body.data[0].id) as string;
  const total = count * 10_000;
  const [budget] = await env.ctx.db.insert(budgets).values({ officeId, customerId, exerciseYear: 2026, status: 'approved', amountCents: total, totalCents: total, installments: count, category: `c${prefix}` }).returning();
  const [billing] = await env.ctx.db.insert(billings).values({ officeId, budgetId: budget.id, customerId, totalCents: total, provider }).returning();
  const rows = await env.ctx.db
    .insert(installments)
    .values(
      Array.from({ length: count }, (_, i) => ({
        officeId,
        billingId: billing.id,
        number: i + 1,
        // vencimentos em ordem: sem o rodízio, as mesmas 60 primeiras seriam sempre as consultadas
        dueDate: `${2031 + Math.floor(i / 336)}-${pad((Math.floor(i / 28) % 12) + 1)}-${pad((i % 28) + 1)}`,
        amountCents: 10_000,
        externalId: `${prefix}${i + 1}`,
      })),
    )
    .returning();
  return { customerId, billing, list: rows.sort((a, b) => a.number - b.number) };
}

const inst = async (id: string) => (await env.ctx.db.query.installments.findFirst({ where: eq(installments.id, id) }))!;
const queuedJobs = (type: string, officeId: string) => env.ctx.db.query.jobs.findMany({ where: and(eq(jobs.type, type), eq(jobs.officeId, officeId), eq(jobs.status, 'queued')) });
const notes = (officeId: string) => env.ctx.db.query.notifications.findMany({ where: eq(notifications.officeId, officeId) });

describe('conciliação periódica do Asaas', () => {
  it('status da cobrança → parcela (a mesma regra do webhook)', () => {
    const state = (status: string, deleted = false) => asaasPaymentState({ status, deleted });
    expect(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].map((s) => state(s))).toEqual(['paid', 'paid', 'paid']);
    expect(state('OVERDUE')).toBe('overdue');
    expect(state('REFUNDED')).toBe('refunded');
    expect(state('PENDING')).toBe('pending');
    expect(state('PENDING', true)).toBe('deleted');
    expect(state('RECEIVED', true)).toBe('deleted');
    // status que não mudam a parcela (análise, estorno em andamento, contestação...)
    expect(['AWAITING_RISK_ANALYSIS', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED', ''].map((s) => state(s))).toEqual([null, null, null, null]);
  });

  it('confere as parcelas em aberto sem depender do webhook, marca a conferência e reagenda a si mesmo', async () => {
    const { api, officeId } = await registerOffice(env, 'Escritório Conciliação');
    await api.put('/api/integrations/asaas', ASAAS_ON);
    const { list } = await issued(officeId, api, 'asaas', 8, 'pay_r');
    // a 8ª já está paga aqui: não é consultada
    await env.ctx.db.update(installments).set({ status: 'paid', paidAt: '2030-12-01' }).where(eq(installments.id, list[7].id));
    const remote: Record<string, Partial<AsaasPayment>> = {
      pay_r1: { status: 'RECEIVED', value: 100, clientPaymentDate: '2031-01-03', paymentDate: '2031-01-04' },
      pay_r2: { status: 'CONFIRMED', value: 99.5, confirmedDate: '2031-01-05' },
      pay_r3: { status: 'RECEIVED_IN_CASH', value: 100, paymentDate: '2031-01-06' },
      pay_r4: { status: 'OVERDUE', value: 100 },
      pay_r5: { status: 'REFUNDED', value: 100 },
      pay_r6: { status: 'PENDING', value: 100, deleted: true },
      pay_r7: { status: 'PENDING', value: 100, invoiceUrl: 'https://asaas/i/novo' },
    };
    const m = mockFetch((c) => {
      const id = c.path.split('/').pop()!;
      return remote[id] ? { json: { id, deleted: false, ...remote[id] } } : { status: 404, json: { errors: [{ description: 'não encontrada' }] } };
    });
    env.providers.fetch = m.fn;

    const before = Date.now();
    const r = await reconcileAsaasPayments(env.ctx, officeId);
    expect(r).toMatchObject({ checked: 7, paid: 3, overdue: 1, canceled: 2, errors: [] });
    expect(m.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `GET /payments/pay_r${i + 1}`));
    expect(await inst(list[0].id)).toMatchObject({ status: 'paid', paidAt: '2031-01-03', paidAmountCents: 10_000 });
    expect(await inst(list[1].id)).toMatchObject({ status: 'paid', paidAt: '2031-01-05', paidAmountCents: 9_950 });
    expect(await inst(list[2].id)).toMatchObject({ status: 'paid', paidAt: '2031-01-06' });
    expect((await inst(list[3].id)).status).toBe('overdue');
    expect(await inst(list[4].id)).toMatchObject({ status: 'canceled', cancelReason: 'Pagamento estornado no Asaas' });
    expect(await inst(list[5].id)).toMatchObject({ status: 'canceled', cancelReason: 'Cobrança removida no Asaas' });
    expect(await inst(list[6].id)).toMatchObject({ status: 'open', externalUrl: 'https://asaas/i/novo' });
    for (const i of list.slice(0, 7)) expect((await inst(i.id)).externalCheckedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await inst(list[7].id)).externalCheckedAt).toBeNull();
    // avisa o escritório dos pagamentos, uma vez por parcela, e registra a origem
    expect((await notes(officeId)).filter((n) => n.title === 'Pagamento recebido pelo Asaas')).toHaveLength(3);
    const logs = await env.ctx.db.query.auditLogs.findMany({ where: and(eq(auditLogs.officeId, officeId), eq(auditLogs.entityId, list[0].id), eq(auditLogs.action, 'installment.asaas_paid')) });
    expect(logs).toHaveLength(1);
    expect(logs[0].data).toMatchObject({ source: 'reconcile', status: 'RECEIVED', paymentId: 'pay_r1' });

    // uma só conciliação na fila por escritório, para daqui a 6 h
    const next = await queuedJobs(ASAAS_RECONCILE_JOB, officeId);
    expect(next).toHaveLength(1);
    const hours = (next[0].runAt.getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(0);
    expect(hours).toBeLessThanOrEqual(6.01);

    // nova rodada: só as que continuam em aberto (4ª vencida e 7ª), sem repetir aviso
    m.calls.length = 0;
    expect(await reconcileAsaasPayments(env.ctx, officeId)).toMatchObject({ checked: 2, paid: 0, overdue: 0, canceled: 0 });
    expect(m.calls.map((c) => c.path).sort()).toEqual(['/payments/pay_r4', '/payments/pay_r7']);
    expect((await notes(officeId)).filter((n) => n.title === 'Pagamento recebido pelo Asaas')).toHaveLength(3);
    expect(await queuedJobs(ASAAS_RECONCILE_JOB, officeId)).toHaveLength(1);

    // cobrança pendente no Asaas com a parcela cancelada aqui: volta a valer (mesma regra do PAYMENT_RESTORED)
    const canceled = await inst(list[5].id);
    expect(await applyAsaasPaymentState(env.ctx, officeId, canceled, { id: 'pay_r6', status: 'PENDING' } as AsaasPayment, 'pending', { source: 'reconcile' })).toBe('restored');
    expect(await inst(list[5].id)).toMatchObject({ status: 'open', canceledAt: null, cancelReason: null });

    // integração desativada: não consulta nem reagenda
    await api.put('/api/integrations/asaas', { enabled: false });
    m.calls.length = 0;
    expect(await reconcileAsaasPayments(env.ctx, officeId)).toMatchObject({ skipped: true });
    expect(m.calls).toHaveLength(0);
  });

  it('rodízio: com mais de 60 em aberto, a rodada seguinte começa pelas que ficaram de fora; erro de uma cobrança não trava as demais', async () => {
    const { api, officeId } = await registerOffice(env, 'Escritório Rodízio');
    await api.put('/api/integrations/asaas', ASAAS_ON);
    const { list } = await issued(officeId, api, 'asaas', 70, 'pay_c');
    const m = mockFetch((c) => {
      const id = c.path.split('/').pop()!;
      // a 3ª cobrança não existe mais no Asaas
      return id === 'pay_c3' ? { status: 404, json: { errors: [{ description: 'Cobrança não encontrada.' }] } } : { json: { id, status: 'PENDING', deleted: false, value: 100 } };
    });
    env.providers.fetch = m.fn;

    const first = await reconcileAsaasPayments(env.ctx, officeId);
    expect(first).toMatchObject({ checked: 60 });
    expect(first.errors).toHaveLength(1);
    expect(first.errors![0]).toContain('parcela 3');
    expect(m.calls.map((c) => c.path)).toEqual(list.slice(0, 60).map((i) => `/payments/${i.externalId}`));
    expect((await env.ctx.db.query.installments.findMany({ where: and(eq(installments.billingId, list[0].billingId)) })).filter((i) => i.externalCheckedAt).length).toBe(60);

    // 2ª rodada: primeiro as 10 nunca conferidas, depois as conferidas há mais tempo
    m.calls.length = 0;
    await reconcileAsaasPayments(env.ctx, officeId);
    expect(m.calls).toHaveLength(60);
    expect(m.calls.slice(0, 10).map((c) => c.path)).toEqual(list.slice(60).map((i) => `/payments/${i.externalId}`));
    expect(new Set(m.calls.slice(10).map((c) => c.path)).has('/payments/pay_c70')).toBe(false);
    // em duas rodadas, todas as 70 foram consultadas
    expect((await env.ctx.db.query.installments.findMany({ where: eq(installments.billingId, list[0].billingId) })).every((i) => i.externalCheckedAt)).toBe(true);

    // Asaas fora do ar: para na primeira falha, sem marcar nada como conferido (tenta de novo na próxima rodada)
    const stamps = async () => (await env.ctx.db.query.installments.findMany({ where: eq(installments.billingId, list[0].billingId) })).map((i) => `${i.number}:${i.externalCheckedAt?.getTime()}`).sort();
    const snapshot = await stamps();
    const down = mockFetch(() => ({ status: 503, json: {} }));
    env.providers.fetch = down.fn;
    const failed = await reconcileAsaasPayments(env.ctx, officeId);
    expect(failed).toMatchObject({ checked: 0 });
    expect(down.calls).toHaveLength(1);
    expect(await stamps()).toEqual(snapshot);
  });

  it('é agendada ao salvar a integração, ao emitir a cobrança e ao subir a API (Asaas e Omie), uma por escritório', async () => {
    const a = await registerOffice(env, 'Escritório Asaas Boot');
    const o = await registerOffice(env, 'Escritório Omie Boot');
    const off = await registerOffice(env, 'Escritório Desligado Boot');
    expect(await queuedJobs(ASAAS_RECONCILE_JOB, a.officeId)).toHaveLength(0);

    // salvar a integração ativa agenda (e salvar de novo não duplica)
    await a.api.put('/api/integrations/asaas', ASAAS_ON);
    await a.api.put('/api/integrations/asaas', { config: { billingType: 'PIX' } });
    const saved = await queuedJobs(ASAAS_RECONCILE_JOB, a.officeId);
    expect(saved).toHaveLength(1);
    expect(saved[0].runAt.getTime()).toBeGreaterThan(Date.now());
    await o.api.put('/api/integrations/omie', OMIE_ON);
    await off.api.put('/api/integrations/asaas', ASAAS_ON);
    await off.api.put('/api/integrations/asaas', { enabled: false });

    // a cadeia se perdeu (job falhou de vez, fila limpa...): ao subir, todo escritório com a integração ativa volta a ter a sua
    await env.ctx.db.delete(jobs).where(and(inArray(jobs.type, [ASAAS_RECONCILE_JOB, OMIE_POLL_JOB]), inArray(jobs.officeId, [a.officeId, o.officeId, off.officeId])));
    await ensureBillingSchedules(env.ctx);
    await ensureBillingSchedules(env.ctx);
    expect(await queuedJobs(ASAAS_RECONCILE_JOB, a.officeId)).toHaveLength(1);
    expect(await queuedJobs(OMIE_POLL_JOB, o.officeId)).toHaveLength(1);
    expect(await queuedJobs(OMIE_POLL_JOB, a.officeId)).toHaveLength(0);
    expect(await queuedJobs(ASAAS_RECONCILE_JOB, off.officeId)).toHaveLength(0);
    expect((await queuedJobs(OMIE_POLL_JOB, o.officeId))[0].runAt.getTime()).toBeGreaterThan(Date.now());

    // emitir a cobrança também agenda
    await env.ctx.db.delete(jobs).where(and(eq(jobs.type, ASAAS_RECONCILE_JOB), eq(jobs.officeId, a.officeId)));
    const method = await a.api.post('/api/finance/payment-methods', { type: 'asaas', name: 'Boleto Asaas', maxInstallments: 6 });
    const c = await a.api.post('/api/customers', { name: 'Cliente Boot', cpfCnpj: VALID_CPFS[1] });
    env.providers.fetch = fakeAsaas().fn;
    const b = await a.api.post('/api/finance/budgets', { customerId: c.body.id, exerciseYear: 2026, type: 'integration', category: 'irpf', amountCents: 20_000, paymentMethodId: method.body.id, status: 'approved' });
    expect(b.status).toBe(201);
    await env.ctx.jobs.drain();
    expect(await queuedJobs(ASAAS_RECONCILE_JOB, a.officeId)).toHaveLength(1);

    // o job da fila executa a conciliação do escritório
    const [job] = await queuedJobs(ASAAS_RECONCILE_JOB, a.officeId);
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, job.id));
    await env.ctx.jobs.drain();
    const ran = (await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, job.id) }))!;
    expect(ran.status).toBe('done');
    expect(ran.result).toMatchObject({ checked: 1 });
    expect(await queuedJobs(ASAAS_RECONCILE_JOB, a.officeId)).toHaveLength(1);
  });
});

describe('consulta periódica do Omie em rodízio', () => {
  it('com mais de 60 títulos em aberto, a rodada seguinte começa pelos que ficaram de fora', async () => {
    const { api, officeId } = await registerOffice(env, 'Escritório Omie Rodízio');
    await api.put('/api/integrations/omie', OMIE_ON);
    const { list } = await issued(officeId, api, 'omie', 65, '91');
    const m = mockFetch((c) => {
      const ref = c.body.param[0].codigo_lancamento_integracao;
      // o 2º título dá erro só nele; o 65º (vencimento mais distante) já foi recebido
      if (ref === list[1].id) return { status: 500, json: { faultstring: 'ERROR: Lançamento não cadastrado para o Código de Integração informado.' } };
      return ref === list[64].id ? { json: { status_titulo: 'RECEBIDO', recebimento: [{ valor: 100, data: '15/01/2031' }] } } : { json: { status_titulo: 'A VENCER' } };
    });
    env.providers.fetch = m.fn;
    const refs = () => m.calls.map((c) => c.body.param[0].codigo_lancamento_integracao as string);

    const first = await pollOmiePayments(env.ctx, officeId);
    expect(first).toMatchObject({ checked: 60, paid: 0 });
    expect(first.errors).toHaveLength(1);
    expect(refs()).toEqual(list.slice(0, 60).map((i) => i.id));
    expect((await inst(list[0].id)).externalCheckedAt).toBeInstanceOf(Date);
    expect((await inst(list[1].id)).externalCheckedAt).toBeInstanceOf(Date);
    expect((await inst(list[64].id)).externalCheckedAt).toBeNull();

    // antes do rodízio, as mesmas 60 de vencimento mais próximo eram consultadas para sempre
    m.calls.length = 0;
    const second = await pollOmiePayments(env.ctx, officeId);
    expect(second).toMatchObject({ checked: 60, paid: 1 });
    expect(refs().slice(0, 5)).toEqual(list.slice(60).map((i) => i.id));
    expect(await inst(list[64].id)).toMatchObject({ status: 'paid', paidAt: '2031-01-15', paidAmountCents: 10_000 });
    expect(await queuedJobs(OMIE_POLL_JOB, officeId)).toHaveLength(1);
  });
});

describe('webhook do Asaas: recebimento desfeito e contestação', () => {
  it('PAYMENT_RECEIVED_IN_CASH_UNDONE reabre a parcela paga sem recibo; com recibo, avisa o escritório', async () => {
    const { api, officeId } = await registerOffice(env, 'Escritório Webhook Novo');
    const saved = await api.put('/api/integrations/asaas', ASAAS_ON);
    const hook = new URL(saved.body.webhookUrl).pathname;
    const post = (id: string, event: string, paymentId: string) => env.app.inject({ method: 'POST', url: hook, payload: { id, event, payment: { id: paymentId, value: 100, status: 'PENDING' } } }).then((r) => r.json());
    const { list, customerId } = await issued(officeId, api, 'asaas', 3, 'pay_w');
    await env.ctx.db.update(installments).set({ status: 'paid', paidAt: '2030-12-20', paidAmountCents: 10_000 }).where(inArray(installments.id, [list[0].id, list[1].id]));
    await env.ctx.db.update(installments).set({ receiptNumber: 7 }).where(eq(installments.id, list[1].id));

    // sem recibo: volta a ficar em aberto
    expect(await post('evt_u1', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'pay_w1')).toMatchObject({ matched: true, action: 'reopened' });
    expect(await inst(list[0].id)).toMatchObject({ status: 'open', paidAt: null, paidAmountCents: null });
    expect(await post('evt_u1', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'pay_w1')).toMatchObject({ action: 'unchanged' });

    // com recibo emitido: continua paga e o escritório é avisado, uma vez
    expect(await post('evt_u2', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'pay_w2')).toMatchObject({ matched: true, action: 'notified' });
    expect(await post('evt_u2', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'pay_w2')).toMatchObject({ action: 'unchanged' });
    expect(await inst(list[1].id)).toMatchObject({ status: 'paid', paidAt: '2030-12-20', receiptNumber: 7 });
    const undone = (await notes(officeId)).filter((n) => n.title === 'Recebimento desfeito no Asaas');
    expect(undone).toHaveLength(1);
    expect(undone[0]).toMatchObject({ customerId, link: `/clientes/${customerId}/irpf/orcamento` });
    expect(undone[0].body).toContain('recibo nº 0007');
    // parcela em aberto: nada a desfazer
    expect(await post('evt_u3', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'pay_w3')).toMatchObject({ matched: true, action: 'unchanged' });
  });

  it('contestação (chargeback): avisa o escritório no sino sem mudar a parcela', async () => {
    const { api, officeId } = await registerOffice(env, 'Escritório Chargeback');
    const saved = await api.put('/api/integrations/asaas', ASAAS_ON);
    const hook = new URL(saved.body.webhookUrl).pathname;
    const post = (id: string, event: string, paymentId = 'pay_k1') => env.app.inject({ method: 'POST', url: hook, payload: { id, event, payment: { id: paymentId, value: 100, status: 'CHARGEBACK_REQUESTED' } } }).then((r) => r.json());
    const { list, customerId } = await issued(officeId, api, 'asaas', 1, 'pay_k');
    await env.ctx.db.update(installments).set({ status: 'paid', paidAt: '2030-12-20', paidAmountCents: 10_000 }).where(eq(installments.id, list[0].id));

    expect(await post('evt_c1', 'PAYMENT_CHARGEBACK_REQUESTED')).toMatchObject({ matched: true, action: 'notified', installmentId: list[0].id });
    // entrega repetida do mesmo evento não duplica o aviso
    expect(await post('evt_c1', 'PAYMENT_CHARGEBACK_REQUESTED')).toMatchObject({ action: 'unchanged' });
    expect(await post('evt_c2', 'PAYMENT_CHARGEBACK_DISPUTE')).toMatchObject({ action: 'notified' });
    expect(await post('evt_c3', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL')).toMatchObject({ action: 'notified' });
    expect(await inst(list[0].id)).toMatchObject({ status: 'paid', paidAt: '2030-12-20' });
    const bell = (await notes(officeId)).filter((n) => n.title === 'Pagamento contestado no Asaas (chargeback)');
    expect(bell).toHaveLength(3);
    expect(bell.every((n) => n.customerId === customerId && n.userId === null)).toBe(true);
    expect(bell.map((n) => n.body).join(' ')).toContain('contestou o pagamento');
    // cobrança desconhecida ou evento sem tratamento: 200 sem efeito
    expect(await post('evt_c4', 'PAYMENT_CHARGEBACK_REQUESTED', 'pay_de_outro')).toMatchObject({ matched: false, action: 'ignored' });
    expect(await post('evt_c5', 'PAYMENT_CHECKOUT_VIEWED')).toMatchObject({ matched: false, action: 'ignored' });
  });
});
