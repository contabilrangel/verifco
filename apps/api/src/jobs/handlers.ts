import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { deliveries } from '../db/schema';
import { importModuleFile, moduleDirs } from '../modules';
import { sendDeliveryJob } from '../services/delivery';

/**
 * Registra os executores de jobs: os do núcleo e os de cada `modules/<nome>/jobs.ts`
 * (que exporta `registerJobs(ctx)`).
 */
export async function registerJobHandlers(ctx: AppContext) {
  ctx.jobs.register('delivery.send', async (job) => sendDeliveryJob(ctx, String(job.payload.deliveryId)), {
    // job interrompido sem tentativas: o envio aparece como falho (e pode ser reenviado), não "na fila" para sempre
    onFailed: async (job, error) => {
      await ctx.db
        .update(deliveries)
        .set({ status: 'failed', error })
        .where(and(eq(deliveries.id, String(job.payload.deliveryId)), eq(deliveries.status, 'queued')));
    },
  });
  for (const dir of moduleDirs()) {
    const mod = await importModuleFile<{ registerJobs?: (ctx: AppContext) => void | Promise<void> }>(dir, 'jobs');
    await mod?.registerJobs?.(ctx);
  }
}
