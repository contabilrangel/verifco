/**
 * Cliente da API v3 do Asaas e regras de cobrança das parcelas.
 *
 * Documentação oficial (docs.asaas.com):
 * - Autenticação: cabeçalho `access_token` + `User-Agent`; sandbox https://api-sandbox.asaas.com/v3,
 *   produção https://api.asaas.com/v3 (https://docs.asaas.com/docs/autenticacao).
 * - Clientes: GET/POST /v3/customers e PUT /v3/customers/{id}
 *   (https://docs.asaas.com/reference/criar-novo-cliente, .../atualizar-cliente-existente).
 * - Cobranças: POST /v3/payments e GET /v3/payments?externalReference=
 *   (https://docs.asaas.com/reference/criar-nova-cobranca, .../listar-cobrancas);
 *   GET, PUT e DELETE /v3/payments/{id} (recuperar, atualizar vencimento/valor e remover);
 *   POST /v3/payments/{id}/receiveInCash e /undoReceivedInCash (recebimento em dinheiro e o desfazer)
 *   (.../recuperar-uma-unica-cobranca, .../atualizar-cobranca-existente, .../excluir-cobranca,
 *   .../confirmar-recebimento-em-dinheiro, .../desfazer-confirmacao-de-recebimento-em-dinheiro).
 * - Webhooks: token no cabeçalho `asaas-access-token`, entrega "pelo menos uma vez"
 *   (https://docs.asaas.com/docs/sobre-os-webhooks, .../webhook-para-cobrancas).
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { formatMoney, onlyDigits } from '@verifco/shared';
import type { AppContext } from '../context';
import { auditLogs, billings, customers, installments, jobs } from '../db/schema';
import { notify } from '../services/notify';
import { IntegrationError, centsToDecimal, decimalToCents, ensureOk, errorMessage, httpRequest, todayIso } from './http';
import { loadIntegration, type LoadedIntegration } from './store';

export interface AsaasConfig {
  environment: 'sandbox' | 'production';
  billingType: 'UNDEFINED' | 'BOLETO' | 'PIX';
  notifyCustomer?: boolean;
}
export interface AsaasSecrets {
  apiKey?: string;
  webhookAuthToken?: string;
}

export const ASAAS_BASE_URLS = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
} as const;

const USER_AGENT = 'Verifco/1.0 (+https://verifco.com.br)';

export interface AsaasCustomer {
  id: string;
  name: string;
  cpfCnpj: string;
}

export interface AsaasPayment {
  id: string;
  customer: string;
  value: number;
  status: string;
  dueDate: string;
  billingType?: string;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  externalReference?: string | null;
  deleted?: boolean;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
}

interface AsaasList<T> {
  data: T[];
  hasMore?: boolean;
  totalCount?: number;
}

/** Erros do Asaas vêm como `{ errors: [{ code, description }] }`. */
const describeAsaasError = (data: unknown) => {
  const errors = (data as { errors?: { description?: string }[] } | null)?.errors;
  return Array.isArray(errors) && errors.length ? errors.map((e) => e.description).filter(Boolean).join('; ') : null;
};

export class AsaasClient {
  readonly baseUrl: string;

  constructor(
    private fetchImpl: typeof fetch,
    private apiKey: string,
    environment: AsaasConfig['environment'] = 'sandbox',
  ) {
    this.baseUrl = ASAAS_BASE_URLS[environment] ?? ASAAS_BASE_URLS.sandbox;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await httpRequest<T>(this.fetchImpl, 'asaas', `${this.baseUrl}${path}`, {
      method,
      body,
      headers: { access_token: this.apiKey, 'User-Agent': USER_AGENT },
    });
    return ensureOk('asaas', res, describeAsaasError);
  }

  /** Lista um cliente só para validar a chave (não altera nada na conta). */
  async ping() {
    return this.request<AsaasList<AsaasCustomer>>('GET', '/customers?limit=1');
  }

  async findCustomerByCpfCnpj(cpfCnpj: string) {
    const r = await this.request<AsaasList<AsaasCustomer & { deleted?: boolean }>>('GET', `/customers?cpfCnpj=${encodeURIComponent(onlyDigits(cpfCnpj))}&limit=10`);
    return (r.data ?? []).find((c) => !c.deleted) ?? null;
  }

  createCustomer(body: Record<string, unknown>) {
    return this.request<AsaasCustomer>('POST', '/customers', body);
  }

  updateCustomer(id: string, body: Record<string, unknown>) {
    return this.request<AsaasCustomer>('PUT', `/customers/${encodeURIComponent(id)}`, body);
  }

  async findPaymentByExternalReference(ref: string) {
    const r = await this.request<AsaasList<AsaasPayment>>('GET', `/payments?externalReference=${encodeURIComponent(ref)}&limit=10`);
    return (r.data ?? []).find((p) => !p.deleted) ?? null;
  }

  createPayment(body: Record<string, unknown>) {
    return this.request<AsaasPayment>('POST', '/payments', body);
  }

  /** GET /payments/{id}: a cobrança removida também volta, com `deleted: true`. */
  getPayment(id: string) {
    return this.request<AsaasPayment>('GET', `/payments/${encodeURIComponent(id)}`);
  }

  /** PUT /payments/{id}: troca vencimento e valor (a forma de pagamento vai junto, sem mudar). */
  updatePayment(id: string, body: { billingType?: string; dueDate: string; value: number }) {
    return this.request<AsaasPayment>('PUT', `/payments/${encodeURIComponent(id)}`, body);
  }

  /** DELETE /payments/{id}: remove a cobrança (o link de pagamento deixa de funcionar). */
  deletePayment(id: string) {
    return this.request<{ deleted?: boolean; id?: string }>('DELETE', `/payments/${encodeURIComponent(id)}`);
  }

  /** POST /payments/{id}/receiveInCash: recebimento por fora do Asaas (dinheiro, transferência). */
  receiveInCash(id: string, input: { paymentDate: string; value: number }) {
    return this.request<AsaasPayment>('POST', `/payments/${encodeURIComponent(id)}/receiveInCash`, { paymentDate: input.paymentDate, value: input.value, notifyCustomer: false });
  }

  /** POST /payments/{id}/undoReceivedInCash: só vale para cobrança com status RECEIVED_IN_CASH. */
  undoReceivedInCash(id: string) {
    return this.request<AsaasPayment>('POST', `/payments/${encodeURIComponent(id)}/undoReceivedInCash`, {});
  }
}

export function asaasClientFrom(ctx: AppContext, loaded: LoadedIntegration<AsaasConfig, AsaasSecrets>) {
  if (!loaded.secrets.apiKey) throw new IntegrationError('asaas', 'Informe a chave de API do Asaas em Administração › Integrações.');
  return new AsaasClient(ctx.providers.fetch, loaded.secrets.apiKey, loaded.config.environment);
}

/** Testa a chave e explica o erro mais comum (chave de um ambiente usada no outro). */
export async function testAsaas(ctx: AppContext, loaded: LoadedIntegration<AsaasConfig, AsaasSecrets>) {
  const client = asaasClientFrom(ctx, loaded);
  const key = loaded.secrets.apiKey ?? '';
  const env = loaded.config.environment;
  try {
    await client.ping();
  } catch (err) {
    if (err instanceof IntegrationError && err.status === 401) {
      const hint =
        env === 'production' && key.includes('_hmlg_')
          ? ' A chave é de sandbox, mas o ambiente escolhido é Produção.'
          : env === 'sandbox' && key.includes('_prod_')
            ? ' A chave é de produção, mas o ambiente escolhido é Sandbox.'
            : '';
      throw new IntegrationError('asaas', err.message + hint, 401);
    }
    throw err;
  }
  return `Conexão com o Asaas (${env === 'production' ? 'produção' : 'sandbox'}) funcionando.`;
}

type CustomerRow = typeof customers.$inferSelect;
type InstallmentRow = typeof installments.$inferSelect;

function asaasCustomerBody(c: CustomerRow, cfg: AsaasConfig) {
  const addr = c.address ?? {};
  const body: Record<string, unknown> = {
    name: c.name,
    cpfCnpj: onlyDigits(c.cpfCnpj),
    externalReference: c.id,
    notificationDisabled: !cfg.notifyCustomer,
  };
  if (c.email) body.email = c.email;
  // o Asaas espera celular nacional (DDD + número)
  if (c.mobile) body.mobilePhone = onlyDigits(c.mobile);
  if (c.phone) body.phone = onlyDigits(c.phone);
  if (addr.street) body.address = addr.street;
  if (addr.number) body.addressNumber = addr.number;
  if (addr.complement) body.complement = addr.complement;
  if (addr.neighborhood) body.province = addr.neighborhood;
  if (addr.zip) body.postalCode = onlyDigits(addr.zip);
  return body;
}

/**
 * Cria ou atualiza o cliente no Asaas e guarda o id em `customers.externalRefs.asaasId`.
 * Sem id guardado, procura pelo CPF/CNPJ antes de criar (evita duplicar o cadastro).
 */
export async function upsertAsaasCustomer(ctx: AppContext, client: AsaasClient, cfg: AsaasConfig, customer: CustomerRow): Promise<string> {
  const body = asaasCustomerBody(customer, cfg);
  let asaasId = customer.externalRefs?.asaasId ?? null;
  if (asaasId) {
    await client.updateCustomer(asaasId, body);
  } else {
    const existing = await client.findCustomerByCpfCnpj(customer.cpfCnpj);
    if (existing) {
      asaasId = existing.id;
      await client.updateCustomer(asaasId, body);
    } else {
      asaasId = (await client.createCustomer(body)).id;
    }
    await ctx.db
      .update(customers)
      .set({ externalRefs: { ...(customer.externalRefs ?? {}), asaasId } })
      .where(eq(customers.id, customer.id));
  }
  return asaasId;
}

/**
 * Cria uma cobrança por parcela pendente e grava `externalId`/`externalUrl`.
 * Idempotente: a parcela é a `externalReference` da cobrança, então uma repetição
 * (job reexecutado) reaproveita a cobrança que já existe em vez de criar outra.
 */
export async function createAsaasCharges(
  ctx: AppContext,
  loaded: LoadedIntegration<AsaasConfig, AsaasSecrets>,
  input: { customer: CustomerRow; pending: InstallmentRow[]; totalInstallments: number; description: string; progress?: (pct: number) => Promise<void> },
) {
  const client = asaasClientFrom(ctx, loaded);
  const customerId = await upsertAsaasCustomer(ctx, client, loaded.config, input.customer);
  const today = todayIso();
  let created = 0;
  let reused = 0;
  for (const [i, inst] of input.pending.entries()) {
    let payment = await client.findPaymentByExternalReference(inst.id);
    if (payment) reused += 1;
    else {
      payment = await client.createPayment({
        customer: customerId,
        billingType: loaded.config.billingType ?? 'UNDEFINED',
        value: centsToDecimal(inst.amountCents),
        // o Asaas não aceita vencimento no passado: parcelas atrasadas vencem hoje
        dueDate: inst.dueDate < today ? today : inst.dueDate,
        description: `${input.description} (parcela ${inst.number}/${input.totalInstallments})`.slice(0, 500),
        externalReference: inst.id,
      });
      created += 1;
    }
    await ctx.db
      .update(installments)
      .set({ externalId: payment.id, externalUrl: payment.invoiceUrl ?? payment.bankSlipUrl ?? null })
      .where(eq(installments.id, inst.id));
    await input.progress?.(((i + 1) / input.pending.length) * 100);
  }
  // o webhook pode falhar ou estar mal configurado: a conciliação periódica confere estas cobranças
  await scheduleAsaasReconcile(ctx, input.customer.officeId);
  return { provider: 'asaas', customerId, created, reused };
}

// ---------------------------------------------------------------------------
// Situação da cobrança → parcela (webhook e conciliação)
// ---------------------------------------------------------------------------
export interface AsaasWebhookEvent {
  id?: string;
  event: string;
  dateCreated?: string;
  payment?: AsaasPayment;
}

type AsaasAction = 'paid' | 'overdue' | 'canceled' | 'restored' | 'reopened' | 'notified' | 'updated' | 'unchanged' | 'ignored';
export type AsaasWebhookResult = { matched: boolean; action: AsaasAction; installmentId?: string };

/** O que a cobrança diz no Asaas, já sem os nomes de status e de evento. */
export type AsaasChargeState = 'paid' | 'overdue' | 'refunded' | 'deleted' | 'pending';

/** Status (ou `deleted`) de uma cobrança consultada no Asaas; null para os que não mudam a parcela. */
export function asaasPaymentState(payment: Pick<AsaasPayment, 'status' | 'deleted'>): AsaasChargeState | null {
  if (payment.deleted) return 'deleted';
  switch (payment.status) {
    case 'RECEIVED':
    case 'CONFIRMED':
    case 'RECEIVED_IN_CASH':
      return 'paid';
    case 'OVERDUE':
      return 'overdue';
    case 'REFUNDED':
      return 'refunded';
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

/** Eventos do webhook que dizem a situação da cobrança (o evento vale mais que o `status` do corpo). */
const EVENT_STATE: Record<string, AsaasChargeState | null> = {
  PAYMENT_RECEIVED: 'paid',
  PAYMENT_CONFIRMED: 'paid',
  PAYMENT_OVERDUE: 'overdue',
  PAYMENT_DELETED: 'deleted',
  PAYMENT_REFUNDED: 'refunded',
  PAYMENT_RESTORED: 'pending',
  // só o link pode ter mudado
  PAYMENT_UPDATED: null,
};
const CASH_UNDONE_EVENT = 'PAYMENT_RECEIVED_IN_CASH_UNDONE';
const CHARGEBACK_EVENTS: Record<string, string> = {
  PAYMENT_CHARGEBACK_REQUESTED: 'O cliente contestou o pagamento no cartão (chargeback).',
  PAYMENT_CHARGEBACK_DISPUTE: 'A contestação do pagamento (chargeback) está em disputa.',
  PAYMENT_AWAITING_CHARGEBACK_REVERSAL: 'A disputa da contestação foi ganha; o Asaas aguarda a devolução do valor pela adquirente.',
};

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

async function customerOfInstallment(ctx: AppContext, inst: InstallmentRow) {
  const billing = await ctx.db.query.billings.findFirst({ where: eq(billings.id, inst.billingId) });
  return billing ? ((await ctx.db.query.customers.findFirst({ where: eq(customers.id, billing.customerId) })) ?? null) : null;
}

/**
 * Leva a situação da cobrança no Asaas para a parcela. É a regra única do webhook e da conciliação:
 * paga (RECEIVED, CONFIRMED, RECEIVED_IN_CASH) → paga; OVERDUE → vencida; estornada ou removida →
 * cancelada (a removida não cancela parcela já paga); PENDING numa cancelada → volta a valer.
 * Idempotente pelo estado: repetir não muda nada nem gera outra notificação. O link de pagamento
 * devolvido pelo Asaas é sempre atualizado.
 */
export async function applyAsaasPaymentState(
  ctx: AppContext,
  officeId: string,
  inst: InstallmentRow,
  payment: AsaasPayment,
  state: AsaasChargeState | null,
  origin: { source: 'webhook' | 'reconcile'; event?: string; eventId?: string | null },
): Promise<AsaasAction> {
  const { db } = ctx;
  const link = { externalId: payment.id, externalUrl: payment.invoiceUrl ?? payment.bankSlipUrl ?? inst.externalUrl };
  let action: AsaasAction = 'unchanged';
  let patch: Partial<InstallmentRow> = {};

  if (state === 'paid') {
    if (inst.status !== 'paid') {
      patch = {
        status: 'paid',
        paidAt: isoDate(payment.clientPaymentDate) ?? isoDate(payment.paymentDate) ?? isoDate(payment.confirmedDate) ?? todayIso(),
        paidAmountCents: typeof payment.value === 'number' ? decimalToCents(payment.value) : inst.amountCents,
        canceledAt: null,
        cancelReason: null,
      };
      action = 'paid';
    }
  } else if (state === 'overdue') {
    if (inst.status === 'open') {
      patch = { status: 'overdue' };
      action = 'overdue';
    }
  } else if (state === 'refunded' || state === 'deleted') {
    // removida no Asaas (sem pagamento) ou estornada: a parcela deixa de valer
    const applies = state === 'refunded' ? inst.status !== 'canceled' : inst.status !== 'paid' && inst.status !== 'canceled';
    if (applies) {
      patch = { status: 'canceled', canceledAt: new Date(), cancelReason: state === 'refunded' ? 'Pagamento estornado no Asaas' : 'Cobrança removida no Asaas' };
      action = 'canceled';
    }
  } else if (state === 'pending') {
    if (inst.status === 'canceled') {
      patch = { status: inst.dueDate < todayIso() ? 'overdue' : 'open', canceledAt: null, cancelReason: null };
      action = 'restored';
    }
  } else if (link.externalUrl !== inst.externalUrl) {
    action = 'updated';
  }

  const linkChanged = inst.externalId !== link.externalId || inst.externalUrl !== link.externalUrl;
  if (action === 'unchanged' && !linkChanged) return action;

  await db
    .update(installments)
    .set({ ...patch, ...link })
    .where(eq(installments.id, inst.id));

  if (action !== 'unchanged' && action !== 'updated') {
    await db.insert(auditLogs).values({
      officeId,
      userId: null,
      action: `installment.asaas_${action}`,
      entity: 'installment',
      entityId: inst.id,
      data: { source: origin.source, event: origin.event ?? null, eventId: origin.eventId ?? null, status: payment.status ?? null, paymentId: payment.id },
    });
  }
  if (action === 'paid') {
    const customer = await customerOfInstallment(ctx, inst);
    await notify(db, {
      officeId,
      customerId: customer?.id ?? null,
      title: 'Pagamento recebido pelo Asaas',
      body: `${customer?.name ?? 'Cliente'}: parcela ${inst.number} paga (${formatMoney(patch.paidAmountCents ?? inst.amountCents)}).`,
      link: customer ? `/clientes/${customer.id}` : undefined,
    });
  }
  return action;
}

/** O mesmo evento (pelo id do Asaas) já foi tratado para a parcela? A entrega é "pelo menos uma vez". */
async function eventSeen(ctx: AppContext, inst: InstallmentRow, action: string, eventId: string | undefined) {
  if (!eventId) return false;
  const [row] = await ctx.db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.entity, 'installment'), eq(auditLogs.entityId, inst.id), eq(auditLogs.action, action), sql`${auditLogs.data} ->> 'eventId' = ${eventId}`))
    .limit(1);
  return Boolean(row);
}

/** Avisa o escritório no sino sobre algo que aconteceu no Asaas e que a parcela sozinha não mostra. */
async function notifyOfficeAboutCharge(ctx: AppContext, officeId: string, inst: InstallmentRow, evt: AsaasWebhookEvent, auditAction: string, title: string, detail: string) {
  if (await eventSeen(ctx, inst, auditAction, evt.id)) return false;
  const customer = await customerOfInstallment(ctx, inst);
  await ctx.db.insert(auditLogs).values({
    officeId,
    userId: null,
    action: auditAction,
    entity: 'installment',
    entityId: inst.id,
    data: { source: 'webhook', event: evt.event, eventId: evt.id ?? null, paymentId: evt.payment?.id ?? null },
  });
  await notify(ctx.db, {
    officeId,
    customerId: customer?.id ?? null,
    title,
    body: `${customer?.name ?? 'Cliente'}, parcela ${inst.number} (${formatMoney(inst.paidAmountCents ?? inst.amountCents)}): ${detail}`,
    link: customer ? `/clientes/${customer.id}/irpf/orcamento` : undefined,
  });
  return true;
}

/**
 * Aplica um evento de cobrança do Asaas à parcela correspondente.
 * Idempotente pelo estado: repetir o mesmo evento não muda nada nem gera nova notificação
 * (o Asaas entrega "pelo menos uma vez").
 */
export async function handleAsaasWebhook(ctx: AppContext, officeId: string, evt: AsaasWebhookEvent): Promise<AsaasWebhookResult> {
  const { db } = ctx;
  const payment = evt.payment;
  const known = evt.event in EVENT_STATE || evt.event === CASH_UNDONE_EVENT || evt.event in CHARGEBACK_EVENTS;
  if (!known || !payment?.id) return { matched: false, action: 'ignored' };

  let inst = await db.query.installments.findFirst({ where: and(eq(installments.officeId, officeId), eq(installments.externalId, payment.id)) });
  // a cobrança pode ter sido criada sem o id gravado (falha no meio do job): acha pela referência
  if (!inst && isUuid(payment.externalReference)) {
    inst = await db.query.installments.findFirst({ where: and(eq(installments.officeId, officeId), eq(installments.id, payment.externalReference)) });
  }
  if (!inst) return { matched: false, action: 'ignored' };
  const result = (action: AsaasAction): AsaasWebhookResult => ({ matched: true, action, installmentId: inst.id });

  // contestação no cartão: o dinheiro pode voltar ao cliente, mas a parcela só muda se virar estorno
  if (evt.event in CHARGEBACK_EVENTS) {
    const told = await notifyOfficeAboutCharge(ctx, officeId, inst, evt, 'installment.asaas_chargeback', 'Pagamento contestado no Asaas (chargeback)', `${CHARGEBACK_EVENTS[evt.event]} Acompanhe pelo Asaas.`);
    return result(told ? 'notified' : 'unchanged');
  }

  // recebimento em dinheiro desfeito no Asaas: a parcela volta a ficar em aberto, a não ser que já tenha recibo
  if (evt.event === CASH_UNDONE_EVENT) {
    if (inst.status !== 'paid') return result('unchanged');
    if (inst.receiptNumber) {
      const told = await notifyOfficeAboutCharge(
        ctx,
        officeId,
        inst,
        evt,
        'installment.asaas_cash_undone',
        'Recebimento desfeito no Asaas',
        `o recebimento em dinheiro foi desfeito no Asaas, mas a parcela já tem o recibo nº ${String(inst.receiptNumber).padStart(4, '0')} emitido e continua paga no Verifco. Confira com o cliente.`,
      );
      return result(told ? 'notified' : 'unchanged');
    }
    await db
      .update(installments)
      .set({ status: inst.dueDate < todayIso() ? 'overdue' : 'open', paidAt: null, paidAmountCents: null })
      .where(eq(installments.id, inst.id));
    await db.insert(auditLogs).values({
      officeId,
      userId: null,
      action: 'installment.asaas_reopened',
      entity: 'installment',
      entityId: inst.id,
      data: { source: 'webhook', event: evt.event, eventId: evt.id ?? null, paymentId: payment.id },
    });
    return result('reopened');
  }

  return result(await applyAsaasPaymentState(ctx, officeId, inst, payment, EVENT_STATE[evt.event], { source: 'webhook', event: evt.event, eventId: evt.id }));
}

// ---------------------------------------------------------------------------
// Conciliação periódica
// ---------------------------------------------------------------------------
export const ASAAS_RECONCILE_JOB = 'asaas.reconcile_payments';
const RECONCILE_BATCH = 60;
const RECONCILE_INTERVAL_MS = 6 * 3600_000;

/**
 * Agenda a próxima conciliação, mantendo no máximo uma na fila por escritório. A chave de
 * idempotência usa a janela de horário, então agendar de novo na mesma janela não duplica o job.
 */
export async function scheduleAsaasReconcile(ctx: AppContext, officeId: string, delayMs?: number) {
  const queued = await ctx.db.query.jobs.findFirst({
    where: and(eq(jobs.type, ASAAS_RECONCILE_JOB), eq(jobs.officeId, officeId), eq(jobs.status, 'queued')),
  });
  if (queued) return queued;
  const runAt = new Date(Date.now() + (delayMs ?? RECONCILE_INTERVAL_MS));
  const slot = Math.floor(runAt.getTime() / RECONCILE_INTERVAL_MS);
  const job = await ctx.jobs.enqueue(ASAAS_RECONCILE_JOB, { officeId }, { officeId, runAt, idempotencyKey: `${officeId}:${slot}` });
  // a chave desta janela é de uma rodada que já terminou ou está rodando (executada fora de hora): recomeça a cadeia
  if (job.status === 'queued') return job;
  return ctx.jobs.enqueue(ASAAS_RECONCILE_JOB, { officeId }, { officeId, runAt, idempotencyKey: `${officeId}:${slot}:${runAt.getTime()}` });
}

/**
 * Confere no Asaas as parcelas em aberto com cobrança emitida e aplica a mesma regra do webhook
 * (que pode estar mal configurado ou ter perdido um aviso). Até 60 por rodada, em rodízio: as
 * conferidas há mais tempo primeiro (`externalCheckedAt`), para nenhuma ficar para trás.
 * Agenda a próxima rodada antes de começar, para a cadeia não parar se esta falhar.
 */
export async function reconcileAsaasPayments(ctx: AppContext, officeId: string) {
  const { db } = ctx;
  const loaded = await loadIntegration<AsaasConfig, AsaasSecrets>(ctx, officeId, 'asaas');
  if (!loaded || !loaded.row.enabled) return { skipped: true, reason: 'Integração Asaas desativada.' };
  await scheduleAsaasReconcile(ctx, officeId);

  const rows = await db
    .select({ inst: installments })
    .from(installments)
    .innerJoin(billings, eq(billings.id, installments.billingId))
    .where(and(eq(installments.officeId, officeId), eq(billings.provider, 'asaas'), isNotNull(installments.externalId), inArray(installments.status, ['open', 'overdue'])))
    .orderBy(sql`${installments.externalCheckedAt} asc nulls first`, asc(installments.dueDate), asc(installments.id))
    .limit(RECONCILE_BATCH);
  if (!rows.length) return { checked: 0, paid: 0, overdue: 0, canceled: 0, errors: [] as string[] };

  const client = asaasClientFrom(ctx, loaded);
  const counts = { paid: 0, overdue: 0, canceled: 0 };
  const errors: string[] = [];
  let checked = 0;
  for (const { inst } of rows) {
    let payment: AsaasPayment;
    try {
      payment = await client.getPayment(inst.externalId!);
    } catch (err) {
      errors.push(`parcela ${inst.number}: ${errorMessage(err)}`);
      // chave recusada, limite de requisições ou Asaas fora do ar: as demais falhariam igual; ficam para a próxima rodada
      const status = err instanceof IntegrationError ? err.status : undefined;
      if (status === undefined || status === 401 || status === 403 || status === 429 || status >= 500) break;
      // erro só desta cobrança (ex.: não existe mais): marca como conferida para não travar o rodízio
      await db.update(installments).set({ externalCheckedAt: new Date() }).where(eq(installments.id, inst.id));
      checked += 1;
      continue;
    }
    const action = await applyAsaasPaymentState(ctx, officeId, inst, payment, asaasPaymentState(payment), { source: 'reconcile' });
    if (action === 'paid' || action === 'overdue' || action === 'canceled') counts[action] += 1;
    await db.update(installments).set({ externalCheckedAt: new Date() }).where(eq(installments.id, inst.id));
    checked += 1;
  }
  return { checked, ...counts, errors };
}
