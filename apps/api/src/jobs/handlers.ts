import type { AppContext } from '../context';
import { importModuleFile, moduleDirs } from '../modules';
import { sendDeliveryJob } from '../services/delivery';

/**
 * Registra os executores de jobs: os do núcleo e os de cada `modules/<nome>/jobs.ts`
 * (que exporta `registerJobs(ctx)`).
 */
export async function registerJobHandlers(ctx: AppContext) {
  ctx.jobs.register('delivery.send', async (job) => sendDeliveryJob(ctx, String(job.payload.deliveryId)));
  for (const dir of moduleDirs()) {
    const mod = await importModuleFile<{ registerJobs?: (ctx: AppContext) => void | Promise<void> }>(dir, 'jobs');
    await mod?.registerJobs?.(ctx);
  }
}
