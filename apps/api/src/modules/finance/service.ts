/**
 * Regras do financeiro: orçamento → envio → aprovação → faturamento (parcelas) → recibos.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  BUDGET_CATEGORIES,
  applyDiscount,
  buildInstallmentPlan,
  computeBudgetAmount,
  effectiveInstallmentStatus,
  formatMoney,
  todayIso,
  type PriceTableLike,
} from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { billings, budgets, customers, declarations, installments, jobs, paymentMethods, priceTables, users } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { getCustomerForUser } from '../../services/customers';
import { advanceDeclaration, changeDeclarationStatus, getOrCreateDeclaration } from '../../services/declarations';
import { queueDelivery } from '../../services/delivery';
// job do módulo de integrações que emite a cobrança no Asaas/Omie (contrato com o financeiro)
import { BILLING_SYNC_JOB } from '../../integrations/billing-sync';
import { categoryLabel } from './text';

export type BudgetRow = typeof budgets.$inferSelect;
export type BillingRow = typeof billings.$inferSelect;
export type InstallmentRow = typeof installments.$inferSelect;
export type PaymentMethodRow = typeof paymentMethods.$inferSelect;
export type PriceTableRow = typeof priceTables.$inferSelect;

/** Métodos de pagamento que geram cobrança em provedor externo (módulo de integrações). */
export const EXTERNAL_PROVIDERS = ['asaas', 'omie'] as const;

/**
 * Categorias de orçamento que acompanham a declaração IRPF no Kanban. Holding, consultoria,
 * Carnê-Leão etc. são serviços à parte e não mexem no status da declaração.
 */
export const DECLARATION_BUDGET_CATEGORIES = ['irpf', 'irpf_rectification'] as const;
export const movesDeclaration = (b: Pick<BudgetRow, 'category'>) => (DECLARATION_BUDGET_CATEGORIES as readonly string[]).includes(b.category);

/** Validade do link público de aprovação. */
export const APPROVAL_LINK_DAYS = 30;

export const linkExpiresAt = (sentAt: Date | null) => (sentAt ? new Date(sentAt.getTime() + APPROVAL_LINK_DAYS * 86400_000) : null);

export const approvalLink = (ctx: AppContext, token: string) => `${ctx.config.WEB_URL.replace(/\/$/, '')}/orcamento/${token}`;

// ---------------------------------------------------------------------------
// Carregamento com isolamento
// ---------------------------------------------------------------------------

/** Orçamento do escritório cujo cliente o usuário pode ver; 404 caso contrário. */
export async function getBudgetForUser(ctx: AppContext, user: AuthUser, id: string): Promise<BudgetRow> {
  const b = await ctx.db.query.budgets.findFirst({ where: and(eq(budgets.id, id), eq(budgets.officeId, user.officeId)) });
  if (!b) throw notFound('Orçamento');
  try {
    await getCustomerForUser(ctx, user, b.customerId);
  } catch {
    throw notFound('Orçamento');
  }
  return b;
}

export async function getInstallmentForUser(ctx: AppContext, user: AuthUser, id: string) {
  const inst = await ctx.db.query.installments.findFirst({ where: and(eq(installments.id, id), eq(installments.officeId, user.officeId)) });
  if (!inst) throw notFound('Parcela');
  const billing = await ctx.db.query.billings.findFirst({ where: eq(billings.id, inst.billingId) });
  if (!billing) throw notFound('Parcela');
  const budget = await ctx.db.query.budgets.findFirst({ where: eq(budgets.id, billing.budgetId) });
  let customer;
  try {
    customer = await getCustomerForUser(ctx, user, billing.customerId);
  } catch {
    throw notFound('Parcela');
  }
  if (!budget) throw notFound('Parcela');
  return { inst, billing, budget, customer };
}

// ---------------------------------------------------------------------------
// Serialização
// ---------------------------------------------------------------------------

export function serializeInstallment(i: InstallmentRow, today = todayIso()) {
  return {
    id: i.id,
    number: i.number,
    dueDate: i.dueDate,
    amountCents: i.amountCents,
    status: effectiveInstallmentStatus(i.status, i.dueDate, today),
    paidAt: i.paidAt,
    paidAmountCents: i.paidAmountCents,
    receiptNumber: i.receiptNumber,
    receiptFileId: i.receiptFileId,
    receiptSentAt: i.receiptSentAt,
    externalId: i.externalId,
    externalUrl: i.externalUrl,
  };
}

export type SerializedInstallment = ReturnType<typeof serializeInstallment>;

/** Totais de um faturamento: recebido, em aberto e vencido. */
export function billingTotals(list: SerializedInstallment[]) {
  let paid = 0;
  let open = 0;
  let overdue = 0;
  for (const i of list) {
    if (i.status === 'paid') paid += i.paidAmountCents ?? i.amountCents;
    else if (i.status === 'overdue') {
      open += i.amountCents;
      overdue += i.amountCents;
    } else if (i.status === 'open') open += i.amountCents;
  }
  return { paidCents: paid, openCents: open, overdueCents: overdue };
}

/** Situação do pagamento de um orçamento (para filtros e relatório). */
export function paymentStatusOf(list: SerializedInstallment[] | null): 'not_billed' | 'paid' | 'overdue' | 'open' {
  if (!list) return 'not_billed';
  const active = list.filter((i) => i.status !== 'canceled');
  if (active.length && active.every((i) => i.status === 'paid')) return 'paid';
  if (active.some((i) => i.status === 'overdue')) return 'overdue';
  return 'open';
}

/** Situação da emissão da cobrança integrada (último job `billing.sync_external` do faturamento). */
export interface ExternalSyncView {
  status: 'queued' | 'running' | 'done' | 'failed';
  error: string | null;
  attempts: number;
  maxAttempts: number;
  at: Date;
}

/** Último job de emissão de cada faturamento (um só SELECT para a lista toda). */
async function latestSyncJobs(ctx: AppContext, bills: BillingRow[]): Promise<Map<string, ExternalSyncView>> {
  const map = new Map<string, ExternalSyncView>();
  if (!bills.length) return map;
  const billingIds = bills.map((b) => b.id);
  const officeIds = [...new Set(bills.map((b) => b.officeId))];
  const billingIdExpr = sql<string>`${jobs.payload}->>'billingId'`;
  const rows = await ctx.db
    .select({
      billingId: billingIdExpr,
      status: jobs.status,
      error: jobs.error,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      createdAt: jobs.createdAt,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(and(eq(jobs.type, BILLING_SYNC_JOB), inArray(jobs.officeId, officeIds), inArray(billingIdExpr, billingIds)))
    .orderBy(desc(jobs.createdAt));
  for (const r of rows) {
    if (map.has(r.billingId)) continue;
    map.set(r.billingId, {
      status: r.status as ExternalSyncView['status'],
      error: r.error,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      at: r.finishedAt ?? r.createdAt,
    });
  }
  return map;
}

/**
 * Situação da cobrança integrada para a tela: `failed` (a fila desistiu; precisa "Emitir de
 * novo"), `retrying` (falhou e a fila tenta de novo), `pending` (na fila ou emitindo), `missing`
 * (há parcela em aberto sem cobrança e nenhuma emissão pendente) ou `ok`.
 */
export function externalSyncState(provider: string | null, list: SerializedInstallment[], job: ExternalSyncView | null) {
  if (!provider) return null;
  const pending = list.filter((i) => !i.externalId && (i.status === 'open' || i.status === 'overdue')).length;
  let state: 'ok' | 'pending' | 'retrying' | 'failed' | 'missing';
  if (!pending) state = 'ok';
  else if (job?.status === 'failed') state = 'failed';
  else if (job?.status === 'queued' && job.error) state = 'retrying';
  else if (job?.status === 'queued' || job?.status === 'running') state = 'pending';
  else state = 'missing';
  const error = state === 'failed' || state === 'retrying' || state === 'missing' ? (job?.error ?? null) : null;
  return { state, pendingInstallments: pending, error, attempts: job?.attempts ?? 0, maxAttempts: job?.maxAttempts ?? 0, at: job?.at ?? null };
}

/** Monta a resposta dos orçamentos com método, tabela, faturamento e parcelas. */
export async function serializeBudgets(ctx: AppContext, rows: BudgetRow[]) {
  const { db } = ctx;
  if (!rows.length) return [];
  const methodIds = [...new Set(rows.map((r) => r.paymentMethodId).filter((x): x is string => Boolean(x)))];
  const tableIds = [...new Set(rows.map((r) => r.priceTableId).filter((x): x is string => Boolean(x)))];
  // mapas por id: o relatório geral passa todos os orçamentos do ano (nada de find/filter em laço)
  const methods = new Map((methodIds.length ? await db.select().from(paymentMethods).where(inArray(paymentMethods.id, methodIds)) : []).map((m) => [m.id, m]));
  const tables = new Map((tableIds.length ? await db.select().from(priceTables).where(inArray(priceTables.id, tableIds)) : []).map((t) => [t.id, t]));
  const bills = await db.select().from(billings).where(inArray(billings.budgetId, rows.map((r) => r.id)));
  const billByBudget = new Map(bills.map((b) => [b.budgetId, b]));
  const insts = bills.length
    ? await db.select().from(installments).where(inArray(installments.billingId, bills.map((b) => b.id))).orderBy(asc(installments.number))
    : [];
  const instsByBilling = new Map<string, InstallmentRow[]>();
  for (const i of insts) {
    const list = instsByBilling.get(i.billingId);
    if (list) list.push(i);
    else instsByBilling.set(i.billingId, [i]);
  }
  const syncJobs = await latestSyncJobs(ctx, bills.filter((b) => b.provider));
  const today = todayIso();
  return rows.map((b) => {
    const m = b.paymentMethodId ? methods.get(b.paymentMethodId) : undefined;
    const t = b.priceTableId ? tables.get(b.priceTableId) : undefined;
    const bill = billByBudget.get(b.id);
    const list = bill ? (instsByBilling.get(bill.id) ?? []).map((i) => serializeInstallment(i, today)) : null;
    return {
      id: b.id,
      customerId: b.customerId,
      declarationId: b.declarationId,
      exerciseYear: b.exerciseYear,
      type: b.type,
      status: b.status,
      category: b.category,
      categoryLabel: categoryLabel(b.category),
      description: b.description,
      priceTableId: b.priceTableId,
      priceTableName: t?.name ?? null,
      pricingInputs: b.pricingInputs,
      amountCents: b.amountCents,
      discountPercent: Number(b.discountPercent),
      totalCents: b.totalCents,
      paymentMethodId: b.paymentMethodId,
      paymentMethodName: m?.name ?? null,
      paymentMethodType: m?.type ?? null,
      billingStartDate: b.billingStartDate,
      installments: b.installments,
      internalNote: b.internalNote,
      sentAt: b.sentAt,
      linkExpiresAt: b.status === 'sent' && b.approvalTokenHash ? linkExpiresAt(b.sentAt) : null,
      approvedAt: b.approvedAt,
      approvedBy: b.approvedBy,
      rejectedAt: b.rejectedAt,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      paymentStatus: paymentStatusOf(list),
      billing: bill
        ? {
            id: bill.id,
            totalCents: bill.totalCents,
            provider: bill.provider,
            createdAt: bill.createdAt,
            ...billingTotals(list!),
            installments: list!,
            externalSync: externalSyncState(bill.provider, list!, syncJobs.get(bill.id) ?? null),
          }
        : null,
    };
  });
}

export type SerializedBudget = Awaited<ReturnType<typeof serializeBudgets>>[number];

export async function serializeBudget(ctx: AppContext, row: BudgetRow) {
  return (await serializeBudgets(ctx, [row]))[0];
}

// ---------------------------------------------------------------------------
// Valores do orçamento
// ---------------------------------------------------------------------------

export interface BudgetInput {
  type: 'fixed' | 'variable' | 'integration';
  category: keyof typeof BUDGET_CATEGORIES;
  description?: string | null;
  priceTableId?: string | null;
  pricingInputs?: { hours?: number; items?: Record<string, number> };
  amountCents?: number | null;
  discountPercent: number;
  paymentMethodId?: string | null;
  billingStartDate?: string | null;
  installments: number;
  internalNote?: string | null;
}

/** Totais da declaração do exercício usados pelas tabelas percentuais. */
export const pricingTotalsOf = (d: typeof declarations.$inferSelect | null | undefined) =>
  d ? { refundCents: d.refundCents, taxDueCents: d.taxDueCents, assetsTotalCents: d.assetsTotalCents, totalIncomeCents: d.totalIncomeCents } : null;

export const priceTableLike = (t: PriceTableRow): PriceTableLike => ({ type: t.type, active: t.active, validFrom: t.validFrom, validUntil: t.validUntil, config: t.config });

/**
 * Valida as referências (método, tabela), o limite de parcelas e calcula valor e total.
 * Orçamento "variável" sempre usa o valor calculado pela tabela.
 */
export async function resolveBudgetValues(
  ctx: AppContext,
  officeId: string,
  declaration: typeof declarations.$inferSelect,
  input: BudgetInput,
  current?: BudgetRow,
) {
  const { db } = ctx;
  let method: PaymentMethodRow | undefined;
  if (input.paymentMethodId) {
    method = await db.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.id, input.paymentMethodId), eq(paymentMethods.officeId, officeId)) });
    if (!method) throw badRequest('Forma de pagamento inválida.');
    if (!method.active && method.id !== current?.paymentMethodId) throw badRequest('A forma de pagamento está inativa.');
  }
  const max = method?.maxInstallments ?? 1;
  if (input.installments > max) {
    throw badRequest(method ? `${method.name} permite até ${max} parcela(s).` : 'Escolha a forma de pagamento para parcelar.');
  }
  if (input.type === 'integration' && !(method && (EXTERNAL_PROVIDERS as readonly string[]).includes(method.type))) {
    throw badRequest('Orçamento integrado exige uma forma de pagamento do tipo Asaas ou Omie.');
  }
  let table: PriceTableRow | undefined;
  if (input.priceTableId) {
    table = await db.query.priceTables.findFirst({ where: and(eq(priceTables.id, input.priceTableId), eq(priceTables.officeId, officeId)) });
    if (!table) throw badRequest('Tabela de cobrança inválida.');
  }
  let amountCents = input.amountCents ?? null;
  const needsTable = input.type === 'variable' || (table && (amountCents === null || amountCents === undefined));
  if (input.type === 'variable' && !table) throw badRequest('Escolha a tabela de cobrança do orçamento variável.');
  if (needsTable && table) {
    const r = computeBudgetAmount(priceTableLike(table), input.pricingInputs ?? {}, pricingTotalsOf(declaration), todayIso());
    if (!r.ok) throw badRequest(r.error);
    amountCents = r.amountCents;
  }
  if (amountCents === null || amountCents === undefined || amountCents <= 0) throw badRequest('Informe o valor do orçamento.');
  return {
    type: input.type,
    category: input.category,
    description: input.description ?? null,
    priceTableId: table?.id ?? null,
    pricingInputs: input.pricingInputs ?? {},
    amountCents,
    discountPercent: input.discountPercent,
    totalCents: applyDiscount(amountCents, input.discountPercent),
    paymentMethodId: method?.id ?? null,
    billingStartDate: input.billingStartDate ?? null,
    installments: input.installments,
    internalNote: input.internalNote ?? null,
  };
}

async function declarationOf(ctx: AppContext, b: BudgetRow) {
  const d = b.declarationId ? await ctx.db.query.declarations.findFirst({ where: eq(declarations.id, b.declarationId) }) : null;
  return d ?? getOrCreateDeclaration(ctx.db, b.officeId, b.customerId, b.exerciseYear);
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

export type Channel = 'email' | 'whatsapp';

export function assertContacts(customer: typeof customers.$inferSelect, channels: Channel[]) {
  if (channels.includes('email') && !customer.email) throw badRequest('O cliente não tem e-mail cadastrado.');
  if (channels.includes('whatsapp') && !customer.mobile) throw badRequest('O cliente não tem celular cadastrado.');
}

/** Gera um novo link de aprovação (o anterior deixa de valer) e marca como enviado. */
export async function issueApprovalLink(ctx: AppContext, budget: BudgetRow) {
  if (budget.status === 'approved') throw conflict('Este orçamento já foi aprovado.');
  if (budget.status === 'canceled') throw conflict('Orçamento cancelado não pode ser enviado.');
  const token = randomToken(32);
  const now = new Date();
  const [row] = await ctx.db
    .update(budgets)
    .set({ approvalTokenHash: sha256(token), sentAt: now, status: 'sent', rejectedAt: null, updatedAt: now })
    .where(eq(budgets.id, budget.id))
    .returning();
  if (movesDeclaration(row)) await advanceDeclaration(ctx.db, await declarationOf(ctx, row), 'budget_sent');
  return { budget: row, token, link: approvalLink(ctx, token) };
}

const valueText = (b: BudgetRow) =>
  b.installments > 1 ? `${formatMoney(b.totalCents)} (${b.installments}x de ${formatMoney(Math.ceil(b.totalCents / b.installments))})` : formatMoney(b.totalCents);

/** Envia a proposta por e-mail e/ou WhatsApp com o link de aprovação (template `budget_digital`). */
export async function sendBudget(ctx: AppContext, budget: BudgetRow, channels: Channel[], userId: string | null) {
  if (!channels.length) throw badRequest('Escolha ao menos um canal de envio.');
  const customer = await ctx.db.query.customers.findFirst({ where: eq(customers.id, budget.customerId) });
  if (!customer) throw notFound('Cliente');
  assertContacts(customer, channels);
  const issued = await issueApprovalLink(ctx, budget);
  const b = issued.budget;
  const values = { CATEGORIA: categoryLabel(b.category), DESCRICAO: b.description ?? '', VALOR: valueText(b), LINK: issued.link };
  const tokenKey = sha256(issued.token).slice(0, 16);
  for (const channel of channels) {
    await queueDelivery(ctx, {
      officeId: b.officeId,
      customerId: b.customerId,
      channel,
      templateKey: 'budget_digital',
      values,
      exerciseYear: b.exerciseYear,
      idempotencyKey: `budget:${b.id}:${channel}:${tokenKey}`,
      userId,
    });
  }
  return issued;
}

// ---------------------------------------------------------------------------
// Aprovação e faturamento
// ---------------------------------------------------------------------------

/**
 * Aprova o orçamento e gera o faturamento uma única vez (índice único por orçamento;
 * a segunda aprovação concorrente encontra o faturamento já criado).
 */
export async function approveBudget(ctx: AppContext, budget: BudgetRow, approvedBy: string) {
  const { db } = ctx;
  if (budget.status === 'canceled') throw conflict('Orçamento cancelado não pode ser aprovado.');
  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(budgets)
      .set({ status: 'approved', approvedAt: now, approvedBy, rejectedAt: null, billingStartDate: budget.billingStartDate ?? todayIso(), updatedAt: now })
      .where(and(eq(budgets.id, budget.id), ne(budgets.status, 'approved'), ne(budgets.status, 'canceled')))
      .returning();
    const current = updated ?? (await tx.query.budgets.findFirst({ where: eq(budgets.id, budget.id) }));
    if (!current) throw notFound('Orçamento');
    if (current.status !== 'approved') throw conflict('Orçamento cancelado não pode ser aprovado.');
    const method = current.paymentMethodId ? await tx.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, current.paymentMethodId) }) : null;
    const provider = method && (EXTERNAL_PROVIDERS as readonly string[]).includes(method.type) ? method.type : null;
    const [created] = await tx
      .insert(billings)
      .values({ officeId: current.officeId, budgetId: current.id, customerId: current.customerId, totalCents: current.totalCents, provider })
      .onConflictDoNothing({ target: billings.budgetId })
      .returning();
    if (created) {
      const plan = buildInstallmentPlan(current.totalCents, current.installments, current.billingStartDate ?? todayIso());
      await tx.insert(installments).values(plan.map((p) => ({ officeId: current.officeId, billingId: created.id, ...p })));
      return { budget: current, billing: created, created: true };
    }
    const existing = await tx.query.billings.findFirst({ where: eq(billings.budgetId, current.id) });
    if (!existing) throw conflict('Não foi possível gerar o faturamento. Tente novamente.');
    return { budget: current, billing: existing, created: false };
  });
  if (result.created) {
    if (result.billing.provider) {
      // contrato com o módulo de integrações: ele emite a cobrança e grava externalId/externalUrl nas parcelas
      await ctx.jobs.enqueue(BILLING_SYNC_JOB, { billingId: result.billing.id }, { officeId: result.budget.officeId, idempotencyKey: result.billing.id });
    }
    if (movesDeclaration(result.budget)) await advanceDeclaration(db, await declarationOf(ctx, result.budget), 'budget_approved');
  }
  return result;
}

/**
 * "Emitir de novo": enfileira outra vez a emissão da cobrança integrada com uma chave nova (a
 * fila devolve o job antigo para a mesma chave, inclusive quando ele falhou). Seguro repetir:
 * o executor só trata parcelas em aberto sem `externalId` e usa o id da parcela como referência
 * no provedor. Não duplica quando já há uma emissão na fila.
 */
export async function retryExternalBilling(ctx: AppContext, billing: BillingRow, userId: string | null) {
  if (!billing.provider) throw badRequest('Este faturamento não tem cobrança integrada.');
  const pending = await ctx.db
    .select({ id: installments.id })
    .from(installments)
    .where(and(eq(installments.billingId, billing.id), isNull(installments.externalId), inArray(installments.status, ['open', 'overdue'])))
    .limit(1);
  if (!pending.length) throw conflict('Todas as parcelas em aberto já têm cobrança emitida.');
  const running = await ctx.db.query.jobs.findFirst({
    where: and(
      eq(jobs.type, BILLING_SYNC_JOB),
      eq(jobs.officeId, billing.officeId),
      sql`${jobs.payload}->>'billingId' = ${billing.id}`,
      inArray(jobs.status, ['queued', 'running']),
    ),
  });
  if (running) return { job: running, alreadyQueued: true };
  const job = await ctx.jobs.enqueue(BILLING_SYNC_JOB, { billingId: billing.id }, { officeId: billing.officeId, userId, idempotencyKey: `${billing.id}:retry:${randomUUID()}` });
  return { job, alreadyQueued: false };
}

/**
 * Orçamento IRPF recusado, cancelado, de volta a rascunho ou excluído: se a declaração só tinha
 * andado por causa dele ("Orçamento enviado") e não há outro orçamento IRPF enviado ou aprovado
 * no exercício, ela volta para "Não iniciado". Qualquer outro andamento é mantido.
 */
export async function rewindDeclarationAfterBudget(ctx: AppContext, budget: BudgetRow) {
  if (!movesDeclaration(budget)) return;
  const decl = await ctx.db.query.declarations.findFirst({
    where: budget.declarationId
      ? eq(declarations.id, budget.declarationId)
      : and(eq(declarations.customerId, budget.customerId), eq(declarations.exerciseYear, budget.exerciseYear)),
  });
  if (!decl || decl.substatus !== 'budget_sent') return;
  const others = await ctx.db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(
        eq(budgets.officeId, budget.officeId),
        eq(budgets.customerId, budget.customerId),
        eq(budgets.exerciseYear, budget.exerciseYear),
        ne(budgets.id, budget.id),
        inArray(budgets.category, [...DECLARATION_BUDGET_CATEGORIES]),
        inArray(budgets.status, ['sent', 'approved']),
      ),
    )
    .limit(1);
  if (others.length) return;
  await changeDeclarationStatus(ctx.db, decl, 'not_started', { by: 'system' });
}

export async function rejectBudget(ctx: AppContext, budget: BudgetRow) {
  if (budget.status === 'approved') throw conflict('Orçamento aprovado não pode ser recusado.');
  if (budget.status === 'canceled') throw conflict('Orçamento cancelado não pode ser recusado.');
  if (budget.status === 'rejected') return budget;
  const now = new Date();
  const [row] = await ctx.db.update(budgets).set({ status: 'rejected', rejectedAt: now, updatedAt: now }).where(eq(budgets.id, budget.id)).returning();
  await rewindDeclarationAfterBudget(ctx, row);
  return row;
}

/** Aplica a mudança de status pedida no formulário (aprovar gera o faturamento). */
export async function applyStatus(ctx: AppContext, budget: BudgetRow, status: string, approvedBy: string) {
  if (status === budget.status) return budget;
  switch (status) {
    case 'approved':
      return (await approveBudget(ctx, budget, approvedBy)).budget;
    case 'sent':
      return (await issueApprovalLink(ctx, budget)).budget;
    case 'rejected':
      return rejectBudget(ctx, budget);
    case 'draft':
    case 'canceled': {
      if (budget.status === 'approved') throw conflict('Orçamento aprovado não pode voltar de status.');
      const [row] = await ctx.db.update(budgets).set({ status, updatedAt: new Date() }).where(eq(budgets.id, budget.id)).returning();
      await rewindDeclarationAfterBudget(ctx, row);
      return row;
    }
    default:
      throw badRequest('Status inválido.');
  }
}

/** Orçamento do ano anterior para referência (prefere o aprovado mais recente). */
export async function previousYearBudget(ctx: AppContext, officeId: string, customerId: string, year: number) {
  const rows = await ctx.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.officeId, officeId), eq(budgets.customerId, customerId), eq(budgets.exerciseYear, year - 1)))
    .orderBy(desc(budgets.createdAt));
  const pick = rows.find((r) => r.status === 'approved') ?? rows.find((r) => r.status !== 'canceled') ?? null;
  return pick ? serializeBudget(ctx, pick) : null;
}

/** Recalcula o total do faturamento a partir das parcelas. */
export async function refreshBillingTotal(ctx: AppContext, billingId: string) {
  const [{ total }] = await ctx.db
    .select({ total: sql<number>`coalesce(sum(${installments.amountCents}), 0)` })
    .from(installments)
    .where(and(eq(installments.billingId, billingId), ne(installments.status, 'canceled')));
  await ctx.db.update(billings).set({ totalCents: Number(total) }).where(eq(billings.id, billingId));
}

/** Próximo número de recibo do escritório (sequencial, sob trava para não repetir). */
export async function assignReceiptNumber(ctx: AppContext, officeId: string, installmentId: string): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`receipt:${officeId}`}, 0))`);
    const fresh = await tx.query.installments.findFirst({ where: eq(installments.id, installmentId) });
    if (fresh?.receiptNumber) return fresh.receiptNumber;
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${installments.receiptNumber}), 0)` })
      .from(installments)
      .where(eq(installments.officeId, officeId));
    const next = Number(max) + 1;
    await tx.update(installments).set({ receiptNumber: next }).where(eq(installments.id, installmentId));
    return next;
  });
}

export async function userName(ctx: AppContext, userId: string) {
  const u = await ctx.db.query.users.findFirst({ where: eq(users.id, userId) });
  return u?.name ?? 'Usuário';
}
