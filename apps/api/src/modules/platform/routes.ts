import bcrypt from 'bcryptjs';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AI_PROVIDERS, CONTRACT_STATUS_KEYS, aiProviderDef, todayIso } from '@verifco/shared';
import { contracts, files, jobs, offices, users } from '../../db/schema';
import { platformUsers, platformSettings, platformAiConnections, platformAuditLogs } from '../../db/platform-schema';
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { guard, parse } from '../../lib/http';
import { PLATFORM_LOGIN_EMAIL_RULE, PLATFORM_LOGIN_RULE, check, consume, fail, resetLimit } from '../../services/rate-limit';
import { unsafeBaseUrlReason } from '../../integrations/ssrf';
import { safeConnection, unlockConnection, resolveGlobalAi } from '../../integrations/platform-ai-store';
import { completeConnection, connectionFetch } from '../../integrations/multi-ai';
import { platformSmtpInfo, testPlatformSmtp } from '../../integrations/email';
import { IntegrationError } from '../../integrations/http';
import { effectiveSettings } from '../../services/platform-settings';
import { DISABLED, TWO_FACTOR_INVALID, TWO_FACTOR_MESSAGE, TWO_FACTOR_REQUIRED, beginSetup, checkSecondFactor, finishSetup } from '../../services/two-factor';

const idParam = z.object({ id: z.uuid() });
const pageQuery = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100),
  search: z.string().trim().max(100).default('') });
const loginBody = z.object({ email: z.email().max(320).transform((s) => s.toLowerCase()), password: z.string().min(1).max(200), code: z.string().trim().max(40).optional() });
const aiBody = z.object({
  provider: z.enum(AI_PROVIDERS.map((p) => p.key) as [string, ...string[]]),
  name: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().max(500).optional(),
  supportsImages: z.boolean().default(false), enabled: z.boolean().default(true),
  apiKey: z.string().trim().max(4000).nullable().optional(),
});
const contractBody = z.object({
  officeId: z.uuid(), name: z.string().trim().min(1).max(100), plan: z.string().trim().min(1).max(50),
  declarationLimit: z.number().int().min(1).max(1000000).nullable(),
  year: z.number().int().min(2000).max(2100),
  startsAt: z.iso.date(), expiresAt: z.iso.date(), hasBackup: z.boolean(),
  status: z.enum(CONTRACT_STATUS_KEYS),
}).refine((v) => v.expiresAt >= v.startsAt, { message: 'O término deve ser igual ou posterior ao início.' });

const platformPassword = z.string().min(12, 'Use uma senha com pelo menos 12 caracteres.').max(200);
/** Endereço público (https) ou vazio; nunca `javascript:` nem outro esquema, porque vira link na tela de entrada. */
const publicUrl = z.string().trim().max(500).refine((v) => /^https:\/\/[^\s]+$/i.test(v), 'Informe um endereço que comece com https://').nullable();
const settingsBody = z.object({
  signupEnabled: z.boolean().nullable(),
  trialDays: z.number().int().min(1).max(365).nullable(),
  trialDeclarationLimit: z.number().int().min(1).max(1000000).nullable(),
  supportEmail: z.email().max(320).nullable(),
  termsUrl: publicUrl,
  privacyUrl: publicUrl,
});
const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;

function platformUser(req: FastifyRequest, owner = false) {
  if (!req.platformAuth) throw unauthorized('Entre na administração do sistema para continuar.');
  if (owner && req.platformAuth.role !== 'owner') throw forbidden('Esta configuração é exclusiva do proprietário do sistema.');
  return req.platformAuth;
}

/** Hash de uma senha aleatória, com o mesmo custo das contas reais (o tempo não revela se o e-mail existe). */
const DUMMY_HASH = '$2b$12$QRSR5O1zG6izTr8bvyZyTu9pVkWRxtlpoheeMyn9tTlTXKsDO1tDy';

export default async function platformRoutes(app: FastifyInstance) {
  const { ctx } = app; const { db, platformDb } = ctx;
  const rateCtx = { config: ctx.config, db: platformDb };
  const read = { preHandler: async (req: FastifyRequest) => { platformUser(req); } };
  const write = { preHandler: async (req: FastifyRequest) => { platformUser(req, true); } };
  async function audit(req: FastifyRequest, action: string, entityId: string | null = null, details: Record<string, unknown> = {}) {
    await platformDb.insert(platformAuditLogs).values({ actorId: platformUser(req).id, action, entityId, details });
  }
  app.post('/platform/login', async (req) => {
    const body = parse(loginBody, req.body);
    // só as falhas contam (quem erra a senha de propósito não bloqueia o dono em outro endereço)
    const ipKey = `platform-login:${body.email}:${req.ip}`;
    const emailKey = `platform-login-email:${body.email}`;
    const message = 'Muitas tentativas sem sucesso. Aguarde alguns minutos e tente de novo.';
    await check(rateCtx, ipKey, PLATFORM_LOGIN_RULE, message);
    await check(rateCtx, emailKey, PLATFORM_LOGIN_EMAIL_RULE, message);
    const user = await platformDb.query.platformUsers.findFirst({ where: eq(platformUsers.email, body.email) });
    // Mesmo custo (12) das senhas reais para conta inexistente; a mensagem não revela se a conta existe.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const valid = await bcrypt.compare(body.password, hash);
    if (!user?.isActive || !valid) {
      await fail(rateCtx, ipKey, PLATFORM_LOGIN_RULE);
      await fail(rateCtx, emailKey, PLATFORM_LOGIN_EMAIL_RULE);
      throw unauthorized('E-mail ou senha inválidos.');
    }
    // segunda etapa: sem código a tela pede o código; código errado conta como tentativa
    const second = checkSecondFactor(ctx.secrets, user, body.code || undefined);
    if (!second.ok) {
      if (!body.code) throw new HttpError(401, TWO_FACTOR_MESSAGE, { code: TWO_FACTOR_REQUIRED });
      await fail(rateCtx, ipKey, PLATFORM_LOGIN_RULE);
      await fail(rateCtx, emailKey, PLATFORM_LOGIN_EMAIL_RULE);
      throw new HttpError(401, TWO_FACTOR_INVALID, { code: TWO_FACTOR_REQUIRED });
    }
    await resetLimit(rateCtx, ipKey);
    await platformDb.update(platformUsers).set({ lastLoginAt: new Date(), ...(second.remaining ? { totpRecoveryHashes: second.remaining } : {}) }).where(eq(platformUsers.id, user.id));
    await platformDb.insert(platformAuditLogs).values({ actorId: user.id, action: 'platform.login', details: second.remaining ? { recoveryCode: true, recoveryCodesLeft: second.remaining.length } : {} });
    return { token: app.jwt.sign({ typ: 'platform', sub: user.id, tv: user.tokenVersion }, { expiresIn: '1h' }) };
  });
  app.get('/platform/me', read, async (req) => {
    const me = platformUser(req);
    const row = await platformDb.query.platformUsers.findFirst({ where: eq(platformUsers.id, me.id) });
    return { ...me, twoFactorEnabled: Boolean(row?.totpEnabledAt) };
  });
  // ---------------------------------------------------------------- verificação em duas etapas
  async function meWithPassword(req: FastifyRequest, password: string) {
    const me = platformUser(req);
    const row = await platformDb.query.platformUsers.findFirst({ where: eq(platformUsers.id, me.id) });
    if (!row || !(await bcrypt.compare(password, row.passwordHash))) throw badRequest('Senha atual incorreta.');
    return row;
  }
  app.post('/platform/2fa/setup', read, async (req) => {
    const row = await meWithPassword(req, parse(z.object({ password: z.string().min(1).max(200) }), req.body).password);
    if (row.totpEnabledAt) throw badRequest('A verificação em duas etapas já está ativa. Desative antes de configurar outro aplicativo.');
    const setup = beginSetup(ctx.secrets, row.email, 'Verifco Sistema');
    await platformDb.update(platformUsers).set(setup.set).where(eq(platformUsers.id, row.id));
    return { secret: setup.secret, otpauthUrl: setup.otpauthUrl };
  });
  app.post('/platform/2fa/enable', read, async (req) => {
    const me = platformUser(req);
    const { code } = parse(z.object({ code: z.string().trim().min(6).max(12) }), req.body);
    const row = await platformDb.query.platformUsers.findFirst({ where: eq(platformUsers.id, me.id) });
    if (!row) throw unauthorized();
    const done = finishSetup(ctx.secrets, row, code);
    await platformDb.update(platformUsers).set(done.set).where(eq(platformUsers.id, row.id));
    await audit(req, 'platform.2fa.enable');
    return { recoveryCodes: done.recoveryCodes };
  });
  app.post('/platform/2fa/disable', read, async (req) => {
    const body = parse(z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(40) }), req.body);
    const row = await meWithPassword(req, body.password);
    if (!row.totpEnabledAt) return { ok: true };
    await consume(rateCtx, `platform-2fa:${row.id}`, { max: 10, windowSec: 900 });
    if (!checkSecondFactor(ctx.secrets, row, body.code).ok) throw badRequest(TWO_FACTOR_INVALID);
    await platformDb.update(platformUsers).set(DISABLED).where(eq(platformUsers.id, row.id));
    await audit(req, 'platform.2fa.disable');
    return { ok: true };
  });
  app.post('/platform/logout', read, async (req) => {
    const user = platformUser(req);
    await platformDb.update(platformUsers).set({ tokenVersion: sql`${platformUsers.tokenVersion} + 1` }).where(eq(platformUsers.id, user.id));
    await audit(req, 'platform.logout'); return { ok: true };
  });
  /** A própria conta troca a senha (as outras sessões caem; esta recebe um token novo). */
  app.post('/platform/change-password', read, async (req) => {
    const me = platformUser(req);
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: platformPassword }), req.body);
    await consume(rateCtx, `platform-password:${me.id}`, { max: 10, windowSec: 900 });
    const row = await platformDb.query.platformUsers.findFirst({ where: eq(platformUsers.id, me.id) });
    if (!row || !(await bcrypt.compare(body.currentPassword, row.passwordHash))) throw badRequest('Senha atual incorreta.');
    const [saved] = await platformDb.update(platformUsers)
      .set({ passwordHash: await bcrypt.hash(body.newPassword, 12), tokenVersion: sql`${platformUsers.tokenVersion} + 1` })
      .where(eq(platformUsers.id, me.id)).returning({ id: platformUsers.id, tokenVersion: platformUsers.tokenVersion });
    await audit(req, 'platform.password.change');
    return { token: app.jwt.sign({ typ: 'platform', sub: saved.id, tv: saved.tokenVersion }, { expiresIn: '1h' }) };
  });
  app.get('/platform/overview', read, async () => {
    const today = todayIso();
    const result = await db.execute(sql`select
      (select count(*)::int from offices) as offices,
      (select count(*)::int from offices where blocked_at is not null) as blocked_offices,
      (select count(*)::int from users where is_active) as collaborators,
      (select count(*)::int from contracts where status = 'active' and starts_at <= ${today}::date and expires_at >= ${today}::date) as active_contracts,
      (select count(*)::int from jobs where status = 'queued' and run_at <= now()) as queued_jobs,
      (select count(*)::int from jobs where status = 'running') as running_jobs,
      (select count(*)::int from jobs where status = 'failed') as failed_jobs,
      (select count(*)::int from jobs where status = 'failed' and finished_at > now() - interval '24 hours') as failed_jobs_24h,
      (select extract(epoch from now() - min(run_at))::int from jobs where status = 'queued' and run_at <= now()) as oldest_queued_seconds`);
    const queue = ctx.jobs.health();
    return {
      ...((result as { rows: Record<string, unknown>[] }).rows[0]),
      // o processo que respondeu está consumindo a fila? (num servidor só de API, `worker` é false)
      queue: { worker: queue.started, alive: queue.alive, lastTickAt: queue.lastTickAt },
      email: platformSmtpInfo(ctx).configured,
    };
  });
  app.get('/platform/offices', read, async (req) => {
    const page = parse(pageQuery, req.query);
    const today = todayIso();
    const term = '%' + page.search.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    return db.select({
    id: offices.id, name: offices.name, email: offices.email, city: offices.city, state: offices.state,
    collaborators: sql<number>`(select count(*)::int from users where office_id = offices.id)`,
    customers: sql<number>`(select count(*)::int from customers where office_id = offices.id and deleted_at is null)`,
    blockedAt: offices.blockedAt, createdAt: offices.createdAt,
    lastLoginAt: sql<Date | null>`(select max(last_login_at) from users where office_id = offices.id)`.mapWith((v) => (v ? new Date(v as string) : null)),
    contractExpiresAt: sql<string | null>`(select max(expires_at)::text from contracts where office_id = offices.id and status = 'active' and starts_at <= ${today}::date)`,
  }).from(offices).where(page.search ? or(ilike(offices.name, term), ilike(offices.email, term), ilike(offices.cpfCnpj, term)) : undefined)
      .orderBy(asc(offices.name), asc(offices.id)).limit(page.limit).offset(page.offset);
  });
  /** Ficha do escritório: quem responde por ele, uso e contratos. Nenhum dado de cliente. */
  app.get('/platform/offices/:id', read, async (req) => {
    const { id } = parse(idParam, req.params);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, id) });
    if (!office) throw notFound('Escritório');
    const usage = await db.execute(sql`select
      (select count(*)::int from users where office_id = ${id} and is_active) as active_users,
      (select count(*)::int from customers where office_id = ${id} and deleted_at is null) as customers,
      (select count(*)::int from declarations where office_id = ${id} and exercise_year = ${Number(todayIso().slice(0, 4))}) as declarations_this_year,
      (select count(*)::int from declarations where office_id = ${id}) as declarations,
      (select coalesce(sum(size), 0)::bigint from files where office_id = ${id}) as storage_bytes,
      (select count(*)::int from files where office_id = ${id}) as files,
      (select count(*)::int from jobs where office_id = ${id} and status = 'failed' and finished_at > now() - interval '7 days') as failed_jobs_7d,
      (select max(last_login_at) from users where office_id = ${id}) as last_login_at`);
    const u = (usage as { rows: Record<string, unknown>[] }).rows[0];
    const owners = await db.select({ name: users.name, email: users.email, lastLoginAt: users.lastLoginAt })
      .from(users).where(and(eq(users.officeId, id), eq(users.isOwner, true))).orderBy(asc(users.name));
    const officeContracts = await db.select({
      id: contracts.id, name: contracts.name, plan: contracts.plan, year: contracts.year, declarationLimit: contracts.declarationLimit,
      startsAt: contracts.startsAt, expiresAt: contracts.expiresAt, hasBackup: contracts.hasBackup, status: contracts.status,
    }).from(contracts).where(eq(contracts.officeId, id)).orderBy(desc(contracts.expiresAt), asc(contracts.id));
    return {
      id: office.id, name: office.name, cpfCnpj: office.cpfCnpj, email: office.email, phone: office.phone, city: office.city, state: office.state,
      createdAt: office.createdAt, blockedAt: office.blockedAt, blockedReason: office.blockedReason,
      termsAcceptedAt: office.termsAcceptedAt, termsVersion: office.termsVersion,
      owners,
      usage: {
        activeUsers: Number(u.active_users), customers: Number(u.customers), declarations: Number(u.declarations),
        declarationsThisYear: Number(u.declarations_this_year), storageBytes: Number(u.storage_bytes), files: Number(u.files),
        failedJobs7d: Number(u.failed_jobs_7d), lastLoginAt: u.last_login_at ? new Date(u.last_login_at as string) : null,
      },
      contracts: officeContracts,
    };
  });
  /** Suspende ou libera o acesso do escritório (colaboradores, portal do cliente e robôs). Os dados ficam. */
  app.put('/platform/offices/:id/block', write, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ blocked: z.boolean(), reason: z.string().trim().max(500).nullable().optional() }), req.body);
    if (body.blocked && !body.reason) throw badRequest('Informe o motivo da suspensão (fica registrado na auditoria).');
    const [saved] = await db.update(offices)
      .set({ blockedAt: body.blocked ? new Date() : null, blockedReason: body.blocked ? body.reason ?? null : null })
      .where(eq(offices.id, id)).returning({ id: offices.id, blockedAt: offices.blockedAt });
    if (!saved) throw notFound('Escritório');
    await audit(req, body.blocked ? 'office.block' : 'office.unblock', id, body.blocked ? { reason: body.reason } : {});
    return saved;
  });
  app.put('/platform/offices/:id', write, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(200), email: z.email().max(320).nullable(),
      city: z.string().trim().max(100).nullable(), state: z.string().regex(/^[A-Z]{2}$/).nullable() }), req.body);
    const [saved] = await db.update(offices).set(body).where(eq(offices.id, id)).returning({ id: offices.id });
    if (!saved) throw notFound('Escritório');
    await audit(req, 'office.update', id); return saved;
  });
  /**
   * Suporte: desliga a verificação em duas etapas de uma conta do escritório cujo dono perdeu o
   * celular e os códigos de recuperação. As sessões da conta caem; a senha não muda.
   */
  app.post('/platform/offices/:id/reset-2fa', write, async (req) => {
    const { id } = parse(idParam, req.params);
    const { email } = parse(z.object({ email: z.email().max(320).transform((v) => v.toLowerCase()) }), req.body);
    const [saved] = await db.update(users)
      .set({ ...DISABLED, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(and(eq(users.officeId, id), sql`lower(${users.email}) = ${email}`)).returning({ id: users.id });
    if (!saved) throw notFound('Conta deste escritório com esse e-mail');
    await audit(req, 'office.user.reset_2fa', id, { userId: saved.id }); return { ok: true };
  });
  /**
   * Exclusão definitiva do escritório (encerramento de contrato, pedido de eliminação): apaga
   * clientes, declarações, cobranças, colaboradores e o conteúdo de todos os arquivos. Exige o
   * acesso já suspenso e o nome digitado. Não tem volta.
   */
  app.delete('/platform/offices/:id', write, async (req) => {
    const { id } = parse(idParam, req.params);
    const { confirmName } = parse(z.object({ confirmName: z.string().trim().min(1).max(200) }), req.body);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, id) });
    if (!office) throw notFound('Escritório');
    if (!office.blockedAt) throw badRequest('Suspenda o acesso do escritório antes de excluir.');
    if (confirmName.toLowerCase() !== office.name.trim().toLowerCase()) throw badRequest('O nome digitado não confere com o do escritório.');
    // primeiro o conteúdo no armazenamento (em lotes), depois as linhas (a exclusão do escritório leva o resto em cascata)
    let removedFiles = 0;
    for (;;) {
      const batch = await db.select({ id: files.id }).from(files).where(eq(files.officeId, id)).limit(500);
      if (!batch.length) break;
      for (const f of batch) { await ctx.files.remove(id, f.id); removedFiles += 1; }
    }
    await db.delete(offices).where(eq(offices.id, id));
    await audit(req, 'office.delete', id, { name: office.name, files: removedFiles });
    return { ok: true, files: removedFiles };
  });
  app.get('/platform/contracts', read, async (req) => {
    const page = parse(pageQuery.extend({ officeId: z.uuid().optional() }), req.query);
    return db.select({
    id: contracts.id, officeId: contracts.officeId, officeName: offices.name, name: contracts.name, plan: contracts.plan,
    year: contracts.year, declarationLimit: contracts.declarationLimit, startsAt: contracts.startsAt, expiresAt: contracts.expiresAt,
    hasBackup: contracts.hasBackup, status: contracts.status,
  }).from(contracts).innerJoin(offices, eq(offices.id, contracts.officeId))
    .where(page.officeId ? eq(contracts.officeId, page.officeId) : undefined)
    .orderBy(desc(contracts.createdAt), asc(contracts.id)).limit(page.limit).offset(page.offset);
  });
  async function saveContract(req: FastifyRequest, id?: string) {
    const body = parse(contractBody, req.body);
    if (!await db.query.offices.findFirst({ where: eq(offices.id, body.officeId) })) throw notFound('Escritório');
    const [saved] = id ? await db.update(contracts).set(body).where(eq(contracts.id, id)).returning()
      : await db.insert(contracts).values(body).returning();
    if (!saved) throw notFound('Contrato');
    await audit(req, id ? 'contract.update' : 'contract.create', saved.id, { officeId: body.officeId, plan: body.plan }); return saved;
  }
  app.post('/platform/contracts', write, async (req, reply) => reply.code(201).send(await saveContract(req)));
  app.put('/platform/contracts/:id', write, async (req) => saveContract(req, parse(idParam, req.params).id));
  app.get('/platform/ai', write, async () => ({
    catalog: AI_PROVIDERS,
    connections: (await platformDb.select().from(platformAiConnections).orderBy(asc(platformAiConnections.name))).map(safeConnection),
    defaultAiId: (await platformDb.query.platformSettings.findFirst({ where: eq(platformSettings.id, 'global') }))?.defaultAiId ?? null,
    environmentConfigured: Boolean(ctx.config.ANTHROPIC_API_KEY),
  }));
  async function saveAi(req: FastifyRequest, id?: string) {
    const body = parse(aiBody, req.body); const def = aiProviderDef(body.provider)!;
    const old = id ? await platformDb.query.platformAiConnections.findFirst({ where: eq(platformAiConnections.id, id) }) : null;
    if (id && !old) throw notFound('Conexão');
    if (old && old.provider !== body.provider) throw badRequest('Crie outra conexão para trocar de serviço.');
    const baseUrl = def.key === 'compatible' ? (body.baseUrl ?? '') : def.baseUrl;
    if (def.key === 'compatible') { const reason = unsafeBaseUrlReason(baseUrl); if (reason) throw badRequest(reason); }
    // Endpoints locais não são escolhidos pelo navegador: apenas Ollama no loopback do servidor.
    const secretsEnc = body.apiKey === null ? null : body.apiKey ? ctx.secrets.encryptJson({ apiKey: body.apiKey }) : old?.secretsEnc ?? null;
    if (body.enabled && !secretsEnc && def.key !== 'ollama') throw badRequest('Informe a chave de API para ativar esta conexão.');
    const values = { provider: def.key, name: body.name, model: body.model, baseUrl: baseUrl.replace(/\/+$/, ''),
      supportsImages: body.supportsImages, enabled: body.enabled, secretsEnc, status: 'configured', lastTestAt: null, updatedAt: new Date() };
    const [saved] = old ? await platformDb.update(platformAiConnections).set(values).where(eq(platformAiConnections.id, old.id)).returning()
      : await platformDb.insert(platformAiConnections).values(values).returning();
    await audit(req, old ? 'ai.update' : 'ai.create', saved.id, { provider: def.key, model: body.model, enabled: body.enabled, keyChanged: Boolean(body.apiKey) || body.apiKey === null });
    return safeConnection(saved);
  }
  app.post('/platform/ai', write, async (req, reply) => reply.code(201).send(await saveAi(req)));
  app.put('/platform/ai/:id', write, async (req) => saveAi(req, parse(idParam, req.params).id));
  app.put('/platform/ai-default', write, async (req) => {
    const { id } = parse(z.object({ id: z.uuid().nullable() }), req.body);
    if (id) {
      const row = await platformDb.query.platformAiConnections.findFirst({ where: eq(platformAiConnections.id, id) });
      if (!row?.enabled) throw badRequest('Selecione uma conexão ativa.');
      unlockConnection(ctx, row);
    }
    await platformDb.insert(platformSettings).values({ id: 'global', defaultAiId: id }).onConflictDoUpdate({
      target: platformSettings.id, set: { defaultAiId: id, updatedAt: new Date() },
    });
    await audit(req, 'ai.default', id); return { ok: true };
  });
  app.post('/platform/ai/:id/test', write, async (req) => {
    await consume(rateCtx, `ai-test:${platformUser(req).id}`, { max: 10, windowSec: 60 });
    const { id } = parse(idParam, req.params);
    const row = await platformDb.query.platformAiConnections.findFirst({ where: eq(platformAiConnections.id, id) });
    if (!row) throw notFound('Conexão');
    let ok = true;
    try {
      const c = unlockConnection(ctx, row);
      await completeConnection(c, { system: 'Responda em português.', messages: [{ role: 'user', content: 'Responda apenas: conexão disponível.' }], maxTokens: 1024 },
        connectionFetch(c, ctx.providers.fetch, ctx.providers.userUrlFetch));
    } catch { ok = false; }
    await platformDb.update(platformAiConnections).set({ lastTestAt: new Date(), status: ok ? 'connected' : 'error' }).where(eq(platformAiConnections.id, id));
    await audit(req, 'ai.test', id, { ok });
    return { ok, message: ok ? 'O modelo respondeu. Conexão disponível.' : 'Não foi possível obter uma resposta. Confira chave, modelo, saldo e disponibilidade do serviço.' };
  });
  app.delete('/platform/ai/:id', write, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    // FK restrict cobre a corrida entre exclusão e seleção como padrão.
    const settings = await platformDb.query.platformSettings.findFirst({ where: eq(platformSettings.id, 'global') });
    if (settings?.defaultAiId === id) throw conflict('Escolha outra conexão padrão antes de excluir esta.');
    const deleted = await platformDb.delete(platformAiConnections).where(eq(platformAiConnections.id, id)).returning({ id: platformAiConnections.id });
    if (!deleted.length) throw notFound('Conexão');
    await audit(req, 'ai.delete', id); return reply.code(204).send();
  });
  // ---------------------------------------------------------------- fila de tarefas
  /** Tarefas da fila (padrão: as que falharam), com o escritório e o erro. O conteúdo do job não sai daqui. */
  app.get('/platform/jobs', read, async (req) => {
    const q = parse(z.object({ status: z.enum(JOB_STATUSES).default('failed'), limit: z.coerce.number().int().min(1).max(200).default(50), officeId: z.uuid().optional() }), req.query);
    return db.select({
      id: jobs.id, type: jobs.type, status: jobs.status, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts, error: jobs.error,
      officeId: jobs.officeId, officeName: offices.name, createdAt: jobs.createdAt, runAt: jobs.runAt, finishedAt: jobs.finishedAt,
    }).from(jobs).leftJoin(offices, eq(offices.id, jobs.officeId))
      .where(and(eq(jobs.status, q.status), q.officeId ? eq(jobs.officeId, q.officeId) : undefined))
      .orderBy(desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`)).limit(q.limit);
  });
  /** Recoloca na fila uma tarefa que falhou (as tentativas recomeçam do zero). */
  app.post('/platform/jobs/:id/retry', write, async (req) => {
    const { id } = parse(idParam, req.params);
    const [saved] = await db.update(jobs)
      .set({ status: 'queued', attempts: 0, error: null, runAt: new Date(), finishedAt: null, lockedAt: null, lockToken: null, progress: 0 })
      .where(and(eq(jobs.id, id), eq(jobs.status, 'failed'))).returning({ id: jobs.id, type: jobs.type });
    if (!saved) throw notFound('Tarefa com falha');
    await audit(req, 'job.retry', id, { type: saved.type }); return { ok: true };
  });
  /** Tira da lista as tarefas com falha já vistas (a rotina de limpeza apagaria só depois do prazo). */
  app.post('/platform/jobs/dismiss', write, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).min(1).max(200) }), req.body);
    const gone = await db.delete(jobs).where(and(inArray(jobs.id, ids), eq(jobs.status, 'failed'))).returning({ id: jobs.id });
    await audit(req, 'job.dismiss', null, { count: gone.length }); return { removed: gone.length };
  });
  // ---------------------------------------------------------------- configurações do sistema
  app.get('/platform/settings', read, async () => {
    const row = await platformDb.query.platformSettings.findFirst({ where: eq(platformSettings.id, 'global') });
    return {
      // o que está gravado (null = padrão) e o que vale de fato
      stored: { signupEnabled: row?.signupEnabled ?? null, trialDays: row?.trialDays ?? null, trialDeclarationLimit: row?.trialDeclarationLimit ?? null,
        supportEmail: row?.supportEmail ?? null, termsUrl: row?.termsUrl ?? null, privacyUrl: row?.privacyUrl ?? null },
      effective: await effectiveSettings(ctx),
      // travas do servidor que o painel não muda
      environment: { signupEnabled: ctx.config.SIGNUP_ENABLED, supportEmail: ctx.config.SUPPORT_EMAIL || null },
    };
  });
  app.put('/platform/settings', write, async (req) => {
    const body = parse(settingsBody, req.body);
    await platformDb.insert(platformSettings).values({ id: 'global', ...body }).onConflictDoUpdate({
      target: platformSettings.id, set: { ...body, updatedAt: new Date() },
    });
    await audit(req, 'settings.update', null, body);
    return effectiveSettings(ctx);
  });
  // ---------------------------------------------------------------- e-mail do sistema
  app.get('/platform/email', read, async () => {
    const failures = await db.execute(sql`select
      (select count(*)::int from jobs where status = 'failed' and type like 'auth.%' and finished_at > now() - interval '7 days') as account_mail_failures_7d,
      (select count(*)::int from deliveries where channel = 'email' and status = 'failed' and created_at > now() - interval '7 days') as delivery_failures_7d,
      (select count(*)::int from deliveries where channel = 'email' and status = 'sent' and created_at > now() - interval '7 days') as delivery_sent_7d`);
    const f = (failures as { rows: Record<string, unknown>[] }).rows[0];
    return { ...platformSmtpInfo(ctx), accountMailFailures7d: Number(f.account_mail_failures_7d), deliveryFailures7d: Number(f.delivery_failures_7d), deliverySent7d: Number(f.delivery_sent_7d) };
  });
  app.post('/platform/email/test', write, async (req) => {
    await consume(rateCtx, `email-test:${platformUser(req).id}`, { max: 10, windowSec: 600 });
    const { to } = parse(z.object({ to: z.email().max(320).optional() }), req.body ?? {});
    let ok = true; let message: string;
    try { message = await testPlatformSmtp(ctx, to, ctx.providers.smtpTransport); }
    catch (err) { ok = false; message = err instanceof IntegrationError ? err.message : 'Não foi possível testar o envio de e-mail.'; }
    await audit(req, 'email.test', null, { ok, sent: Boolean(to) });
    return { ok, message };
  });
  // ---------------------------------------------------------------- contas do sistema
  app.get('/platform/users', write, async () => platformDb.select({
    id: platformUsers.id, name: platformUsers.name, email: platformUsers.email, role: platformUsers.role, isActive: platformUsers.isActive,
    createdAt: platformUsers.createdAt, lastLoginAt: platformUsers.lastLoginAt,
    twoFactor: sql<boolean>`${platformUsers.totpEnabledAt} is not null`,
  }).from(platformUsers).orderBy(asc(platformUsers.name)));
  /** Nome e papel de uma conta. Rebaixar o último proprietário ativo é recusado; ninguém muda o próprio papel. */
  app.put('/platform/users/:id', write, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(100), role: z.enum(['owner', 'developer']) }), req.body);
    const saved = await platformDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(728103)`);
      const target = await tx.query.platformUsers.findFirst({ where: eq(platformUsers.id, id) });
      if (!target) throw notFound('Conta do sistema');
      if (target.role !== body.role) {
        if (id === platformUser(req).id) throw badRequest('Você não pode mudar o seu próprio papel.');
        if (target.role === 'owner' && target.isActive) {
          const owners = await tx.select({ id: platformUsers.id }).from(platformUsers).where(sql`${platformUsers.role} = 'owner' and ${platformUsers.isActive}`);
          if (owners.length <= 1) throw conflict('O sistema precisa manter pelo menos um proprietário ativo.');
        }
      }
      // mudou o papel: as sessões abertas da conta caem (o token antigo carregaria o papel anterior só até a próxima requisição, mas encerrar é mais claro)
      return (await tx.update(platformUsers)
        .set({ name: body.name, role: body.role, ...(target.role !== body.role ? { tokenVersion: sql`${platformUsers.tokenVersion} + 1` } : {}) })
        .where(eq(platformUsers.id, id)).returning({ id: platformUsers.id }))[0];
    });
    await audit(req, 'platform.user.update', id, { role: body.role }); return saved;
  });
  /** O proprietário define uma senha nova para outra conta (a própria se troca em "Minha conta"). */
  app.put('/platform/users/:id/password', write, async (req) => {
    const { id } = parse(idParam, req.params);
    const { password } = parse(z.object({ password: platformPassword }), req.body);
    if (id === platformUser(req).id) throw badRequest('Para a sua conta, use "Trocar senha" (pede a senha atual).');
    const [saved] = await platformDb.update(platformUsers)
      .set({ passwordHash: await bcrypt.hash(password, 12), tokenVersion: sql`${platformUsers.tokenVersion} + 1` })
      .where(eq(platformUsers.id, id)).returning({ id: platformUsers.id, email: platformUsers.email });
    if (!saved) throw notFound('Conta do sistema');
    // a conta pode estar bloqueada por tentativas com a senha antiga
    await resetLimit(rateCtx, `platform-login-email:${saved.email}`);
    await audit(req, 'platform.user.password', id); return { id: saved.id };
  });
  app.post('/platform/users', write, async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(100), email: z.email().max(320).transform((v) => v.toLowerCase()),
      password: platformPassword, role: z.enum(['owner', 'developer']) }), req.body);
    if (await platformDb.query.platformUsers.findFirst({ where: eq(platformUsers.email, body.email) })) throw conflict('Este e-mail já possui uma conta do sistema.');
    const [saved] = await platformDb.insert(platformUsers).values({ name: body.name, email: body.email, role: body.role,
      passwordHash: await bcrypt.hash(body.password, 12) }).returning({ id: platformUsers.id });
    await audit(req, 'platform.user.create', saved.id, { role: body.role }); return reply.code(201).send(saved);
  });
  app.put('/platform/users/:id/active', write, async (req) => {
    const { id } = parse(idParam, req.params); const { isActive } = parse(z.object({ isActive: z.boolean() }), req.body);
    if (id === platformUser(req).id) throw badRequest('Você não pode desativar sua própria conta.');
    const saved = await platformDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(728103)`);
      const actor = await tx.query.platformUsers.findFirst({ where: eq(platformUsers.id, platformUser(req).id) });
      if (!actor?.isActive || actor.role !== 'owner') throw forbidden();
      const target = await tx.query.platformUsers.findFirst({ where: eq(platformUsers.id, id) });
      if (!target) throw notFound('Conta do sistema');
      if (!isActive && target.role === 'owner') {
        const owners = await tx.select({ id: platformUsers.id }).from(platformUsers).where(sql`${platformUsers.role} = 'owner' and ${platformUsers.isActive}`);
        if (owners.length <= 1) throw conflict('O sistema precisa manter pelo menos um proprietário ativo.');
      }
      return (await tx.update(platformUsers).set({ isActive, tokenVersion: sql`${platformUsers.tokenVersion} + 1` })
        .where(eq(platformUsers.id, id)).returning({ id: platformUsers.id }))[0];
    });
    await audit(req, 'platform.user.active', id, { isActive }); return saved;
  });
  app.get('/platform/audit', read, async () => platformDb.select({
    id: platformAuditLogs.id, actor: platformUsers.name, action: platformAuditLogs.action,
    entityId: platformAuditLogs.entityId, details: platformAuditLogs.details, createdAt: platformAuditLogs.createdAt,
  }).from(platformAuditLogs).leftJoin(platformUsers, eq(platformUsers.id, platformAuditLogs.actorId))
    .orderBy(desc(platformAuditLogs.createdAt)).limit(200));
  app.get('/ai/platform-status', { preHandler: guard('ai.use', 'integrations.manage') }, async () => {
    try { const c = await resolveGlobalAi(ctx); return { available: true, provider: aiProviderDef(c.provider)?.label, model: c.model, pdf: aiProviderDef(c.provider)?.pdf, images: c.supportsImages }; }
    catch { return { available: false, provider: null, model: null, pdf: false, images: false }; }
  });
}
