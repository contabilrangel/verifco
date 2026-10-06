import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { brazilToday, formatDate } from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { backlogs } from '../../db/schema';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { audit, dateStr, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { queueDelivery } from '../../services/delivery';
import { syncBacklogSubstatus } from '../../services/declarations';
import { getDeclarationForUser } from './access';

type BacklogRow = typeof backlogs.$inferSelect;

const description = z.string().trim().min(2, 'Descreva o documento').max(2000);
const dueDate = z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional());

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Lista HTML das pendências em aberto para o template `missing_document`. */
export function backlogListHtml(items: { description: string; dueDate: string | null }[]): string {
  const li = items.map((b) => `<li>${escapeHtml(b.description)}${b.dueDate ? ` <em>(até ${formatDate(b.dueDate)})</em>` : ''}</li>`);
  return `<ul>${li.join('')}</ul>`;
}

async function getBacklogForUser(ctx: AppContext, user: AuthUser, id: string) {
  const backlog = await ctx.db.query.backlogs.findFirst({ where: and(eq(backlogs.id, id), eq(backlogs.officeId, user.officeId)) });
  if (!backlog) throw notFound('Pendência');
  await getCustomerForUser(ctx, user, backlog.customerId).catch((err) => {
    throw err instanceof HttpError && err.statusCode === 404 ? notFound('Pendência') : err;
  });
  return backlog;
}

const present = (b: BacklogRow, today = brazilToday()) => ({ ...b, overdue: !b.resolvedAt && Boolean(b.dueDate && b.dueDate < today) });

/**
 * Documentos faltantes da declaração.
 * - Criar uma pendência com a declaração em preenchimento muda o subestado para
 *   "Documentos faltantes".
 * - Ao baixar (ou excluir) a última pendência em aberto, a declaração que estava em
 *   "Documentos faltantes" volta para "Em elaboração".
 */
export async function backlogRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  // a mesma regra vale para as pendências criadas pelo checklist digital (services/declarations.ts)
  const syncSubstatus = (declarationId: string) => syncBacklogSubstatus(db, declarationId);

  app.get('/declarations/:id/backlogs', { preHandler: guard('declaration.view') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const rows = await db
      .select()
      .from(backlogs)
      .where(eq(backlogs.declarationId, declaration.id))
      .orderBy(sql`${backlogs.resolvedAt} is not null`, asc(backlogs.dueDate), asc(backlogs.createdAt));
    const today = brazilToday();
    return rows.map((b) => present(b, today));
  });

  app.post('/declarations/:id/backlogs', { preHandler: guard('declaration.edit') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ description, dueDate }), req.body);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const [row] = await db
      .insert(backlogs)
      .values({ officeId: user.officeId, customerId: declaration.customerId, declarationId: declaration.id, description: body.description, dueDate: body.dueDate ?? null, createdByUserId: user.userId })
      .returning();
    await syncSubstatus(declaration.id);
    await audit(req, 'create', 'backlog', row.id);
    reply.status(201);
    return present(row);
  });

  /** Edita, dá baixa (`resolved: true`) ou reabre (`resolved: false`). */
  app.put('/backlogs/:id', { preHandler: guard('declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ description: description.optional(), dueDate, resolved: z.boolean().optional() }), req.body);
    const backlog = await getBacklogForUser(app.ctx, user, id);
    const [row] = await db
      .update(backlogs)
      .set({
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
        ...(body.resolved !== undefined ? { resolvedAt: body.resolved ? (backlog.resolvedAt ?? new Date()) : null } : {}),
      })
      .where(eq(backlogs.id, backlog.id))
      .returning();
    if (body.resolved !== undefined) await syncSubstatus(backlog.declarationId);
    await audit(req, body.resolved === undefined ? 'update' : body.resolved ? 'resolve' : 'reopen', 'backlog', backlog.id);
    return present(row);
  });

  app.delete('/backlogs/:id', { preHandler: guard('declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const backlog = await getBacklogForUser(app.ctx, user, id);
    await db.delete(backlogs).where(eq(backlogs.id, backlog.id));
    await syncSubstatus(backlog.declarationId);
    await audit(req, 'delete', 'backlog', backlog.id);
    return { ok: true };
  });

  /** Envia a lista em aberto por e-mail ou WhatsApp (template `missing_document`). */
  app.post('/declarations/:id/backlogs/send', { preHandler: guard('declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { channel } = parse(z.object({ channel: z.enum(['email', 'whatsapp']) }), req.body);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const open = await db
      .select()
      .from(backlogs)
      .where(and(eq(backlogs.declarationId, declaration.id), isNull(backlogs.resolvedAt)))
      .orderBy(asc(backlogs.dueDate), asc(backlogs.createdAt));
    if (!open.length) throw badRequest('Não há documentos faltantes em aberto para enviar.');
    const delivery = await queueDelivery(app.ctx, {
      officeId: user.officeId,
      customerId: declaration.customerId,
      channel,
      templateKey: 'missing_document',
      values: { PENDENCIAS: backlogListHtml(open) },
      rawHtml: ['PENDENCIAS'],
      exerciseYear: declaration.exerciseYear,
      userId: user.userId,
    });
    await audit(req, 'send', 'backlog', declaration.id, { channel, count: open.length });
    return { ok: true, deliveryId: delivery.id, count: open.length };
  });
}
