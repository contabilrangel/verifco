import { and, asc, count, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OPPORTUNITY_CATEGORIES, OPPORTUNITY_STATUS, RADAR_RULES, evaluateRadar, type DeclarationItem, type OpportunityCategory } from '@verifco/shared';
import type { AppContext } from '../../context';
import { customers, declarationItems, declarations, jobs, opportunities } from '../../db/schema';
import { notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { customerScope, getCustomerForUser } from '../../services/customers';
import { getOfficeSettings } from '../../services/settings';

const categories = Object.keys(OPPORTUNITY_CATEGORIES) as [OpportunityCategory, ...OpportunityCategory[]];
const statuses = Object.keys(OPPORTUNITY_STATUS) as [keyof typeof OPPORTUNITY_STATUS, ...(keyof typeof OPPORTUNITY_STATUS)[]];

/**
 * Recalcula as oportunidades do escritório no exercício. Mantém o status das que continuam
 * válidas; remove as abertas que deixaram de atender à regra.
 */
export async function computeRadar(ctx: AppContext, officeId: string, year: number, progress?: (pct: number) => Promise<void>) {
  const { db } = ctx;
  const settings = await getOfficeSettings(db, officeId);
  const decls = await db
    .select({ id: declarations.id, customerId: declarations.customerId })
    .from(declarations)
    .innerJoin(customers, eq(customers.id, declarations.customerId))
    .where(and(eq(declarations.officeId, officeId), eq(declarations.exerciseYear, year), isNull(customers.deletedAt)));
  const keep: string[] = [];
  let found = 0;
  const chunk = 200;
  for (let i = 0; i < decls.length; i += chunk) {
    const part = decls.slice(i, i + chunk);
    const rows = await db.select().from(declarationItems).where(inArray(declarationItems.declarationId, part.map((d) => d.id)));
    const byDecl = new Map<string, DeclarationItem[]>();
    for (const r of rows) byDecl.set(r.declarationId, [...(byDecl.get(r.declarationId) ?? []), { ...r, kind: r.kind as DeclarationItem['kind'] }]);
    for (const d of part) {
      const signals = evaluateRadar({ items: byDecl.get(d.id) ?? [], calendarYear: year - 1, highNetWorthBaseCents: settings.highNetWorthBaseCents });
      for (const s of signals) {
        const [row] = await db
          .insert(opportunities)
          .values({ officeId, customerId: d.customerId, category: s.category, exerciseYear: year, score: s.score, evidence: s.evidence })
          .onConflictDoUpdate({
            target: [opportunities.customerId, opportunities.category, opportunities.exerciseYear],
            set: { score: s.score, evidence: s.evidence, updatedAt: new Date() },
          })
          .returning({ id: opportunities.id });
        keep.push(row.id);
        found++;
      }
    }
    await progress?.(Math.round(((i + part.length) / Math.max(1, decls.length)) * 100));
  }
  const stale = and(eq(opportunities.officeId, officeId), eq(opportunities.exerciseYear, year), eq(opportunities.status, 'open'), keep.length ? notInArray(opportunities.id, keep) : undefined);
  const removed = await db.delete(opportunities).where(stale).returning({ id: opportunities.id });
  return { declarations: decls.length, opportunities: found, removed: removed.length };
}

export async function radarRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  const lastJob = (officeId: string, year: number) =>
    db.query.jobs.findFirst({
      where: and(eq(jobs.officeId, officeId), eq(jobs.type, 'radar.compute'), sql`${jobs.payload}->>'year' = ${String(year)}`),
      orderBy: desc(jobs.createdAt),
    });

  app.get('/radar', { preHandler: guard('radar.view') }, async (req) => {
    const user = requireUser(req);
    const { year } = parse(z.object({ year: yearSchema }), req.query);
    const scope = await customerScope(app.ctx, user);
    const rows = await db
      .select({ category: opportunities.category, status: opportunities.status, n: count() })
      .from(opportunities)
      .innerJoin(customers, eq(customers.id, opportunities.customerId))
      .where(and(eq(opportunities.officeId, user.officeId), eq(opportunities.exerciseYear, year), scope))
      .groupBy(opportunities.category, opportunities.status);
    const job = await lastJob(user.officeId, year);
    return {
      year,
      categories: categories.map((c) => {
        const byStatus = Object.fromEntries(statuses.map((s) => [s, rows.find((r) => r.category === c && r.status === s)?.n ?? 0]));
        const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
        return { category: c, ...RADAR_RULES[c], label: OPPORTUNITY_CATEGORIES[c], total, active: byStatus.open + byStatus.in_progress, byStatus };
      }),
      lastJob: job ? { id: job.id, status: job.status, progress: job.progress, finishedAt: job.finishedAt, createdAt: job.createdAt, error: job.error, result: job.result } : null,
    };
  });

  app.post('/radar/refresh', { preHandler: guard('radar.view') }, async (req, reply) => {
    const user = requireUser(req);
    const { year } = parse(z.object({ year: yearSchema }), req.body);
    const job = await lastJob(user.officeId, year);
    if (job && (job.status === 'queued' || job.status === 'running')) return { job, alreadyRunning: true };
    const created = await app.ctx.jobs.enqueue('radar.compute', { officeId: user.officeId, year }, { officeId: user.officeId, userId: user.userId, maxAttempts: 2 });
    await audit(req, 'refresh', 'radar', null, { year });
    reply.status(202);
    return { job: created, alreadyRunning: false };
  });

  app.get('/radar/opportunities', { preHandler: guard('radar.view') }, async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ year: yearSchema, category: z.enum(categories).optional(), status: z.enum(statuses).optional() }), req.query);
    const scope = await customerScope(app.ctx, user);
    const conds = [eq(opportunities.officeId, user.officeId), eq(opportunities.exerciseYear, q.year), scope];
    if (q.category) conds.push(eq(opportunities.category, q.category));
    if (q.status) conds.push(eq(opportunities.status, q.status));
    const rows = await db
      .select({ o: opportunities, name: customers.name, cpfCnpj: customers.cpfCnpj, email: customers.email })
      .from(opportunities)
      .innerJoin(customers, eq(customers.id, opportunities.customerId))
      .where(and(...conds))
      .orderBy(desc(opportunities.score), asc(customers.name));
    return rows.map((r) => ({ ...r.o, customerName: r.name, cpfCnpj: r.cpfCnpj, email: r.email }));
  });

  app.put('/radar/opportunities/:id', { preHandler: guard('radar.view') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(z.object({ status: z.enum(statuses) }), req.body);
    const row = await db.query.opportunities.findFirst({ where: and(eq(opportunities.id, id), eq(opportunities.officeId, user.officeId)) });
    if (!row) throw notFound('Oportunidade');
    await getCustomerForUser(app.ctx, user, row.customerId);
    const [updated] = await db.update(opportunities).set({ status, updatedAt: new Date() }).where(eq(opportunities.id, id)).returning();
    await audit(req, 'status', 'opportunity', id, { status });
    return updated;
  });
}
