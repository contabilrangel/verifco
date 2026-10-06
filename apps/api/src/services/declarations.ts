import { and, count, eq, isNull } from 'drizzle-orm';
import { STAGE_SUBSTATUS, declarationTotals, stageOfSubstatus, type DeclarationItem, type DeclarationSubstatus } from '@verifco/shared';
import type { Db } from '../db/client';
import { backlogs, customers, declarationItems, declarations } from '../db/schema';
import { notFound } from '../lib/errors';

export type DeclarationRow = typeof declarations.$inferSelect;

/** Busca o cliente garantindo que pertence ao escritório (e não foi excluído). */
export async function getCustomerOr404(db: Db, officeId: string, customerId: string) {
  const c = await db.query.customers.findFirst({
    where: and(eq(customers.id, customerId), eq(customers.officeId, officeId), isNull(customers.deletedAt)),
  });
  if (!c) throw notFound('Cliente');
  return c;
}

/** A declaração de um cliente num exercício é criada na primeira vez que alguém a usa. */
export async function getOrCreateDeclaration(db: Db, officeId: string, customerId: string, exerciseYear: number): Promise<DeclarationRow> {
  await getCustomerOr404(db, officeId, customerId);
  const existing = await db.query.declarations.findFirst({
    where: and(eq(declarations.customerId, customerId), eq(declarations.exerciseYear, exerciseYear)),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(declarations)
    .values({ officeId, customerId, exerciseYear })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  // corrida: outra requisição criou ao mesmo tempo
  const again = await db.query.declarations.findFirst({
    where: and(eq(declarations.customerId, customerId), eq(declarations.exerciseYear, exerciseYear)),
  });
  if (!again) throw new Error('Falha ao criar a declaração.');
  return again;
}

export async function getDeclarationOr404(db: Db, officeId: string, declarationId: string) {
  const d = await db.query.declarations.findFirst({ where: and(eq(declarations.id, declarationId), eq(declarations.officeId, officeId)) });
  if (!d) throw notFound('Declaração');
  return d;
}

/** Atualiza o subestado e a etapa do Kanban de forma consistente. */
export async function setDeclarationSubstatus(db: Db, declarationId: string, substatus: DeclarationSubstatus, extra: Partial<DeclarationRow> = {}) {
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

/**
 * Avança o status só se a declaração estiver num ponto anterior do fluxo.
 * Ex.: aprovar o orçamento move de "Não iniciado" para "Orçamento aprovado",
 * mas não puxa de volta uma declaração que já está em preenchimento.
 */
export async function advanceDeclaration(db: Db, decl: DeclarationRow, substatus: DeclarationSubstatus) {
  if (substatusRank(substatus) > substatusRank(decl.substatus as DeclarationSubstatus)) {
    return setDeclarationSubstatus(db, decl.id, substatus);
  }
  return decl;
}

/**
 * "Documentos faltantes" acompanha as pendências (backlogs) da declaração: com alguma em aberto e a
 * declaração em preenchimento, o subestado passa a "Documentos faltantes"; sem nenhuma em aberto,
 * volta para "Em elaboração". Vale para as pendências do escritório e as do checklist digital.
 */
export async function syncBacklogSubstatus(db: Db, declarationId: string) {
  const d = await db.query.declarations.findFirst({ where: eq(declarations.id, declarationId) });
  if (!d) return;
  const [{ open }] = await db
    .select({ open: count() })
    .from(backlogs)
    .where(and(eq(backlogs.declarationId, declarationId), isNull(backlogs.resolvedAt)));
  if (open > 0 && d.stage === 'filling' && d.substatus !== 'missing_documents') await setDeclarationSubstatus(db, d.id, 'missing_documents');
  if (open === 0 && d.substatus === 'missing_documents') await setDeclarationSubstatus(db, d.id, 'elaboration');
}

const STAGE_ORDER = ['not_started', 'negotiation', 'filling', 'transmitted', 'finished'] as const;
function substatusRank(s: DeclarationSubstatus) {
  const stage = stageOfSubstatus(s);
  return STAGE_ORDER.indexOf(stage) * 100 + STAGE_SUBSTATUS[stage].indexOf(s);
}

export async function listItems(db: Db, declarationId: string): Promise<DeclarationItem[]> {
  const rows = await db.select().from(declarationItems).where(eq(declarationItems.declarationId, declarationId));
  return rows.map((r) => ({ ...r, kind: r.kind as DeclarationItem['kind'] }));
}

/** Recalcula os totais gravados na declaração a partir das linhas. */
export async function recomputeTotals(db: Db, declarationId: string) {
  const items = await listItems(db, declarationId);
  const totals = declarationTotals(items);
  const [row] = await db.update(declarations).set({ ...totals, updatedAt: new Date() }).where(eq(declarations.id, declarationId)).returning();
  return row;
}
