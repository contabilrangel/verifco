import { and, count, desc, eq, gte, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { customers, deliveries, messages, notifications, offices, users } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { queueDelivery } from '../../services/delivery';
import { notify } from '../../services/notify';
import { sendStoredFile } from '../../services/uploads';
import { requirePortal } from '../portal/access';
import { attachmentOf, messagePreview, publicAttachments, readMessageInput, removeAttachments, saveAttachments } from './attachments';
import { listThreads, threadsQuery, unreadCount } from './threads';

const MAX_MESSAGES = 300;
const attachmentParams = z.object({ messageId: z.uuid(), fileId: z.uuid() });
/** Mensagens novas do cliente em sequência geram uma notificação só (enquanto não lida). */
const NOTIFY_COALESCE_MS = 30 * 60_000;

/** Escapa só o necessário para o texto passar pelo conversor HTML → texto do WhatsApp. */
const escapeForWhatsApp = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Conversa entre escritório e cliente. O escritório envia pelo portal (e, se quiser, também
 * por WhatsApp); o cliente lê e responde no portal. A caixa de mensagens (`/messages/threads`)
 * junta as conversas de todos os clientes que o usuário enxerga.
 * `direction`: 'out' = do escritório para o cliente; 'in' = do cliente para o escritório.
 * `readAt`: quando o destinatário leu.
 * `attachments`: arquivos da mensagem; só saem pelas rotas de anexo daqui, que conferem a
 * conversa (escritório: escopo do cliente; portal: o próprio cliente).
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
        attachments: messages.attachments,
        authorName: users.name,
        deliveryStatus: deliveries.status,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .leftJoin(deliveries, eq(deliveries.id, messages.deliveryId))
      .where(and(eq(messages.officeId, officeId), eq(messages.customerId, customerId)))
      .orderBy(desc(messages.createdAt))
      .limit(MAX_MESSAGES);
    return rows.reverse().map((m) => ({ ...m, attachments: publicAttachments(m.attachments) }));
  }

  /** Entrega o anexo `fileId` da mensagem (que já foi conferida como sendo da conversa de quem pede). */
  async function sendAttachment(req: FastifyRequest, reply: FastifyReply, officeId: string, customerId: string) {
    const { messageId, fileId } = parse(attachmentParams, req.params);
    const message = await db.query.messages.findFirst({ where: and(eq(messages.id, messageId), eq(messages.officeId, officeId), eq(messages.customerId, customerId)) });
    const attachment = attachmentOf(message, fileId);
    const { row, stream } = await ctx.files.open(officeId, attachment.fileId);
    return sendStoredFile(reply, { ...row, filename: attachment.filename }, stream, (req.query as Record<string, string>).inline === '1');
  }

  // ------------------------------------------------------------------ escritório
  /** Caixa de mensagens: uma linha por cliente com conversa (mesma permissão de ler a conversa do cliente). */
  app.get('/messages/threads', { preHandler: guard('customer.list') }, async (req) => {
    const user = requireUser(req);
    return listThreads(ctx, user, parse(threadsQuery, req.query));
  });

  /** Selo do menu: mensagens de clientes ainda não lidas pelo escritório. */
  app.get('/messages/unread-count', { preHandler: guard('customer.list') }, async (req) => unreadCount(ctx, requireUser(req)));

  app.get('/customers/:id/messages', { preHandler: guard('customer.list') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const customer = await getCustomerForUser(ctx, user, id);
    const list = await conversation(user.officeId, customer.id);
    return {
      // a caixa de mensagens abre a conversa só com o id do cliente
      customer: { id: customer.id, name: customer.name },
      messages: list,
      unread: list.filter((m) => m.direction === 'in' && !m.readAt).length,
      portalEnabled: customer.portalEnabled,
      hasMobile: Boolean(customer.mobile),
    };
  });

  app.post('/customers/:id/messages', { preHandler: guard('message.send') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const customer = await getCustomerForUser(ctx, user, id);
    const input = await readMessageInput(req);
    if (input.whatsapp) {
      // pelo WhatsApp o arquivo vai como documento da própria mensagem: um por envio, com o texto
      if (!input.body) throw badRequest('Para enviar por WhatsApp, escreva a mensagem.');
      if (input.files.length > 1) throw badRequest('Pelo WhatsApp vai um anexo por mensagem. Envie os arquivos um a um ou desmarque o WhatsApp.');
    }
    const attachments = await saveAttachments(ctx, user.officeId, input.files, user.userId);
    try {
      if (input.whatsapp) {
        // o envio por WhatsApp já registra a mensagem na conversa (canal whatsapp)
        const delivery = await queueDelivery(ctx, {
          officeId: user.officeId,
          customerId: customer.id,
          channel: 'whatsapp',
          body: escapeForWhatsApp(input.body),
          attachments: attachments.map((a) => ({ fileId: a.fileId, filename: a.filename })),
          userId: user.userId,
        });
        if (attachments.length) await db.update(messages).set({ attachments }).where(and(eq(messages.officeId, user.officeId), eq(messages.deliveryId, delivery.id)));
      } else {
        await db.insert(messages).values({ officeId: user.officeId, customerId: customer.id, direction: 'out', channel: 'portal', body: input.body, authorUserId: user.userId, attachments });
      }
    } catch (err) {
      await removeAttachments(ctx, user.officeId, attachments);
      throw err;
    }
    await audit(req, 'send_message', 'customer', customer.id, { whatsapp: input.whatsapp, attachments: attachments.length });
    reply.status(201);
    return { messages: await conversation(user.officeId, customer.id) };
  });

  app.get('/customers/:id/messages/:messageId/attachments/:fileId', { preHandler: guard('customer.list') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const customer = await getCustomerForUser(ctx, user, id);
    return sendAttachment(req, reply, user.officeId, customer.id);
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
      .select({ id: messages.id, direction: messages.direction, channel: messages.channel, body: messages.body, createdAt: messages.createdAt, readAt: messages.readAt, attachments: messages.attachments })
      .from(messages)
      .where(and(eq(messages.officeId, officeId), eq(messages.customerId, customerId)))
      .orderBy(desc(messages.createdAt))
      .limit(MAX_MESSAGES);
    return {
      officeName: office?.name ?? '',
      messages: rows.reverse().map((m) => ({ ...m, attachments: publicAttachments(m.attachments), fromMe: m.direction === 'in' })),
      unread: rows.filter((m) => m.direction === 'out' && !m.readAt).length,
    };
  }

  app.get('/portal/messages', async (req) => {
    const auth = requirePortal(req);
    return portalConversation(auth.officeId, auth.customerId);
  });

  app.post('/portal/messages', async (req, reply) => {
    const auth = requirePortal(req);
    const customer = await db.query.customers.findFirst({ where: and(eq(customers.id, auth.customerId), eq(customers.officeId, auth.officeId)) });
    if (!customer) throw notFound('Cliente');
    const input = await readMessageInput(req);
    const attachments = await saveAttachments(ctx, auth.officeId, input.files);
    try {
      await db.insert(messages).values({ officeId: auth.officeId, customerId: customer.id, direction: 'in', channel: 'portal', body: input.body, attachments });
    } catch (err) {
      await removeAttachments(ctx, auth.officeId, attachments);
      throw err;
    }

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
        body: messagePreview(input.body, attachments.length),
        link,
      });
    }
    reply.status(201);
    return portalConversation(auth.officeId, auth.customerId);
  });

  /** O cliente só baixa anexos de mensagens da própria conversa. */
  app.get('/portal/messages/:messageId/attachments/:fileId', async (req, reply) => {
    const auth = requirePortal(req);
    return sendAttachment(req, reply, auth.officeId, auth.customerId);
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
