/**
 * Cliente da API v3 do Asaas e regras de cobrança das parcelas.
 *
 * Documentação oficial (docs.asaas.com):
 * - Autenticação: cabeçalho `access_token` + `User-Agent`; sandbox https://api-sandbox.asaas.com/v3,
 *   produção https://api.asaas.com/v3 (https://docs.asaas.com/docs/autenticacao).
 * - Clientes: GET/POST /v3/customers e PUT /v3/customers/{id}
 *   (https://docs.asaas.com/reference/criar-novo-cliente, .../atualizar-cliente-existente).
 * - Cobranças: POST /v3/payments e GET /v3/payments?externalReference=
 *   (https://docs.asaas.com/reference/criar-nova-cobranca, .../listar-cobrancas).
 * - Webhooks: token no cabeçalho `asaas-access-token`, entrega "pelo menos uma vez"
 *   (https://docs.asaas.com/docs/sobre-os-webhooks, .../webhook-para-cobrancas).
 */
import { and, eq } from 'drizzle-orm';
import { formatMoney, onlyDigits } from '@verifco/shared';
import type { AppContext } from '../context';
import { auditLogs, billings, customers, installments } from '../db/schema';
import { notify } from '../services/notify';
import { IntegrationError, centsToDecimal, decimalToCents, ensureOk, httpRequest, todayIso } from './http';
import type { LoadedIntegration } from './store';

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
  return { provider: 'asaas', customerId, created, reused };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
export interface AsaasWebhookEvent {
  id?: string;
  event: string;
  dateCreated?: string;
  payment?: AsaasPayment;
}

export type AsaasWebhookResult = { matched: boolean; action: 'paid' | 'overdue' | 'canceled' | 'restored' | 'updated' | 'unchanged' | 'ignored'; installmentId?: string };

const PAID_EVENTS = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED']);
const CANCEL_EVENTS = new Set(['PAYMENT_DELETED', 'PAYMENT_REFUNDED']);
const HANDLED_EVENTS = new Set([...PAID_EVENTS, ...CANCEL_EVENTS, 'PAYMENT_OVERDUE', 'PAYMENT_RESTORED', 'PAYMENT_UPDATED']);

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/**
 * Aplica um evento de cobrança do Asaas à parcela correspondente.
 * Idempotente pelo estado: repetir o mesmo evento não muda nada nem gera nova notificação
 * (o Asaas entrega "pelo menos uma vez").
 */
export async function handleAsaasWebhook(ctx: AppContext, officeId: string, evt: AsaasWebhookEvent): Promise<AsaasWebhookResult> {
  const { db } = ctx;
  const payment = evt.payment;
  if (!HANDLED_EVENTS.has(evt.event) || !payment?.id) return { matched: false, action: 'ignored' };

  let inst = await db.query.installments.findFirst({ where: and(eq(installments.officeId, officeId), eq(installments.externalId, payment.id)) });
  // a cobrança pode ter sido criada sem o id gravado (falha no meio do job): acha pela referência
  if (!inst && isUuid(payment.externalReference)) {
    inst = await db.query.installments.findFirst({ where: and(eq(installments.officeId, officeId), eq(installments.id, payment.externalReference)) });
  }
  if (!inst) return { matched: false, action: 'ignored' };

  const link = { externalId: payment.id, externalUrl: payment.invoiceUrl ?? payment.bankSlipUrl ?? inst.externalUrl };
  let action: AsaasWebhookResult['action'] = 'unchanged';
  let patch: Partial<InstallmentRow> = {};

  if (PAID_EVENTS.has(evt.event)) {
    if (inst.status !== 'paid') {
      patch = {
        status: 'paid',
        paidAt: isoDate(payment.clientPaymentDate) ?? isoDate(payment.paymentDate) ?? isoDate(payment.confirmedDate) ?? todayIso(),
        paidAmountCents: typeof payment.value === 'number' ? decimalToCents(payment.value) : inst.amountCents,
      };
      action = 'paid';
    }
  } else if (evt.event === 'PAYMENT_OVERDUE') {
    if (inst.status === 'open') {
      patch = { status: 'overdue' };
      action = 'overdue';
    }
  } else if (CANCEL_EVENTS.has(evt.event)) {
    // removida no Asaas (sem pagamento) ou estornada: a parcela deixa de valer
    const applies = evt.event === 'PAYMENT_REFUNDED' ? inst.status !== 'canceled' : inst.status !== 'paid' && inst.status !== 'canceled';
    if (applies) {
      patch = { status: 'canceled' };
      action = 'canceled';
    }
  } else if (evt.event === 'PAYMENT_RESTORED') {
    if (inst.status === 'canceled') {
      patch = { status: inst.dueDate < todayIso() ? 'overdue' : 'open' };
      action = 'restored';
    }
  } else if (evt.event === 'PAYMENT_UPDATED') {
    if (link.externalUrl !== inst.externalUrl) action = 'updated';
  }

  const linkChanged = inst.externalId !== link.externalId || inst.externalUrl !== link.externalUrl;
  if (action === 'unchanged' && !linkChanged) return { matched: true, action, installmentId: inst.id };

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
      data: { event: evt.event, eventId: evt.id ?? null, paymentId: payment.id },
    });
  }
  if (action === 'paid') {
    const billing = await db.query.billings.findFirst({ where: eq(billings.id, inst.billingId) });
    const customer = billing ? await db.query.customers.findFirst({ where: eq(customers.id, billing.customerId) }) : null;
    await notify(db, {
      officeId,
      title: 'Pagamento recebido pelo Asaas',
      body: `${customer?.name ?? 'Cliente'}: parcela ${inst.number} paga (${formatMoney(patch.paidAmountCents ?? inst.amountCents)}).`,
      link: customer ? `/clientes/${customer.id}` : undefined,
    });
  }
  return { matched: true, action, installmentId: inst.id };
}
