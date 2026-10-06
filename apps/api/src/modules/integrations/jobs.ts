import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '@verifco/shared';
import type { AppContext } from '../../context';
import { billings, customers, installments, integrations, jobs, notifications } from '../../db/schema';
import { BILLING_SYNC_JOB, syncBillingExternal } from '../../integrations/billing-sync';
import { IntegrationError, errorMessage } from '../../integrations/http';
import { OMIE_POLL_JOB, pollOmiePayments } from '../../integrations/omie';
import { INTERRUPTED_ERROR, JOB_LEASE_MS, PermanentJobError, type JobRow } from '../../jobs/queue';
import { notify } from '../../services/notify';

type BillingProvider = 'asaas' | 'omie';
const BILLING_PROVIDERS: BillingProvider[] = ['asaas', 'omie'];
const isBillingProvider = (p: unknown): p is BillingProvider => BILLING_PROVIDERS.includes(p as BillingProvider);

/** Integrações de cobrança ativas e com os campos obrigatórios preenchidos no escritório. */
export async function billingProvidersReady(ctx: AppContext, officeId: string): Promise<Record<BillingProvider, boolean>> {
  const rows = await ctx.db
    .select({ provider: integrations.provider, enabled: integrations.enabled, status: integrations.status })
    .from(integrations)
    .where(and(eq(integrations.officeId, officeId), inArray(integrations.provider, BILLING_PROVIDERS)));
  const ready = (p: BillingProvider) => rows.some((r) => r.provider === p && r.enabled && r.status !== 'not_configured');
  return { asaas: ready('asaas'), omie: ready('omie') };
}

/**
 * Falha que repetir não resolve: credencial recusada, requisição recusada pelo provedor (4xx) ou
 * integração desligada/incompleta. Fica parada até alguém agir (salvar a integração reenfileira).
 */
async function isPermanentBillingError(ctx: AppContext, officeId: string | null, billingId: string, err: unknown) {
  const billing = await ctx.db.query.billings.findFirst({ where: eq(billings.id, billingId) });
  if (!billing) return true;
  if (!(err instanceof IntegrationError)) return false;
  if (err.message.startsWith('Credenciais recusadas')) return true;
  if (err.status !== undefined && err.status >= 400 && err.status < 500) return ![408, 409, 425, 429].includes(err.status);
  if (err.status !== undefined || !isBillingProvider(billing.provider)) return false;
  return !(await billingProvidersReady(ctx, officeId ?? billing.officeId))[billing.provider];
}

/**
 * Aviso ao escritório quando a cobrança não foi emitida e não haverá nova tentativa. Com a
 * integração desligada, um aviso por dia basta (aprovações em lote não lotam o sino): cada
 * faturamento mostra a falha no painel e todos são emitidos quando a integração for ativada.
 */
async function notifyBillingFailure(ctx: AppContext, job: JobRow, error: string) {
  const billing = await ctx.db.query.billings.findFirst({ where: eq(billings.id, String(job.payload.billingId ?? '')) });
  if (!billing || !isBillingProvider(billing.provider)) return;
  const label = INTEGRATION_PROVIDERS[billing.provider];
  const title = `Cobrança não emitida no ${label}`;
  if (!(await billingProvidersReady(ctx, billing.officeId))[billing.provider]) {
    const recent = await ctx.db.query.notifications.findFirst({
      where: and(eq(notifications.officeId, billing.officeId), eq(notifications.title, title), isNull(notifications.customerId), gt(notifications.createdAt, new Date(Date.now() - 86400_000))),
    });
    if (recent) return;
    await notify(ctx.db, {
      officeId: billing.officeId,
      title,
      body: `A integração ${label} não está ativa: as cobranças dos orçamentos aprovados ficam pendentes e são emitidas quando ela for ativada em Administração › Integrações.`,
      link: '/admin/integracoes',
    });
    return;
  }
  const customer = await ctx.db.query.customers.findFirst({ where: eq(customers.id, billing.customerId) });
  await notify(ctx.db, {
    officeId: billing.officeId,
    customerId: billing.customerId,
    title,
    body: `${customer?.name ?? 'Cliente'}: ${error}`,
    link: `/clientes/${billing.customerId}/irpf/orcamento`,
  });
}

/**
 * Pede a emissão já (botão "Emitir novamente", integração salva): reabre o job do faturamento
 * (chave = id do faturamento) ou antecipa a próxima tentativa. Não duplica cobranças: a emissão só
 * trata parcelas em aberto sem `externalId`.
 */
export async function requestBillingSync(ctx: AppContext, list: { id: string; officeId: string }[], userId: string | null) {
  await ctx.jobs.retryNow(
    BILLING_SYNC_JOB,
    list.map((b) => ({ idempotencyKey: b.id, payload: { billingId: b.id }, officeId: b.officeId })),
    { userId },
  );
}

/** Reenfileira os faturamentos do provedor com parcelas em aberto ainda sem cobrança emitida. */
export async function requeuePendingBillings(ctx: AppContext, officeId: string, provider: IntegrationProvider, userId: string | null) {
  if (!isBillingProvider(provider)) return 0;
  const rows = await ctx.db
    .selectDistinct({ id: billings.id, officeId: billings.officeId })
    .from(billings)
    .innerJoin(installments, eq(installments.billingId, billings.id))
    .where(and(eq(billings.officeId, officeId), eq(billings.provider, provider), isNull(installments.externalId), inArray(installments.status, ['open', 'overdue'])));
  if (rows.length) await requestBillingSync(ctx, rows, userId);
  return rows.length;
}

export interface BillingSyncState {
  /** Emissão no provedor: sem tarefa, na fila (ou esperando nova tentativa), emitindo, concluída ou falhou de vez. */
  status: 'none' | 'queued' | 'running' | 'done' | 'failed';
  error: string | null;
  attempts: number;
  maxAttempts: number;
  /** Próxima tentativa automática depois de uma falha. */
  nextAttemptAt: Date | null;
  finishedAt: Date | null;
  /** A integração do provedor está ativa e configurada. */
  integrationReady: boolean;
}

function syncStatus(job: JobRow): Pick<BillingSyncState, 'status' | 'error'> {
  if (job.status !== 'running' || !job.lockedAt || job.lockedAt.getTime() > Date.now() - JOB_LEASE_MS) return { status: job.status as BillingSyncState['status'], error: job.error };
  // processo caiu no meio: será retomada (ou falha de vez se acabaram as tentativas)
  return job.attempts < job.maxAttempts ? { status: 'queued', error: job.error } : { status: 'failed', error: INTERRUPTED_ERROR };
}

/** Situação da emissão de cada faturamento integrado (último job `billing.sync_external`). */
export async function billingSyncStates(ctx: AppContext, officeId: string, list: { id: string; provider: string | null }[]) {
  const states = new Map<string, BillingSyncState>();
  const integrated = list.filter((b) => isBillingProvider(b.provider));
  if (!integrated.length) return states;
  const ready = await billingProvidersReady(ctx, officeId);
  const rows: JobRow[] = [];
  for (let i = 0; i < integrated.length; i += 500) {
    const keys = integrated.slice(i, i + 500).map((b) => b.id);
    rows.push(...(await ctx.db.select().from(jobs).where(and(eq(jobs.officeId, officeId), eq(jobs.type, BILLING_SYNC_JOB), inArray(jobs.idempotencyKey, keys)))));
  }
  for (const b of integrated) {
    const job = rows.find((j) => j.idempotencyKey === b.id);
    const integrationReady = ready[b.provider as BillingProvider];
    if (!job) {
      states.set(b.id, { status: 'none', error: null, attempts: 0, maxAttempts: 0, nextAttemptAt: null, finishedAt: null, integrationReady });
      continue;
    }
    const s = syncStatus(job);
    states.set(b.id, {
      ...s,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      nextAttemptAt: s.status === 'queued' && job.attempts > 0 ? job.runAt : null,
      finishedAt: job.finishedAt,
      integrationReady,
    });
  }
  return states;
}

/**
 * Executores da fila ligados às integrações:
 * - `billing.sync_external` `{ billingId }`: cria as cobranças das parcelas no Asaas/Omie
 *   (enfileirado pelo módulo financeiro ao faturar com `billings.provider`). Repete com espera
 *   crescente (até 24 h); erro permanente não repete; na falha final, avisa o escritório.
 * - `omie.poll_payments` `{ officeId }`: consulta as contas a receber em aberto no Omie e
 *   marca as pagas; reagenda a si mesmo conforme o intervalo configurado.
 */
export function registerJobs(ctx: AppContext) {
  ctx.jobs.register(
    BILLING_SYNC_JOB,
    async (job, { progress }) => {
      const billingId = String(job.payload.billingId ?? '');
      if (!billingId) throw new PermanentJobError('Informe billingId no job billing.sync_external.');
      try {
        return await syncBillingExternal(ctx, billingId, { officeId: job.officeId, progress });
      } catch (err) {
        if (await isPermanentBillingError(ctx, job.officeId, billingId, err)) throw new PermanentJobError(errorMessage(err));
        throw err;
      }
    },
    { onFailed: (job, error) => notifyBillingFailure(ctx, job, error) },
  );

  ctx.jobs.register(OMIE_POLL_JOB, async (job) => {
    const officeId = job.officeId ?? String(job.payload.officeId ?? '');
    if (!officeId) throw new Error('Job omie.poll_payments sem escritório.');
    return pollOmiePayments(ctx, officeId);
  });
}
