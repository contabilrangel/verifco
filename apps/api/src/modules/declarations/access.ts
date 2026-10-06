import { and, eq } from 'drizzle-orm';
import type { AppContext, AuthUser } from '../../context';
import { declarations } from '../../db/schema';
import { HttpError, notFound } from '../../lib/errors';
import { getCustomerForUser, type CustomerRow } from '../../services/customers';
import type { DeclarationRow } from '../../services/declarations';

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

// Regras de status e da análise de caixa moram em services/declarations.ts (usadas por vários
// módulos); reexportadas aqui para quem já importava deste arquivo.
export { ECAC_TO_SUBSTATUS, SUBSTATUS_TO_ECAC, computeCashAnalysis, refreshDeclaration } from '../../services/declarations';
