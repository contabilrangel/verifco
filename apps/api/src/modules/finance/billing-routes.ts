/** Cobrança integrada (Asaas/Omie) do faturamento: situação da emissão e "Emitir novamente". */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext, AuthUser } from '../../context';
import { billings, installments } from '../../db/schema';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { billingSyncStates, requestBillingSync, type BillingSyncState } from '../integrations/jobs';
import type { SerializedBudget } from './service';

/** Faturamento do escritório cujo cliente o usuário pode ver; 404 caso contrário. */
async function getBillingForUser(ctx: AppContext, user: AuthUser, id: string) {
  const billing = await ctx.db.query.billings.findFirst({ where: and(eq(billings.id, id), eq(billings.officeId, user.officeId)) });
  if (!billing) throw notFound('Faturamento');
  try {
    await getCustomerForUser(ctx, user, billing.customerId);
  } catch {
    throw notFound('Faturamento');
  }
  return billing;
}

/** Acrescenta aos faturamentos integrados a situação da emissão no provedor (`billing.externalSync`). */
export async function withExternalSync(ctx: AppContext, officeId: string, list: SerializedBudget[]) {
  const states = await billingSyncStates(ctx, officeId, list.flatMap((b) => (b.billing ? [b.billing] : [])));
  return list.map((b) => (b.billing ? { ...b, billing: { ...b.billing, externalSync: states.get(b.billing.id) ?? null } } : b));
}

/**
 * Cobrança integrada não emitida: há parcela em aberto sem boleto/Pix no provedor e nenhuma emissão
 * em andamento ou com nova tentativa agendada (a fila desistiu, nunca foi pedida ou terminou sem
 * emitir tudo). É o caso em que alguém precisa agir ("Emitir novamente" no orçamento do cliente).
 */
export function externalSyncFailed(
  billing: { provider: string | null; installments: { status: string; externalId: string | null }[] } | null,
  sync: BillingSyncState | null | undefined,
) {
  if (!billing?.provider || !sync) return false;
  if (sync.status === 'running' || sync.status === 'queued') return false;
  return billing.installments.some((i) => (i.status === 'open' || i.status === 'overdue') && !i.externalId);
}

export async function billingRoutes(app: FastifyInstance) {
  const { ctx } = app;

  /** Emite de novo no Asaas/Omie as parcelas em aberto ainda sem boleto/Pix (as já emitidas não se repetem). */
  app.post('/finance/billings/:id/sync', { preHandler: guard('billing.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const billing = await getBillingForUser(ctx, user, id);
    if (!billing.provider) throw badRequest('Este faturamento não tem cobrança integrada (Asaas ou Omie).');
    const pending = await ctx.db.query.installments.findFirst({
      where: and(eq(installments.billingId, billing.id), isNull(installments.externalId), inArray(installments.status, ['open', 'overdue'])),
    });
    if (!pending) throw conflict('Todas as parcelas em aberto já têm cobrança emitida.');
    await requestBillingSync(ctx, [billing], user.userId);
    await audit(req, 'billing_sync', 'billing', billing.id, { provider: billing.provider });
    return { externalSync: (await billingSyncStates(ctx, user.officeId, [billing])).get(billing.id) ?? null };
  });
}
