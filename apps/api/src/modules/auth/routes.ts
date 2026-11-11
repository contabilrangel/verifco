import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADMIN_ROLE_NAME, ALL_PERMISSIONS, DEFAULT_OPERATOR_PERMISSIONS, addDaysIso, isValidCpfCnpj, onlyDigits, todayIso } from '@verifco/shared';
import { auditLogs, contracts, offices, passwordResets, roles, userFavorites, users } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { HttpError, badRequest, conflict, forbidden, unauthorized } from '../../lib/errors';
import { OFFICE_BLOCKED_MESSAGE, parse, requireUser } from '../../lib/http';
import { effectiveSettings, termsVersionOf } from '../../services/platform-settings';
import { signUserToken } from '../../plugins/auth';
import { FORGOT_PER_ACCOUNT_RULE, LOGIN_EMAIL_RULE, allow, check, fail, resetLimit } from '../../services/rate-limit';
import { DISABLED, TWO_FACTOR_INVALID, TWO_FACTOR_MESSAGE, TWO_FACTOR_REQUIRED, beginSetup, checkSecondFactor, finishSetup } from '../../services/two-factor';
import { EMAIL_CHANGED_JOB, LOCKOUT_NOTICE_JOB, PASSWORD_RESET_JOB, VERIFY_EMAIL_JOB, type EmailChangedPayload } from './jobs';
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
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      isOwner: user.isOwner,
      notificationPrefs: user.notificationPrefs,
      twoFactorEnabled: Boolean(user.totpEnabledAt),
      emailVerified: Boolean(user.emailVerifiedAt),
      // troca de e-mail aguardando o clique no link (não conta a confirmação do próprio endereço)
      pendingEmail: user.pendingEmail && user.pendingEmail.toLowerCase() !== user.email.toLowerCase() && (user.pendingEmailExpiresAt?.getTime() ?? 0) > Date.now() ? user.pendingEmail : null,
    },
    office: office && { id: office.id, name: office.name, logoFileId: office.logoFileId, settings: canSeeSettings ? office.settings : {} },
    role: role && { id: role.id, name: role.name },
    permissions,
    favorites: favorites.map((f) => ({ path: f.path, label: f.label })),
  };
}

/** Validade do link de confirmação de e-mail. */
const EMAIL_LINK_MS = 24 * 3600_000;

export async function authRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  /** Guarda o endereço pendente com um token novo e manda o link de confirmação para ele. */
  async function sendEmailConfirmation(user: { id: string; officeId: string }, address: string) {
    const token = randomToken();
    await db
      .update(users)
      .set({ pendingEmail: address, pendingEmailTokenHash: sha256(token), pendingEmailExpiresAt: new Date(Date.now() + EMAIL_LINK_MS) })
      .where(eq(users.id, user.id));
    await app.ctx.jobs.enqueue(VERIFY_EMAIL_JOB, { userId: user.id, token: app.ctx.secrets.encrypt(token) }, { officeId: user.officeId });
  }

  /**
   * O que a tela de entrada precisa saber antes do login: se o cadastro está aberto, o contato do
   * suporte e os endereços dos termos de uso e da política de privacidade.
   */
  app.get('/auth/config', async () => {
    const s = await effectiveSettings(app.ctx);
    return { signupEnabled: s.signupEnabled, trialDays: s.trialDays, supportEmail: s.supportEmail, termsUrl: s.termsUrl, privacyUrl: s.privacyUrl };
  });

  /** Cadastro de um novo escritório com o usuário administrador. */
  app.post('/auth/register', async (req, reply) => {
    const settings = await effectiveSettings(app.ctx);
    if (!settings.signupEnabled) {
      throw forbidden(`O cadastro de novos escritórios está fechado.${settings.supportEmail ? ` Fale com o suporte: ${settings.supportEmail}.` : ''}`);
    }
    const body = parse(
      z.object({
        officeName: z.string().trim().min(2).max(200),
        officeDocument: z.string().trim().optional(),
        name: z.string().trim().min(2).max(200),
        email: z.email(),
        password,
        acceptTerms: z.boolean().optional(),
      }),
      req.body,
    );
    // com termos publicados, a conta só nasce com o aceite (guardado no escritório, com a versão)
    if (settings.termsUrl && body.acceptTerms !== true) throw badRequest('Para criar a conta, aceite os termos de uso.');
    if (body.officeDocument && !isValidCpfCnpj(body.officeDocument)) throw badRequest('CPF/CNPJ do escritório inválido.');
    const existing = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${body.email.toLowerCase()}` });
    if (existing) throw conflict('Já existe uma conta com este e-mail.');

    const result = await db.transaction(async (tx) => {
      const [office] = await tx
        .insert(offices)
        .values({
          name: body.officeName,
          cpfCnpj: body.officeDocument ? onlyDigits(body.officeDocument) : null,
          email: body.email,
          termsAcceptedAt: body.acceptTerms ? new Date() : null,
          termsVersion: body.acceptTerms ? termsVersionOf(settings) : null,
        })
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
          // sem e-mail do sistema não há como mandar o link: o endereço vale como informado
          emailVerifiedAt: app.ctx.config.SMTP_URL ? null : new Date(),
        })
        .returning();
      // avaliação contada no dia de Brasília (services/plan.ts aplica o limite e a validade);
      // dias e limite vêm do painel do sistema (padrão: 30 dias, 30 declarações)
      const today = todayIso();
      await tx.insert(contracts).values({
        officeId: office.id,
        name: 'Avaliação gratuita',
        plan: 'trial',
        declarationLimit: settings.trialDeclarationLimit,
        year: Number(today.slice(0, 4)),
        startsAt: today,
        expiresAt: addDaysIso(today, settings.trialDays),
      });
      return { office, user };
    });
    await seedOfficeDefaults(db, result.office.id);
    if (!result.user.emailVerifiedAt) await sendEmailConfirmation(result.user, result.user.email);
    const token = signUserToken(app, result.user);
    reply.status(201);
    return { token, ...(await serializeMe(app, result.user.id)) };
  });

  /**
   * Login. Além do limite por IP (app.ts), as falhas contam por e-mail: depois de 10 em 15 minutos
   * o e-mail fica bloqueado até a janela acabar, e o dono da conta recebe um aviso.
   */
  app.post('/auth/login', async (req) => {
    const body = parse(
      z.object({ email: z.email('Informe um e-mail válido.'), password: z.string().min(1, 'Informe a senha.'), code: z.string().trim().max(40).optional() }),
      req.body,
    );
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
    // segunda etapa: sem código, a tela pede o código (não conta como tentativa errada); código errado conta
    const second = checkSecondFactor(app.ctx.secrets, user, body.code || undefined);
    if (!second.ok) {
      if (!body.code) throw new HttpError(401, TWO_FACTOR_MESSAGE, { code: TWO_FACTOR_REQUIRED });
      const failures = await fail(app.ctx, emailKey, LOGIN_EMAIL_RULE);
      if (failures === LOGIN_EMAIL_RULE.max) await app.ctx.jobs.enqueue(LOCKOUT_NOTICE_JOB, { userId: user.id }, { officeId: user.officeId });
      throw new HttpError(401, TWO_FACTOR_INVALID, { code: TWO_FACTOR_REQUIRED });
    }
    await resetLimit(app.ctx, emailKey);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, user.officeId) });
    if (office?.blockedAt) throw forbidden(OFFICE_BLOCKED_MESSAGE);
    await db
      .update(users)
      .set({ lastLoginAt: new Date(), ...(second.remaining ? { totpRecoveryHashes: second.remaining } : {}) })
      .where(eq(users.id, user.id));
    // quem entrou, quando e de onde: aparece em Meu escritório › Auditoria
    await db.insert(auditLogs).values({
      officeId: user.officeId,
      userId: user.id,
      action: 'login',
      entity: 'session',
      entityId: user.id,
      data: { ip: req.ip, twoFactor: Boolean(user.totpEnabledAt), ...(second.remaining ? { recoveryCode: true, recoveryCodesLeft: second.remaining.length } : {}) },
    });
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
        // o link chegou por e-mail: quem o usou controla o endereço
        .set({ passwordHash: await bcrypt.hash(body.password, 10), tokenVersion: user.tokenVersion + 1, emailVerifiedAt: user.emailVerifiedAt ?? new Date() })
        .where(eq(users.id, user.id));
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- verificação em duas etapas
  /** Senha atual conferida antes de qualquer mudança na segunda etapa. */
  async function userWithPassword(req: Parameters<typeof requireUser>[0], password: string) {
    const auth = requireUser(req);
    const user = await db.query.users.findFirst({ where: eq(users.id, auth.userId) });
    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) throw badRequest('Senha atual incorreta.');
    return user;
  }
  const passwordBody = z.object({ password: z.string().min(1, 'Informe a senha atual.').max(200) });

  /** Começa a ativação: devolve a chave e o endereço para o aplicativo (QR code). Só vale depois do código. */
  app.post('/auth/2fa/setup', async (req) => {
    const user = await userWithPassword(req, parse(passwordBody, req.body).password);
    if (user.totpEnabledAt) throw badRequest('A verificação em duas etapas já está ativa. Desative antes de configurar outro aplicativo.');
    const setup = beginSetup(app.ctx.secrets, user.email, 'Verifco');
    await db.update(users).set(setup.set).where(eq(users.id, user.id));
    return { secret: setup.secret, otpauthUrl: setup.otpauthUrl };
  });

  /** Conclui com o código do aplicativo e mostra, uma única vez, os códigos de recuperação. */
  app.post('/auth/2fa/enable', async (req) => {
    const auth = requireUser(req);
    const { code } = parse(z.object({ code: z.string().trim().min(6).max(12) }), req.body);
    const user = await db.query.users.findFirst({ where: eq(users.id, auth.userId) });
    if (!user) throw unauthorized();
    const done = finishSetup(app.ctx.secrets, user, code);
    await db.update(users).set(done.set).where(eq(users.id, user.id));
    await db.insert(auditLogs).values({ officeId: user.officeId, userId: user.id, action: 'enable', entity: 'two_factor', entityId: user.id });
    return { recoveryCodes: done.recoveryCodes };
  });

  /** Desativa: senha e um código (do aplicativo ou de recuperação). */
  app.post('/auth/2fa/disable', async (req) => {
    const body = parse(passwordBody.extend({ code: z.string().trim().min(6).max(40) }), req.body);
    const user = await userWithPassword(req, body.password);
    if (!user.totpEnabledAt) return { ok: true };
    await check(app.ctx, `2fa:${user.id}`, LOGIN_EMAIL_RULE, 'Muitas tentativas sem sucesso. Aguarde alguns minutos.');
    if (!checkSecondFactor(app.ctx.secrets, user, body.code).ok) {
      await fail(app.ctx, `2fa:${user.id}`, LOGIN_EMAIL_RULE);
      throw badRequest(TWO_FACTOR_INVALID);
    }
    await resetLimit(app.ctx, `2fa:${user.id}`);
    await db.update(users).set(DISABLED).where(eq(users.id, user.id));
    await db.insert(auditLogs).values({ officeId: user.officeId, userId: user.id, action: 'disable', entity: 'two_factor', entityId: user.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- e-mail de acesso
  /**
   * Troca do próprio e-mail: o endereço novo só passa a valer depois do clique no link enviado
   * a ele (24 horas). Até lá o acesso continua pelo e-mail atual.
   */
  app.post('/auth/change-email', async (req) => {
    const body = parse(passwordBody.extend({ newEmail: z.email('Informe um e-mail válido.').max(320) }), req.body);
    const user = await userWithPassword(req, body.password);
    const address = body.newEmail.toLowerCase();
    if (address === user.email.toLowerCase()) throw badRequest('Este já é o seu e-mail de acesso.');
    const taken = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${address}` });
    if (taken) throw conflict('Já existe uma conta com este e-mail.');
    await sendEmailConfirmation(user, address);
    return { ok: true, pendingEmail: address };
  });

  /** Desiste da troca pendente. */
  app.post('/auth/change-email/cancel', async (req) => {
    const auth = requireUser(req);
    await db.update(users).set({ pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null }).where(eq(users.id, auth.userId));
    return { ok: true };
  });

  /** Manda de novo o link para confirmar o e-mail atual (quem ainda não confirmou). */
  app.post('/auth/verify-email/resend', async (req) => {
    const auth = requireUser(req);
    const user = await db.query.users.findFirst({ where: eq(users.id, auth.userId) });
    if (!user) throw unauthorized();
    if (user.emailVerifiedAt) return { ok: true, alreadyVerified: true };
    if (!(await allow(app.ctx, `verify-email:${user.id}`, FORGOT_PER_ACCOUNT_RULE))) throw new HttpError(429, 'O link acabou de ser enviado. Confira a caixa de entrada e o spam, ou aguarde alguns minutos para pedir de novo.');
    await sendEmailConfirmation(user, user.email);
    return { ok: true, alreadyVerified: false };
  });

  /** O clique no link (sem login): confirma o endereço e, se for troca, passa a valer o novo. */
  app.post('/auth/confirm-email', async (req) => {
    const { token } = parse(z.object({ token: z.string({ error: 'Link inválido ou expirado.' }).min(10, 'Link inválido ou expirado.').max(200) }), req.body);
    const user = await db.query.users.findFirst({ where: and(eq(users.pendingEmailTokenHash, sha256(token)), gt(users.pendingEmailExpiresAt, new Date())) });
    if (!user?.pendingEmail) throw badRequest('Link inválido ou expirado. Peça um novo em Minha conta.');
    const address = user.pendingEmail.toLowerCase();
    const changing = address !== user.email.toLowerCase();
    if (changing) {
      const taken = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${address}` });
      if (taken) throw conflict('Já existe uma conta com este e-mail.');
    }
    await db
      .update(users)
      .set({
        email: address,
        emailVerifiedAt: new Date(),
        pendingEmail: null,
        pendingEmailTokenHash: null,
        pendingEmailExpiresAt: null,
        updatedAt: new Date(),
        // trocou o endereço de acesso: as sessões abertas caem e o login passa a ser pelo novo
        ...(changing ? { tokenVersion: user.tokenVersion + 1 } : {}),
      })
      .where(eq(users.id, user.id));
    if (changing) {
      const payload: EmailChangedPayload = { userId: user.id, oldEmail: user.email, newEmail: address, changedBy: user.name };
      await app.ctx.jobs.enqueue(EMAIL_CHANGED_JOB, payload, { officeId: user.officeId, userId: user.id });
      await db.insert(auditLogs).values({ officeId: user.officeId, userId: user.id, action: 'change_email', entity: 'employee', entityId: user.id, data: { from: user.email, to: address } });
    }
    return { ok: true, changed: changing, email: address };
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
