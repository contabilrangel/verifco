/**
 * Job `billing.sync_external` (contrato com o módulo financeiro).
 *
 * Payload: `{ billingId }`. Lê `billings.provider` (`asaas` ou `omie`), o cliente e as parcelas,
 * cria as cobranças no provedor e grava `installments.externalId` / `externalUrl`.
 * Pode ser reexecutado: só trata parcelas em aberto ainda sem `externalId`, e cada provedor
 * usa o id da parcela como referência externa para não duplicar lançamentos.
 */
import { asc, eq } from 'drizzle-orm';
import { BUDGET_CATEGORIES } from '@verifco/shared';
import type { AppContext } from '../context';
import { billings, budgets, customers, installments, offices } from '../db/schema';
import { createAsaasCharges, type AsaasConfig, type AsaasSecrets } from './asaas';
import { IntegrationError } from './http';
import { createOmieReceivables, type OmieConfig, type OmieSecrets } from './omie';
import { requireIntegration } from './store';

export const BILLING_SYNC_JOB = 'billing.sync_external';

/** "Declaração IRPF 2026 – Escritório X" */
export function chargeDescription(budget: { category: string; exerciseYear: number } | null | undefined, officeName?: string | null) {
  const cat = budget ? ((BUDGET_CATEGORIES as Record<string, string>)[budget.category] ?? 'Honorários') : 'Honorários';
  const base = budget ? `${cat} ${budget.exerciseYear}` : cat;
  return officeName ? `${base} – ${officeName}` : base;
}

export async function syncBillingExternal(
  ctx: AppContext,
  billingId: string,
  opts: { officeId?: string | null; progress?: (pct: number) => Promise<void> } = {},
) {
  const { db } = ctx;
  const billing = await db.query.billings.findFirst({ where: eq(billings.id, billingId) });
  if (!billing || (opts.officeId && billing.officeId !== opts.officeId)) throw new Error('Faturamento não encontrado.');
  const provider = billing.provider;
  if (provider !== 'asaas' && provider !== 'omie') return { skipped: true, reason: 'Faturamento sem cobrança integrada.' };

  const customer = await db.query.customers.findFirst({ where: eq(customers.id, billing.customerId) });
  if (!customer) throw new Error('Cliente do faturamento não encontrado.');
  const all = await db.query.installments.findMany({ where: eq(installments.billingId, billing.id), orderBy: asc(installments.number) });
  const pending = all.filter((i) => !i.externalId && (i.status === 'open' || i.status === 'overdue'));
  if (!pending.length) return { provider, created: 0, message: 'Nenhuma parcela pendente de envio.' };

  const budget = await db.query.budgets.findFirst({ where: eq(budgets.id, billing.budgetId) });
  const office = await db.query.offices.findFirst({ where: eq(offices.id, billing.officeId) });
  const input = { customer, pending, totalInstallments: all.length, description: chargeDescription(budget, office?.name), progress: opts.progress };

  if (provider === 'asaas') {
    if (!customer.cpfCnpj) throw new IntegrationError('asaas', 'O cliente não tem CPF/CNPJ cadastrado.');
    const loaded = await requireIntegration<AsaasConfig, AsaasSecrets>(ctx, billing.officeId, 'asaas');
    return createAsaasCharges(ctx, loaded, input);
  }
  const loaded = await requireIntegration<OmieConfig, OmieSecrets>(ctx, billing.officeId, 'omie');
  return createOmieReceivables(ctx, loaded, input);
}
