import { and, asc, count, eq, exists, ilike, inArray, isNotNull, isNull, notExists, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DECLARATION_STAGES, KANBAN_PERMISSIONS, currentExerciseYear, onlyDigits, type DeclarationStage } from '@verifco/shared';
import { backlogs, customerGroupMembers, customerGroups, customers, declarations, users } from '../../db/schema';
import { guard, parse, requireUser, yearSchema } from '../../lib/http';
import { customerScope } from '../../services/customers';

const STAGES = Object.keys(DECLARATION_STAGES) as DeclarationStage[];

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

const kanbanQuery = z.object({
  year: yearSchema.optional(),
  search: z.string().trim().max(200).optional(),
  /** Ids de grupos; `none` = clientes sem grupo. */
  groups: csv,
  /** Cartões por coluna (carteiras grandes carregam aos poucos). */
  stageLimit: z.coerce.number().int().min(1).max(500).default(50),
  /** Com `stage`, devolve só aquela coluna a partir de `offset` ("carregar mais"). */
  stage: z.enum(STAGES as [DeclarationStage, ...DeclarationStage[]]).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface KanbanCard {
  customerId: string;
  name: string;
  cpfCnpj: string;
  email: string | null;
  responsibleName: string | null;
  groups: { id: string; name: string }[];
  declarationId: string | null;
  stage: string;
  substatus: string;
  ecacStatus: string | null;
  taxDueCents: number;
  refundCents: number;
  openBacklogs: number;
  updatedAt: string | null;
}

/**
 * Kanban das declarações do exercício. Clientes sem declaração no ano entram em
 * "Não iniciado". Clientes inativos só aparecem se já tiverem declaração no ano.
 */
export async function kanbanRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.get('/kanban', { preHandler: guard(...KANBAN_PERMISSIONS) }, async (req) => {
    const user = requireUser(req);
    const q = parse(kanbanQuery, req.query);
    const year = q.year ?? currentExerciseYear();
    const joinOn = and(eq(declarations.customerId, customers.id), eq(declarations.exerciseYear, year));
    const stageExpr = sql<string>`coalesce(${declarations.stage}, 'not_started')`;

    const conds: SQL[] = [await customerScope(app.ctx, user), or(eq(customers.status, 'active'), isNotNull(declarations.id))!];
    if (q.search) {
      const term = `%${q.search}%`;
      const digits = onlyDigits(q.search);
      const any = [ilike(customers.name, term), ilike(customers.email, term)];
      if (digits.length >= 3) any.push(ilike(customers.cpfCnpj, `%${digits}%`));
      conds.push(or(...any)!);
    }
    if (q.groups.length) {
      const ids = q.groups.filter((g) => g !== 'none' && z.uuid().safeParse(g).success);
      const options: SQL[] = [];
      if (ids.length) {
        options.push(exists(db.select().from(customerGroupMembers).where(and(eq(customerGroupMembers.customerId, customers.id), inArray(customerGroupMembers.groupId, ids)))));
      }
      if (q.groups.includes('none')) options.push(notExists(db.select().from(customerGroupMembers).where(eq(customerGroupMembers.customerId, customers.id))));
      conds.push(options.length ? or(...options)! : sql`false`);
    }
    const where = and(...conds)!;

    const totals = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<DeclarationStage, number>;
    const counted = await db
      .select({ stage: stageExpr, n: count() })
      .from(customers)
      .leftJoin(declarations, joinOn)
      .where(where)
      .groupBy(stageExpr);
    for (const r of counted) if (r.stage in totals) totals[r.stage as DeclarationStage] = r.n;

    const loadStage = async (stage: DeclarationStage, offset: number) => {
      const rows = await db
        .select({
          customerId: customers.id,
          name: customers.name,
          cpfCnpj: customers.cpfCnpj,
          email: customers.email,
          responsibleName: users.name,
          declarationId: declarations.id,
          stage: stageExpr,
          substatus: sql<string>`coalesce(${declarations.substatus}, 'not_started')`,
          ecacStatus: declarations.ecacStatus,
          taxDueCents: declarations.taxDueCents,
          refundCents: declarations.refundCents,
          updatedAt: declarations.updatedAt,
        })
        .from(customers)
        .leftJoin(declarations, joinOn)
        .leftJoin(users, eq(users.id, customers.responsibleUserId))
        .where(and(where, sql`${stageExpr} = ${stage}`))
        .orderBy(asc(customers.name), asc(customers.id))
        .limit(q.stageLimit)
        .offset(offset);
      return rows;
    };

    const stagesToLoad = q.stage ? [q.stage] : STAGES;
    const loaded = await Promise.all(stagesToLoad.map(async (s) => [s, await loadStage(s, q.stage ? q.offset : 0)] as const));

    const customerIds = loaded.flatMap(([, rows]) => rows.map((r) => r.customerId));
    const declarationIds = loaded.flatMap(([, rows]) => rows.map((r) => r.declarationId).filter((x): x is string => Boolean(x)));
    const groupsBy = new Map<string, { id: string; name: string }[]>();
    if (customerIds.length) {
      const gm = await db
        .select({ customerId: customerGroupMembers.customerId, id: customerGroups.id, name: customerGroups.name })
        .from(customerGroupMembers)
        .innerJoin(customerGroups, eq(customerGroups.id, customerGroupMembers.groupId))
        .where(inArray(customerGroupMembers.customerId, customerIds))
        .orderBy(asc(customerGroups.name));
      for (const g of gm) groupsBy.set(g.customerId, [...(groupsBy.get(g.customerId) ?? []), { id: g.id, name: g.name }]);
    }
    const backlogsBy = new Map<string, number>();
    if (declarationIds.length) {
      const open = await db
        .select({ declarationId: backlogs.declarationId, n: count() })
        .from(backlogs)
        .where(and(inArray(backlogs.declarationId, declarationIds), isNull(backlogs.resolvedAt)))
        .groupBy(backlogs.declarationId);
      for (const o of open) backlogsBy.set(o.declarationId, o.n);
    }

    const columns = loaded.map(([stage, rows]) => ({
      stage,
      label: DECLARATION_STAGES[stage],
      total: totals[stage],
      offset: q.stage ? q.offset : 0,
      cards: rows.map(
        (r): KanbanCard => ({
          ...r,
          groups: groupsBy.get(r.customerId) ?? [],
          taxDueCents: r.taxDueCents ?? 0,
          refundCents: r.refundCents ?? 0,
          openBacklogs: r.declarationId ? (backlogsBy.get(r.declarationId) ?? 0) : 0,
          updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
        }),
      ),
    }));
    return { year, stageLimit: q.stageLimit, total: Object.values(totals).reduce((a, n) => a + n, 0), columns };
  });
}
