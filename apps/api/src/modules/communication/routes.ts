import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, exists, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DELIVERY_CHANNELS,
  DELIVERY_STATUS,
  MAILING_MAX_RECIPIENTS,
  MAILING_SKIP_REASONS,
  MAILING_TYPES,
  TEMPLATES,
  getMailingType,
  getTemplateDef,
  renderTemplate,
  sampleTemplateValues,
  sanitizeHtml,
  unknownVariables,
  type MailingSkipReason,
} from '@verifco/shared';
import type { AuthUser } from '../../context';
import { customers, deliveries, emailTemplates, jobs, offices } from '../../db/schema';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { audit, can, dateStr, guard, paginate, parse, requirePermission, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { resolveTemplate } from '../../services/delivery';
import { getOfficeSettings } from '../../services/settings';
import { checklistPdfFor } from '../checklist/pdf';
import { buildKitPdf } from '../reports/kit';
import { MAILING_JOB, mailingSchema, planMailing, renderForCustomer, requestMailing, summarize, type MailingRunPayload, type MailingRunResult } from './mailing';

interface RunRow {
  id: string;
  status: string;
  progress: number;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  finishedAt: Date | null;
  payload: Record<string, unknown>;
  total?: number;
}

/** Situação de uma mala direta para a tela: o planejado na revisão e o andamento do envio. */
function runView(row: RunRow) {
  const p = row.payload as Partial<MailingRunPayload>;
  const r = (row.result ?? {}) as Partial<MailingRunResult>;
  const type = p.type ? getMailingType(p.type) : undefined;
  const total = row.total ?? (Array.isArray(p.targets) ? p.targets.length : 0);
  const skippedOnSend = Object.entries(r.skipped ?? {}).map(([reason, s]) => ({
    reason,
    label: MAILING_SKIP_REASONS[reason as MailingSkipReason] ?? reason,
    count: s?.count ?? 0,
    names: s?.names ?? [],
  }));
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    error: row.status === 'failed' ? row.error : null,
    type: { key: p.type ?? '', label: type?.label ?? p.type ?? '', attachment: type?.attachment ?? null },
    channel: p.channel ?? null,
    year: p.year ?? null,
    customers: p.planned?.customers ?? total,
    deliveries: p.planned?.deliveries ?? { email: 0, whatsapp: 0, total: 0 },
    skipped: p.planned?.skipped ?? [],
    progressDetail: {
      total,
      processed: r.processed ?? 0,
      queued: (r.queued ?? 0) + (r.already ?? 0),
      skipped: skippedOnSend,
      errorCount: r.errorCount ?? 0,
      errors: r.errors ?? [],
    },
  };
}

const keyParam = z.object({ key: z.string().refine((k) => Boolean(getTemplateDef(k)), 'Template desconhecido') });
const SEND_PERMS = [...new Set([...MAILING_TYPES.map((t) => t.permission), 'message.send'])];

/** Assunto é texto puro: sem tags e sem quebras de linha. */
const cleanSubject = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();

const templateBody = z.object({
  subject: z.string().max(300).transform(cleanSubject).pipe(z.string().min(1, 'Informe o assunto.')),
  body: z
    .string()
    .max(200_000)
    .transform((b) => sanitizeHtml(b))
    .pipe(z.string().refine((b) => b.replace(/<[^>]*>/g, '').trim().length > 0 || /<img\s/i.test(b), 'O conteúdo do e-mail está vazio.')),
});

const deliveriesQuery = z.object({
  search: z.string().trim().max(200).optional(),
  templateKey: z.string().max(60).optional(),
  channel: z.enum(['email', 'whatsapp']).optional(),
  status: z.enum(['queued', 'sent', 'delivered', 'failed']).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export async function communicationRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  // ------------------------------------------------------------------ templates
  app.get('/email-templates', { preHandler: guard('email_template.list') }, async (req) => {
    const user = requireUser(req);
    const custom = await db.select().from(emailTemplates).where(eq(emailTemplates.officeId, user.officeId));
    return TEMPLATES.map((def) => {
      const c = custom.find((x) => x.key === def.key);
      return { key: def.key, name: def.name, description: def.description, subject: c?.subject ?? def.defaultSubject, customized: Boolean(c), updatedAt: c?.updatedAt ?? null, variables: def.variables.length };
    });
  });

  app.get('/email-templates/:key', { preHandler: guard('email_template.list') }, async (req) => {
    const user = requireUser(req);
    const { key } = parse(keyParam, req.params);
    const tpl = await resolveTemplate(ctx, user.officeId, key);
    return {
      key,
      name: tpl.def.name,
      description: tpl.def.description,
      variables: tpl.def.variables,
      subject: tpl.subject,
      body: tpl.body,
      customized: tpl.customized,
      defaultSubject: tpl.def.defaultSubject,
      defaultBody: tpl.def.defaultBody,
      unknownVariables: unknownVariables(`${tpl.subject} ${tpl.body}`, tpl.def),
    };
  });

  app.put('/email-templates/:key', { preHandler: guard('email_template.edit') }, async (req) => {
    const user = requireUser(req);
    const { key } = parse(keyParam, req.params);
    const body = parse(templateBody, req.body);
    const def = getTemplateDef(key)!;
    const isDefault = body.subject === def.defaultSubject && body.body === sanitizeHtml(def.defaultBody);
    if (isDefault) {
      // igual ao padrão: não guarda cópia, o template volta a acompanhar o padrão do sistema
      await db.delete(emailTemplates).where(and(eq(emailTemplates.officeId, user.officeId), eq(emailTemplates.key, key)));
    } else {
      await db
        .insert(emailTemplates)
        .values({ officeId: user.officeId, key, subject: body.subject, body: body.body })
        .onConflictDoUpdate({ target: [emailTemplates.officeId, emailTemplates.key], set: { subject: body.subject, body: body.body, updatedAt: new Date() } });
    }
    await audit(req, 'update', 'email_template', key);
    return { key, subject: body.subject, body: isDefault ? def.defaultBody : body.body, customized: !isDefault, unknownVariables: unknownVariables(`${body.subject} ${body.body}`, def) };
  });

  /** Restaura o modelo padrão (apaga a personalização do escritório). */
  app.delete('/email-templates/:key', { preHandler: guard('email_template.edit') }, async (req) => {
    const user = requireUser(req);
    const { key } = parse(keyParam, req.params);
    const def = getTemplateDef(key)!;
    await db.delete(emailTemplates).where(and(eq(emailTemplates.officeId, user.officeId), eq(emailTemplates.key, key)));
    await audit(req, 'restore_default', 'email_template', key);
    return { key, subject: def.defaultSubject, body: def.defaultBody, customized: false, unknownVariables: [] };
  });

  /** Pré-visualização com valores de exemplo (do texto em edição ou do salvo). */
  app.post('/email-templates/:key/preview', { preHandler: guard('email_template.list') }, async (req) => {
    const user = requireUser(req);
    const { key } = parse(keyParam, req.params);
    const body = parse(z.object({ subject: z.string().max(300).optional(), body: z.string().max(200_000).optional(), year: yearSchema.optional() }), req.body);
    const tpl = await resolveTemplate(ctx, user.officeId, key);
    const subject = cleanSubject(body.subject ?? tpl.subject);
    const html = sanitizeHtml(body.body ?? tpl.body);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, user.officeId) });
    const sample: Record<string, string | number> = { ...sampleTemplateValues(body.year ?? new Date().getFullYear()), ESCRITORIO: office?.name ?? '', CONTADOR: user.name };
    // só as variáveis do template recebem valor; as desconhecidas ficam visíveis como {{VAR}}
    const values = Object.fromEntries(tpl.def.variables.map((v) => [v.name, sample[v.name] ?? '']));
    return {
      subject: renderTemplate(subject, values, { html: false }),
      html: renderTemplate(html, values, { rawHtml: ['PENDENCIAS'] }),
      unknownVariables: unknownVariables(`${subject} ${html}`, tpl.def),
    };
  });

  // ------------------------------------------------------------------ envios
  /** Envios visíveis: do escritório e, se ele restringe por responsável, só dos clientes do usuário. */
  const deliveryScope = async (user: AuthUser): Promise<SQL> => {
    const conds: SQL[] = [eq(deliveries.officeId, user.officeId)];
    const settings = await getOfficeSettings(db, user.officeId);
    if (!user.isOwner && settings.restrictCustomersToResponsible) {
      conds.push(exists(db.select({ x: sql`1` }).from(customers).where(and(eq(customers.id, deliveries.customerId), eq(customers.responsibleUserId, user.userId)))));
    }
    return and(...conds)!;
  };

  app.get('/deliveries', { preHandler: guard('mailing.list') }, async (req) => {
    const user = requireUser(req);
    const q = parse(deliveriesQuery, req.query);
    const conds: SQL[] = [await deliveryScope(user)];
    if (q.search) {
      const term = `%${q.search}%`;
      conds.push(or(ilike(deliveries.toName, term), ilike(deliveries.toAddress, term), ilike(customers.name, term))!);
    }
    if (q.templateKey) conds.push(q.templateKey === 'none' ? isNull(deliveries.templateKey) : eq(deliveries.templateKey, q.templateKey));
    if (q.channel) conds.push(eq(deliveries.channel, q.channel));
    if (q.status) conds.push(eq(deliveries.status, q.status));
    const day = sql`(${deliveries.createdAt} at time zone 'America/Sao_Paulo')::date`;
    if (q.from) conds.push(sql`${day} >= ${q.from}::date`);
    if (q.to) conds.push(sql`${day} <= ${q.to}::date`);
    const where = and(...conds);
    const [{ total }] = await db.select({ total: count() }).from(deliveries).leftJoin(customers, eq(customers.id, deliveries.customerId)).where(where);
    const rows = await db
      .select({
        id: deliveries.id,
        customerId: deliveries.customerId,
        customerName: customers.name,
        channel: deliveries.channel,
        templateKey: deliveries.templateKey,
        subject: deliveries.subject,
        toAddress: deliveries.toAddress,
        toName: deliveries.toName,
        status: deliveries.status,
        error: deliveries.error,
        attachments: deliveries.attachments,
        sentAt: deliveries.sentAt,
        createdAt: deliveries.createdAt,
      })
      .from(deliveries)
      .leftJoin(customers, eq(customers.id, deliveries.customerId))
      .where(where)
      .orderBy(desc(deliveries.createdAt), asc(deliveries.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return paginate(
      rows.map((r) => ({ ...r, attachments: r.attachments.length })),
      total,
      q.page,
      q.pageSize,
    );
  });

  const loadDelivery = async (user: AuthUser, id: string) => {
    const [row] = await db
      .select({ d: deliveries, customerName: customers.name })
      .from(deliveries)
      .leftJoin(customers, eq(customers.id, deliveries.customerId))
      .where(and(await deliveryScope(user), eq(deliveries.id, id)));
    if (!row) throw notFound('Envio');
    return row;
  };

  app.get('/deliveries/:id', { preHandler: guard('mailing.list') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { d, customerName } = await loadDelivery(user, id);
    const { idempotencyKey, providerMessageId, ...rest } = d;
    return {
      ...rest,
      body: d.channel === 'email' ? sanitizeHtml(d.body) : d.body,
      customerName,
      templateName: d.templateKey ? (getTemplateDef(d.templateKey)?.name ?? d.templateKey) : null,
      canResend: d.status === 'failed',
    };
  });

  /** Reenvia um envio que falhou (o mesmo registro volta para a fila). */
  app.post('/deliveries/:id/resend', { preHandler: guard('mailing.list') }, async (req) => {
    const user = requirePermission(req, ...SEND_PERMS);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { d } = await loadDelivery(user, id);
    if (d.status !== 'failed') throw conflict('Só é possível reenviar envios que falharam.');
    // troca de estado atômica: dois cliques seguidos não geram dois reenvios
    const [row] = await db
      .update(deliveries)
      .set({ status: 'queued', error: null })
      .where(and(eq(deliveries.id, d.id), eq(deliveries.status, 'failed')))
      .returning();
    if (!row) throw conflict('Este envio já foi colocado na fila novamente.');
    await ctx.jobs.enqueue('delivery.send', { deliveryId: row.id }, { officeId: user.officeId, idempotencyKey: `${row.id}:resend:${randomUUID()}`, userId: user.userId });
    await audit(req, 'resend', 'delivery', row.id);
    return { ok: true, status: row.status };
  });

  /** Opções dos filtros de envios. */
  app.get('/deliveries/options', { preHandler: guard('mailing.list') }, async () => ({
    templates: TEMPLATES.map((t) => ({ value: t.key, label: t.name })),
    channels: Object.entries(DELIVERY_CHANNELS).map(([value, label]) => ({ value, label })),
    statuses: Object.entries(DELIVERY_STATUS).map(([value, label]) => ({ value, label })),
  }));

  // ------------------------------------------------------------------ mala direta
  const typePermission = (req: FastifyRequest, type: string) => {
    const t = getMailingType(type);
    if (!t) throw badRequest('Tipo de envio inválido.');
    return requirePermission(req, t.permission);
  };

  /** Tipos de envio que o usuário pode usar. */
  app.get('/mailing/types', async (req) => {
    const user = requireUser(req);
    return MAILING_TYPES.map((t) => ({ ...t, allowed: can(user, t.permission) }));
  });

  /** Revisão do envio: contagens, motivos de quem fica de fora e a mensagem de um cliente. */
  app.post('/mailing/preview', async (req) => {
    const input = parse(mailingSchema, req.body);
    const user = typePermission(req, input.type);
    const { type, entries, matched, truncated } = await planMailing(ctx, user, input);
    const wanted = input.channel === 'both' ? 2 : 1;
    // exemplo: o cliente escolhido ou, de preferência, um que receba por todos os canais pedidos
    const sampleEntry =
      entries.find((e) => e.customer.id === input.previewCustomerId) ?? entries.find((e) => e.channels.length === wanted) ?? entries.find((e) => e.channels.length) ?? entries[0];
    const rendered = sampleEntry ? await renderForCustomer(ctx, user.officeId, type, sampleEntry, input.year) : null;
    const sample =
      sampleEntry && rendered
        ? {
            customerId: sampleEntry.customer.id,
            customerName: sampleEntry.customer.name,
            email: sampleEntry.customer.email,
            mobile: sampleEntry.customer.mobile,
            channels: sampleEntry.channels,
            skips: sampleEntry.skips,
            subject: rendered.subject,
            html: sanitizeHtml(rendered.html),
            text: rendered.text,
            attachment: type.attachment ? (type.attachment === 'kit' ? 'Kit pós-declaração (PDF)' : 'Checklist de documentos (PDF)') : null,
          }
        : null;
    return {
      type: { key: type.key, label: type.label, templateKey: type.templateKey, note: type.note ?? null, attachment: type.attachment },
      ...summarize(entries),
      // mais clientes que o limite: a tela avisa e o envio é recusado (nada é cortado em silêncio)
      matched,
      truncated,
      limit: MAILING_MAX_RECIPIENTS,
      recipients: entries.slice(0, 300).map((e) => ({
        id: e.customer.id,
        name: e.customer.name,
        email: e.customer.email,
        mobile: e.customer.mobile,
        channels: e.channels,
        skips: e.skips,
        stage: e.declaration?.stage ?? 'not_started',
      })),
      sample,
    };
  });

  /**
   * Envia: registra a mala direta na fila e responde na hora (202). O job gera os envios em lotes
   * (um por cliente e canal) e grava o andamento, que a tela acompanha em `GET /mailing/runs/:id`.
   * Repetir o pedido (mesmo `requestId`) devolve a mala direta já registrada, sem enviar de novo.
   */
  app.post('/mailing/send', async (req, reply) => {
    const input = parse(mailingSchema.extend({ requestId: z.uuid() }), req.body);
    const user = typePermission(req, input.type);
    const { job, created } = await requestMailing(ctx, user, input);
    if (created) {
      const p = job.payload as MailingRunPayload;
      await audit(req, 'mailing_send', 'mailing', input.requestId, { type: input.type, channel: input.channel, year: input.year, customers: p.planned.customers, deliveries: p.planned.deliveries.total });
    }
    reply.status(202);
    return { ...runView(job), alreadyRequested: !created };
  });

  /** Quem acompanha uma mala direta: quem tem "E-mails enviados" sem restrição de carteira vê todas; os demais, as próprias. */
  const runScope = async (user: AuthUser): Promise<SQL> => {
    const conds: SQL[] = [eq(jobs.officeId, user.officeId), eq(jobs.type, MAILING_JOB)];
    const restricted = !user.isOwner && (await getOfficeSettings(db, user.officeId)).restrictCustomersToResponsible;
    if (restricted || !can(user, 'mailing.list')) conds.push(eq(jobs.createdByUserId, user.userId));
    return and(...conds)!;
  };

  /** Colunas da mala direta sem a lista de destinatários (que pode ter milhares de linhas). */
  const runColumns = {
    id: jobs.id,
    status: jobs.status,
    progress: jobs.progress,
    error: jobs.error,
    result: jobs.result,
    createdAt: jobs.createdAt,
    finishedAt: jobs.finishedAt,
    createdByUserId: jobs.createdByUserId,
    payload: sql<Omit<MailingRunPayload, 'targets'>>`${jobs.payload} - 'targets'`,
    total: sql<number>`coalesce(jsonb_array_length(${jobs.payload}->'targets'), 0)`.mapWith(Number),
  };

  /** Malas diretas recentes, com o andamento. */
  app.get('/mailing/runs', async (req) => {
    const user = requirePermission(req, ...SEND_PERMS);
    const rows = await db.select(runColumns).from(jobs).where(await runScope(user)).orderBy(desc(jobs.createdAt)).limit(10);
    return rows.map(runView);
  });

  app.get('/mailing/runs/:id', async (req) => {
    const user = requirePermission(req, ...SEND_PERMS);
    const { id } = parse(uuidParam, req.params);
    const [row] = await db.select(runColumns).from(jobs).where(and(await runScope(user), eq(jobs.id, id)));
    if (!row) throw notFound('Mala direta');
    return runView(row);
  });

  /** Anexo de exemplo (kit ou checklist em PDF) de um cliente, para conferir antes do envio. */
  app.get('/mailing/attachment-preview', async (req, reply) => {
    const q = parse(z.object({ type: z.enum(['kit', 'checklist_pdf']), customerId: z.uuid(), year: yearSchema }), req.query);
    const user = typePermission(req, q.type);
    const customer = await getCustomerForUser(ctx, user, q.customerId);
    let file: { buffer: Buffer; filename: string };
    if (q.type === 'kit') {
      const declaration = await db.query.declarations.findFirst({ where: (d, { and: a, eq: e }) => a(e(d.customerId, customer.id), e(d.exerciseYear, q.year)) });
      if (!declaration) throw badRequest('O cliente não tem declaração neste exercício.');
      file = await buildKitPdf(ctx, declaration, customer);
    } else {
      // o mesmo PDF da etapa Documentação (checklist digital do cliente, quando houver)
      file = await checklistPdfFor(ctx, customer, q.year);
    }
    return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${file.filename}"`).send(file.buffer);
  });
}
