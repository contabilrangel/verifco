import type { AppContext } from '../../context';
import { MAILING_JOB, legacyDeliverPayload, runMailing, type MailingRunPayload } from './mailing';

/** Mala direta: um job por pedido, que envia em lotes e grava o andamento. */
export function registerJobs(ctx: AppContext) {
  ctx.jobs.register(MAILING_JOB, async (job) => runMailing(ctx, job.id, job.payload as MailingRunPayload));
  // jobs por cliente gravados antes da fila por lotes, que ainda estejam na fila
  ctx.jobs.register('mailing.deliver', async (job) => runMailing(ctx, job.id, legacyDeliverPayload(job.payload)));
}
