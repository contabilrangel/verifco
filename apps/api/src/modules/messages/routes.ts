import { and, count, desc, eq, gte, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { customers, deliveries, messages, notifications, offices, users } from '../../db/schema';
import { notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { queueDelivery } from '../../services/delivery';
import { notify } from '../../services/notify';
import { requirePortal } from '../portal/access';

const MAX_MESSAGES = 300;
const messageBody = z.string().trim().min(1, 'Escreva a mensagem').max(4000, 'Mensagem muito longa (máximo de 4.000 caracteres)');
/** Mensagens novas do cliente em sequência geram uma notificação só (enquanto não lida). */
const NOTIFY_COALESCE_MS = 30 * 60_000;

/**
 * Texto digitado → HTML que o conversor do WhatsApp (htmlToText) devolve igual: escapa o que seria
 * lido como tag ou entidade e mantém as quebras de linha (no HTML, quebra do código não conta).
 */
const escapeForWhatsApp = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');

/**
 * Conversa entre escritório e cliente. O escritório envia pelo portal (e, se quiser, também
 * por WhatsApp); o cliente lê e responde no portal.
 * `direction`: 'out' = do escritório para o cliente; 'in' = do cliente para o escritório.
 * `readAt`: quando o destinatário leu.
 */
export async function messagesRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  async function conversation(officeId: string, customerId: string) {
    const rows = await db
      .select({
        id: messages.id,
        direction: messages.direction,
        channel: messages.channel,
        body: messages.body,
        createdAt: messages.createdAt,
        readAt: messages.readAt,
        authorName: users.name,
        deliveryStatus: deliveries.status,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .leftJoin(deliveries, eq(deliveries.id, messages.deliveryId))
      .where(and(eq(messages.officeId, officeId), eq(messages.customerId, customerId)))
      .orderBy(desc(messages.createdAt))
      .limit(MAX_MESSAGES);
    return rows.reverse();
  }

  // ------------------------------------------------------------------ escritório
  app.get('/customers/:id/messages', { preHandler: guard('customer.list') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const customer = await getCustomerForUser(ctx, user, id);
    const list = await conversation(user.officeId, customer.id);
    return {
      messages: list,
      unread: list.filter((m) => m.direction === 'in' && !m.readAt).length,
      portalEnabled: customer.portalEnabled,
      hasMobile: Boolean(customer.mobile),
    };
  });

  app.post('/customers/:id/messages', { preHandler: guard('message.send') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ body: messageBody, whatsapp: z.boolean().default(false) }), req.body);
    const customer = await getCustomerForUser(ctx, user, id);
    if (body.whatsapp) {
      // o envio por WhatsApp já registra a mensagem na conversa (canal whatsapp)
      await queueDelivery(ctx, { officeId: user.officeId, customerId: customer.id, channel: 'whatsapp', body: escapeForWhatsApp(body.body), userId: user.userId });
    } else {
      await db.insert(messages).values({ officeId: user.officeId, customerId: customer.id, direction: 'out', channel: 'portal', body: body.body, authorUserId: user.userId });
    }
    await audit(req, 'send_message', 'customer', customer.id, { whatsapp: body.whatsapp });
    reply.status(201);
    return { messages: await conversation(user.officeId, customer.id) };
  });

  app.post('/customers/:id/messages/read', { preHandler: guard('customer.list') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const customer = await getCustomerForUser(ctx, user, id);
    await db
      .update(messages)
      .set({ readAt: new Date() })
      .where(and(eq(messages.officeId, user.officeId), eq(messages.customerId, customer.id), eq(messages.direction, 'in'), isNull(messages.readAt)));
    return { ok: true };
  });

  // ------------------------------------------------------------------ cliente (portal)
  /** Na visão do cliente, as mensagens do escritório aparecem com o nome do escritório. */
  async function portalConversation(officeId: string, customerId: string) {
    const office = await db.query.offices.findFirst({ where: eq(offices.id, officeId) });
    const rows = await db
      .select({ id: messages.id, direction: messages.direction, channel: messages.channel, body: messages.body, createdAt: messages.createdAt, readAt: messages.readAt })
      .from(messages)
      .where(and(eq(messages.officeId, officeId), eq(messages.customerId, customerId)))
      .orderBy(desc(messages.createdAt))
      .limit(MAX_MESSAGES);
    return {
      officeName: office?.name ?? '',
      messages: rows.reverse().map((m) => ({ ...m, fromMe: m.direction === 'in' })),
      unread: rows.filter((m) => m.direction === 'out' && !m.readAt).length,
    };
  }

  app.get('/portal/messages', async (req) => {
    const auth = requirePortal(req);
    return portalConversation(auth.officeId, auth.customerId);
  });

  app.post('/portal/messages', async (req, reply) => {
    const auth = requirePortal(req);
    const body = parse(z.object({ body: messageBody }), req.body);
    const customer = await db.query.customers.findFirst({ where: and(eq(customers.id, auth.customerId), eq(customers.officeId, auth.officeId)) });
    if (!customer) throw notFound('Cliente');
    await db.insert(messages).values({ officeId: auth.officeId, customerId: customer.id, direction: 'in', channel: 'portal', body: body.body });

    const link = `/clientes/${customer.id}/mensagens`;
    const recent = await db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.officeId, auth.officeId), eq(notifications.link, link), isNull(notifications.readAt), gte(notifications.createdAt, new Date(Date.now() - NOTIFY_COALESCE_MS))));
    if (!recent[0].n) {
      await notify(db, {
        officeId: auth.officeId,
        userId: customer.responsibleUserId ?? null,
        customerId: customer.id,
        title: `Nova mensagem de ${customer.name}`,
        body: body.body.length > 140 ? `${body.body.slice(0, 139)}…` : body.body,
        link,
      });
    }
    reply.status(201);
    return portalConversation(auth.officeId, auth.customerId);
  });

  app.post('/portal/messages/read', async (req) => {
    const auth = requirePortal(req);
    await db
      .update(messages)
      .set({ readAt: new Date() })
      .where(and(eq(messages.officeId, auth.officeId), eq(messages.customerId, auth.customerId), eq(messages.direction, 'out'), isNull(messages.readAt)));
    return { ok: true };
  });
}
