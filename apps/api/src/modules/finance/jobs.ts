import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { importBatches } from '../../db/schema';
import { BUDGET_IMPORT_JOB, runBudgetImport, type BudgetImportPayload } from './budget-import';

/** Importação de orçamentos em lote (fora da requisição). */
export function registerJobs(ctx: AppContext) {
  ctx.jobs.register(BUDGET_IMPORT_JOB, async (job, { progress }) => runBudgetImport(ctx, job, progress), {
    // cobre a queda do processo com as tentativas esgotadas: o lote não fica "processando" para sempre
    onFailed: async (job, error) => {
      const p = job.payload as BudgetImportPayload;
      if (!p.batchId || !p.officeId) return;
      await ctx.db
        .update(importBatches)
        .set({ status: 'failed', results: [{ row: 1, ok: false, message: 'A importação não foi concluída. Envie a planilha de novo.' }], failed: 1 })
        .where(and(eq(importBatches.id, p.batchId), eq(importBatches.officeId, p.officeId), eq(importBatches.status, 'processing')));
    },
  });
}
