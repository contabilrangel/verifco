import { and, eq } from 'drizzle-orm';
import { cashAnalysis, type CashAnalysisResult, type DeclarationSubstatus, type EcacDeclarationStatus } from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { declarations } from '../../db/schema';
import { HttpError, notFound } from '../../lib/errors';
import { getCustomerForUser, type CustomerRow } from '../../services/customers';
import { listItems, recomputeTotals, type DeclarationRow } from '../../services/declarations';
import { getOfficeSettings } from '../../services/settings';

/**
 * Carrega a declaração pelo id garantindo escritório e visibilidade do cliente
 * (a restrição "contadores veem só seus clientes" vale aqui também).
 */
export async function getDeclarationForUser(ctx: AppContext, user: AuthUser, declarationId: string): Promise<{ declaration: DeclarationRow; customer: CustomerRow }> {
  const declaration = await ctx.db.query.declarations.findFirst({
    where: and(eq(declarations.id, declarationId), eq(declarations.officeId, user.officeId)),
  });
  if (!declaration) throw notFound('Declaração');
  const customer = await getCustomerForUser(ctx, user, declaration.customerId).catch((err) => {
    throw err instanceof HttpError && err.statusCode === 404 ? notFound('Declaração') : err;
  });
  return { declaration, customer };
}

/** Declaração ainda não criada: devolvida pelo GET sem gravar nada. */
export function emptyDeclaration(customerId: string, exerciseYear: number) {
  return {
    id: null,
    exists: false,
    customerId,
    exerciseYear,
    stage: 'not_started',
    substatus: 'not_started',
    ecacStatus: 'unknown',
    taxation: null,
    isRectification: false,
    receiptNumber: null,
    transmittedAt: null,
    taxDueCents: 0,
    refundCents: 0,
    refundLotDate: null,
    refundPaidAt: null,
    totalIncomeCents: 0,
    taxableIncomeCents: 0,
    exemptIncomeCents: 0,
    exclusiveIncomeCents: 0,
    deductionsCents: 0,
    withheldTaxCents: 0,
    assetsTotalCents: 0,
    assetsPrevTotalCents: 0,
    debtsTotalCents: 0,
    debtsPrevTotalCents: 0,
    cashBalanceCents: null,
    otherExpenses: {},
    finishedAt: null,
  };
}

export const presentDeclaration = (d: DeclarationRow) => ({ ...d, exists: true });

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

/** Roda a análise de caixa da declaração com as preferências do escritório. */
export async function computeCashAnalysis(ctx: AppContext, declaration: DeclarationRow): Promise<{ result: CashAnalysisResult; itemCount: number }> {
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
 * Depois de mudar linhas ou o resumo: recalcula os totais e grava o saldo de caixa
 * (usado nos alertas do dashboard). Sem linhas, o saldo fica vazio.
 */
export async function refreshDeclaration(ctx: AppContext, declarationId: string): Promise<DeclarationRow> {
  const row = await recomputeTotals(ctx.db, declarationId);
  const { result, itemCount } = await computeCashAnalysis(ctx, row);
  const cashBalanceCents = itemCount ? result.balanceCents : null;
  const [updated] = await ctx.db.update(declarations).set({ cashBalanceCents }).where(eq(declarations.id, declarationId)).returning();
  return updated;
}
