import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { customers, declarations } from '../../db/schema';
import { PermanentJobError, WAIT_FOR_CHILDREN, type JobRow } from '../../jobs/queue';
import { listItems } from '../../services/declarations';
import { notify } from '../../services/notify';
import { AiProviderError, buildExportPackage, exportFileName, extractDocument, isExtractable, loadDocStats, refreshElaborationStatus } from './service';

type Payload = { year: number; customerIds: string[]; force?: boolean };
type Skipped = { customerId: string; name: string; reason: string };
/** Resultado do processamento de um cliente (job filho de `elaboration.process`). */
type CustomerResult = { missing?: boolean; processed?: number; failed?: number; conflicts?: number; skipped?: Skipped | null };

/** Um job por cliente: o lote não prende o worker e outros escritórios não esperam a carteira inteira. */
const PROCESS_CUSTOMER_JOB = 'elaboration.process_customer';

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

  /**
   * Processa com IA os documentos (PDF/imagem) ainda não processados das declarações selecionadas.
   * Cria um job por cliente e só junta os resultados (o progresso é o dos clientes terminados).
   */
  ctx.jobs.register('elaboration.process', async (job, { spawn, children }) => {
    const officeId = job.officeId;
    if (!officeId) throw new Error('Job sem escritório.');
    const p = job.payload as unknown as Payload;
    const kids = await children();
    if (!kids.length) {
      const ids = [...new Set(Array.isArray(p.customerIds) ? p.customerIds.map(String) : [])];
      if (!ids.length) return { declarations: 0, processed: 0, failed: 0, conflicts: 0, skipped: [] };
      await spawn(ids.map((customerId) => ({ type: PROCESS_CUSTOMER_JOB, payload: { year: p.year, customerId, force: Boolean(p.force) }, idempotencyKey: `${job.id}:${customerId}`, maxAttempts: 1 })));
      return WAIT_FOR_CHILDREN;
    }
    if (kids.some((k) => k.status === 'queued' || k.status === 'running')) return WAIT_FOR_CHILDREN;
    return collectProcessResults(kids);
  });

  /** Um cliente do lote; falha da IA (indisponível ou não configurada) encerra o restante do lote. */
  ctx.jobs.register(PROCESS_CUSTOMER_JOB, async (job) => {
    const officeId = job.officeId;
    if (!officeId) throw new Error('Job sem escritório.');
    const p = job.payload as { year: number; customerId: string; force?: boolean };
    const [row] = await targets(ctx, officeId, { year: p.year, customerIds: [p.customerId], force: p.force });
    if (!row) return { missing: true } satisfies CustomerResult;
    const { c, d } = row;
    if (!d) return { processed: 0, failed: 0, conflicts: 0, skipped: { customerId: c.id, name: c.name, reason: 'Sem documentos no exercício.' } } satisfies CustomerResult;
    const docs = ((await loadDocStats(db, [d.id])).get(d.id) ?? []).filter((x) => isExtractable(x.mimeType) && (p.force || x.processingStatus !== 'processed'));
    const skipped = docs.length ? null : { customerId: c.id, name: c.name, reason: 'Nenhum documento novo para processar.' };
    const existing = await listItems(db, d.id);
    let processed = 0;
    let failed = 0;
    let conflicts = 0;
    for (const doc of docs) {
      try {
        const ex = await extractDocument(ctx, { officeId, customer: c, decl: d, doc, existing });
        if (ex.error) failed++;
        else {
          processed++;
          conflicts += ex.lines.filter((l) => l.match === 'conflict').length;
        }
      } catch (err) {
        // IA indisponível/não configurada (AiProviderError) ou falha de leitura: interrompe o cliente;
        // erro da IA afetaria todos, então os clientes ainda na fila param também
        await refreshElaborationStatus(db, d.id);
        if (err instanceof AiProviderError) {
          await ctx.jobs.cancelSiblings(job, err.message);
          throw new PermanentJobError(err.message);
        }
        throw new Error(`Falha ao processar "${doc.filename}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await refreshElaborationStatus(db, d.id);
    return { processed, failed, conflicts, skipped } satisfies CustomerResult;
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

/** Junta os resultados dos clientes; se algum falhou, o lote falha com o erro (e quantos deram certo). */
function collectProcessResults(kids: JobRow[]) {
  let declarations = 0;
  let processed = 0;
  let failed = 0;
  let conflicts = 0;
  const skipped: Skipped[] = [];
  const errors: string[] = [];
  for (const k of kids) {
    if (k.status !== 'done') {
      errors.push(k.error ?? 'Falha ao processar o cliente.');
      continue;
    }
    const r = (k.result ?? {}) as CustomerResult;
    if (r.missing) continue;
    declarations++;
    processed += Number(r.processed ?? 0);
    failed += Number(r.failed ?? 0);
    conflicts += Number(r.conflicts ?? 0);
    if (r.skipped) skipped.push(r.skipped);
  }
  if (errors.length) {
    const ok = kids.length - errors.length;
    throw new PermanentJobError(`${errors[0]}${ok ? ` (${ok} de ${kids.length} cliente(s) processado(s))` : ''}`);
  }
  return { declarations, processed, failed, conflicts, skipped };
}
