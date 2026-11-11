/**
 * Leva ao Asaas/Omie o que o escritório muda numa parcela com cobrança emitida lá: vencimento e
 * valor, recebimento manual, desfazer o recebimento e cancelamento. A chamada ao provedor vem
 * sempre ANTES da gravação no Verifco: se o provedor recusar ou não responder, a rota devolve o
 * erro dele e nada muda aqui (o cliente nunca fica com um boleto diferente do que o painel mostra).
 *
 * Com a integração desativada ou removida, o Verifco deixa de acompanhar a cobrança e o controle
 * volta a ser manual (`providerOf` devolve null). Parcela sem `externalId` também é só local.
 */
import { asc, eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { installments, offices } from '../../db/schema';
import { asaasClientFrom, asaasPaymentState, type AsaasConfig, type AsaasSecrets } from '../../integrations/asaas';
import { chargeDescription } from '../../integrations/billing-sync';
import { IntegrationError, centsToDecimal, todayIso } from '../../integrations/http';
import { omieAccount, omieClientFrom, omieContaBody, omieContaState, omieReceipts, type OmieConfig, type OmieSecrets } from '../../integrations/omie';
import { loadIntegration } from '../../integrations/store';
import { HttpError, conflict } from '../../lib/errors';
import { billingProvidersReady } from '../integrations/jobs';
import type { BillingRow, BudgetRow, InstallmentRow } from './service';

type CustomerLike = { externalRefs?: { omieId?: string | null } | null };
export interface ProviderTarget {
  inst: InstallmentRow;
  billing: BillingRow;
  budget?: BudgetRow | null;
  customer?: CustomerLike | null;
}

type BillingProvider = 'asaas' | 'omie';

/** Provedor que acompanha a cobrança da parcela (integração ativa e parcela emitida lá); senão null. */
export async function providerOf(ctx: AppContext, inst: InstallmentRow, billing: BillingRow): Promise<BillingProvider | null> {
  if (!inst.externalId || (billing.provider !== 'asaas' && billing.provider !== 'omie')) return null;
  return (await billingProvidersReady(ctx, billing.officeId))[billing.provider] ? billing.provider : null;
}

/** Fim da mensagem de erro quando o provedor recusa: deixa claro que a parcela ficou como estava. */
export const PROVIDER_UNCHANGED_NOTE = 'Nada foi alterado no Verifco.';

/**
 * Erro do provedor como resposta da rota: recusa da requisição (4xx; no Omie, `faultstring`) vira
 * 409 com a mensagem dele; credencial recusada, limite, indisponibilidade e falha de rede viram 502.
 */
function providerFailure(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (!(err instanceof IntegrationError)) throw err;
  const fault = Boolean((err.details as { faultstring?: unknown } | null | undefined)?.faultstring);
  const credentials = err.message.startsWith('Credenciais recusadas');
  const refused = !credentials && ((err.status !== undefined && err.status >= 400 && err.status < 500 && ![401, 403, 408, 429].includes(err.status)) || fault);
  const message = err.message.trim();
  throw new HttpError(refused ? 409 : 502, `${message}${/[.!?]$/.test(message) ? '' : '.'} ${PROVIDER_UNCHANGED_NOTE}`);
}

const asaasOf = async (ctx: AppContext, officeId: string) => {
  const loaded = await loadIntegration<AsaasConfig, AsaasSecrets>(ctx, officeId, 'asaas');
  if (!loaded) throw new IntegrationError('asaas', 'A integração Asaas não está configurada.');
  return asaasClientFrom(ctx, loaded);
};

const omieOf = async (ctx: AppContext, officeId: string) => {
  const loaded = await loadIntegration<OmieConfig, OmieSecrets>(ctx, officeId, 'omie');
  if (!loaded) throw new IntegrationError('omie', 'A integração Omie não está configurada.');
  return { client: omieClientFrom(ctx, loaded), config: loaded.config };
};

/** Troca vencimento e/ou valor da cobrança no provedor. Devolve o provedor atualizado (ou null: só local). */
export async function pushInstallmentChange(ctx: AppContext, t: ProviderTarget, next: { dueDate: string; amountCents: number }): Promise<BillingProvider | null> {
  const provider = await providerOf(ctx, t.inst, t.billing);
  if (!provider) return null;
  try {
    if (provider === 'asaas') {
      const client = await asaasOf(ctx, t.billing.officeId);
      const payment = await client.getPayment(t.inst.externalId!);
      const state = asaasPaymentState(payment);
      if (state !== 'pending' && state !== 'overdue') {
        throw conflict(
          state === 'paid'
            ? 'Esta cobrança já consta como paga no Asaas e não pode mais ser alterada. A parcela será atualizada pelo aviso do Asaas.'
            : 'Esta cobrança não está mais em aberto no Asaas (removida ou estornada) e não pode ser alterada.',
        );
      }
      // vencimento que não mudou: mantém o do Asaas (a cobrança de parcela atrasada foi emitida com outro vencimento)
      const dueDate = next.dueDate !== t.inst.dueDate ? next.dueDate : payment.dueDate;
      if (next.dueDate !== t.inst.dueDate && next.dueDate < todayIso()) throw conflict('O Asaas não aceita vencimento no passado. Escolha uma data a partir de hoje.');
      await client.updatePayment(t.inst.externalId!, { ...(payment.billingType ? { billingType: payment.billingType } : {}), dueDate, value: centsToDecimal(next.amountCents) });
    } else {
      const { client, config } = await omieOf(ctx, t.billing.officeId);
      const omieCustomerId = Number(t.customer?.externalRefs?.omieId);
      if (!Number.isFinite(omieCustomerId) || !omieCustomerId) throw conflict('O cliente não tem o código do Omie gravado. Altere a conta a receber no Omie.');
      const { accountId, categoryCode } = omieAccount(config);
      const office = await ctx.db.query.offices.findFirst({ where: eq(offices.id, t.billing.officeId) });
      const all = await ctx.db.query.installments.findMany({ where: eq(installments.billingId, t.billing.id), orderBy: asc(installments.number), columns: { id: true } });
      await client.alterarContaReceber(
        omieContaBody({ ...t.inst, ...next }, { omieCustomerId, categoryCode, accountId, description: chargeDescription(t.budget, office?.name), totalInstallments: all.length }),
      );
    }
  } catch (err) {
    providerFailure(err);
  }
  return provider;
}

/** Registra no provedor o recebimento feito por fora (dinheiro, transferência). */
export async function pushInstallmentReceipt(ctx: AppContext, t: ProviderTarget, paid: { paidAt: string; paidAmountCents: number }): Promise<BillingProvider | null> {
  const provider = await providerOf(ctx, t.inst, t.billing);
  if (!provider) return null;
  try {
    if (provider === 'asaas') {
      const client = await asaasOf(ctx, t.billing.officeId);
      await client.receiveInCash(t.inst.externalId!, { paymentDate: paid.paidAt, value: centsToDecimal(paid.paidAmountCents) });
    } else {
      const { client, config } = await omieOf(ctx, t.billing.officeId);
      await client.lancarRecebimento({
        codigoIntegracao: t.inst.id,
        contaCorrente: omieAccount(config).accountId,
        valueCents: paid.paidAmountCents,
        date: paid.paidAt,
        note: 'Recebimento registrado no Verifco',
      });
    }
  } catch (err) {
    providerFailure(err);
  }
  return provider;
}

/**
 * Desfaz no provedor o recebimento registrado. No Asaas, só o recebimento em dinheiro
 * (RECEIVED_IN_CASH) pode ser desfeito: pagamento de verdade (boleto, Pix, cartão) é estorno, feito
 * no Asaas. No Omie, só quando a consulta do título devolve o código da baixa.
 * Se o provedor não tem recebimento algum (baixa feita só no Verifco), não há o que desfazer lá.
 */
export async function pushInstallmentReopen(ctx: AppContext, t: ProviderTarget): Promise<BillingProvider | null> {
  const provider = await providerOf(ctx, t.inst, t.billing);
  if (!provider) return null;
  try {
    if (provider === 'asaas') {
      const client = await asaasOf(ctx, t.billing.officeId);
      const payment = await client.getPayment(t.inst.externalId!);
      const state = asaasPaymentState(payment);
      if (payment.status === 'RECEIVED_IN_CASH' && !payment.deleted) await client.undoReceivedInCash(t.inst.externalId!);
      else if (state === 'paid') {
        throw conflict(
          'Este pagamento foi feito pelo Asaas (boleto, Pix ou cartão) e não pode ser desfeito por aqui. Para devolver o valor ao cliente, estorne a cobrança no Asaas; o Verifco atualiza a parcela pelo aviso do Asaas.',
        );
      } else if (state !== 'pending' && state !== 'overdue') {
        throw conflict('Esta cobrança não está mais em aberto no Asaas (removida ou estornada): o recebimento não pode ser desfeito por aqui. Confira a cobrança no Asaas.');
      }
    } else {
      const { client } = await omieOf(ctx, t.billing.officeId);
      const r = await client.consultarContaReceber(t.inst.id);
      const conta = r.conta_receber_cadastro ?? r;
      const receipts = omieReceipts(conta);
      const codes = receipts.map((x) => x.codigo_baixa).filter((c): c is number | string => c !== undefined && c !== null && String(c) !== '' && String(c) !== '0');
      if (omieContaState(conta) === 'paid' || receipts.length) {
        if (!codes.length || codes.length !== receipts.length) {
          throw conflict('Não foi possível identificar a baixa deste título no Omie. Cancele o recebimento na conta a receber do Omie; o Verifco confere os pagamentos do Omie periodicamente.');
        }
        for (const code of codes) await client.cancelarRecebimento(code);
      }
    }
  } catch (err) {
    providerFailure(err);
  }
  return provider;
}

/** Cancela a cobrança no provedor (Asaas: remove a cobrança; Omie: exclui a conta a receber). */
export async function pushInstallmentCancel(ctx: AppContext, t: ProviderTarget): Promise<BillingProvider | null> {
  const provider = await providerOf(ctx, t.inst, t.billing);
  if (!provider) return null;
  try {
    if (provider === 'asaas') await (await asaasOf(ctx, t.billing.officeId)).deletePayment(t.inst.externalId!);
    else await (await omieOf(ctx, t.billing.officeId)).client.excluirContaReceber(t.inst.id);
  } catch (err) {
    providerFailure(err);
  }
  return provider;
}
