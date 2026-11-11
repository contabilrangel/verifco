/**
 * Job `billing.sync_external` (contrato com o módulo financeiro).
 *
 * Payload: `{ billingId }`. Lê `billings.provider` (`asaas` ou `omie`), o cliente e as parcelas,
 * cria as cobranças no provedor e grava `installments.externalId` / `externalUrl`.
 * Pode ser reexecutado: só trata parcelas em aberto ainda sem `externalId`, e cada provedor
 * usa o id da parcela como referência externa para não duplicar lançamentos.
 *
 * Emitida a cobrança, o link de pagamento da primeira parcela em aberto vai ao cliente por e-mail
 * (template `charge`), uma vez só, quando a preferência `chargeLinkAutoSend` está ligada e o Asaas
 * não está configurado para avisar o cliente por conta própria.
 */
import { asc, count, eq } from 'drizzle-orm';
import { BUDGET_CATEGORIES, formatDate, formatMoney, type DeliveryChannel } from '@verifco/shared';
import type { AppContext } from '../context';
import { billings, budgets, customers, installments, offices } from '../db/schema';
import { queueDelivery } from '../services/delivery';
import { getOfficeSettings } from '../services/settings';
import { createAsaasCharges, type AsaasConfig, type AsaasSecrets } from './asaas';
import { IntegrationError } from './http';
import { createOmieReceivables, type OmieConfig, type OmieSecrets } from './omie';
import { loadIntegration, requireIntegration } from './store';

export const BILLING_SYNC_JOB = 'billing.sync_external';

type BillingRow = typeof billings.$inferSelect;
type BudgetRow = typeof budgets.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;
type InstallmentRow = typeof installments.$inferSelect;

/** Parcela que o cliente ainda pode pagar pelo link do provedor. */
export const hasPayLink = (i: Pick<InstallmentRow, 'status' | 'externalUrl'>) => Boolean(i.externalUrl) && (i.status === 'open' || i.status === 'overdue');

/**
 * Envia ao cliente o link de pagamento da parcela (template `charge`) e grava `chargeSentAt`.
 * Com a mesma `idempotencyKey`, repetir não gera outro envio.
 */
export async function queueChargeLink(
  ctx: AppContext,
  input: { inst: InstallmentRow; billing: BillingRow; budget: BudgetRow | null | undefined; channel: DeliveryChannel; idempotencyKey: string; userId?: string | null },
) {
  const { inst, billing, budget } = input;
  const [{ total }] = await ctx.db.select({ total: count() }).from(installments).where(eq(installments.billingId, billing.id));
  const delivery = await queueDelivery(ctx, {
    officeId: billing.officeId,
    customerId: billing.customerId,
    channel: input.channel,
    templateKey: 'charge',
    values: {
      CATEGORIA: budget ? ((BUDGET_CATEGORIES as Record<string, string>)[budget.category] ?? 'serviços') : 'serviços',
      PARCELA: `${inst.number}/${total}`,
      VALOR: formatMoney(inst.amountCents),
      VENCIMENTO: formatDate(inst.dueDate),
      LINK: inst.externalUrl ?? '',
    },
    exerciseYear: budget?.exerciseYear,
    idempotencyKey: input.idempotencyKey,
    userId: input.userId ?? null,
  });
  await ctx.db.update(installments).set({ chargeSentAt: new Date() }).where(eq(installments.id, inst.id));
  return delivery;
}

/**
 * Envio automático do link depois da emissão: só a primeira parcela em aberto com link, por e-mail,
 * e só uma vez (chave `charge:<parcela>`; uma nova execução do job não repete). Não envia com a
 * preferência desligada, sem e-mail do cliente ou quando o próprio Asaas já avisa o cliente.
 */
async function autoSendChargeLink(ctx: AppContext, billing: BillingRow, customer: CustomerRow, budget: BudgetRow | null | undefined) {
  if (!customer.email || customer.deletedAt) return null;
  if (!(await getOfficeSettings(ctx.db, billing.officeId)).chargeLinkAutoSend) return null;
  if (billing.provider === 'asaas') {
    const loaded = await loadIntegration<AsaasConfig, AsaasSecrets>(ctx, billing.officeId, 'asaas');
    if (loaded?.config.notifyCustomer) return null;
  }
  const list = await ctx.db.query.installments.findMany({ where: eq(installments.billingId, billing.id), orderBy: asc(installments.number) });
  const first = list.find(hasPayLink);
  if (!first || first.chargeSentAt) return null;
  await queueChargeLink(ctx, { inst: first, billing, budget, channel: 'email', idempotencyKey: `charge:${first.id}` });
  return first.id;
}

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
  const budget = await db.query.budgets.findFirst({ where: eq(budgets.id, billing.budgetId) });
  if (!pending.length) {
    // nova execução depois de emitir tudo: garante o envio do link que tenha ficado para trás
    await autoSendChargeLink(ctx, billing, customer, budget);
    return { provider, created: 0, message: 'Nenhuma parcela pendente de envio.' };
  }

  const office = await db.query.offices.findFirst({ where: eq(offices.id, billing.officeId) });
  const input = { customer, pending, totalInstallments: all.length, description: chargeDescription(budget, office?.name), progress: opts.progress };

  let result: Awaited<ReturnType<typeof createAsaasCharges>> | Awaited<ReturnType<typeof createOmieReceivables>>;
  if (provider === 'asaas') {
    if (!customer.cpfCnpj) throw new IntegrationError('asaas', 'O cliente não tem CPF/CNPJ cadastrado.');
    const loaded = await requireIntegration<AsaasConfig, AsaasSecrets>(ctx, billing.officeId, 'asaas');
    result = await createAsaasCharges(ctx, loaded, input);
  } else {
    const loaded = await requireIntegration<OmieConfig, OmieSecrets>(ctx, billing.officeId, 'omie');
    result = await createOmieReceivables(ctx, loaded, input);
  }
  const chargeSentFor = await autoSendChargeLink(ctx, billing, customer, budget);
  return { ...result, chargeSentFor };
}
