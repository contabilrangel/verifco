import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  STAGE_SUBSTATUS,
  cashAnalysis,
  declarationTotals,
  stageOfSubstatus,
  type CashAnalysisResult,
  type DeclarationItem,
  type DeclarationSubstatus,
  type EcacDeclarationStatus,
} from '@verifco/shared';
import type { AuthUser } from '../context';
import type { DbOrTx } from '../db/client';
import { backlogs, checklistSections, checklists, customers, declarationItems, declarations } from '../db/schema';
import { forbidden, notFound } from '../lib/errors';
import { can } from '../lib/http';
import { getOfficeSettings } from './settings';
import { assertDeclarationQuota } from './plan';

export type DeclarationRow = typeof declarations.$inferSelect;

/** Situação eCAC → subestado da etapa "Transmitida". */
export const ECAC_TO_SUBSTATUS: Record<EcacDeclarationStatus, DeclarationSubstatus> = {
  unknown: 'ecac_unknown',
  waiting: 'ecac_waiting',
  processing: 'ecac_processing',
  fine_mesh: 'ecac_fine_mesh',
  pending_issues: 'ecac_fine_mesh',
  refund_lot: 'ecac_refund',
  processed: 'ecac_processed',
};

/** Subestado da etapa "Transmitida" → situação eCAC (mantém os dois coerentes). */
export const SUBSTATUS_TO_ECAC: Partial<Record<DeclarationSubstatus, EcacDeclarationStatus>> = {
  ecac_unknown: 'unknown',
  ecac_waiting: 'waiting',
  ecac_processing: 'processing',
  ecac_fine_mesh: 'fine_mesh',
  ecac_refund: 'refund_lot',
  ecac_processed: 'processed',
};

/** Busca o cliente garantindo que pertence ao escritório (e não foi excluído). */
export async function getCustomerOr404(db: DbOrTx, officeId: string, customerId: string) {
  const c = await db.query.customers.findFirst({
    where: and(eq(customers.id, customerId), eq(customers.officeId, officeId), isNull(customers.deletedAt)),
  });
  if (!c) throw notFound('Cliente');
  return c;
}

/**
 * A declaração de um cliente num exercício é criada na primeira vez que alguém a usa, dentro do
 * limite de declarações dos contratos vigentes (services/plan.ts).
 */
export async function getOrCreateDeclaration(db: DbOrTx, officeId: string, customerId: string, exerciseYear: number): Promise<DeclarationRow> {
  return db.transaction(async (tx) => {
    await getCustomerOr404(tx, officeId, customerId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`declaration-quota:${officeId}:${exerciseYear}`}, 0))`);
    const existing = await tx.query.declarations.findFirst({
      where: and(eq(declarations.customerId, customerId), eq(declarations.exerciseYear, exerciseYear)),
    });
    if (existing) return existing;
    await assertDeclarationQuota(tx, officeId, exerciseYear);
    const [row] = await tx
      .insert(declarations)
      .values({ officeId, customerId, exerciseYear })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    // corrida: outra requisição criou ao mesmo tempo
    const again = await tx.query.declarations.findFirst({
      where: and(eq(declarations.customerId, customerId), eq(declarations.exerciseYear, exerciseYear)),
    });
    if (!again) throw new Error('Falha ao criar a declaração.');
    return again;
  });
}

/**
 * Versão em lote de `getOrCreateDeclaration` para clientes já conferidos (escritório e escopo do
 * usuário): cria de uma vez as declarações que faltam no exercício e devolve todas.
 */
export async function getOrCreateDeclarations(db: DbOrTx, officeId: string, customerIds: string[], exerciseYear: number): Promise<DeclarationRow[]> {
  if (!customerIds.length) return [];
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`declaration-quota:${officeId}:${exerciseYear}`}, 0))`);
    const existing = await tx.select({ customerId: declarations.customerId }).from(declarations)
      .where(and(eq(declarations.officeId, officeId), eq(declarations.exerciseYear, exerciseYear), inArray(declarations.customerId, customerIds)));
    const present = new Set(existing.map((d) => d.customerId));
    const missing = [...new Set(customerIds)].filter((id) => !present.has(id));
    if (missing.length) {
      await assertDeclarationQuota(tx, officeId, exerciseYear, missing.length);
      await tx.insert(declarations).values(missing.map((customerId) => ({ officeId, customerId, exerciseYear }))).onConflictDoNothing();
    }
    return tx.select().from(declarations)
      .where(and(eq(declarations.officeId, officeId), eq(declarations.exerciseYear, exerciseYear), inArray(declarations.customerId, customerIds)));
  });
}

export async function getDeclarationOr404(db: DbOrTx, officeId: string, declarationId: string) {
  const d = await db.query.declarations.findFirst({ where: and(eq(declarations.id, declarationId), eq(declarations.officeId, officeId)) });
  if (!d) throw notFound('Declaração');
  return d;
}

/** Atualiza o subestado e a etapa do Kanban de forma consistente. */
export async function setDeclarationSubstatus(db: DbOrTx, declarationId: string, substatus: DeclarationSubstatus, extra: Partial<DeclarationRow> = {}) {
  const stage = stageOfSubstatus(substatus);
  const [row] = await db
    .update(declarations)
    .set({
      ...extra,
      substatus,
      stage,
      finishedAt: stage === 'finished' ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(declarations.id, declarationId))
    .returning();
  return row;
}

/** Finalizar uma declaração exige a permissão própria (os demais subestados, a de edição). */
export function assertCanSetSubstatus(user: AuthUser, substatus: DeclarationSubstatus) {
  if (substatus === 'finished' && !can(user, 'declaration.finish')) throw forbidden('Você não tem permissão para finalizar declarações.');
}

/**
 * Muda o subestado (Kanban) de uma ou mais declarações. É a regra única da troca manual de status,
 * usada pela declaração (PATCH) e pela ação em massa da lista de clientes:
 * - finalizar exige `declaration.finish`, conferida antes de gravar qualquer uma (um lote nunca
 *   fica finalizado pela metade);
 * - os subestados da etapa "Transmitida" levam junto a situação eCAC correspondente.
 * Devolve cada declaração alterada com a linha anterior (`before`), para a auditoria de/para.
 */
export async function changeSubstatus(db: DbOrTx, user: AuthUser, decls: DeclarationRow[], substatus: DeclarationSubstatus) {
  assertCanSetSubstatus(user, substatus);
  if (!decls.length) return [];
  const stage = stageOfSubstatus(substatus);
  const ecacStatus = SUBSTATUS_TO_ECAC[substatus];
  // os mesmos campos de `setDeclarationSubstatus`, gravados de uma vez para todas
  const rows = await db
    .update(declarations)
    .set({ substatus, stage, finishedAt: stage === 'finished' ? new Date() : null, updatedAt: new Date(), ...(ecacStatus ? { ecacStatus } : {}) })
    .where(inArray(declarations.id, decls.map((d) => d.id)))
    .returning();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return decls.flatMap((before) => {
    const row = byId.get(before.id);
    return row ? [{ before, row }] : [];
  });
}

/**
 * Avança o status só se a declaração estiver num ponto anterior do fluxo.
 * Ex.: aprovar o orçamento move de "Não iniciado" para "Orçamento aprovado",
 * mas não puxa de volta uma declaração que já está em preenchimento.
 */
export async function advanceDeclaration(db: DbOrTx, decl: DeclarationRow, substatus: DeclarationSubstatus) {
  if (substatusRank(substatus) > substatusRank(decl.substatus as DeclarationSubstatus)) {
    return setDeclarationSubstatus(db, decl.id, substatus);
  }
  return decl;
}

const STAGE_ORDER = ['not_started', 'negotiation', 'filling', 'transmitted', 'finished'] as const;
function substatusRank(s: DeclarationSubstatus) {
  const stage = stageOfSubstatus(s);
  return STAGE_ORDER.indexOf(stage) * 100 + STAGE_SUBSTATUS[stage].indexOf(s);
}

/**
 * Etapa da declaração depois de gravar a transmissão ou a situação eCAC (`before` é a linha
 * anterior; `after`, a gravada). Regra única do resumo da declaração (PUT), dos registros do
 * eCAC (manual, extensão, sincronizador, SERPRO) e do recibo (.REC) do sincronizador:
 * - com a transmissão informada (data ou número do recibo), a declaração ainda em "Não iniciado",
 *   "Negociação" ou "Em preenchimento" vai para o subestado da situação eCAC em "Transmitida";
 * - numa declaração já transmitida, mudar a situação eCAC atualiza o subestado.
 */
export async function syncDeclarationStage(db: DbOrTx, before: Pick<DeclarationRow, 'ecacStatus'>, after: DeclarationRow): Promise<DeclarationRow> {
  const ecacSubstatus = ECAC_TO_SUBSTATUS[after.ecacStatus as EcacDeclarationStatus] ?? 'ecac_unknown';
  const stage = stageOfSubstatus(after.substatus as DeclarationSubstatus);
  if ((after.transmittedAt || after.receiptNumber) && (stage === 'not_started' || stage === 'negotiation' || stage === 'filling')) {
    return advanceDeclaration(db, after, ecacSubstatus);
  }
  if (after.ecacStatus !== before.ecacStatus && stage === 'transmitted') return setDeclarationSubstatus(db, after.id, ecacSubstatus);
  return after;
}

/**
 * "Documentos faltantes" acompanha o que falta da declaração: pendências em aberto e seções do
 * checklist que o cliente finalizou "com documentos pendentes".
 * - Com algo faltando, a declaração em preenchimento passa para "Documentos faltantes".
 * - Sem nada faltando, a que estava em "Documentos faltantes" volta para "Em elaboração".
 * Chamada ao criar, baixar, reabrir ou excluir pendência, ao finalizar ou reabrir seção do checklist
 * e ao excluir o checklist.
 */
export async function syncSubstatus(db: DbOrTx, declarationId: string) {
  const d = await db.query.declarations.findFirst({ where: eq(declarations.id, declarationId) });
  if (!d) return;
  const [{ open }] = await db
    .select({ open: sql<number>`count(*)`.mapWith(Number) })
    .from(backlogs)
    .where(and(eq(backlogs.declarationId, declarationId), isNull(backlogs.resolvedAt)));
  const [{ sections }] = await db
    .select({ sections: sql<number>`count(*)`.mapWith(Number) })
    .from(checklistSections)
    .innerJoin(checklists, eq(checklists.id, checklistSections.checklistId))
    .where(and(eq(checklists.declarationId, declarationId), eq(checklistSections.status, 'pending_documents')));
  const missing = open + sections;
  if (missing > 0 && d.stage === 'filling' && d.substatus !== 'missing_documents') await setDeclarationSubstatus(db, d.id, 'missing_documents');
  if (missing === 0 && d.substatus === 'missing_documents') await setDeclarationSubstatus(db, d.id, 'elaboration');
}

export async function listItems(db: DbOrTx, declarationId: string): Promise<DeclarationItem[]> {
  const rows = await db.select().from(declarationItems).where(eq(declarationItems.declarationId, declarationId));
  return rows.map((r) => ({ ...r, kind: r.kind as DeclarationItem['kind'] }));
}

/** Recalcula os totais gravados na declaração a partir das linhas. */
export async function recomputeTotals(db: DbOrTx, declarationId: string) {
  const items = await listItems(db, declarationId);
  const totals = declarationTotals(items);
  const [row] = await db.update(declarations).set({ ...totals, updatedAt: new Date() }).where(eq(declarations.id, declarationId)).returning();
  return row;
}

/** Roda a análise de caixa da declaração com as preferências do escritório (`ctx.db` pode ser uma transação). */
export async function computeCashAnalysis(ctx: { db: DbOrTx }, declaration: DeclarationRow): Promise<{ result: CashAnalysisResult; itemCount: number }> {
  const items = await listItems(ctx.db, declaration.id);
  const settings = await getOfficeSettings(ctx.db, declaration.officeId);
  const result = cashAnalysis({
    exerciseYear: declaration.exerciseYear,
    taxation: declaration.taxation === 'complete' || declaration.taxation === 'simplified' ? declaration.taxation : null,
    items,
    otherExpenses: declaration.otherExpenses ?? {},
    simplifiedDiscountMode: settings.cashAnalysisSimplifiedDiscount,
  });
  return { result, itemCount: items.length };
}

/**
 * Depois de mudar linhas, outros gastos ou o resumo: recalcula os totais e grava o saldo de caixa
 * (usado nos alertas do dashboard). Sem linhas, o saldo fica vazio.
 */
export async function refreshDeclaration(ctx: { db: DbOrTx }, declarationId: string): Promise<DeclarationRow> {
  const row = await recomputeTotals(ctx.db, declarationId);
  const { result, itemCount } = await computeCashAnalysis(ctx, row);
  const cashBalanceCents = itemCount ? result.balanceCents : null;
  const [updated] = await ctx.db.update(declarations).set({ cashBalanceCents }).where(eq(declarations.id, declarationId)).returning();
  return updated;
}
