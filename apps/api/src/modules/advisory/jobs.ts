import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { aiAnalyses, customers, documents } from '../../db/schema';
import { AI_LIMITS, FINANCIAL_ADVISOR_PROMPT, attachmentsForAi, completeWithTimeout } from './ai-service';
import { runBackupJob } from './backup';
import { clientContextText } from './common';
import { computeRadar } from './radar';

/** Executa a análise do assessor financeiro e grava o resultado (ou o erro) na própria análise. */
export async function runFinancialAnalysis(ctx: AppContext, analysisId: string) {
  const { db } = ctx;
  const row = await db.query.aiAnalyses.findFirst({ where: eq(aiAnalyses.id, analysisId) });
  if (!row) return { skipped: true };
  await db.update(aiAnalyses).set({ status: 'running' }).where(eq(aiAnalyses.id, row.id));
  try {
    const customer = await db.query.customers.findFirst({ where: and(eq(customers.id, row.customerId), eq(customers.officeId, row.officeId)) });
    if (!customer) throw new Error('Cliente não encontrado.');
    const docs = row.documentIds.length
      ? await db
          .select({ fileId: documents.fileId })
          .from(documents)
          .where(and(eq(documents.officeId, row.officeId), eq(documents.customerId, row.customerId), inArray(documents.id, row.documentIds)))
      : [];
    if (!docs.length) throw new Error('Os documentos selecionados não estão mais disponíveis.');
    const att = await attachmentsForAi(ctx, row.officeId, docs.map((d) => d.fileId));
    const context = await clientContextText(ctx, row.officeId, customer, new Date().getFullYear());
    const out = await completeWithTimeout(
      ctx,
      row.officeId,
      {
        system: `${FINANCIAL_ADVISOR_PROMPT}\n\nContexto do cliente:\n${context}`,
        messages: [
          {
            role: 'user',
            content: [`Analise os ${att.names.length} documento(s) anexados: ${att.names.map((n) => n.filename).join(', ')}.`, ...att.texts].join('\n\n'),
            files: att.files.length ? att.files : undefined,
          },
        ],
        maxTokens: 6000,
      },
      AI_LIMITS.analysisTimeoutMs,
    );
    await db.update(aiAnalyses).set({ status: 'done', result: out.text }).where(eq(aiAnalyses.id, row.id));
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(aiAnalyses).set({ status: 'failed', result: message }).where(eq(aiAnalyses.id, row.id));
    return { ok: false, error: message };
  }
}

export function registerJobs(ctx: AppContext) {
  ctx.jobs.register('radar.compute', async (job, { progress }) => computeRadar(ctx, String(job.payload.officeId), Number(job.payload.year), progress));
  ctx.jobs.register('ai.financial_analysis', async (job) => runFinancialAnalysis(ctx, String(job.payload.analysisId)));
  ctx.jobs.register('backup.generate', async (job, { progress }) =>
    runBackupJob(ctx, String(job.payload.officeId), job.payload.userId ? String(job.payload.userId) : null, progress),
  );
}
