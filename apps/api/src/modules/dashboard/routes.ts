import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ASSET_GROUPS,
  AUTH_TYPES,
  BUDGET_STATUS,
  CND_STATUS,
  DECLARATION_STAGES,
  ECAC_DECLARATION_STATUS,
  IRPFM_THRESHOLD_CENTS,
  PROCURATION_STATUS,
  brazilToday,
  currentExerciseYear,
  type DeclarationItem,
} from '@verifco/shared';
import { backlogs, budgets, customers, darfs, declarationItems, declarations, integrations, jobs, procurators } from '../../db/schema';
import type { Db } from '../../db/client';
import { guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { customerScope, getCustomerForUser } from '../../services/customers';
import { computeCashAnalysis, listItems } from '../../services/declarations';
import { emptyDeclaration, presentDeclaration } from '../declarations/access';

const yearQuery = z.object({ year: yearSchema.optional() });
const ALERT_LIMIT = 50;

type Slice = { key: string; label: string; count: number; cents?: number };

/** Garante todas as categorias conhecidas (com zero) na ordem do catálogo. */
function slices(labels: Record<string, string>, rows: { k: string | null; n: number; cents?: number }[], fallbackKey = 'none', fallbackLabel = 'Não informado'): Slice[] {
  const by = new Map<string, { n: number; cents: number }>();
  for (const r of rows) {
    const k = r.k ?? fallbackKey;
    const cur = by.get(k) ?? { n: 0, cents: 0 };
    by.set(k, { n: cur.n + r.n, cents: cur.cents + (r.cents ?? 0) });
  }
  const out: Slice[] = Object.entries(labels).map(([key, label]) => ({ key, label, count: by.get(key)?.n ?? 0, cents: by.get(key)?.cents ?? 0 }));
  for (const [k, v] of by) if (!(k in labels)) out.push({ key: k, label: k === fallbackKey ? fallbackLabel : k, count: v.n, cents: v.cents });
  return out;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Situação do acesso de cada procurador, derivada só de dados que o Verifco tem: forma de acesso,
 * certificado enviado e validade informada, e o último uso do certificado no SERPRO (teste da
 * integração ou sincronização do eCAC). O login gov.br acontece no navegador, fora do Verifco.
 */
export const PROCURATOR_ACCESS = {
  serpro_ok: 'Autenticado no SERPRO',
  valid: 'Certificado no prazo',
  expiring: 'Certificado vence em até 30 dias',
  expired: 'Certificado vencido',
  missing: 'Certificado não enviado',
  serpro_error: 'Falha no SERPRO',
  unverified: 'Sem verificação',
} as const;
export type ProcuratorAccess = keyof typeof PROCURATOR_ACCESS;

export function procuratorAccess(
  p: { id: string; authType: string; hasCert: boolean; certExpiresAt: string | null },
  ctx: { today: string; in30: string; serproProcuratorId: string | null; serproState: 'ok' | 'error' | null },
): ProcuratorAccess {
  if (p.authType === 'govbr') return 'unverified';
  if (p.certExpiresAt && p.certExpiresAt < ctx.today) return 'expired';
  if (p.authType === 'certificate_cloud' && !p.hasCert) return 'missing';
  if (p.id === ctx.serproProcuratorId && ctx.serproState) return ctx.serproState === 'ok' ? 'serpro_ok' : 'serpro_error';
  if (p.certExpiresAt) return p.certExpiresAt <= ctx.in30 ? 'expiring' : 'valid';
  return 'unverified';
}

/**
 * Último uso do certificado do escritório no SERPRO: o mais recente entre o teste da integração
 * (Administração › Integrações) e as sincronizações do eCAC terminadas. Sincronização de um
 * cliente que falhou não conta (o erro pode ser do cliente, como procuração ausente).
 */
async function serproUsage(db: Db, officeId: string) {
  const row = await db.query.integrations.findFirst({ where: and(eq(integrations.officeId, officeId), eq(integrations.provider, 'serpro')) });
  const procuratorId = row?.enabled && typeof row.publicConfig?.procuratorId === 'string' ? row.publicConfig.procuratorId : null;
  if (!row || !procuratorId) return { procuratorId: null, state: null, at: null, error: null };
  const events: { at: Date; ok: boolean; error: string | null }[] = [];
  const testAt = typeof row.publicConfig?.lastTestAt === 'string' ? new Date(row.publicConfig.lastTestAt) : null;
  if (testAt && !Number.isNaN(testAt.getTime()) && (row.status === 'connected' || row.status === 'error')) {
    events.push({ at: testAt, ok: row.status === 'connected', error: row.status === 'error' ? row.lastError : null });
  }
  const [job] = await db
    .select({ type: jobs.type, status: jobs.status, error: jobs.error, result: jobs.result, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.officeId, officeId),
        isNotNull(jobs.finishedAt),
        or(and(eq(jobs.type, 'ecac.sync'), eq(jobs.status, 'done')), and(eq(jobs.type, 'ecac.sync_office'), inArray(jobs.status, ['done', 'failed']))),
      ),
    )
    .orderBy(desc(jobs.finishedAt))
    .limit(1);
  if (job?.finishedAt) {
    const result = (job.result ?? {}) as { ok?: unknown; failed?: unknown };
    const allFailed = job.type === 'ecac.sync_office' && num(result.ok) === 0 && num(result.failed) > 0;
    const ok = job.status === 'done' && !allFailed;
    events.push({ at: job.finishedAt, ok, error: ok ? null : (job.error ?? 'Nenhum cliente sincronizado na última sincronização do eCAC.') });
  }
  const last = events.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  return { procuratorId, state: last ? (last.ok ? ('ok' as const) : ('error' as const)) : null, at: last?.at ?? null, error: last?.error ?? null };
}

export async function dashboardRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  const sumOf = (col: SQL | AnyPgColumn) => sql<number>`coalesce(sum(${col}), 0)`.mapWith(Number);

  /** Dashboard do escritório no exercício: indicadores, alertas e gráficos. */
  app.get('/dashboard', { preHandler: guard('declaration.view', 'customer.list') }, async (req) => {
    const user = requireUser(req);
    const year = parse(yearQuery, req.query).year ?? currentExerciseYear();
    const today = brazilToday();
    const scope = await customerScope(app.ctx, user);
    const inYear = and(scope, eq(declarations.exerciseYear, year))!;

    // ---------------- indicadores
    const [active] = await db.select({ n: count() }).from(customers).where(and(scope, eq(customers.status, 'active')));
    const [ind] = await db
      .select({
        started: sql<number>`count(*) filter (where ${declarations.stage} <> 'not_started')`.mapWith(Number),
        transmitted: sql<number>`count(*) filter (where ${declarations.stage} in ('transmitted', 'finished'))`.mapWith(Number),
        finished: sql<number>`count(*) filter (where ${declarations.stage} = 'finished')`.mapWith(Number),
        taxDueCents: sumOf(declarations.taxDueCents),
        refundCents: sumOf(declarations.refundCents),
        taxDueCount: sql<number>`count(*) filter (where ${declarations.taxDueCents} > 0)`.mapWith(Number),
        refundCount: sql<number>`count(*) filter (where ${declarations.refundCents} > 0)`.mapWith(Number),
      })
      .from(declarations)
      .innerJoin(customers, eq(customers.id, declarations.customerId))
      .where(inYear);

    // ---------------- alertas (clientes afetados)
    const alertCustomers = async (where: SQL, value?: SQL) => {
      const rows = await db
        .select({ id: customers.id, name: customers.name, valueCents: value ? sql<number>`${value}`.mapWith(Number) : sql<number>`0`.mapWith(Number) })
        .from(declarations)
        .innerJoin(customers, eq(customers.id, declarations.customerId))
        .where(and(inYear, where))
        .orderBy(asc(customers.name));
      return { count: rows.length, customers: rows.slice(0, ALERT_LIMIT) };
    };
    const negativeCash = await alertCustomers(lt(declarations.cashBalanceCents, 0), sql`${declarations.cashBalanceCents}`);
    const fineMesh = await alertCustomers(
      or(inArray(declarations.ecacStatus, ['fine_mesh', 'pending_issues']), eq(declarations.substatus, 'ecac_fine_mesh'))!,
    );
    // art. 16-A, caput: soma dos rendimentos SUPERIOR a R$ 600 mil (o total gravado usa o resultado rural, não a receita bruta)
    const irpfm = await alertCustomers(sql`${declarations.totalIncomeCents} > ${IRPFM_THRESHOLD_CENTS}`, sql`${declarations.totalIncomeCents}`);
    const overdueRows = await db
      .select({ id: customers.id, name: customers.name, valueCents: sumOf(darfs.valueCents), n: count() })
      .from(darfs)
      .innerJoin(declarations, eq(declarations.id, darfs.declarationId))
      .innerJoin(customers, eq(customers.id, darfs.customerId))
      .where(and(inYear, ne(darfs.status, 'paid'), isNull(darfs.paidAt), lt(darfs.dueDate, today)))
      .groupBy(customers.id, customers.name)
      .orderBy(asc(customers.name));
    const darfOverdue = { count: overdueRows.length, customers: overdueRows.slice(0, ALERT_LIMIT).map(({ id, name, valueCents }) => ({ id, name, valueCents })) };

    // ---------------- gráficos
    const procurationRows = await db
      .select({ k: customers.procurationStatus, n: count() })
      .from(customers)
      .where(and(scope, eq(customers.status, 'active')))
      .groupBy(customers.procurationStatus);
    const cndRows = await db.select({ k: customers.cndStatus, n: count() }).from(customers).where(and(scope, eq(customers.status, 'active'))).groupBy(customers.cndStatus);

    const procRows = await db
      .select({
        id: procurators.id,
        authType: procurators.authType,
        hasCert: sql<boolean>`(${procurators.certificateFileId} is not null and ${procurators.certificatePasswordEnc} is not null)`,
        certExpiresAt: procurators.certificateExpiresAt,
      })
      .from(procurators)
      .where(eq(procurators.officeId, user.officeId));
    const serpro = await serproUsage(db, user.officeId);
    const in30 = new Date(new Date(`${today}T12:00:00Z`).getTime() + 30 * 86400_000).toISOString().slice(0, 10);
    const byAuth = new Map<string, number>();
    const byAccess = new Map<string, number>();
    for (const p of procRows) {
      byAuth.set(p.authType, (byAuth.get(p.authType) ?? 0) + 1);
      const access = procuratorAccess(p, { today, in30, serproProcuratorId: serpro.procuratorId, serproState: serpro.state });
      byAccess.set(access, (byAccess.get(access) ?? 0) + 1);
    }
    const accessCount = (...keys: ProcuratorAccess[]) => keys.reduce((a, k) => a + (byAccess.get(k) ?? 0), 0);
    const procuratorLogin = {
      total: procRows.length,
      byAuthType: slices(AUTH_TYPES, [...byAuth].map(([k, n]) => ({ k, n }))),
      byAccess: slices(PROCURATOR_ACCESS, [...byAccess].map(([k, n]) => ({ k, n }))),
      loginOk: accessCount('serpro_ok', 'valid', 'expiring'),
      loginError: accessCount('serpro_error', 'expired', 'missing'),
      certificatesExpired: accessCount('expired'),
      unverified: accessCount('unverified'),
      serpro: { state: serpro.state, at: serpro.at, error: serpro.error },
    };

    const ecacRows = await db
      .select({ k: declarations.ecacStatus, n: count() })
      .from(declarations)
      .innerJoin(customers, eq(customers.id, declarations.customerId))
      .where(and(inYear, inArray(declarations.stage, ['transmitted', 'finished'])))
      .groupBy(declarations.ecacStatus);

    const stageExpr = sql<string>`coalesce(${declarations.stage}, 'not_started')`;
    const stageRows = await db
      .select({ k: stageExpr, n: count() })
      .from(customers)
      .leftJoin(declarations, and(eq(declarations.customerId, customers.id), eq(declarations.exerciseYear, year)))
      .where(and(scope, or(eq(customers.status, 'active'), isNotNull(declarations.id))))
      .groupBy(stageExpr);

    const taxationRows = await db
      .select({ k: declarations.taxation, n: count() })
      .from(declarations)
      .innerJoin(customers, eq(customers.id, declarations.customerId))
      .where(and(inYear, ne(declarations.stage, 'not_started')))
      .groupBy(declarations.taxation);

    const budgetRows = await db
      .select({ k: budgets.status, n: count(), cents: sumOf(budgets.totalCents) })
      .from(budgets)
      .innerJoin(customers, eq(customers.id, budgets.customerId))
      .where(and(scope, eq(budgets.exerciseYear, year)))
      .groupBy(budgets.status);

    const groupExpr = sql<string>`coalesce(${declarationItems.groupCode}, '99')`;
    const assetRows = await db
      .select({ k: groupExpr, n: count(), cents: sumOf(declarationItems.valueCents) })
      .from(declarationItems)
      .innerJoin(declarations, eq(declarations.id, declarationItems.declarationId))
      .innerJoin(customers, eq(customers.id, declarations.customerId))
      .where(and(inYear, eq(declarationItems.kind, 'asset')))
      .groupBy(groupExpr);

    return {
      year,
      indicators: {
        activeCustomers: active.n,
        declarations: ind?.started ?? 0,
        transmitted: ind?.transmitted ?? 0,
        finished: ind?.finished ?? 0,
        taxDueCents: ind?.taxDueCents ?? 0,
        refundCents: ind?.refundCents ?? 0,
        taxDueCount: ind?.taxDueCount ?? 0,
        refundCount: ind?.refundCount ?? 0,
      },
      alerts: [
        { key: 'negative_cash', label: 'Saldo de caixa negativo', ...negativeCash },
        { key: 'fine_mesh', label: 'Malha fina', ...fineMesh },
        { key: 'darf_overdue', label: 'DARF vencido', ...darfOverdue },
        { key: 'irpfm', label: 'Rendimentos sujeitos ao IRPFM', ...irpfm, thresholdCents: IRPFM_THRESHOLD_CENTS },
      ],
      charts: {
        procurations: slices(PROCURATION_STATUS, procurationRows),
        procuratorLogin,
        ecac: slices(ECAC_DECLARATION_STATUS, ecacRows),
        stages: slices(DECLARATION_STAGES, stageRows),
        cnd: slices(CND_STATUS, cndRows),
        taxation: slices({ complete: 'Completa', simplified: 'Simplificada' }, taxationRows, 'none', 'Não definida'),
        budgets: slices(BUDGET_STATUS, budgetRows),
        assets: slices(ASSET_GROUPS, assetRows),
      },
    };
  });

  /** Painel do cliente no exercício. */
  app.get('/customers/:id/dashboard', { preHandler: guard('declaration.view') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const year = parse(yearQuery, req.query).year ?? currentExerciseYear();
    const customer = await getCustomerForUser(app.ctx, user, id);
    const procurator = customer.procuratorId ? await db.query.procurators.findFirst({ where: eq(procurators.id, customer.procuratorId) }) : null;
    const decl = await db.query.declarations.findFirst({ where: and(eq(declarations.customerId, customer.id), eq(declarations.exerciseYear, year)) });
    const customerInfo = {
      procurationStatus: customer.procurationStatus,
      procurationExpiresAt: customer.procurationExpiresAt,
      procuratorName: procurator?.name ?? null,
      cndStatus: customer.cndStatus,
    };
    if (!decl) {
      return { year, declaration: emptyDeclaration(customer.id, year), customer: customerInfo, itemCount: 0, cash: null, netWorth: null, health: 0, education: 0, dependents: [], assetsByGroup: [], backlogs: { open: 0, overdue: 0 }, darfs: { total: 0, open: 0, overdue: 0, paid: 0, openCents: 0 } };
    }
    const items: DeclarationItem[] = await listItems(db, decl.id);
    const { result } = await computeCashAnalysis(app.ctx, decl);
    const payments = items.filter((i) => i.kind === 'payment');
    const paid = (nature: string) => payments.filter((p) => p.extra?.nature === nature).reduce((a, p) => a + (p.valueCents ?? 0) - num(p.extra?.reimbursedCents), 0);
    const assetsBy = new Map<string, number>();
    for (const a of items.filter((i) => i.kind === 'asset')) assetsBy.set(a.groupCode ?? '99', (assetsBy.get(a.groupCode ?? '99') ?? 0) + (a.valueCents ?? 0));
    const today = brazilToday();
    const bl = await db.select({ dueDate: backlogs.dueDate }).from(backlogs).where(and(eq(backlogs.declarationId, decl.id), isNull(backlogs.resolvedAt)));
    const dfs = await db.select().from(darfs).where(eq(darfs.declarationId, decl.id));
    const isPaid = (d: (typeof dfs)[number]) => d.status === 'paid' || Boolean(d.paidAt);
    return {
      year,
      declaration: presentDeclaration(decl),
      customer: customerInfo,
      itemCount: items.length,
      cash: items.length ? { balanceCents: result.balanceCents, status: result.status, totalSourcesCents: result.totalSourcesCents, totalUsesCents: result.totalUsesCents } : null,
      netWorth: {
        assetsPrevCents: result.assetsPrevCents,
        assetsCents: result.assetsCents,
        debtsPrevCents: result.debtsPrevCents,
        debtsCents: result.debtsCents,
        variationCents: result.netWorthVariationCents,
      },
      health: paid('health'),
      education: paid('education'),
      dependents: items.filter((i) => i.kind === 'dependent').map((d) => ({ id: d.id, name: d.ownerName ?? '', relationship: (d.extra?.relationship as string) ?? null })),
      assetsByGroup: Object.entries(ASSET_GROUPS)
        .map(([key, label]) => ({ key, label, cents: assetsBy.get(key) ?? 0 }))
        .filter((g) => g.cents > 0),
      backlogs: { open: bl.length, overdue: bl.filter((b) => b.dueDate && b.dueDate < today).length },
      darfs: {
        total: dfs.length,
        paid: dfs.filter(isPaid).length,
        overdue: dfs.filter((d) => !isPaid(d) && d.dueDate < today).length,
        open: dfs.filter((d) => !isPaid(d)).length,
        openCents: dfs.filter((d) => !isPaid(d)).reduce((a, d) => a + d.valueCents, 0),
      },
    };
  });
}
