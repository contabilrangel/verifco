/**
 * Cliente da API do Omie (JSON) e regras das contas a receber.
 *
 * Documentação oficial (developer.omie.com.br / app.omie.com.br/api/v1):
 * - Formato: POST JSON `{ call, app_key, app_secret, param: [ {...} ] }` (https://developer.omie.com.br/service-list/).
 * - Clientes: https://app.omie.com.br/api/v1/geral/clientes/ — UpsertCliente / ListarClientes
 *   (chave de integração `codigo_cliente_integracao`; resposta `codigo_cliente_omie`).
 * - Contas a receber: https://app.omie.com.br/api/v1/financas/contareceber/ — UpsertContaReceber
 *   (inclusão idempotente pelo `codigo_lancamento_integracao`) e ConsultarContaReceber (`status_titulo`
 *   e `recebimento` com a baixa). Datas no formato dd/mm/aaaa.
 * - Limites: até 240 requisições/min, sem inclusões simultâneas e bloqueio de requisições idênticas
 *   repetidas em 60 s (https://ajuda.omie.com.br/pt-BR/articles/8001888-tratando-os-erros-de-api).
 */
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { formatCpfCnpj, formatMoney, onlyDigits } from '@verifco/shared';
import type { AppContext } from '../context';
import { auditLogs, billings, customers, installments, jobs } from '../db/schema';
import { notify } from '../services/notify';
import { IntegrationError, centsToDecimal, decimalToCents, errorMessage, httpRequest, todayIso } from './http';
import { loadIntegration, type LoadedIntegration } from './store';

export interface OmieConfig {
  categoryCode: string;
  bankAccountId: number | string;
  pollHours?: string;
}
export interface OmieSecrets {
  appKey?: string;
  appSecret?: string;
}

export const OMIE_BASE_URL = 'https://app.omie.com.br/api/v1';
const OMIE_TIMEOUT_MS = 30_000;

interface OmieStatus {
  codigo_status?: string;
  descricao_status?: string;
}

export class OmieClient {
  constructor(
    private fetchImpl: typeof fetch,
    private appKey: string,
    private appSecret: string,
  ) {}

  /** Chamada genérica: o Omie devolve 500 com `faultstring` quando algo falha. */
  async call<T>(path: string, call: string, param: Record<string, unknown>): Promise<T> {
    const res = await httpRequest<T & OmieStatus & { faultstring?: string; faultcode?: string }>(this.fetchImpl, 'omie', `${OMIE_BASE_URL}/${path}/`, {
      method: 'POST',
      body: { call, app_key: this.appKey, app_secret: this.appSecret, param: [param] },
      timeoutMs: OMIE_TIMEOUT_MS,
    });
    const data = res.data as (T & OmieStatus & { faultstring?: string }) | string | null;
    const fault = data && typeof data === 'object' ? data.faultstring : null;
    if (!res.ok || fault) {
      const msg = fault ?? (typeof data === 'string' && data ? data.slice(0, 300) : `HTTP ${res.status}`);
      const auth = /app_key|app_secret|chave de acesso|n[ãa]o autorizad/i.test(String(msg));
      throw new IntegrationError('omie', auth ? `Credenciais recusadas pelo Omie: ${msg}` : `Omie (${call}): ${msg}`, res.status, data);
    }
    const status = (data as OmieStatus | null)?.codigo_status;
    if (status !== undefined && status !== null && String(status) !== '0') {
      throw new IntegrationError('omie', `Omie (${call}): ${(data as OmieStatus).descricao_status ?? `código ${status}`}`, res.status, data);
    }
    return data as T;
  }

  ping() {
    return this.call<{ total_de_registros?: number }>('geral/clientes', 'ListarClientes', { pagina: 1, registros_por_pagina: 1, apenas_importado_api: 'N' });
  }

  upsertCliente(cadastro: Record<string, unknown>) {
    return this.call<{ codigo_cliente_omie: number; codigo_cliente_integracao: string }>('geral/clientes', 'UpsertCliente', cadastro);
  }

  upsertContaReceber(conta: Record<string, unknown>) {
    return this.call<{ codigo_lancamento_omie: number; codigo_lancamento_integracao: string }>('financas/contareceber', 'UpsertContaReceber', conta);
  }

  consultarContaReceber(codigoIntegracao: string) {
    return this.call<OmieContaReceber & { conta_receber_cadastro?: OmieContaReceber }>('financas/contareceber', 'ConsultarContaReceber', {
      codigo_lancamento_integracao: codigoIntegracao,
    });
  }
}

export interface OmieContaReceber {
  codigo_lancamento_omie?: number;
  codigo_lancamento_integracao?: string;
  status_titulo?: string;
  valor_documento?: number;
  recebimento?: { valor?: number; data?: string }[] | { valor?: number; data?: string };
}

export function omieClientFrom(ctx: AppContext, loaded: LoadedIntegration<OmieConfig, OmieSecrets>) {
  const { appKey, appSecret } = loaded.secrets;
  if (!appKey || !appSecret) throw new IntegrationError('omie', 'Informe a App Key e o App Secret do Omie em Administração › Integrações.');
  return new OmieClient(ctx.providers.fetch, appKey, appSecret);
}

export async function testOmie(ctx: AppContext, loaded: LoadedIntegration<OmieConfig, OmieSecrets>) {
  await omieClientFrom(ctx, loaded).ping();
  return 'Conexão com o Omie funcionando.';
}

/** AAAA-MM-DD → dd/mm/aaaa (formato do Omie). */
export const toOmieDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** dd/mm/aaaa → AAAA-MM-DD. */
export const fromOmieDate = (br: string | undefined | null) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

type CustomerRow = typeof customers.$inferSelect;
type InstallmentRow = typeof installments.$inferSelect;

/** Cadastra/atualiza o cliente no Omie (chave de integração = id do cliente no Verifco). */
export async function upsertOmieCustomer(ctx: AppContext, client: OmieClient, customer: CustomerRow): Promise<number> {
  const mobile = onlyDigits(customer.mobile);
  const cadastro: Record<string, unknown> = {
    codigo_cliente_integracao: customer.id,
    razao_social: customer.name.slice(0, 60),
    nome_fantasia: customer.name.slice(0, 100),
    cnpj_cpf: formatCpfCnpj(customer.cpfCnpj),
  };
  if (customer.email) cadastro.email = customer.email;
  if (mobile.length >= 10) {
    cadastro.telefone1_ddd = mobile.slice(0, 2);
    cadastro.telefone1_numero = mobile.slice(2);
  }
  const r = await client.upsertCliente(cadastro);
  const omieId = String(r.codigo_cliente_omie);
  if (customer.externalRefs?.omieId !== omieId) {
    await ctx.db
      .update(customers)
      .set({ externalRefs: { ...(customer.externalRefs ?? {}), omieId } })
      .where(eq(customers.id, customer.id));
  }
  return r.codigo_cliente_omie;
}

/** Inclui uma conta a receber por parcela pendente e grava o código do Omie em `externalId`. */
export async function createOmieReceivables(
  ctx: AppContext,
  loaded: LoadedIntegration<OmieConfig, OmieSecrets>,
  input: { customer: CustomerRow; pending: InstallmentRow[]; totalInstallments: number; description: string; progress?: (pct: number) => Promise<void> },
) {
  const client = omieClientFrom(ctx, loaded);
  const accountId = Number(loaded.config.bankAccountId);
  if (!loaded.config.categoryCode || !Number.isFinite(accountId)) {
    throw new IntegrationError('omie', 'Informe a categoria de receita e a conta corrente do Omie em Administração › Integrações.');
  }
  const omieCustomerId = await upsertOmieCustomer(ctx, client, input.customer);
  let created = 0;
  // chamadas em sequência: o Omie não aceita inclusões simultâneas
  for (const [i, inst] of input.pending.entries()) {
    const due = toOmieDate(inst.dueDate);
    const r = await client.upsertContaReceber({
      codigo_lancamento_integracao: inst.id,
      codigo_cliente_fornecedor: omieCustomerId,
      data_vencimento: due,
      data_previsao: due,
      valor_documento: centsToDecimal(inst.amountCents),
      codigo_categoria: loaded.config.categoryCode,
      id_conta_corrente: accountId,
      numero_documento: `VF-${inst.billingId.slice(0, 8)}-${inst.number}`.slice(0, 20),
      observacao: `${input.description} (parcela ${inst.number}/${input.totalInstallments})`,
    });
    await ctx.db
      .update(installments)
      .set({ externalId: String(r.codigo_lancamento_omie) })
      .where(eq(installments.id, inst.id));
    created += 1;
    await input.progress?.(((i + 1) / input.pending.length) * 100);
  }
  await scheduleOmiePoll(ctx, input.customer.officeId, loaded.config);
  return { provider: 'omie', customerId: String(omieCustomerId), created };
}

// ---------------------------------------------------------------------------
// Consulta periódica dos pagamentos
// ---------------------------------------------------------------------------
export const OMIE_POLL_JOB = 'omie.poll_payments';
const POLL_BATCH = 60;

const pollIntervalMs = (cfg: Partial<OmieConfig>) => Math.max(1, Number(cfg.pollHours ?? 6) || 6) * 3600_000;

/**
 * Agenda a próxima consulta, mantendo no máximo uma na fila por escritório
 * (mudar o intervalo não cria uma segunda cadeia). A chave de idempotência usa a
 * janela de horário, então agendar de novo na mesma janela não duplica o job.
 */
export async function scheduleOmiePoll(ctx: AppContext, officeId: string, cfg: Partial<OmieConfig>, delayMs?: number) {
  const queued = await ctx.db.query.jobs.findFirst({
    where: and(eq(jobs.type, OMIE_POLL_JOB), eq(jobs.officeId, officeId), eq(jobs.status, 'queued')),
  });
  if (queued) return queued;
  const interval = pollIntervalMs(cfg);
  const runAt = new Date(Date.now() + (delayMs ?? interval));
  const slot = Math.floor(runAt.getTime() / interval);
  return ctx.jobs.enqueue(OMIE_POLL_JOB, { officeId }, { officeId, runAt, idempotencyKey: `${officeId}:${interval}:${slot}` });
}

const normalizeStatus = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

/**
 * Consulta no Omie as parcelas em aberto lançadas lá e marca as pagas.
 * Agenda a próxima rodada antes de começar, para a cadeia não parar se esta falhar.
 */
export async function pollOmiePayments(ctx: AppContext, officeId: string) {
  const { db } = ctx;
  const loaded = await loadIntegration<OmieConfig, OmieSecrets>(ctx, officeId, 'omie');
  if (!loaded || !loaded.row.enabled) return { skipped: true, reason: 'Integração Omie desativada.' };
  await scheduleOmiePoll(ctx, officeId, loaded.config);

  const rows = await db
    .select({ inst: installments, customerId: billings.customerId })
    .from(installments)
    .innerJoin(billings, eq(billings.id, installments.billingId))
    .where(
      and(
        eq(installments.officeId, officeId),
        eq(billings.provider, 'omie'),
        isNotNull(installments.externalId),
        inArray(installments.status, ['open', 'overdue']),
      ),
    )
    .orderBy(asc(installments.dueDate))
    .limit(POLL_BATCH);
  if (!rows.length) return { checked: 0, paid: 0 };

  const client = omieClientFrom(ctx, loaded);
  const today = todayIso();
  let paid = 0;
  let canceled = 0;
  const errors: string[] = [];
  for (const { inst, customerId } of rows) {
    let conta: OmieContaReceber;
    try {
      const r = await client.consultarContaReceber(inst.id);
      conta = r.conta_receber_cadastro ?? r;
    } catch (err) {
      errors.push(`parcela ${inst.number}: ${errorMessage(err)}`);
      continue;
    }
    const status = normalizeStatus(conta.status_titulo);
    if (status.includes('RECEBIDO') || status.includes('LIQUIDADO') || status === 'PAGO') {
      const receipts = Array.isArray(conta.recebimento) ? conta.recebimento : conta.recebimento ? [conta.recebimento] : [];
      const total = receipts.reduce((s, r) => s + (Number(r.valor) || 0), 0);
      const lastDate = receipts.map((r) => fromOmieDate(r.data)).filter(Boolean).sort().pop();
      const paidAmountCents = total > 0 ? decimalToCents(total) : inst.amountCents;
      await db
        .update(installments)
        .set({ status: 'paid', paidAt: lastDate ?? today, paidAmountCents })
        .where(and(eq(installments.id, inst.id), inArray(installments.status, ['open', 'overdue'])));
      await db.insert(auditLogs).values({ officeId, userId: null, action: 'installment.omie_paid', entity: 'installment', entityId: inst.id, data: { status: conta.status_titulo } });
      const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
      await notify(db, {
        officeId,
        title: 'Pagamento baixado no Omie',
        body: `${customer?.name ?? 'Cliente'}: parcela ${inst.number} paga (${formatMoney(paidAmountCents)}).`,
        link: `/clientes/${customerId}`,
      });
      paid += 1;
    } else if (status.includes('CANCELADO')) {
      await db.update(installments).set({ status: 'canceled' }).where(eq(installments.id, inst.id));
      canceled += 1;
    } else if (status.includes('ATRASADO') && inst.status === 'open') {
      await db.update(installments).set({ status: 'overdue' }).where(eq(installments.id, inst.id));
    }
  }
  return { checked: rows.length, paid, canceled, errors };
}
