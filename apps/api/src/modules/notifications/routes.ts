import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { notifications } from '../../db/schema';
import { parse, requireUser, uuidParam } from '../../lib/http';

export async function notificationRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  // notificações do usuário ou do escritório inteiro (userId nulo)
  const mine = (officeId: string, userId: string) =>
    and(eq(notifications.officeId, officeId), or(eq(notifications.userId, userId), isNull(notifications.userId)));

  app.get('/notifications', async (req) => {
    const user = requireUser(req);
    return db.select().from(notifications).where(mine(user.officeId, user.userId)).orderBy(desc(notifications.createdAt)).limit(50);
  });

  app.post('/notifications/:id/read', async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), mine(user.officeId, user.userId)));
    return { ok: true };
  });

  app.post('/notifications/read-all', async (req) => {
    const user = requireUser(req);
    await db.update(notifications).set({ readAt: new Date() }).where(and(mine(user.officeId, user.userId), isNull(notifications.readAt)));
    return { ok: true };
  });
}
