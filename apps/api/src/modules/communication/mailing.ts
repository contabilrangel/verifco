import { and, asc, count, desc, eq, exists, inArray, isNotNull, isNull, ne, notExists, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  MAILING_GENERATED_ON_SEND,
  MAILING_MAX_RECIPIENTS,
  MAILING_SKIP_REASONS,
  MAILING_TYPES,
  checklistLock,
  getMailingType,
  renderTemplate,
  type DeliveryChannel,
  type MailingSkipReason,
  type MailingType,
  type MailingTypeKey,
} from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { budgets, checklists, customerGroupMembers, customers, declarations, deliveries, jobs } from '../../db/schema';
import { badRequest } from '../../lib/errors';
import { yearSchema } from '../../lib/http';
import { customerScope, type CustomerRow } from '../../services/customers';
import type { DeclarationRow } from '../../services/declarations';
import { baseTemplateValues, customerAddress, htmlToText, queueDeliveries, resolveTemplate, type BulkDeliveryItem } from '../../services/delivery';
import { getOfficeSettings } from '../../services/settings';
import { checklistPdfFor } from '../checklist/pdf';
import { issueChecklistAccess, markChecklistSent, type ChecklistRow } from '../checklist/service';
import { budgetTemplateValues, prepareBudgetSend, type BudgetRow } from '../finance/service';
import { buildKitPdf } from '../reports/kit';

const TYPE_KEYS = MAILING_TYPES.map((t) => t.key) as [MailingTypeKey, ...MailingTypeKey[]];

export const mailingSchema = z.object({
  type: z.enum(TYPE_KEYS),
  channel: z.enum(['email', 'whatsapp', 'both']),
  year: yearSchema,
  customerIds: z.array(z.uuid()).max(MAILING_MAX_RECIPIENTS).optional(),
  filters: z
    .object({
      groups: z.array(z.uuid()).optional(),
      noGroup: z.boolean().optional(),
      responsible: z.array(z.uuid()).optional(),
      stage: z.array(z.string()).optional(),
      substatus: z.array(z.string()).optional(),
      email: z.enum(['with', 'without']).optional(),
      mobile: z.enum(['with', 'without']).optional(),
    })
    .optional(),
  previewCustomerId: z.uuid().optional(),
});
export type MailingInput = z.infer<typeof mailingSchema>;

export interface PlanEntry {
  customer: CustomerRow;
  declaration: DeclarationRow | null;
  channels: DeliveryChannel[];
  skips: MailingSkipReason[];
  values: Record<string, string | number>;
}

const hasText = (v: string | null | undefined) => Boolean(v && v.trim());
const filled = (col: typeof customers.email | typeof customers.mobile) => and(isNotNull(col), ne(col, ''))!;
const empty = (col: typeof customers.email | typeof customers.mobile) => or(isNull(col), eq(col, ''))!;

/** Tipos que geram um link e um código individuais por envio (o anterior deixa de valer). */
const ROTATES_ACCESS = new Set<MailingTypeKey>(['checklist_digital', 'budget']);

/**
 * Clientes do envio: os ids informados (dentro do escopo) ou os ativos que atendem aos filtros.
 * Traz no máximo {@link MAILING_MAX_RECIPIENTS}; `matched` diz quantos atendem de fato, para a tela
 * avisar (e o envio recusar) quando passa do limite, em vez de cortar em silêncio.
 */
export async function findRecipients(ctx: AppContext, user: AuthUser, input: MailingInput): Promise<{ customers: CustomerRow[]; matched: number }> {
  const { db } = ctx;
  const conds: SQL[] = [await customerScope(ctx, user)];
  if (input.customerIds?.length) {
    conds.push(inArray(customers.id, input.customerIds));
  } else {
    const f = input.filters ?? {};
    conds.push(eq(customers.status, 'active'));
    if (f.responsible?.length) conds.push(inArray(customers.responsibleUserId, f.responsible));
    if (f.email === 'with') conds.push(filled(customers.email));
    if (f.email === 'without') conds.push(empty(customers.email));
    if (f.mobile === 'with') conds.push(filled(customers.mobile));
    if (f.mobile === 'without') conds.push(empty(customers.mobile));
    const memberOf = (ids: string[]) =>
      exists(db.select().from(customerGroupMembers).where(and(eq(customerGroupMembers.customerId, customers.id), inArray(customerGroupMembers.groupId, ids))));
    const noGroup = notExists(db.select().from(customerGroupMembers).where(eq(customerGroupMembers.customerId, customers.id)));
    if (f.groups?.length && f.noGroup) conds.push(or(memberOf(f.groups), noGroup)!);
    else if (f.groups?.length) conds.push(memberOf(f.groups));
    else if (f.noGroup) conds.push(noGroup);
    if (f.stage?.length || f.substatus?.length) {
      const dc: SQL[] = [eq(declarations.customerId, customers.id), eq(declarations.exerciseYear, input.year)];
      if (f.stage?.length) dc.push(inArray(declarations.stage, f.stage));
      if (f.substatus?.length) dc.push(inArray(declarations.substatus, f.substatus));
      const match = exists(db.select().from(declarations).where(and(...dc)));
      const wantsNotStarted = f.stage?.includes('not_started') || f.substatus?.includes('not_started');
      const none = notExists(db.select().from(declarations).where(and(eq(declarations.customerId, customers.id), eq(declarations.exerciseYear, input.year))));
      conds.push(wantsNotStarted ? or(match, none)! : match);
    }
  }
  const where = and(...conds);
  const rows = await db.select().from(customers).where(where).orderBy(asc(customers.name)).limit(MAILING_MAX_RECIPIENTS + 1);
  if (rows.length <= MAILING_MAX_RECIPIENTS) return { customers: rows, matched: rows.length };
  const [{ n }] = await db.select({ n: count() }).from(customers).where(where);
  return { customers: rows.slice(0, MAILING_MAX_RECIPIENTS), matched: n };
}

/** Orçamento mais recente do exercício por cliente (cancelados não contam). */
async function latestBudgets(ctx: AppContext, officeId: string, customerIds: string[], year: number) {
  const by = new Map<string, BudgetRow>();
  if (!customerIds.length) return by;
  const rows = await ctx.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.officeId, officeId), inArray(budgets.customerId, customerIds), eq(budgets.exerciseYear, year), ne(budgets.status, 'canceled')))
    .orderBy(desc(budgets.createdAt));
  for (const b of rows) if (!by.has(b.customerId)) by.set(b.customerId, b);
  return by;
}

/** Só vai orçamento em rascunho ou já enviado; aprovado ou recusado nunca volta como proposta. */
function budgetSkip(b: BudgetRow | undefined): MailingSkipReason | null {
  if (!b) return 'no_budget';
  if (b.status === 'approved') return 'budget_approved';
  if (b.status === 'rejected') return 'budget_rejected';
  return b.status === 'draft' || b.status === 'sent' ? null : 'no_budget';
}

async function declarationsOf(ctx: AppContext, customerIds: string[], year: number) {
  const by = new Map<string, DeclarationRow>();
  if (!customerIds.length) return by;
  const rows = await ctx.db.select().from(declarations).where(and(inArray(declarations.customerId, customerIds), eq(declarations.exerciseYear, year)));
  for (const d of rows) by.set(d.customerId, d);
  return by;
}

/** Decide, cliente a cliente, por quais canais o envio sai e por que alguns ficam de fora. */
export async function planMailing(ctx: AppContext, user: AuthUser, input: MailingInput): Promise<{ type: MailingType; entries: PlanEntry[]; matched: number; truncated: boolean }> {
  const type = getMailingType(input.type)!;
  const { customers: recipients, matched } = await findRecipients(ctx, user, input);
  const ids = recipients.map((c) => c.id);
  const decls = await declarationsOf(ctx, ids, input.year);
  const budgetBy = type.key === 'budget' ? await latestBudgets(ctx, user.officeId, ids, input.year) : new Map<string, BudgetRow>();
  const settings = type.key === 'checklist_digital' ? await getOfficeSettings(ctx.db, user.officeId) : null;
  const wanted: DeliveryChannel[] = input.channel === 'both' ? ['email', 'whatsapp'] : [input.channel];
  const entries = recipients.map((customer): PlanEntry => {
    const declaration = decls.get(customer.id) ?? null;
    const skips: MailingSkipReason[] = [];
    let values: Record<string, string | number> = {};
    if (type.key === 'kit') {
      if (!declaration) skips.push('no_declaration');
      else if (!['transmitted', 'finished'].includes(declaration.stage)) skips.push('not_transmitted');
    }
    if (type.key === 'budget') {
      const b = budgetBy.get(customer.id);
      const skip = budgetSkip(b);
      if (skip) skips.push(skip);
      // o link de aprovação só é gerado no envio
      else values = budgetTemplateValues(b!, MAILING_GENERATED_ON_SEND);
    }
    if (type.key === 'checklist_digital') {
      if (settings && checklistLock(settings, declaration ?? { substatus: 'not_started' }).readOnly) skips.push('checklist_locked');
      // link e código individuais só são gerados no envio
      values = { LINK: MAILING_GENERATED_ON_SEND, CODIGO: MAILING_GENERATED_ON_SEND };
    }
    const channels: DeliveryChannel[] = [];
    if (!skips.length) {
      for (const ch of wanted) {
        const ok = ch === 'email' ? hasText(customer.email) : hasText(customer.mobile);
        if (ok) channels.push(ch);
        else skips.push(ch === 'email' ? 'no_email' : 'no_mobile');
      }
    }
    return { customer, declaration, channels, skips, values };
  });
  return { type, entries, matched, truncated: matched > recipients.length };
}

export interface SkipSummary {
  reason: MailingSkipReason;
  label: string;
  count: number;
  names: string[];
}

export function summarize(entries: PlanEntry[]) {
  const skipped: SkipSummary[] = (Object.keys(MAILING_SKIP_REASONS) as MailingSkipReason[])
    .map((reason) => {
      const list = entries.filter((e) => e.skips.includes(reason));
      return { reason, label: MAILING_SKIP_REASONS[reason], count: list.length, names: list.slice(0, 8).map((e) => e.customer.name) };
    })
    .filter((s) => s.count > 0);
  const email = entries.filter((e) => e.channels.includes('email')).length;
  const whatsapp = entries.filter((e) => e.channels.includes('whatsapp')).length;
  return {
    total: entries.length,
    withEmail: entries.filter((e) => hasText(e.customer.email)).length,
    withoutEmail: entries.filter((e) => !hasText(e.customer.email)).length,
    withMobile: entries.filter((e) => hasText(e.customer.mobile)).length,
    withoutMobile: entries.filter((e) => !hasText(e.customer.mobile)).length,
    customers: entries.filter((e) => e.channels.length > 0).length,
    deliveries: { email, whatsapp, total: email + whatsapp },
    skipped,
  };
}

/** Mensagem como o cliente vai receber (template do escritório com os valores dele). */
export async function renderForCustomer(ctx: AppContext, officeId: string, type: MailingType, entry: PlanEntry, year: number) {
  const tpl = await resolveTemplate(ctx, officeId, type.templateKey);
  const values = { ...(await baseTemplateValues(ctx, officeId, entry.customer.id, year)), ...entry.values };
  const html = renderTemplate(tpl.body, values);
  return { subject: renderTemplate(tpl.subject, values, { html: false }), html, text: htmlToText(html) };
}

export const deliveryKey = (requestId: string, customerId: string, channel: string) => `mailing:${requestId}:${customerId}:${channel}`;

// ---------------------------------------------------------------------------
// Execução na fila (DAD-5): a requisição só registra; o job envia em lotes e informa o andamento
// ---------------------------------------------------------------------------

export const MAILING_JOB = 'mailing.run';
/**
 * Clientes por lote: cada lote lê clientes, declarações e envios já feitos de uma vez e grava os
 * envios juntos. Tipos com trabalho por cliente (PDF, link e código) usam lotes menores, para o
 * andamento avançar com mais frequência.
 */
const batchSize = (type: MailingType) => (type.attachment || ROTATES_ACCESS.has(type.key) ? 25 : 200);
const MAX_ERRORS_LISTED = 20;

export interface MailingTarget {
  id: string;
  channels: DeliveryChannel[];
}

export interface MailingRunPayload {
  [k: string]: unknown;
  officeId: string;
  userId: string;
  type: MailingTypeKey;
  channel: 'email' | 'whatsapp' | 'both';
  year: number;
  requestId: string;
  targets: MailingTarget[];
  /** O que a revisão mostrou no momento do pedido. */
  planned: { customers: number; deliveries: { email: number; whatsapp: number; total: number }; skipped: SkipSummary[] };
}

export interface MailingRunResult {
  [k: string]: unknown;
  total: number;
  processed: number;
  /** Envios novos colocados na fila. */
  queued: number;
  /** Envios que já existiam (nova tentativa do job). */
  already: number;
  /** Quem ficou de fora na hora do envio (os dados mudaram depois da revisão). */
  skipped: Partial<Record<MailingSkipReason, { count: number; names: string[] }>>;
  errorCount: number;
  errors: { customerId: string; name: string; message: string }[];
}

export const mailingJobKey = (officeId: string, requestId: string) => `mailing:${officeId}:${requestId}`;

/**
 * Registra a mala direta na fila e devolve o job. Repetir o pedido (mesmo `requestId`) devolve o
 * job já registrado, sem enviar de novo.
 */
export async function requestMailing(ctx: AppContext, user: AuthUser, input: MailingInput & { requestId: string }) {
  const key = mailingJobKey(user.officeId, input.requestId);
  const existing = await ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, MAILING_JOB), eq(jobs.idempotencyKey, key)) });
  if (existing) return { job: existing, created: false };
  const plan = await planMailing(ctx, user, input);
  if (plan.truncated) {
    throw badRequest(
      `${plan.matched.toLocaleString('pt-BR')} clientes atendem aos filtros, e cada mala direta vai para até ${MAILING_MAX_RECIPIENTS.toLocaleString('pt-BR')}. Use os filtros (grupo, responsável, etapa) para dividir o envio.`,
    );
  }
  const summary = summarize(plan.entries);
  if (!summary.customers) throw badRequest('Nenhum cliente selecionado pode receber este envio.');
  const payload: MailingRunPayload = {
    officeId: user.officeId,
    userId: user.userId,
    type: plan.type.key,
    channel: input.channel,
    year: input.year,
    requestId: input.requestId,
    targets: plan.entries.filter((e) => e.channels.length).map((e) => ({ id: e.customer.id, channels: e.channels })),
    planned: { customers: summary.customers, deliveries: summary.deliveries, skipped: summary.skipped },
  };
  try {
    const job = await ctx.jobs.enqueue(MAILING_JOB, payload, { officeId: user.officeId, idempotencyKey: key, userId: user.userId });
    return { job, created: true };
  } catch (err) {
    // dois cliques ao mesmo tempo: a chave única deixa passar só um
    const again = await ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, MAILING_JOB), eq(jobs.idempotencyKey, key)) });
    if (again) return { job: again, created: false };
    throw err;
  }
}

const emptyResult = (total: number): MailingRunResult => ({ total, processed: 0, queued: 0, already: 0, skipped: {}, errorCount: 0, errors: [] });

function skip(state: MailingRunResult, reason: MailingSkipReason, name: string) {
  const s = (state.skipped[reason] ??= { count: 0, names: [] });
  s.count++;
  if (s.names.length < 8) s.names.push(name);
}

/** Executor do job: processa os clientes em lotes e grava o andamento no próprio job. */
export async function runMailing(ctx: AppContext, jobId: string, p: MailingRunPayload): Promise<MailingRunResult> {
  const type = getMailingType(p.type);
  if (!type) throw new Error(`Tipo de mala direta desconhecido: ${p.type}`);
  const state = emptyResult(p.targets.length);
  const settings = type.key === 'checklist_digital' ? await getOfficeSettings(ctx.db, p.officeId) : null;
  const size = batchSize(type);
  for (let i = 0; i < p.targets.length; i += size) {
    const slice = p.targets.slice(i, i + size);
    await processBatch(ctx, type, p, slice, state, settings);
    state.processed += slice.length;
    await ctx.db
      .update(jobs)
      .set({ progress: Math.min(99, Math.floor((state.processed / Math.max(1, state.total)) * 100)), result: state })
      .where(eq(jobs.id, jobId));
  }
  return state;
}

type Prepared = { skip: MailingSkipReason } | { values?: Record<string, string | number>; redact?: string[]; attachments?: { fileId: string; filename: string }[]; checklistId?: string };

async function processBatch(
  ctx: AppContext,
  type: MailingType,
  p: MailingRunPayload,
  slice: MailingTarget[],
  state: MailingRunResult,
  settings: Awaited<ReturnType<typeof getOfficeSettings>> | null,
) {
  const { db } = ctx;
  const ids = slice.map((t) => t.id);
  const rows = await db.select().from(customers).where(and(eq(customers.officeId, p.officeId), inArray(customers.id, ids)));
  const byId = new Map(rows.map((c) => [c.id, c]));
  const keys = slice.flatMap((t) => t.channels.map((ch) => deliveryKey(p.requestId, t.id, ch)));
  const done = new Set(
    (await db.select({ k: deliveries.idempotencyKey }).from(deliveries).where(and(eq(deliveries.officeId, p.officeId), inArray(deliveries.idempotencyKey, keys)))).map((r) => r.k),
  );
  const needsDeclaration = type.key === 'kit' || type.key === 'checklist_pdf' || type.key === 'checklist_digital';
  const decls = needsDeclaration ? await declarationsOf(ctx, ids, p.year) : new Map<string, DeclarationRow>();
  const budgetBy = type.key === 'budget' ? await latestBudgets(ctx, p.officeId, ids, p.year) : new Map<string, BudgetRow>();
  const checklistBy = new Map<string, ChecklistRow>();
  if (type.key === 'checklist_digital' && decls.size) {
    const list = await db.select().from(checklists).where(inArray(checklists.declarationId, [...decls.values()].map((d) => d.id)));
    for (const c of list) checklistBy.set(c.declarationId, c);
  }

  const prepare = async (c: CustomerRow): Promise<Prepared> => {
    const declaration = decls.get(c.id) ?? null;
    switch (type.key) {
      case 'checklist_digital': {
        if (settings && checklistLock(settings, declaration ?? { substatus: 'not_started' }).readOnly) return { skip: 'checklist_locked' };
        // o mesmo serviço do envio pela etapa Documentação: cria o checklist se faltar e gera link + código
        const access = await issueChecklistAccess(ctx, { officeId: p.officeId, customer: c, exerciseYear: p.year, declaration, checklist: declaration ? checklistBy.get(declaration.id) : null });
        return { values: access.values, redact: access.redact, checklistId: access.checklist.id };
      }
      case 'budget': {
        const b = budgetBy.get(c.id);
        const reason = budgetSkip(b);
        if (reason) return { skip: reason };
        // o mesmo fluxo do financeiro: link de aprovação, "Enviado" e a declaração avança
        return { values: (await prepareBudgetSend(ctx, b!)).values };
      }
      case 'kit': {
        if (!declaration) return { skip: 'no_declaration' };
        if (!['transmitted', 'finished'].includes(declaration.stage)) return { skip: 'not_transmitted' };
        const file = await buildKitPdf(ctx, declaration, c);
        const saved = await ctx.files.save({ officeId: p.officeId, data: file.buffer, filename: file.filename, mimeType: 'application/pdf', userId: p.userId });
        return { attachments: [{ fileId: saved.id, filename: file.filename }] };
      }
      case 'checklist_pdf': {
        // o mesmo PDF da etapa Documentação (checklist digital do cliente, quando houver)
        const file = await checklistPdfFor(ctx, c, p.year, declaration);
        const saved = await ctx.files.save({ officeId: p.officeId, data: file.buffer, filename: file.filename, mimeType: 'application/pdf', userId: p.userId });
        return { attachments: [{ fileId: saved.id, filename: file.filename }] };
      }
      default:
        return {};
    }
  };

  const items: BulkDeliveryItem[] = [];
  const sentChecklists: string[] = [];
  for (const t of slice) {
    const c = byId.get(t.id);
    if (!c || c.deletedAt) {
      skip(state, 'customer_removed', c?.name ?? t.id);
      continue;
    }
    const pending = t.channels.filter((ch) => !done.has(deliveryKey(p.requestId, c.id, ch)));
    state.already += t.channels.length - pending.length;
    if (!pending.length) continue;
    // link e código são por cliente: se um canal já saiu, um novo par invalidaria o enviado
    if (ROTATES_ACCESS.has(type.key) && pending.length < t.channels.length) continue;
    const reachable = pending.filter((ch) => {
      if (customerAddress(c, ch)) return true;
      skip(state, ch === 'email' ? 'no_email' : 'no_mobile', c.name);
      return false;
    });
    if (!reachable.length) continue;
    try {
      const prepared = await prepare(c);
      if ('skip' in prepared) {
        skip(state, prepared.skip, c.name);
        continue;
      }
      for (const ch of reachable) {
        items.push({ customer: c, channel: ch, values: prepared.values, redact: prepared.redact, attachments: prepared.attachments, idempotencyKey: deliveryKey(p.requestId, c.id, ch) });
      }
      if (prepared.checklistId) sentChecklists.push(prepared.checklistId);
    } catch (err) {
      state.errorCount++;
      if (state.errors.length < MAX_ERRORS_LISTED) state.errors.push({ customerId: c.id, name: c.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const created = await queueDeliveries(ctx, { officeId: p.officeId, templateKey: type.templateKey, exerciseYear: p.year, userId: p.userId, items });
  state.queued += created.length;
  state.already += items.length - created.length;
  await markChecklistSent(db, sentChecklists);
}

/**
 * Jobs `mailing.deliver` gravados antes da fila por lotes (um job por cliente, com anexo):
 * viram uma mala direta de um cliente só.
 */
export function legacyDeliverPayload(payload: Record<string, unknown>): MailingRunPayload {
  const channels = (Array.isArray(payload.channels) ? payload.channels : []) as DeliveryChannel[];
  return {
    officeId: String(payload.officeId),
    userId: String(payload.userId),
    type: payload.type as MailingTypeKey,
    channel: channels.length > 1 ? 'both' : (channels[0] ?? 'email'),
    year: Number(payload.year),
    requestId: String(payload.requestId),
    targets: [{ id: String(payload.customerId), channels }],
    planned: { customers: 1, deliveries: { email: 0, whatsapp: 0, total: channels.length }, skipped: [] },
  };
}
