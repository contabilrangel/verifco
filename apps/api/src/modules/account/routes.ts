import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { users } from '../../db/schema';
import { audit, parse, requireUser } from '../../lib/http';
import { serializeMe } from '../auth/routes';

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
}
