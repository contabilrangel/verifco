import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { jobs } from '../../db/schema';
import { receiveWhatsAppMessage, type InboundWhatsApp } from '../../integrations/whatsapp';

/** Mensagem recebida pelo webhook do WhatsApp (uma por job; a chave de idempotência é o id da mensagem). */
export const WHATSAPP_INBOUND_JOB = 'whatsapp.inbound';

export function registerJobs(ctx: AppContext) {
  ctx.jobs.register(WHATSAPP_INBOUND_JOB, async (job) => {
    if (!job.officeId) throw new Error('Job sem escritório.');
    const msg = job.payload.message as InboundWhatsApp | undefined;
    if (!msg?.id) return { skipped: true };
    const result = await receiveWhatsAppMessage(ctx, job.officeId, msg);
    // o texto já está na conversa do cliente: o job guarda só o id
    await ctx.db.update(jobs).set({ payload: { messageId: msg.id } }).where(eq(jobs.id, job.id));
    return result;
  });
}
