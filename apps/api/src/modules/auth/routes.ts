import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADMIN_ROLE_NAME, ALL_PERMISSIONS, DEFAULT_OPERATOR_PERMISSIONS, isValidCpfCnpj, onlyDigits } from '@verifco/shared';
import { contracts, offices, passwordResets, roles, userFavorites, users } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, unauthorized } from '../../lib/errors';
import { parse, requireUser } from '../../lib/http';
import { signUserToken } from '../../plugins/auth';
import { seedOfficeDefaults } from './seed-office';

const password = z.string().min(8, 'A senha precisa ter ao menos 8 caracteres').max(200);

export async function serializeMe(app: FastifyInstance, userId: string) {
  const { db } = app.ctx;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw unauthorized();
  const office = await db.query.offices.findFirst({ where: eq(offices.id, user.officeId) });
  const role = user.roleId ? await db.query.roles.findFirst({ where: eq(roles.id, user.roleId) }) : null;
  const favorites = await db.select().from(userFavorites).where(eq(userFavorites.userId, user.id));
  return {
    user: { id: user.id, name: user.name, email: user.email, isOwner: user.isOwner, notificationPrefs: user.notificationPrefs },
    office: office && { id: office.id, name: office.name, logoFileId: office.logoFileId, settings: office.settings },
    role: role && { id: role.id, name: role.name },
    permissions: user.isOwner ? ALL_PERMISSIONS : (role?.permissions ?? []),
    favorites: favorites.map((f) => ({ path: f.path, label: f.label })),
  };
}

export async function authRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  /** Cadastro de um novo escritório com o usuário administrador. */
  app.post('/auth/register', async (req, reply) => {
    const body = parse(
      z.object({
        officeName: z.string().trim().min(2).max(200),
        officeDocument: z.string().trim().optional(),
        name: z.string().trim().min(2).max(200),
        email: z.email(),
        password,
      }),
      req.body,
    );
    if (body.officeDocument && !isValidCpfCnpj(body.officeDocument)) throw badRequest('CPF/CNPJ do escritório inválido.');
    const existing = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${body.email.toLowerCase()}` });
    if (existing) throw conflict('Já existe uma conta com este e-mail.');

    const result = await db.transaction(async (tx) => {
      const [office] = await tx
        .insert(offices)
        .values({ name: body.officeName, cpfCnpj: body.officeDocument ? onlyDigits(body.officeDocument) : null, email: body.email })
        .returning();
      const [admin] = await tx
        .insert(roles)
        .values({ officeId: office.id, name: ADMIN_ROLE_NAME, permissions: ALL_PERMISSIONS, isSystem: true })
        .returning();
      await tx.insert(roles).values({ officeId: office.id, name: 'Contador', permissions: DEFAULT_OPERATOR_PERMISSIONS });
      const [user] = await tx
        .insert(users)
        .values({
          officeId: office.id,
          roleId: admin.id,
          name: body.name,
          email: body.email.toLowerCase(),
          passwordHash: await bcrypt.hash(body.password, 10),
          isOwner: true,
        })
        .returning();
      const year = new Date().getFullYear();
      await tx.insert(contracts).values({
        officeId: office.id,
        name: 'Avaliação gratuita',
        plan: 'trial',
        declarationLimit: 30,
        year,
        startsAt: new Date().toISOString().slice(0, 10),
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      });
      return { office, user };
    });
    await seedOfficeDefaults(db, result.office.id);
    const token = signUserToken(app, result.user);
    reply.status(201);
    return { token, ...(await serializeMe(app, result.user.id)) };
  });

  app.post('/auth/login', async (req) => {
    const body = parse(z.object({ email: z.email(), password: z.string().min(1) }), req.body);
    const user = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${body.email.toLowerCase()}` });
    const ok = user?.passwordHash ? await bcrypt.compare(body.password, user.passwordHash) : false;
    if (!user || !ok || !user.isActive) throw unauthorized('E-mail ou senha incorretos.');
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    return { token: signUserToken(app, user), ...(await serializeMe(app, user.id)) };
  });

  app.get('/auth/me', async (req) => {
    const user = requireUser(req);
    return serializeMe(app, user.userId);
  });

  app.post('/auth/change-password', async (req) => {
    const auth = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string(), newPassword: password }), req.body);
    const user = await db.query.users.findFirst({ where: eq(users.id, auth.userId) });
    if (!user?.passwordHash || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw badRequest('Senha atual incorreta.');
    }
    const [updated] = await db
      .update(users)
      .set({ passwordHash: await bcrypt.hash(body.newPassword, 10), tokenVersion: user.tokenVersion + 1, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    return { token: signUserToken(app, updated) };
  });

  /** Solicita link de redefinição. Responde igual exista ou não a conta. */
  app.post('/auth/forgot-password', async (req) => {
    const body = parse(z.object({ email: z.email() }), req.body);
    const user = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${body.email.toLowerCase()}` });
    if (user?.isActive) {
      const token = randomToken();
      await db.insert(passwordResets).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) });
      const link = `${app.ctx.config.WEB_URL}/redefinir-senha?token=${token}`;
      await app.ctx.providers.email
        .send(user.officeId, {
          to: user.email,
          toName: user.name,
          subject: 'Redefinição de senha — Verifco',
          html: `<p>Olá, ${user.name}.</p><p>Para criar uma nova senha, acesse: <a href="${link}">${link}</a></p><p>O link vale por 1 hora. Se não foi você, ignore este e-mail.</p>`,
        })
        .catch((err) => req.log.warn({ err }, 'falha ao enviar e-mail de redefinição'));
    }
    return { ok: true };
  });

  app.post('/auth/reset-password', async (req) => {
    const body = parse(z.object({ token: z.string().min(10), password }), req.body);
    const reset = await db.query.passwordResets.findFirst({
      where: and(eq(passwordResets.tokenHash, sha256(body.token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())),
    });
    if (!reset) throw badRequest('Link inválido ou expirado.');
    const user = await db.query.users.findFirst({ where: eq(users.id, reset.userId) });
    if (!user) throw badRequest('Link inválido ou expirado.');
    await db.transaction(async (tx) => {
      await tx.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, reset.id));
      await tx
        .update(users)
        .set({ passwordHash: await bcrypt.hash(body.password, 10), tokenVersion: user.tokenVersion + 1 })
        .where(eq(users.id, user.id));
    });
    return { ok: true };
  });

  /** Encerra todas as sessões do usuário (invalida tokens emitidos). */
  app.post('/auth/logout-all', async (req) => {
    const auth = requireUser(req);
    await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, auth.userId));
    return { ok: true };
  });

  app.put('/auth/preferences', async (req) => {
    const auth = requireUser(req);
    const body = parse(z.object({ notificationsEnabled: z.boolean() }), req.body);
    await db.update(users).set({ notificationPrefs: { enabled: body.notificationsEnabled } }).where(eq(users.id, auth.userId));
    return serializeMe(app, auth.userId);
  });

  app.put('/auth/favorites', async (req) => {
    const auth = requireUser(req);
    const body = parse(z.object({ path: z.string().min(1).max(300), label: z.string().min(1).max(200), favorite: z.boolean() }), req.body);
    if (body.favorite) {
      await db.insert(userFavorites).values({ userId: auth.userId, path: body.path, label: body.label }).onConflictDoNothing();
    } else {
      await db.delete(userFavorites).where(and(eq(userFavorites.userId, auth.userId), eq(userFavorites.path, body.path)));
    }
    return { ok: true };
  });
}
