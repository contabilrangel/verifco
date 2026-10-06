import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  STAGE_SUBSTATUS,
  cashAnalysis,
  declarationTotals,
  stageOfSubstatus,
  type CashAnalysisResult,
  type DeclarationItem,
  type DeclarationStage,
  type DeclarationSubstatus,
  type EcacDeclarationStatus,
} from '@verifco/shared';
import type { AppContext, AuthUser } from '../context';
import type { Db } from '../db/client';
import { customers, declarationItems, declarations, type OfficeSettings } from '../db/schema';
import { forbidden, notFound } from '../lib/errors';
import { can } from '../lib/http';
import { getOfficeSettings } from './settings';

export type DeclarationRow = typeof declarations.$inferSelect;

/** Transação do Drizzle (mesmos métodos de consulta do `Db`). */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Banco ou transação em andamento: as funções que gravam linhas e totais aceitam os dois. */
export type DbExecutor = Db | DbTx;

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

// ---------------------------------------------------------------------------
// Status da declaração (Kanban) × situação no eCAC
// ---------------------------------------------------------------------------

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

/** Etapas anteriores à transmissão: a chegada do recibo/situação eCAC leva para "Transmitida". */
const BEFORE_TRANSMISSION: DeclarationStage[] = ['not_started', 'negotiation', 'filling'];

const ecacSubstatusOf = (ecacStatus: string | null | undefined): DeclarationSubstatus =>
  ECAC_TO_SUBSTATUS[(ecacStatus ?? 'unknown') as EcacDeclarationStatus] ?? 'ecac_unknown';

/**
 * Grava subestado e etapa de forma consistente (escritor de baixo nível; prefira
 * `changeDeclarationStatus`). Mantém a situação eCAC coerente com o subestado da etapa
 * "Transmitida" (ex.: mover para "Malha fina" grava a situação `fine_mesh`, mas preserva
 * `pending_issues`, que também cai em "Malha fina") e preserva a data de finalização de quem
 * já estava finalizado.
 */
export async function setDeclarationSubstatus(
  db: DbExecutor,
  declarationId: string,
  substatus: DeclarationSubstatus,
  extra: Partial<DeclarationRow> = {},
): Promise<DeclarationRow> {
  const stage = stageOfSubstatus(substatus);
  const ecac = SUBSTATUS_TO_ECAC[substatus];
  // situações eCAC que já correspondem ao subestado pedido ficam como estão
  const compatible = (Object.entries(ECAC_TO_SUBSTATUS) as [EcacDeclarationStatus, DeclarationSubstatus][]).filter(([, s]) => s === substatus).map(([k]) => k);
  const [row] = await db
    .update(declarations)
    .set({
      ...(ecac && extra.ecacStatus === undefined
        ? { ecacStatus: sql`case when ${declarations.ecacStatus} in (${sql.join(compatible.map((k) => sql`${k}`), sql`, `)}) then ${declarations.ecacStatus} else ${ecac} end` }
        : {}),
      ...extra,
      substatus,
      stage,
      finishedAt: stage === 'finished' ? sql`coalesce(${declarations.finishedAt}, now())` : null,
      updatedAt: new Date(),
    })
    .where(eq(declarations.id, declarationId))
    .returning();
  if (!row) throw notFound('Declaração');
  return row;
}

/** Quem muda o status: um usuário (regras de permissão) ou o próprio sistema (regras automáticas). */
export type StatusActor = AuthUser | 'system';

/**
 * Porta única para mudar o status de uma declaração, usada pelo Kanban/tela (PATCH), pela ação
 * em massa dos clientes e pelos demais módulos (orçamento, eCAC, sincronizador):
 * - finalizar exige a permissão `declaration.finish` quando quem pede é um usuário;
 * - `onlyForward`: só avança no fluxo (orçamento aprovado não puxa de volta quem já está em
 *   preenchimento) e nunca mexe numa declaração finalizada;
 * - a situação eCAC acompanha o subestado da etapa "Transmitida" (`setDeclarationSubstatus`).
 * Devolve a linha atualizada (ou a mesma, quando nada muda).
 */
export async function changeDeclarationStatus(
  db: DbExecutor,
  decl: DeclarationRow,
  substatus: DeclarationSubstatus,
  opts: { by: StatusActor; onlyForward?: boolean; extra?: Partial<DeclarationRow> },
): Promise<DeclarationRow> {
  assertCanSetSubstatus(opts.by, substatus);
  if (opts.onlyForward && (decl.stage === 'finished' || substatusRank(substatus) <= substatusRank(decl.substatus as DeclarationSubstatus))) return decl;
  if (decl.substatus === substatus && !opts.extra) return decl;
  return setDeclarationSubstatus(db, decl.id, substatus, opts.extra);
}

/** Finalizar exige `declaration.finish` (vale para a tela, o Kanban e a ação em massa). */
export function assertCanSetSubstatus(by: StatusActor, substatus: DeclarationSubstatus) {
  if (by !== 'system' && substatus === 'finished' && !can(by, 'declaration.finish')) {
    throw forbidden('Você não tem permissão para finalizar declarações.');
  }
}

/**
 * Avança o status só se a declaração estiver num ponto anterior do fluxo.
 * Ex.: aprovar o orçamento move de "Não iniciado" para "Orçamento aprovado",
 * mas não puxa de volta uma declaração que já está em preenchimento.
 */
export async function advanceDeclaration(db: DbExecutor, decl: DeclarationRow, substatus: DeclarationSubstatus) {
  return changeDeclarationStatus(db, decl, substatus, { by: 'system', onlyForward: true });
}

/**
 * Aplica ao status a situação eCAC e os dados de transmissão já gravados em `after`
 * (resumo da declaração, registros do eCAC vindos da tela, da extensão ou do SERPRO, e o
 * recibo .REC do sincronizador):
 * - com prova de transmissão (data, recibo ou `transmitted`), uma declaração antes de
 *   "Transmitida" avança para o subestado da situação eCAC;
 * - numa declaração já "Transmitida", mudar a situação eCAC atualiza o subestado;
 * - declaração finalizada não regride.
 */
export async function syncStatusWithEcac(
  db: DbExecutor,
  before: Pick<DeclarationRow, 'ecacStatus'> | null,
  after: DeclarationRow,
  opts: { transmitted?: boolean } = {},
): Promise<DeclarationRow> {
  const target = ecacSubstatusOf(after.ecacStatus);
  const stage = stageOfSubstatus(after.substatus as DeclarationSubstatus);
  const transmitted = Boolean(after.transmittedAt || after.receiptNumber || opts.transmitted);
  if (transmitted && BEFORE_TRANSMISSION.includes(stage)) {
    return changeDeclarationStatus(db, after, target, { by: 'system', onlyForward: true });
  }
  if (stage === 'transmitted' && before && before.ecacStatus !== after.ecacStatus && after.substatus !== target) {
    return changeDeclarationStatus(db, after, target, { by: 'system' });
  }
  return after;
}

const STAGE_ORDER = ['not_started', 'negotiation', 'filling', 'transmitted', 'finished'] as const;
function substatusRank(s: DeclarationSubstatus) {
  const stage = stageOfSubstatus(s);
  return STAGE_ORDER.indexOf(stage) * 100 + STAGE_SUBSTATUS[stage].indexOf(s);
}

// ---------------------------------------------------------------------------
// Linhas, totais e análise de caixa
// ---------------------------------------------------------------------------

export async function listItems(db: DbExecutor, declarationId: string): Promise<DeclarationItem[]> {
  const rows = await db.select().from(declarationItems).where(eq(declarationItems.declarationId, declarationId));
  return rows.map((r) => ({ ...r, kind: r.kind as DeclarationItem['kind'] }));
}

/** Recalcula os totais gravados na declaração a partir das linhas. */
export async function recomputeTotals(db: DbExecutor, declarationId: string) {
  const items = await listItems(db, declarationId);
  const totals = declarationTotals(items);
  const [row] = await db.update(declarations).set({ ...totals, updatedAt: new Date() }).where(eq(declarations.id, declarationId)).returning();
  return row;
}

/**
 * Opções para rodar dentro de uma transação: `db` é a transação e `settings` as preferências já
 * carregadas (dentro da transação do PGlite, uma consulta por `ctx.db` esperaria a transação acabar).
 */
export interface ExecutorOptions {
  db?: DbExecutor;
  settings?: Required<OfficeSettings>;
}

/** Roda a análise de caixa da declaração com as preferências do escritório. */
export async function computeCashAnalysis(
  ctx: AppContext,
  declaration: DeclarationRow,
  opts: ExecutorOptions = {},
): Promise<{ result: CashAnalysisResult; itemCount: number }> {
  const items = await listItems(opts.db ?? ctx.db, declaration.id);
  const settings = opts.settings ?? (await getOfficeSettings(ctx.db, declaration.officeId));
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
 * Depois de mudar linhas, o resumo ou os "outros gastos": recalcula os totais e grava o saldo de
 * caixa (usado no alerta "Saldo de caixa negativo" do dashboard). Sem linhas, o saldo fica vazio.
 * Todo módulo que mexe em `declaration_items` ou em `otherExpenses` chama esta função.
 */
export async function refreshDeclaration(ctx: AppContext, declarationId: string, opts: ExecutorOptions = {}): Promise<DeclarationRow> {
  const db = opts.db ?? ctx.db;
  const row = await recomputeTotals(db, declarationId);
  const { result, itemCount } = await computeCashAnalysis(ctx, row, opts);
  const cashBalanceCents = itemCount ? result.balanceCents : null;
  const [updated] = await db.update(declarations).set({ cashBalanceCents }).where(eq(declarations.id, declarationId)).returning();
  return updated;
}

