import type { AppContext } from '../../context';
import { BUDGET_IMPORT_JOB, runBudgetImport } from './budget-import';

/** Importação de orçamentos em lote (fora da requisição). */
export function registerJobs(ctx: AppContext) {
  ctx.jobs.register(BUDGET_IMPORT_JOB, async (job, { progress }) => runBudgetImport(ctx, job, progress));
}
