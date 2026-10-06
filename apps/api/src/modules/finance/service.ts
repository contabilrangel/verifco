/**
 * Regras do financeiro: orçamento → envio → aprovação → faturamento (parcelas) → recibos.
 */
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
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
import { billings, budgets, customers, declarations, installments, paymentMethods, priceTables, users } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { getCustomerForUser } from '../../services/customers';
import { advanceDeclaration, getOrCreateDeclaration, setDeclarationSubstatus } from '../../services/declarations';
import { queueDelivery } from '../../services/delivery';
import { categoryLabel } from './text';

export type BudgetRow = typeof budgets.$inferSelect;
export type BillingRow = typeof billings.$inferSelect;
export type InstallmentRow = typeof installments.$inferSelect;
export type PaymentMethodRow = typeof paymentMethods.$inferSelect;
export type PriceTableRow = typeof priceTables.$inferSelect;

/** Métodos de pagamento que geram cobrança em provedor externo (módulo de integrações). */
export const EXTERNAL_PROVIDERS = ['asaas', 'omie'] as const;

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

/** Monta a resposta dos orçamentos com método, tabela, faturamento e parcelas. */
export async function serializeBudgets(ctx: AppContext, rows: BudgetRow[]) {
  const { db } = ctx;
  if (!rows.length) return [];
  const methodIds = [...new Set(rows.map((r) => r.paymentMethodId).filter((x): x is string => Boolean(x)))];
  const tableIds = [...new Set(rows.map((r) => r.priceTableId).filter((x): x is string => Boolean(x)))];
  const methods = methodIds.length ? await db.select().from(paymentMethods).where(inArray(paymentMethods.id, methodIds)) : [];
  const tables = tableIds.length ? await db.select().from(priceTables).where(inArray(priceTables.id, tableIds)) : [];
  const bills = await db.select().from(billings).where(inArray(billings.budgetId, rows.map((r) => r.id)));
  const insts = bills.length
    ? await db.select().from(installments).where(inArray(installments.billingId, bills.map((b) => b.id))).orderBy(asc(installments.number))
    : [];
  const today = todayIso();
  return rows.map((b) => {
    const m = methods.find((x) => x.id === b.paymentMethodId);
    const t = tables.find((x) => x.id === b.priceTableId);
    const bill = bills.find((x) => x.budgetId === b.id);
    const list = bill ? insts.filter((i) => i.billingId === bill.id).map((i) => serializeInstallment(i, today)) : null;
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
        ? { id: bill.id, totalCents: bill.totalCents, provider: bill.provider, createdAt: bill.createdAt, ...billingTotals(list!), installments: list! }
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

/** Só os orçamentos da própria declaração (IRPF e retificação) movem a etapa dela no Kanban. */
const IRPF_BUDGET_CATEGORIES = ['irpf', 'irpf_rectification'];
const movesDeclaration = (b: BudgetRow) => IRPF_BUDGET_CATEGORIES.includes(b.category);

/**
 * Proposta IRPF enviada que foi recusada, cancelada, voltou a rascunho ou foi excluída (`b` é a
 * linha anterior à mudança): a declaração que estava em "Orçamento enviado" volta para
 * "Não iniciado" se não houver outro orçamento IRPF enviado ou aprovado no exercício.
 */
export async function releaseDeclarationStage(ctx: AppContext, b: BudgetRow) {
  if (!movesDeclaration(b) || b.status !== 'sent') return;
  const { db } = ctx;
  const decl = await db.query.declarations.findFirst({ where: and(eq(declarations.customerId, b.customerId), eq(declarations.exerciseYear, b.exerciseYear)) });
  if (decl?.substatus !== 'budget_sent') return;
  const [other] = await db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(
        eq(budgets.officeId, b.officeId),
        eq(budgets.customerId, b.customerId),
        eq(budgets.exerciseYear, b.exerciseYear),
        ne(budgets.id, b.id),
        inArray(budgets.category, IRPF_BUDGET_CATEGORIES),
        inArray(budgets.status, ['sent', 'approved']),
      ),
    )
    .limit(1);
  if (!other) await setDeclarationSubstatus(db, decl.id, 'not_started');
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

/** Valores do template `budget_digital` (proposta com o link de aprovação); também usados pela mala direta. */
export const budgetDigitalValues = (b: BudgetRow, link: string) => ({ CATEGORIA: categoryLabel(b.category), DESCRICAO: b.description ?? '', VALOR: valueText(b), LINK: link });

/** Envia a proposta por e-mail e/ou WhatsApp com o link de aprovação (template `budget_digital`). */
export async function sendBudget(ctx: AppContext, budget: BudgetRow, channels: Channel[], userId: string | null) {
  if (!channels.length) throw badRequest('Escolha ao menos um canal de envio.');
  const customer = await ctx.db.query.customers.findFirst({ where: eq(customers.id, budget.customerId) });
  if (!customer) throw notFound('Cliente');
  assertContacts(customer, channels);
  const issued = await issueApprovalLink(ctx, budget);
  const b = issued.budget;
  const values = budgetDigitalValues(b, issued.link);
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
      await ctx.jobs.enqueue('billing.sync_external', { billingId: result.billing.id }, { officeId: result.budget.officeId, idempotencyKey: result.billing.id });
    }
    if (movesDeclaration(result.budget)) await advanceDeclaration(db, await declarationOf(ctx, result.budget), 'budget_approved');
  }
  return result;
}

export async function rejectBudget(ctx: AppContext, budget: BudgetRow) {
  if (budget.status === 'approved') throw conflict('Orçamento aprovado não pode ser recusado.');
  if (budget.status === 'canceled') throw conflict('Orçamento cancelado não pode ser recusado.');
  if (budget.status === 'rejected') return budget;
  const now = new Date();
  const [row] = await ctx.db.update(budgets).set({ status: 'rejected', rejectedAt: now, updatedAt: now }).where(eq(budgets.id, budget.id)).returning();
  await releaseDeclarationStage(ctx, budget);
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
      await releaseDeclarationStage(ctx, budget);
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
