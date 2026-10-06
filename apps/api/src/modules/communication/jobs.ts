import type { AppContext } from '../../context';
import { deliverWithAttachment, type MailingJobPayload } from './mailing';

/** Mala direta com anexo por cliente (kit pós-declaração, checklist em PDF). */
export function registerJobs(ctx: AppContext) {
  ctx.jobs.register('mailing.deliver', async (job) => deliverWithAttachment(ctx, job.payload as MailingJobPayload));
}
