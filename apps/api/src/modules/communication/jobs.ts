import type { AppContext } from '../../context';
import { MAILING_DELIVER_JOB, MAILING_JOB, deliverWithAttachment, runMailingRequest, type MailingJobPayload } from './mailing';

/** Mala direta: o pedido inteiro (envios em lote) e o anexo por cliente (kit pós-declaração, checklist em PDF). */
export function registerJobs(ctx: AppContext) {
  ctx.jobs.register(MAILING_JOB, async (job, { progress }) => runMailingRequest(ctx, job, progress));
  ctx.jobs.register(MAILING_DELIVER_JOB, async (job) => deliverWithAttachment(ctx, job.payload as MailingJobPayload));
}
