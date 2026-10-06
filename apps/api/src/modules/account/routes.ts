import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { customers, procurators, users } from '../../db/schema';
import { audit, parse, requireUser } from '../../lib/http';
import { serializeMe } from '../auth/routes';
import { publicProcurator } from '../customers/routes';

/** Navegadores com notificação ligada por usuário (Conta › Preferências › Este navegador). */
const MAX_DEVICES = 20;
const deviceParam = z.object({ deviceId: z.uuid('Dispositivo inválido.') });

/** Conta do próprio usuário (o e-mail só é alterado por quem administra colaboradores). */
export async function accountRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.put('/account/profile', async (req) => {
    const auth = requireUser(req);
    const body = parse(z.object({ name: z.string().trim().min(2, 'Informe o nome').max(200) }), req.body);
    await db.update(users).set({ name: body.name, updatedAt: new Date() }).where(eq(users.id, auth.userId));
    await audit(req, 'update_profile', 'user', auth.userId);
    return serializeMe(app, auth.userId);
  });

  /** Registros de procurador do próprio usuário (cartão "Você como procurador"), sem exigir procuration.list. */
  app.get('/account/procurator', async (req) => {
    const auth = requireUser(req);
    const rows = await db
      .select({ p: procurators, customers: count(customers.id) })
      .from(procurators)
      .leftJoin(customers, and(eq(customers.procuratorId, procurators.id), isNull(customers.deletedAt)))
      .where(and(eq(procurators.officeId, auth.officeId), eq(procurators.userId, auth.userId)))
      .groupBy(procurators.id)
      .orderBy(asc(procurators.name));
    return rows.map(({ p, customers: n }) => ({ ...publicProcurator(p), customers: n }));
  });

  // ------------------------------------------------------------------ notificações por navegador
  const devicesOf = async (userId: string) => (await db.query.users.findFirst({ where: eq(users.id, userId) }))?.notificationPrefs ?? {};

  /** Liga as notificações do navegador atual (o id do dispositivo é gerado e guardado no navegador). */
  app.post('/account/notification-devices', async (req) => {
    const auth = requireUser(req);
    const { deviceId } = parse(deviceParam, req.body);
    const prefs = await devicesOf(auth.userId);
    const devices = [deviceId, ...(prefs.devices ?? []).filter((d) => d !== deviceId)].slice(0, MAX_DEVICES);
    await db.update(users).set({ notificationPrefs: { ...prefs, devices } }).where(eq(users.id, auth.userId));
    return serializeMe(app, auth.userId);
  });

  app.delete('/account/notification-devices/:deviceId', async (req) => {
    const auth = requireUser(req);
    const { deviceId } = parse(deviceParam, req.params);
    const prefs = await devicesOf(auth.userId);
    await db
      .update(users)
      .set({ notificationPrefs: { ...prefs, devices: (prefs.devices ?? []).filter((d) => d !== deviceId) } })
      .where(eq(users.id, auth.userId));
    return serializeMe(app, auth.userId);
  });

  /** "Revogar todas as notificações": desliga em todos os navegadores (as sessões continuam). */
  app.delete('/account/notification-devices', async (req) => {
    const auth = requireUser(req);
    const prefs = await devicesOf(auth.userId);
    await db.update(users).set({ notificationPrefs: { ...prefs, devices: [] } }).where(eq(users.id, auth.userId));
    await audit(req, 'revoke_notification_devices', 'user', auth.userId);
    return serializeMe(app, auth.userId);
  });
}
