import { and, desc, eq, exists, isNotNull, isNull, notExists, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '../../context';
import { customers, notificationReads, notifications, users } from '../../db/schema';
import { parse, requireUser, uuidParam } from '../../lib/http';
import { getOfficeSettings } from '../../services/settings';

export async function notificationRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  /**
   * Notificações visíveis ao usuário: as dele e as do escritório (userId nulo). As ligadas a um
   * cliente respeitam a restrição "contadores veem só seus clientes".
   */
  const visible = async (user: AuthUser): Promise<SQL> => {
    const conds: SQL[] = [eq(notifications.officeId, user.officeId), or(eq(notifications.userId, user.userId), isNull(notifications.userId))!];
    const restricted = !user.isOwner && (await getOfficeSettings(db, user.officeId)).restrictCustomersToResponsible === true;
    if (restricted) {
      conds.push(
        or(
          eq(notifications.userId, user.userId),
          isNull(notifications.customerId),
          exists(
            db
              .select({ x: sql`1` })
              .from(customers)
              .where(and(eq(customers.id, notifications.customerId), eq(customers.responsibleUserId, user.userId), isNull(customers.deletedAt))),
          ),
        )!,
      );
    }
    return and(...conds)!;
  };

  app.get('/notifications', async (req) => {
    const user = requireUser(req);
    // o usuário pode desligar as notificações em Conta › Preferências
    const me = await db.query.users.findFirst({ where: eq(users.id, user.userId) });
    if (me?.notificationPrefs?.enabled === false) return [];
    const rows = await db
      .select({
        id: notifications.id,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        // nulo = aviso do escritório inteiro; preenchido = aviso só deste usuário
        userId: notifications.userId,
        customerId: notifications.customerId,
        // pessoal: lida na própria linha; do escritório: lida por usuário
        readAt: sql<Date | null>`coalesce(${notifications.readAt}, ${notificationReads.readAt})`,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, user.userId)))
      .where(await visible(user))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    return rows;
  });

  /** Marca como lida só para quem leu (a notificação do escritório continua não lida para os outros). */
  async function markRead(user: AuthUser, extra?: SQL) {
    const where = and(await visible(user), ...(extra ? [extra] : []));
    const now = new Date();
    await db.update(notifications).set({ readAt: now }).where(and(where, eq(notifications.userId, user.userId), isNull(notifications.readAt)));
    const shared = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          where,
          isNull(notifications.userId),
          notExists(db.select({ x: sql`1` }).from(notificationReads).where(and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, user.userId)))),
        ),
      );
    if (shared.length) {
      await db
        .insert(notificationReads)
        .values(shared.map((n) => ({ notificationId: n.id, userId: user.userId, readAt: now })))
        .onConflictDoNothing();
    }
  }

  app.post('/notifications/:id/read', async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    await markRead(user, eq(notifications.id, id));
    return { ok: true };
  });

  app.post('/notifications/read-all', async (req) => {
    const user = requireUser(req);
    await markRead(user, isNotNull(notifications.id));
    return { ok: true };
  });
}
