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
import { FORGOT_PER_ACCOUNT_RULE, LOGIN_EMAIL_RULE, allow, check, fail, resetLimit } from '../../services/rate-limit';
import { LOCKOUT_NOTICE_JOB, PASSWORD_RESET_JOB } from './jobs';
import { seedOfficeDefaults } from './seed-office';

const password = z.string().min(8, 'A senha precisa ter ao menos 8 caracteres').max(200);

export async function serializeMe(app: FastifyInstance, userId: string) {
  const { db } = app.ctx;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw unauthorized();
  const office = await db.query.offices.findFirst({ where: eq(offices.id, user.officeId) });
  const role = user.roleId ? await db.query.roles.findFirst({ where: eq(roles.id, user.roleId) }) : null;
  const favorites = await db.select().from(userFavorites).where(eq(userFavorites.userId, user.id));
  const permissions = user.isOwner ? ALL_PERMISSIONS : (role?.permissions ?? []);
  // as preferências do escritório só para quem pode vê-las (Administração › Preferências)
  const canSeeSettings = permissions.includes('settings.view') || permissions.includes('settings.edit');
  return {
    user: { id: user.id, name: user.name, email: user.email, isOwner: user.isOwner, notificationPrefs: user.notificationPrefs },
    office: office && { id: office.id, name: office.name, logoFileId: office.logoFileId, settings: canSeeSettings ? office.settings : {} },
    role: role && { id: role.id, name: role.name },
    permissions,
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

  /**
   * Login. Além do limite por IP (app.ts), as falhas contam por e-mail: depois de 10 em 15 minutos
   * o e-mail fica bloqueado até a janela acabar, e o dono da conta recebe um aviso.
   */
  app.post('/auth/login', async (req) => {
    const body = parse(z.object({ email: z.email('Informe um e-mail válido.'), password: z.string().min(1, 'Informe a senha.') }), req.body);
    const email = body.email.toLowerCase();
    const emailKey = `login-email:${email}`;
    await check(app.ctx, emailKey, LOGIN_EMAIL_RULE, 'Muitas tentativas sem sucesso para este e-mail. Aguarde alguns minutos ou use “Esqueci minha senha”.');
    const user = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
    const ok = user?.passwordHash ? await bcrypt.compare(body.password, user.passwordHash) : false;
    if (!user || !ok || !user.isActive) {
      const failures = await fail(app.ctx, emailKey, LOGIN_EMAIL_RULE);
      if (user?.isActive && failures === LOGIN_EMAIL_RULE.max) {
        await app.ctx.jobs.enqueue(LOCKOUT_NOTICE_JOB, { userId: user.id }, { officeId: user.officeId });
      }
      throw unauthorized('E-mail ou senha incorretos.');
    }
    await resetLimit(app.ctx, emailKey);
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

  /**
   * Solicita link de redefinição. Responde igual (e no mesmo tempo) exista ou não a conta: o
   * e-mail sai pela fila, com o token cifrado no job. No máximo um envio a cada 5 minutos por conta.
   */
  app.post('/auth/forgot-password', async (req) => {
    const body = parse(z.object({ email: z.email('Informe um e-mail válido.') }), req.body);
    const user = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${body.email.toLowerCase()}` });
    if (user?.isActive && (await allow(app.ctx, `forgot-account:${user.id}`, FORGOT_PER_ACCOUNT_RULE))) {
      const token = randomToken();
      await db.insert(passwordResets).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) });
      await app.ctx.jobs.enqueue(PASSWORD_RESET_JOB, { userId: user.id, token: app.ctx.secrets.encrypt(token) }, { officeId: user.officeId });
    }
    return { ok: true };
  });

  app.post('/auth/reset-password', async (req) => {
    const body = parse(z.object({ token: z.string({ error: 'Link inválido ou expirado.' }).min(10, 'Link inválido ou expirado.'), password }), req.body);
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
    const me = await db.query.users.findFirst({ where: eq(users.id, auth.userId) });
    // mantém os navegadores cadastrados (Conta › Preferências › Este navegador)
    await db
      .update(users)
      .set({ notificationPrefs: { ...(me?.notificationPrefs ?? {}), enabled: body.notificationsEnabled } })
      .where(eq(users.id, auth.userId));
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
