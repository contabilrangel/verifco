import bcrypt from 'bcryptjs';
import { asc, desc, eq, ilike, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AI_PROVIDERS, aiProviderDef, todayIso } from '@verifco/shared';
import { contracts, offices } from '../../db/schema';
import { platformUsers, platformSettings, platformAiConnections, platformAuditLogs } from '../../db/platform-schema';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { guard, parse } from '../../lib/http';
import { consume } from '../../services/rate-limit';
import { unsafeBaseUrlReason } from '../../integrations/ssrf';
import { safeConnection, unlockConnection, resolveGlobalAi } from '../../integrations/platform-ai-store';
import { completeConnection, connectionFetch } from '../../integrations/multi-ai';

const idParam = z.object({ id: z.uuid() });
const pageQuery = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100),
  search: z.string().trim().max(100).default('') });
const loginBody = z.object({ email: z.email().max(320).transform((s) => s.toLowerCase()), password: z.string().min(1).max(200) });
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
  status: z.enum(['active', 'expired', 'cancelled']),
}).refine((v) => v.expiresAt >= v.startsAt, { message: 'O término deve ser igual ou posterior ao início.' });

function platformUser(req: FastifyRequest, owner = false) {
  if (!req.platformAuth) throw unauthorized('Entre na administração do sistema para continuar.');
  if (owner && req.platformAuth.role !== 'owner') throw forbidden('Esta configuração é exclusiva do proprietário do sistema.');
  return req.platformAuth;
}

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
    await consume(rateCtx, `platform-login-email:${body.email}`, { max: 10, windowSec: 900 });
    const user = await platformDb.query.platformUsers.findFirst({ where: eq(platformUsers.email, body.email) });
    // Mesmo custo para conta inexistente; mensagem não revela se a conta existe.
    const hash = user?.passwordHash ?? '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const valid = await bcrypt.compare(body.password, hash);
    if (!user?.isActive || !valid) throw unauthorized('E-mail ou senha inválidos.');
    await platformDb.insert(platformAuditLogs).values({ actorId: user.id, action: 'platform.login' });
    return { token: app.jwt.sign({ typ: 'platform', sub: user.id, tv: user.tokenVersion }, { expiresIn: '1h' }) };
  });
  app.get('/platform/me', read, async (req) => platformUser(req));
  app.post('/platform/logout', read, async (req) => {
    const user = platformUser(req);
    await platformDb.update(platformUsers).set({ tokenVersion: sql`${platformUsers.tokenVersion} + 1` }).where(eq(platformUsers.id, user.id));
    await audit(req, 'platform.logout'); return { ok: true };
  });
  app.get('/platform/overview', read, async () => {
    const today = todayIso();
    const result = await db.execute(sql`select
      (select count(*)::int from offices) as offices,
      (select count(*)::int from users where is_active) as collaborators,
      (select count(*)::int from contracts where status = 'active' and starts_at <= ${today}::date and expires_at >= ${today}::date) as active_contracts,
      (select count(*)::int from jobs where status = 'queued') as queued_jobs,
      (select count(*)::int from jobs where status = 'failed') as failed_jobs`);
    return (result as { rows: unknown[] }).rows[0];
  });
  app.get('/platform/offices', read, async (req) => {
    const page = parse(pageQuery, req.query);
    return db.select({
    id: offices.id, name: offices.name, email: offices.email, city: offices.city, state: offices.state,
    collaborators: sql<number>`(select count(*)::int from users where office_id = offices.id)`,
    customers: sql<number>`(select count(*)::int from customers where office_id = offices.id and deleted_at is null)`,
  }).from(offices).where(page.search ? ilike(offices.name, '%' + page.search + '%') : undefined)
      .orderBy(asc(offices.name), asc(offices.id)).limit(page.limit).offset(page.offset);
  });
  app.put('/platform/offices/:id', write, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(200), email: z.email().max(320).nullable(),
      city: z.string().trim().max(100).nullable(), state: z.string().regex(/^[A-Z]{2}$/).nullable() }), req.body);
    const [saved] = await db.update(offices).set(body).where(eq(offices.id, id)).returning({ id: offices.id });
    if (!saved) throw notFound('Escritório');
    await audit(req, 'office.update', id); return saved;
  });
  app.get('/platform/contracts', read, async (req) => {
    const page = parse(pageQuery, req.query);
    return db.select({
    id: contracts.id, officeId: contracts.officeId, officeName: offices.name, name: contracts.name, plan: contracts.plan,
    year: contracts.year, declarationLimit: contracts.declarationLimit, startsAt: contracts.startsAt, expiresAt: contracts.expiresAt,
    hasBackup: contracts.hasBackup, status: contracts.status,
  }).from(contracts).innerJoin(offices, eq(offices.id, contracts.officeId))
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
  app.get('/platform/users', write, async () => platformDb.select({
    id: platformUsers.id, name: platformUsers.name, email: platformUsers.email, role: platformUsers.role, isActive: platformUsers.isActive,
  }).from(platformUsers).orderBy(asc(platformUsers.name)));
  app.post('/platform/users', write, async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(100), email: z.email().max(320).transform((v) => v.toLowerCase()),
      password: z.string().min(12, 'Use uma senha com pelo menos 12 caracteres.').max(200), role: z.enum(['owner', 'developer']) }), req.body);
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
