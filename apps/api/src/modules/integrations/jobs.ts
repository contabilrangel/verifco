import type { AppContext } from '../../context';
import { BILLING_SYNC_JOB, syncBillingExternal } from '../../integrations/billing-sync';
import { OMIE_POLL_JOB, pollOmiePayments } from '../../integrations/omie';

/**
 * Executores da fila ligados às integrações:
 * - `billing.sync_external` `{ billingId }`: cria as cobranças das parcelas no Asaas/Omie
 *   (enfileirado pelo módulo financeiro ao faturar com `billings.provider`).
 * - `omie.poll_payments` `{ officeId }`: consulta as contas a receber em aberto no Omie e
 *   marca as pagas; reagenda a si mesmo conforme o intervalo configurado.
 */
export function registerJobs(ctx: AppContext) {
  ctx.jobs.register(BILLING_SYNC_JOB, async (job, { progress }) => {
    const billingId = String(job.payload.billingId ?? '');
    if (!billingId) throw new Error('Informe billingId no job billing.sync_external.');
    return syncBillingExternal(ctx, billingId, { officeId: job.officeId, progress });
  });

  ctx.jobs.register(OMIE_POLL_JOB, async (job) => {
    const officeId = job.officeId ?? String(job.payload.officeId ?? '');
    if (!officeId) throw new Error('Job omie.poll_payments sem escritório.');
    return pollOmiePayments(ctx, officeId);
  });
}
