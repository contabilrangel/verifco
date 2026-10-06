import { and, asc, count, desc, eq, exists, getTableColumns, inArray, isNotNull, isNull, like, ne, notExists, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  MAILING_MAX_RECIPIENTS,
  MAILING_SKIP_REASONS,
  MAILING_TYPES,
  checklistLock,
  getMailingType,
  htmlToText,
  renderTemplate,
  type DeliveryChannel,
  type MailingSkipReason,
  type MailingType,
  type MailingTypeKey,
} from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { budgets, customerGroupMembers, customers, declarations, deliveries, jobs, users } from '../../db/schema';
import type { JobRow } from '../../jobs/queue';
import { HttpError, notFound } from '../../lib/errors';
import { can, yearSchema } from '../../lib/http';
import { customerScope, type CustomerRow } from '../../services/customers';
import type { DeclarationRow } from '../../services/declarations';
import { baseTemplateValues, createDeliveryBatch, queueDelivery, resolveTemplate, type BulkDeliveryItem } from '../../services/delivery';
import { getOfficeSettings } from '../../services/settings';
import { customerChecklistPdf } from '../checklist/pdf';
import { issueChecklistAccess } from '../checklist/service';
import { budgetDigitalValues, issueApprovalLink, type BudgetRow } from '../finance/service';
import { buildKitPdf, slug } from '../reports/kit';

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

/** Texto da prévia no lugar do link e do código, que só existem depois do envio. */
export const GENERATED_ON_SEND = '(gerado no envio)';

export interface PlanEntry {
  customer: CustomerRow;
  declaration: DeclarationRow | null;
  /** Orçamento que vai na proposta (tipo "Orçamento"). */
  budget: BudgetRow | null;
  channels: DeliveryChannel[];
  skips: MailingSkipReason[];
  values: Record<string, string | number>;
}

const hasText = (v: string | null | undefined) => Boolean(v && v.trim());
const filled = (col: typeof customers.email | typeof customers.mobile) => and(isNotNull(col), ne(col, ''))!;
const empty = (col: typeof customers.email | typeof customers.mobile) => or(isNull(col), eq(col, ''))!;

/**
 * Clientes do envio: os ids informados (dentro do escopo) ou os ativos que atendem aos filtros,
 * em ordem alfabética e até {@link MAILING_MAX_RECIPIENTS}. Acima do limite, `truncated` avisa e
 * `matched` diz quantos atendiam à seleção.
 */
export async function findRecipients(ctx: AppContext, user: AuthUser, input: MailingInput): Promise<{ customers: CustomerRow[]; truncated: boolean; matched: number }> {
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
  const rows = await db.select().from(customers).where(where).orderBy(asc(customers.name), asc(customers.id)).limit(MAILING_MAX_RECIPIENTS + 1);
  if (rows.length <= MAILING_MAX_RECIPIENTS) return { customers: rows, truncated: false, matched: rows.length };
  const [{ n }] = await db.select({ n: count() }).from(customers).where(where);
  return { customers: rows.slice(0, MAILING_MAX_RECIPIENTS), truncated: true, matched: Number(n) };
}

/**
 * Decide, cliente a cliente, por quais canais o envio sai e por que alguns ficam de fora. Só lê:
 * link, código, link de aprovação e anexos são gerados no envio (a prévia mostra
 * {@link GENERATED_ON_SEND}).
 */
async function planEntries(ctx: AppContext, officeId: string, type: MailingType, input: { channel: MailingInput['channel']; year: number }, recipients: CustomerRow[]) {
  const ids = recipients.map((c) => c.id);
  const decls = new Map<string, DeclarationRow>();
  const budgetBy = new Map<string, { pending?: BudgetRow; approved?: boolean }>();
  let settings: Awaited<ReturnType<typeof getOfficeSettings>> | null = null;
  if (ids.length) {
    const rows = await ctx.db.select().from(declarations).where(and(eq(declarations.officeId, officeId), inArray(declarations.customerId, ids), eq(declarations.exerciseYear, input.year)));
    for (const d of rows) decls.set(d.customerId, d);
    if (type.key === 'budget') {
      // proposta: o rascunho ou enviado mais recente; quem já aprovou fica de fora
      const bs = await ctx.db
        .select()
        .from(budgets)
        .where(and(eq(budgets.officeId, officeId), inArray(budgets.customerId, ids), eq(budgets.exerciseYear, input.year), inArray(budgets.status, ['draft', 'sent', 'approved'])))
        .orderBy(desc(budgets.createdAt));
      for (const b of bs) {
        const cur = budgetBy.get(b.customerId) ?? {};
        if (b.status === 'approved') cur.approved = true;
        else cur.pending ??= b;
        budgetBy.set(b.customerId, cur);
      }
    }
    if (type.key === 'checklist_digital') settings = await getOfficeSettings(ctx.db, officeId);
  }
  const wanted: DeliveryChannel[] = input.channel === 'both' ? ['email', 'whatsapp'] : [input.channel];
  return recipients.map((customer): PlanEntry => {
    const declaration = decls.get(customer.id) ?? null;
    const skips: MailingSkipReason[] = [];
    let values: Record<string, string | number> = {};
    let budget: BudgetRow | null = null;
    if (type.key === 'kit') {
      if (!declaration) skips.push('no_declaration');
      else if (!['transmitted', 'finished'].includes(declaration.stage)) skips.push('not_transmitted');
    }
    if (type.key === 'budget') {
      const b = budgetBy.get(customer.id);
      if (b?.pending) {
        budget = b.pending;
        values = budgetDigitalValues(b.pending, GENERATED_ON_SEND);
      } else skips.push(b?.approved ? 'budget_approved' : 'no_budget');
    }
    if (type.key === 'checklist_digital') {
      // mesma regra do checklist do cliente: bloqueado ou em modo consulta não recebe novo acesso
      if (checklistLock(settings!, declaration ?? { substatus: 'not_started', checklistLocked: false }).readOnly) skips.push('checklist_locked');
      else values = { LINK: GENERATED_ON_SEND, CODIGO: GENERATED_ON_SEND };
    }
    const channels: DeliveryChannel[] = [];
    if (!skips.length) {
      for (const ch of wanted) {
        const ok = ch === 'email' ? hasText(customer.email) : hasText(customer.mobile);
        if (ok) channels.push(ch);
        else skips.push(ch === 'email' ? 'no_email' : 'no_mobile');
      }
    }
    return { customer, declaration, budget, channels, skips, values };
  });
}

/** Revisão do envio: destinatários (no escopo do usuário) e o plano de cada um. */
export async function planMailing(ctx: AppContext, user: AuthUser, input: MailingInput) {
  const type = getMailingType(input.type)!;
  const recipients = await findRecipients(ctx, user, input);
  const entries = await planEntries(ctx, user.officeId, type, input, recipients.customers);
  return { type, entries, truncated: recipients.truncated, matched: recipients.matched };
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

/** Mensagem como o cliente vai receber (template do escritório com os valores dele; no WhatsApp, o mesmo texto do envio). */
export async function renderForCustomer(ctx: AppContext, officeId: string, type: MailingType, entry: PlanEntry, year: number) {
  const tpl = await resolveTemplate(ctx, officeId, type.templateKey);
  const values = { ...(await baseTemplateValues(ctx, officeId, entry.customer.id, year)), ...entry.values };
  const html = renderTemplate(tpl.body, values);
  return { subject: renderTemplate(tpl.subject, values, { html: false }), html, text: htmlToText(html) };
}

export const deliveryKey = (requestId: string, customerId: string, channel: string) => `mailing:${requestId}:${customerId}:${channel}`;

/** Nome do checklist em PDF anexado pela mala direta. */
export const checklistPdfFilename = (customer: CustomerRow, year: number) => `checklist-irpf-${year}-${slug(customer.name)}.pdf`;

// ---------------------------------------------------------------------------
// Pedido e execução (fila de tarefas)
// ---------------------------------------------------------------------------

/** Job que prepara a mala direta inteira; um por pedido. */
export const MAILING_JOB = 'mailing.plan';
/** Job que gera o anexo de um cliente (kit ou checklist em PDF) e enfileira os envios dele. */
export const MAILING_DELIVER_JOB = 'mailing.deliver';

/** Chave do job do pedido: o id do pedido vem do navegador, por isso vai junto do escritório. */
const requestKey = (officeId: string, requestId: string) => `${officeId}:${requestId}`;

export type MailingSummary = ReturnType<typeof summarize>;

/** Pedido de mala direta guardado no job: destinatários já resolvidos no escopo de quem pediu. */
export interface MailingRequestPayload {
  [k: string]: unknown;
  officeId: string;
  userId: string;
  requestId: string;
  type: MailingTypeKey;
  channel: MailingInput['channel'];
  year: number;
  customerIds: string[];
  /** Revisão no momento do pedido (o job refaz o plano com os dados do momento do envio). */
  planned: { customers: number; deliveries: MailingSummary['deliveries']; skipped: MailingSummary['skipped']; truncated: boolean; matched: number };
}

export interface MailingJobResult {
  [k: string]: unknown;
  queued: number;
  alreadyQueued: number;
  failed: { customerId: string; name: string; message: string }[];
}

/** Colunas do pedido sem a lista de destinatários (até milhares de ids; a tela consulta o andamento a cada segundo e meio). */
const requestColumns = () => ({ ...getTableColumns(jobs), payload: sql<Record<string, unknown>>`${jobs.payload} - 'customerIds'` });

/** O pedido do escritório, sem a lista de destinatários. */
export async function findMailingRequest(ctx: AppContext, officeId: string, requestId: string): Promise<JobRow | undefined> {
  const [row] = await ctx.db
    .select(requestColumns())
    .from(jobs)
    .where(and(eq(jobs.type, MAILING_JOB), eq(jobs.idempotencyKey, requestKey(officeId, requestId)), eq(jobs.officeId, officeId)))
    .limit(1);
  return row;
}

/**
 * Registra o pedido: só grava o job `mailing.plan`, que gera link, código, anexos, envios,
 * mensagens e jobs de envio fora da requisição. O mesmo pedido repetido devolve o job já gravado.
 */
export async function requestMailing(
  ctx: AppContext,
  user: AuthUser,
  input: MailingInput & { requestId: string },
  plan: Awaited<ReturnType<typeof planMailing>>,
  summary: MailingSummary,
): Promise<JobRow> {
  const payload: MailingRequestPayload = {
    officeId: user.officeId,
    userId: user.userId,
    requestId: input.requestId,
    type: input.type,
    channel: input.channel,
    year: input.year,
    customerIds: plan.entries.filter((e) => e.channels.length).map((e) => e.customer.id),
    planned: { customers: summary.customers, deliveries: summary.deliveries, skipped: summary.skipped, truncated: plan.truncated, matched: plan.matched },
  };
  try {
    return await ctx.jobs.enqueue(MAILING_JOB, payload, { officeId: user.officeId, idempotencyKey: requestKey(user.officeId, input.requestId), userId: user.userId });
  } catch (err) {
    // dois cliques ao mesmo tempo: a chave única segura o segundo, que segue o primeiro
    const again = await findMailingRequest(ctx, user.officeId, input.requestId);
    if (!again) throw err;
    return again;
  }
}

/**
 * Pedido que falhou (esgotou as tentativas) volta para a fila quando é repetido: o job pula o que
 * já foi gravado, então tentar de novo não duplica envios nem gera outro link para quem já recebeu.
 */
export async function retryMailingRequest(ctx: AppContext, job: JobRow): Promise<JobRow> {
  if (job.status !== 'failed') return job;
  await ctx.db
    .update(jobs)
    .set({ status: 'queued', attempts: 0, error: null, runAt: new Date(), finishedAt: null })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'failed')));
  return { ...job, status: 'queued', attempts: 0, error: null, finishedAt: null };
}

/** Anexos gerados até agora (kit ou checklist em PDF, um job por cliente). */
async function attachmentProgress(ctx: AppContext, p: MailingRequestPayload) {
  const rows = await ctx.db
    .select({ status: jobs.status, n: count() })
    .from(jobs)
    .where(and(eq(jobs.type, MAILING_DELIVER_JOB), eq(jobs.officeId, p.officeId), like(jobs.idempotencyKey, `mailing:${p.requestId}:%`)))
    .groupBy(jobs.status);
  const by = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { total: rows.reduce((a, r) => a + Number(r.n), 0), done: by('done'), failed: by('failed') };
}

/** Situação do pedido sem consultar o banco: o que a revisão planejou e o andamento da preparação. */
function mailingRequestSummary(job: JobRow) {
  const p = job.payload as MailingRequestPayload;
  return {
    requestId: p.requestId,
    jobId: job.id,
    type: p.type,
    channel: p.channel,
    year: p.year,
    status: job.status as 'queued' | 'running' | 'done' | 'failed',
    progress: job.progress,
    error: job.status === 'failed' ? 'Não foi possível preparar os envios. Tente de novo: o que já foi preparado não se repete.' : null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    ...p.planned,
  };
}

/** Andamento do pedido para a tela: preparação (job) e, com anexo, a geração dos PDFs. */
export async function mailingRequestView(ctx: AppContext, job: JobRow) {
  const p = job.payload as MailingRequestPayload;
  const type = getMailingType(p.type);
  const done = job.status === 'done';
  return {
    ...mailingRequestSummary(job),
    result: done ? ((job.result ?? null) as MailingJobResult | null) : null,
    attachments: type?.attachment && done ? await attachmentProgress(ctx, p) : null,
  };
}

// ---------------------------------------------------------------------------
// Malas diretas recentes
// ---------------------------------------------------------------------------

/** Quantas malas diretas a lista de recentes mostra. */
export const MAILING_RECENT_RUNS = 20;

/** Quantos clientes com falha o detalhe lista (a contagem vem inteira). */
const RUN_FAILURES_SHOWN = 50;

/**
 * Malas diretas que o usuário acompanha: as do escritório, dos tipos que ele pode enviar. Quem não
 * tem "E-mails enviados" ou vê só os próprios clientes (carteira restrita ao responsável)
 * acompanha só as que pediu: as dos outros trazem clientes fora da carteira dele.
 */
async function runScope(ctx: AppContext, user: AuthUser) {
  const allowed = MAILING_TYPES.filter((t) => can(user, t.permission)).map((t) => t.key as string);
  const restricted = !user.isOwner && (await getOfficeSettings(ctx.db, user.officeId)).restrictCustomersToResponsible;
  const conds: SQL[] = [eq(jobs.officeId, user.officeId), eq(jobs.type, MAILING_JOB), inArray(sql`${jobs.payload}->>'type'`, allowed.length ? allowed : [''])];
  if (restricted || !can(user, 'mailing.list')) conds.push(eq(jobs.createdByUserId, user.userId));
  return { where: and(...conds)!, restricted };
}

/** Pedidos de mala direta com o nome de quem pediu (consulta pelo índice escritório + tipo + data). */
const runQuery = (ctx: AppContext) =>
  ctx.db
    .select({ job: requestColumns(), createdByName: users.name })
    .from(jobs)
    .leftJoin(users, and(eq(users.id, jobs.createdByUserId), eq(users.officeId, jobs.officeId)));

/** Malas diretas recentes (mais novas primeiro), sem nomes de clientes: o detalhe mostra quem ficou de fora. */
export async function listMailingRuns(ctx: AppContext, user: AuthUser) {
  const { where } = await runScope(ctx, user);
  const rows = await runQuery(ctx).where(where).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(MAILING_RECENT_RUNS);
  return rows.map(({ job, createdByName }) => {
    const { skipped, ...summary } = mailingRequestSummary(job);
    return {
      ...summary,
      id: job.id,
      label: getMailingType(summary.type)?.label ?? summary.type,
      createdBy: createdByName ?? null,
      skippedCount: skipped.reduce((a, s) => a + s.count, 0),
    };
  });
}

/**
 * Chaves de idempotência dos envios (cliente e canal) ou, sem canal, dos jobs de anexo de um
 * pedido, montadas no banco a partir dos clientes do payload: a busca usa o índice único de cada
 * tabela, sem varrer os envios do escritório.
 */
function runKeys(jobId: string, perChannel: boolean): SQL {
  if (!perChannel) {
    return sql`select 'mailing:' || (j.payload->>'requestId') || ':' || c.id
      from ${jobs} j cross join lateral jsonb_array_elements_text(j.payload->'customerIds') as c(id)
      where j.id = ${jobId}`;
  }
  return sql`select 'mailing:' || (j.payload->>'requestId') || ':' || c.id || ':' || ch.channel
    from ${jobs} j cross join lateral jsonb_array_elements_text(j.payload->'customerIds') as c(id)
    cross join (values ('email'), ('whatsapp')) as ch(channel)
    where j.id = ${jobId} and (j.payload->>'channel' = 'both' or j.payload->>'channel' = ch.channel)`;
}

/** Tira e-mails e telefones do erro do provedor: o detalhe da mala direta mostra só o nome do cliente e o canal. */
export function maskContacts(text: string): string {
  return text
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g, '[e-mail]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '[telefone]' : m));
}

interface StatusCount {
  queued: number;
  sent: number;
  failed: number;
  total: number;
}
const noDeliveries = (): StatusCount => ({ queued: 0, sent: 0, failed: 0, total: 0 });

export interface MailingRunFailure {
  customerId: string | null;
  name: string;
  channel: DeliveryChannel | null;
  /** Onde falhou: na preparação do pedido, na geração do anexo ou na entrega pelo provedor. */
  stage: 'preparation' | 'attachment' | 'delivery';
  message: string;
}

/**
 * Detalhe de uma mala direta: o andamento do pedido (o mesmo de `/mailing/requests/:requestId`),
 * os envios por canal e situação e os clientes com falha, com o motivo. Fora do escopo, 404.
 */
export async function mailingRunDetail(ctx: AppContext, user: AuthUser, jobId: string) {
  const { db } = ctx;
  const { where, restricted } = await runScope(ctx, user);
  const [row] = await runQuery(ctx).where(and(where, eq(jobs.id, jobId)));
  if (!row) throw notFound('Mala direta');
  const view = await mailingRequestView(ctx, row.job);
  const inRun = and(eq(deliveries.officeId, user.officeId), sql`${deliveries.idempotencyKey} in (${runKeys(jobId, true)})`);

  // envios por canal e situação ("entregue" conta como enviado)
  const sending = { email: noDeliveries(), whatsapp: noDeliveries(), total: noDeliveries() };
  const counts = await db
    .select({ channel: deliveries.channel, status: deliveries.status, n: count() })
    .from(deliveries)
    .where(inRun)
    .groupBy(deliveries.channel, deliveries.status);
  for (const c of counts) {
    const bucket = c.status === 'failed' ? 'failed' : c.status === 'queued' ? 'queued' : 'sent';
    for (const t of [sending[c.channel as DeliveryChannel], sending.total]) {
      if (!t) continue;
      t[bucket] += Number(c.n);
      t.total += Number(c.n);
    }
  }

  // carteira restrita: só os nomes dos clientes que o usuário vê hoje
  const scope = restricted ? await customerScope(ctx, user) : undefined;
  const customerName = sql<string>`coalesce(${customers.name}, ${deliveries.toName}, '')`;
  const failedDeliveries = sending.total.failed
    ? await db
        .select({ customerId: deliveries.customerId, name: customerName, channel: deliveries.channel, error: deliveries.error })
        .from(deliveries)
        .leftJoin(customers, eq(customers.id, deliveries.customerId))
        .where(and(inRun, eq(deliveries.status, 'failed'), scope))
        .orderBy(customerName, asc(deliveries.channel))
        .limit(RUN_FAILURES_SHOWN)
    : [];
  const failedAttachments = view.attachments?.failed
    ? await db
        .select({ customerId: customers.id, name: customers.name })
        .from(jobs)
        .innerJoin(customers, and(sql`${customers.id}::text = ${jobs.payload}->>'customerId'`, eq(customers.officeId, user.officeId)))
        .where(and(eq(jobs.type, MAILING_DELIVER_JOB), sql`${jobs.idempotencyKey} in (${runKeys(jobId, false)})`, eq(jobs.status, 'failed'), scope))
        .orderBy(asc(customers.name))
        .limit(RUN_FAILURES_SHOWN)
    : [];
  let prepared = view.result?.failed ?? [];
  if (scope && prepared.length) {
    const visible = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(scope, inArray(customers.id, prepared.map((f) => f.customerId))));
    const ids = new Set(visible.map((v) => v.id));
    prepared = prepared.filter((f) => ids.has(f.customerId));
  }

  const items: MailingRunFailure[] = [
    ...prepared.map((f) => ({ customerId: f.customerId, name: f.name, channel: null, stage: 'preparation' as const, message: f.message })),
    ...failedAttachments.map((f) => ({ customerId: f.customerId, name: f.name, channel: null, stage: 'attachment' as const, message: 'Não foi possível gerar o anexo em PDF.' })),
    ...failedDeliveries.map((f) => ({
      customerId: f.customerId,
      name: f.name,
      channel: f.channel as DeliveryChannel,
      stage: 'delivery' as const,
      message: maskContacts(f.error || 'O provedor não entregou a mensagem.'),
    })),
  ];
  return {
    ...view,
    // os nomes de quem ficou de fora na revisão não têm o id para conferir a carteira de hoje: só a contagem
    skipped: scope ? view.skipped.map((s) => ({ ...s, names: [] })) : view.skipped,
    result: view.result ? { ...view.result, failed: prepared } : null,
    id: row.job.id,
    label: getMailingType(view.type)?.label ?? view.type,
    createdBy: row.createdByName ?? null,
    sending,
    failures: {
      count: prepared.length + (view.attachments?.failed ?? 0) + sending.total.failed,
      items: items.slice(0, RUN_FAILURES_SHOWN),
    },
  };
}

/** Clientes por bloco na execução: acessos, envios e jobs de um bloco são gravados juntos. */
const EXEC_CHUNK = 200;

/**
 * Executor do job `mailing.plan`. Refaz o plano com os dados atuais (só os clientes do pedido),
 * carrega template, escritório e responsáveis uma vez e grava em lote, bloco a bloco, com a
 * chave de idempotência de cada envio: repetir o job não duplica nada nem gera outro link ou
 * código para quem já recebeu.
 */
export async function runMailingRequest(ctx: AppContext, job: JobRow, progress: (pct: number) => Promise<void>): Promise<MailingJobResult> {
  const p = job.payload as MailingRequestPayload;
  const type = getMailingType(p.type);
  if (!type) throw new Error(`Tipo de mala direta desconhecido: ${p.type}`);
  const ids = Array.isArray(p.customerIds) ? p.customerIds.map(String) : [];
  const recipients = ids.length
    ? await ctx.db
        .select()
        .from(customers)
        .where(and(eq(customers.officeId, p.officeId), isNull(customers.deletedAt), inArray(customers.id, ids)))
        .orderBy(asc(customers.name), asc(customers.id))
    : [];
  const entries = await planEntries(ctx, p.officeId, type, p, recipients);
  const targets = entries.filter((e) => e.channels.length);
  const result: MailingJobResult = { queued: 0, alreadyQueued: 0, failed: [] };
  const batch = type.attachment
    ? null
    : await createDeliveryBatch(ctx, { officeId: p.officeId, templateKey: type.templateKey, exerciseYear: p.year, userId: p.userId, customers: targets.map((e) => e.customer) });
  for (let i = 0; i < targets.length; i += EXEC_CHUNK) {
    const chunk = targets.slice(i, i + EXEC_CHUNK);
    const keys = chunk.flatMap((e) => e.channels.map((ch) => deliveryKey(p.requestId, e.customer.id, ch)));
    const existing = await ctx.db
      .select({ k: deliveries.idempotencyKey })
      .from(deliveries)
      .where(and(eq(deliveries.officeId, p.officeId), inArray(deliveries.idempotencyKey, keys)));
    const sent = new Set(existing.map((r) => r.k));
    const pendingOf = (e: PlanEntry) => e.channels.filter((ch) => !sent.has(deliveryKey(p.requestId, e.customer.id, ch)));
    if (batch) await queueChunk(ctx, p, type, chunk, pendingOf, batch, result);
    else await enqueueAttachments(ctx, p, type, chunk, pendingOf, result);
    await progress(((i + chunk.length) / targets.length) * 100);
  }
  return result;
}

/** Um bloco de envios sem anexo: gera link e código (ou o link de aprovação) de cada cliente e grava tudo em lote. */
async function queueChunk(
  ctx: AppContext,
  p: MailingRequestPayload,
  type: MailingType,
  chunk: PlanEntry[],
  pendingOf: (e: PlanEntry) => DeliveryChannel[],
  batch: Awaited<ReturnType<typeof createDeliveryBatch>>,
  result: MailingJobResult,
) {
  // tipos com link próprio: um par novo invalidaria o já enviado, então quem já recebeu não ganha outro
  const ownLink = type.key === 'checklist_digital' || type.key === 'budget';
  const items: BulkDeliveryItem[] = [];
  for (const e of chunk) {
    const pending = pendingOf(e);
    result.alreadyQueued += e.channels.length - pending.length;
    if (!pending.length || (ownLink && pending.length < e.channels.length)) continue;
    try {
      let values: BulkDeliveryItem['values'] = e.values;
      let redact: string[] | undefined;
      if (type.key === 'checklist_digital') {
        const access = await issueChecklistAccess(ctx, { officeId: p.officeId, customer: e.customer, year: p.year, markSent: true });
        values = { LINK: access.link, CODIGO: access.code };
        // link e código só na mensagem entregue; o histórico (envios e mensagens) guarda a versão mascarada
        redact = [access.token, access.code];
      } else if (type.key === 'budget' && e.budget) {
        // o mesmo envio do financeiro: novo link de aprovação, orçamento "Enviado" e etapa da declaração
        const issued = await issueApprovalLink(ctx, e.budget);
        values = budgetDigitalValues(issued.budget, issued.link);
      }
      for (const channel of pending) items.push({ customer: e.customer, channel, values, redact, idempotencyKey: deliveryKey(p.requestId, e.customer.id, channel) });
    } catch (err) {
      result.failed.push({ customerId: e.customer.id, name: e.customer.name, message: err instanceof HttpError ? err.message : 'Não foi possível preparar o envio deste cliente.' });
    }
  }
  const r = await batch.queue(items);
  result.queued += r.queued;
  result.alreadyQueued += r.existing;
  for (const m of r.missing) {
    result.failed.push({ customerId: m.customer.id, name: m.customer.name, message: m.channel === 'email' ? 'O cliente não tem e-mail cadastrado.' : 'O cliente não tem celular cadastrado.' });
  }
}

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

/** Um bloco de envios com anexo: um job por cliente (o PDF é gerado uma vez e vai em todos os canais dele), gravados em lote. */
async function enqueueAttachments(ctx: AppContext, p: MailingRequestPayload, type: MailingType, chunk: PlanEntry[], pendingOf: (e: PlanEntry) => DeliveryChannel[], result: MailingJobResult) {
  const rows = chunk.flatMap((e) => {
    const pending = pendingOf(e);
    result.alreadyQueued += e.channels.length - pending.length;
    if (!pending.length) return [];
    const payload: MailingJobPayload = {
      officeId: p.officeId,
      userId: p.userId,
      customerId: e.customer.id,
      declarationId: e.declaration?.id ?? null,
      type: type.key,
      year: p.year,
      channels: pending,
      requestId: p.requestId,
    };
    return [{ type: MAILING_DELIVER_JOB, payload, officeId: p.officeId, idempotencyKey: `mailing:${p.requestId}:${e.customer.id}`, createdByUserId: p.userId }];
  });
  if (!rows.length) return;
  // em lote, como ctx.jobs.enqueue faria um a um (a chave única não deixa duplicar)
  const created = await ctx.db.insert(jobs).values(rows).onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] }).returning({ key: jobs.idempotencyKey });
  const isNew = new Set(created.map((r) => r.key));
  for (const r of rows) {
    if (isNew.has(r.idempotencyKey)) result.queued += r.payload.channels.length;
    else result.alreadyQueued += r.payload.channels.length;
  }
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
    // o mesmo PDF da etapa Documentação (itens do checklist digital do cliente)
    file = { buffer: await customerChecklistPdf(ctx, customer, p.year), filename: checklistPdfFilename(customer, p.year) };
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
