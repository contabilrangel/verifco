import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { customers, declarations } from '../../db/schema';
import { listItems } from '../../services/declarations';
import { notify } from '../../services/notify';
import { AiProviderError, buildExportPackage, exportFileName, extractDocument, isExtractable, loadDocStats, refreshElaborationStatus } from './service';

type Payload = { year: number; customerIds: string[]; force?: boolean };

async function targets(ctx: AppContext, officeId: string, p: Payload) {
  const ids = Array.isArray(p.customerIds) ? p.customerIds.map(String) : [];
  if (!ids.length) return [];
  const rows = await ctx.db
    .select({ c: customers, d: declarations })
    .from(customers)
    .leftJoin(declarations, and(eq(declarations.customerId, customers.id), eq(declarations.exerciseYear, Number(p.year))))
    .where(and(eq(customers.officeId, officeId), isNull(customers.deletedAt), inArray(customers.id, ids)));
  return rows;
}

export function registerJobs(ctx: AppContext) {
  const { db } = ctx;

  /** Processa com IA os documentos (PDF/imagem) ainda não processados das declarações selecionadas. */
  ctx.jobs.register('elaboration.process', async (job, { progress }) => {
    const officeId = job.officeId;
    if (!officeId) throw new Error('Job sem escritório.');
    const p = job.payload as unknown as Payload;
    const rows = await targets(ctx, officeId, p);
    let processed = 0;
    let failed = 0;
    let conflicts = 0;
    const skipped: { customerId: string; name: string; reason: string }[] = [];
    for (const [i, { c, d }] of rows.entries()) {
      if (!d) {
        skipped.push({ customerId: c.id, name: c.name, reason: 'Sem documentos no exercício.' });
        continue;
      }
      const docs = ((await loadDocStats(db, [d.id])).get(d.id) ?? []).filter((x) => isExtractable(x.mimeType) && (p.force || x.processingStatus !== 'processed'));
      if (!docs.length) skipped.push({ customerId: c.id, name: c.name, reason: 'Nenhum documento novo para processar.' });
      const existing = await listItems(db, d.id);
      for (const doc of docs) {
        try {
          const ex = await extractDocument(ctx, { officeId, customer: c, decl: d, doc, existing });
          if (ex.error) failed++;
          else {
            processed++;
            conflicts += ex.lines.filter((l) => l.match === 'conflict').length;
          }
        } catch (err) {
          // IA indisponível/não configurada (AiProviderError) ou falha de leitura: interrompe o job
          await refreshElaborationStatus(db, d.id);
          throw err instanceof AiProviderError ? err : new Error(`Falha ao processar "${doc.filename}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await refreshElaborationStatus(db, d.id);
      await progress(((i + 1) / Math.max(1, rows.length)) * 100);
    }
    return { declarations: rows.length, processed, failed, conflicts, skipped };
  });

  /** Gera o pacote de conferência (.zip) de cada declaração selecionada. */
  ctx.jobs.register('elaboration.export', async (job, { progress }) => {
    const officeId = job.officeId;
    if (!officeId) throw new Error('Job sem escritório.');
    const p = job.payload as unknown as Payload;
    const rows = await targets(ctx, officeId, p);
    let exported = 0;
    const skipped: { customerId: string; name: string; reason: string }[] = [];
    for (const [i, { c, d }] of rows.entries()) {
      const docs = d ? ((await loadDocStats(db, [d.id])).get(d.id) ?? []) : [];
      const items = d ? await listItems(db, d.id) : [];
      if (!d || (!docs.length && !items.length)) {
        skipped.push({ customerId: c.id, name: c.name, reason: 'Sem documentos nem linhas para exportar.' });
        continue;
      }
      const zip = await buildExportPackage(ctx, officeId, c, d);
      const saved = await ctx.files.save({ officeId, data: zip, filename: exportFileName(c, d.exerciseYear), mimeType: 'application/zip', userId: job.createdByUserId });
      await db.update(declarations).set({ exportedFileId: saved.id, elaborationStatus: 'exported', updatedAt: new Date() }).where(eq(declarations.id, d.id));
      if (d.exportedFileId) await ctx.files.remove(officeId, d.exportedFileId);
      await refreshElaborationStatus(db, d.id);
      exported++;
      await progress(((i + 1) / Math.max(1, rows.length)) * 100);
    }
    await notify(db, {
      officeId,
      userId: job.createdByUserId,
      title: 'Exportação concluída',
      body: `${exported} pacote(s) de conferência gerado(s)${skipped.length ? `, ${skipped.length} sem conteúdo` : ''}.`,
      link: '/elaboracao',
    });
    return { exported, skipped };
  });
}
