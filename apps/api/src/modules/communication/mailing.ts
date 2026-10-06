import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, ne, notExists, notInArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  BUDGET_CATEGORIES,
  MAILING_SKIP_REASONS,
  MAILING_TYPES,
  formatMoney,
  getMailingType,
  renderTemplate,
  type DeliveryChannel,
  type MailingSkipReason,
  type MailingType,
  type MailingTypeKey,
} from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { budgets, customerGroupMembers, customers, declarations, deliveries } from '../../db/schema';
import { yearSchema } from '../../lib/http';
import { customerScope, type CustomerRow } from '../../services/customers';
import type { DeclarationRow } from '../../services/declarations';
import { baseTemplateValues, queueDelivery, resolveTemplate } from '../../services/delivery';
import { buildKitPdf } from '../reports/kit';
import { buildChecklistPdf } from './checklist-pdf';

const TYPE_KEYS = MAILING_TYPES.map((t) => t.key) as [MailingTypeKey, ...MailingTypeKey[]];

export const mailingSchema = z.object({
  type: z.enum(TYPE_KEYS),
  channel: z.enum(['email', 'whatsapp', 'both']),
  year: yearSchema,
  customerIds: z.array(z.uuid()).max(5000).optional(),
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

/** Clientes do envio: os ids informados (dentro do escopo) ou os ativos que atendem aos filtros. */
export async function findRecipients(ctx: AppContext, user: AuthUser, input: MailingInput): Promise<CustomerRow[]> {
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
  return db.select().from(customers).where(and(...conds)).orderBy(asc(customers.name)).limit(5000);
}

/** Decide, cliente a cliente, por quais canais o envio sai e por que alguns ficam de fora. */
export async function planMailing(ctx: AppContext, user: AuthUser, input: MailingInput): Promise<{ type: MailingType; entries: PlanEntry[] }> {
  const type = getMailingType(input.type)!;
  const recipients = await findRecipients(ctx, user, input);
  const ids = recipients.map((c) => c.id);
  const decls = new Map<string, DeclarationRow>();
  const budgetBy = new Map<string, typeof budgets.$inferSelect>();
  if (ids.length) {
    const rows = await ctx.db.select().from(declarations).where(and(inArray(declarations.customerId, ids), eq(declarations.exerciseYear, input.year)));
    for (const d of rows) decls.set(d.customerId, d);
    if (type.key === 'budget') {
      const bs = await ctx.db
        .select()
        .from(budgets)
        .where(and(eq(budgets.officeId, user.officeId), inArray(budgets.customerId, ids), eq(budgets.exerciseYear, input.year), notInArray(budgets.status, ['canceled', 'rejected'])))
        .orderBy(desc(budgets.createdAt));
      for (const b of bs) if (!budgetBy.has(b.customerId)) budgetBy.set(b.customerId, b);
    }
  }
  const wanted: DeliveryChannel[] = input.channel === 'both' ? ['email', 'whatsapp'] : [input.channel];
  const entries = recipients.map((customer): PlanEntry => {
    const declaration = decls.get(customer.id) ?? null;
    const skips: MailingSkipReason[] = [];
    const values: Record<string, string | number> = {};
    if (type.key === 'kit') {
      if (!declaration) skips.push('no_declaration');
      else if (!['transmitted', 'finished'].includes(declaration.stage)) skips.push('not_transmitted');
    }
    if (type.key === 'budget') {
      const b = budgetBy.get(customer.id);
      if (!b) skips.push('no_budget');
      else {
        values.CATEGORIA = BUDGET_CATEGORIES[b.category as keyof typeof BUDGET_CATEGORIES] ?? b.category;
        values.DESCRICAO = b.description ?? '';
        values.VALOR = formatMoney(b.totalCents);
      }
    }
    if (type.key === 'checklist_digital') {
      values.LINK = `${ctx.config.WEB_URL}/portal`;
      values.CODIGO = 'enviado pelo seu contador';
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
  return { type, entries };
}

export function summarize(entries: PlanEntry[]) {
  const skipped = (Object.keys(MAILING_SKIP_REASONS) as MailingSkipReason[])
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

export const htmlToText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2: $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Mensagem como o cliente vai receber (template do escritório com os valores dele). */
export async function renderForCustomer(ctx: AppContext, officeId: string, type: MailingType, entry: PlanEntry, year: number) {
  const tpl = await resolveTemplate(ctx, officeId, type.templateKey);
  const values = { ...(await baseTemplateValues(ctx, officeId, entry.customer.id, year)), ...entry.values };
  const html = renderTemplate(tpl.body, values);
  return { subject: renderTemplate(tpl.subject, values, { html: false }), html, text: htmlToText(html) };
}

export const deliveryKey = (requestId: string, customerId: string, channel: string) => `mailing:${requestId}:${customerId}:${channel}`;

export interface MailingJobPayload {
  [k: string]: unknown;
  officeId: string;
  userId: string;
  customerId: string;
  declarationId: string | null;
  type: MailingTypeKey;
  year: number;
  channels: DeliveryChannel[];
  requestId: string;
}

/** Enfileira os envios planejados. Repetir a mesma operação (mesmo requestId) não duplica. */
export async function executeMailing(ctx: AppContext, user: AuthUser, input: MailingInput & { requestId: string }) {
  const { type, entries } = await planMailing(ctx, user, input);
  const targets = entries.filter((e) => e.channels.length);
  const keys = targets.flatMap((e) => e.channels.map((ch) => deliveryKey(input.requestId, e.customer.id, ch)));
  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await ctx.db
      .select({ k: deliveries.idempotencyKey })
      .from(deliveries)
      .where(and(eq(deliveries.officeId, user.officeId), inArray(deliveries.idempotencyKey, keys.slice(i, i + 500))));
    for (const r of rows) if (r.k) existing.add(r.k);
  }
  let queued = 0;
  for (const e of targets) {
    const pending = e.channels.filter((ch) => !existing.has(deliveryKey(input.requestId, e.customer.id, ch)));
    if (!pending.length) continue;
    if (type.attachment) {
      const payload: MailingJobPayload = {
        officeId: user.officeId,
        userId: user.userId,
        customerId: e.customer.id,
        declarationId: e.declaration?.id ?? null,
        type: type.key,
        year: input.year,
        channels: pending,
        requestId: input.requestId,
      };
      await ctx.jobs.enqueue('mailing.deliver', payload, { officeId: user.officeId, idempotencyKey: `mailing:${input.requestId}:${e.customer.id}`, userId: user.userId });
    } else {
      for (const ch of pending) {
        await queueDelivery(ctx, {
          officeId: user.officeId,
          customerId: e.customer.id,
          channel: ch,
          templateKey: type.templateKey,
          values: e.values,
          exerciseYear: input.year,
          idempotencyKey: deliveryKey(input.requestId, e.customer.id, ch),
          userId: user.userId,
        });
      }
    }
    queued += pending.length;
  }
  return { type, entries, queued, alreadyQueued: keys.length - queued };
}

/** Executor do job: gera o anexo (kit ou checklist em PDF) uma vez e enfileira os envios do cliente. */
export async function deliverWithAttachment(ctx: AppContext, p: MailingJobPayload) {
  const type = getMailingType(p.type);
  if (!type?.attachment) throw new Error(`Tipo de envio sem anexo: ${p.type}`);
  const existing = await ctx.db
    .select({ k: deliveries.idempotencyKey })
    .from(deliveries)
    .where(and(eq(deliveries.officeId, p.officeId), inArray(deliveries.idempotencyKey, p.channels.map((ch) => deliveryKey(p.requestId, p.customerId, ch)))));
  const done = new Set(existing.map((r) => r.k));
  const pending = p.channels.filter((ch) => !done.has(deliveryKey(p.requestId, p.customerId, ch)));
  if (!pending.length) return { skipped: true };
  const customer = await ctx.db.query.customers.findFirst({ where: and(eq(customers.id, p.customerId), eq(customers.officeId, p.officeId), isNull(customers.deletedAt)) });
  if (!customer) return { skipped: true, reason: 'customer_not_found' };
  let file: { buffer: Buffer; filename: string };
  if (type.attachment === 'kit') {
    const declaration = p.declarationId
      ? await ctx.db.query.declarations.findFirst({ where: and(eq(declarations.id, p.declarationId), eq(declarations.officeId, p.officeId)) })
      : undefined;
    if (!declaration) return { skipped: true, reason: 'declaration_not_found' };
    file = await buildKitPdf(ctx, declaration, customer);
  } else {
    file = await buildChecklistPdf(ctx, customer, p.year);
  }
  const saved = await ctx.files.save({ officeId: p.officeId, data: file.buffer, filename: file.filename, mimeType: 'application/pdf', userId: p.userId });
  const errors: string[] = [];
  for (const ch of pending) {
    try {
      await queueDelivery(ctx, {
        officeId: p.officeId,
        customerId: customer.id,
        channel: ch,
        templateKey: type.templateKey,
        exerciseYear: p.year,
        attachments: [{ fileId: saved.id, filename: file.filename }],
        idempotencyKey: deliveryKey(p.requestId, customer.id, ch),
        userId: p.userId,
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { fileId: saved.id, deliveries: pending.length - errors.length, errors };
}
