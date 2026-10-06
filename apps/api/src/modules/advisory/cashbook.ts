import JSZip from 'jszip';
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CASHBOOK_MAX_ROWS,
  carneLeaoFiles,
  cashbookByMonth,
  detectCashbookKind,
  normalizeHeader,
  parseCashbookRow,
  type CashbookEntryData,
} from '@verifco/shared';
import { cashbookEntries, importBatches } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { fileTypes, readUploads } from '../../services/uploads';
import { readCsv, readSheet, type SheetRow } from '../../services/xlsx';
import { decodeText } from './ai-service';

const calendarYear = z.coerce.number().int().min(2000).max(2100);

/** Planilhas aceitas na conversão do livro caixa. */
const CASHBOOK_TYPES = fileTypes('csv', 'txt', 'xlsx');

/** Lê .csv (UTF-8 ou Windows-1252, ; ou ,) ou .xlsx e devolve cabeçalhos normalizados e linhas. */
async function readUpload(data: Buffer, filename: string): Promise<{ headers: string[]; rows: SheetRow[] }> {
  if (/\.(csv|txt)$/i.test(filename)) {
    const text = decodeText(data).replace(/^﻿/, '');
    const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
    const sep = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ';' : ',';
    return { headers: first.split(sep).map((h) => normalizeHeader(h.replace(/^"|"$/g, ''))), rows: readCsv(text) };
  }
  if (/\.xlsx$/i.test(filename)) {
    const rows = await readSheet(data, filename);
    return { headers: rows[0] ? Object.keys(rows[0].values) : [], rows };
  }
  throw badRequest(`${filename}: envie um arquivo .csv ou .xlsx no layout do modelo.`);
}

export async function cashbookRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.get('/customers/:id/cashbook', { preHandler: guard('cashbook.use') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(z.object({ year: calendarYear }), req.query);
    const customer = await getCustomerForUser(app.ctx, user, id);
    const entries = await db
      .select()
      .from(cashbookEntries)
      .where(and(eq(cashbookEntries.officeId, user.officeId), eq(cashbookEntries.customerId, customer.id), eq(cashbookEntries.year, year)))
      .orderBy(asc(cashbookEntries.entryDate), asc(cashbookEntries.createdAt));
    const batches = await db
      .select({ id: importBatches.id, total: importBatches.total, succeeded: importBatches.succeeded, failed: importBatches.failed, createdAt: importBatches.createdAt })
      .from(importBatches)
      .where(and(eq(importBatches.officeId, user.officeId), eq(importBatches.kind, `cashbook:${customer.id}:${year}`)))
      .orderBy(desc(importBatches.createdAt))
      .limit(20);
    const months = cashbookByMonth(entries);
    const totals = months.reduce(
      (a, m) => ({
        incomeCents: a.incomeCents + m.incomeCents,
        deductionCents: a.deductionCents + m.deductionCents,
        irrfCents: a.irrfCents + m.irrfCents,
        deductibleCents: a.deductibleCents + m.deductibleCents,
        nonDeductibleCents: a.nonDeductibleCents + m.nonDeductibleCents,
        generalPaymentsCents: a.generalPaymentsCents + m.generalPaymentsCents,
        count: a.count + m.count,
      }),
      { incomeCents: 0, deductionCents: 0, irrfCents: 0, deductibleCents: 0, nonDeductibleCents: 0, generalPaymentsCents: 0, count: 0 },
    );
    return { year, entries, months, totals, batches };
  });

  /**
   * Conversão: valida cada linha dos arquivos (até 1.000 linhas por envio) e acrescenta os
   * lançamentos válidos, sem sobrescrever os anteriores. Devolve o resultado por linha.
   */
  app.post('/customers/:id/cashbook/import', { preHandler: guard('cashbook.use') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(z.object({ year: calendarYear }), req.query);
    const customer = await getCustomerForUser(app.ctx, user, id);
    const { files: uploads } = await readUploads(req, { types: CASHBOOK_TYPES, accepted: 'um arquivo .csv ou .xlsx no layout do modelo' });
    if (!uploads.length) throw badRequest('Selecione ao menos um arquivo.');
    const parsed = [];
    let total = 0;
    for (const u of uploads) {
      const sheet = await readUpload(u.data, u.filename);
      const kind = detectCashbookKind(sheet.headers);
      if (!kind) throw badRequest(`${u.filename}: cabeçalho fora do layout do modelo (baixe um dos modelos de rendimentos ou pagamentos).`);
      total += sheet.rows.length;
      parsed.push({ ...u, kind, rows: sheet.rows });
    }
    if (total > CASHBOOK_MAX_ROWS) throw badRequest(`O envio tem ${total} linhas; o máximo é ${CASHBOOK_MAX_ROWS} por envio. Divida em arquivos menores.`);
    if (!total) throw badRequest('Os arquivos não têm linhas preenchidas.');

    const results: { file: string; row: number; ok: boolean; message: string }[] = [];
    const valid: { file: string; row: number; entry: CashbookEntryData }[] = [];
    for (const f of parsed) {
      for (const r of f.rows) {
        const res = parseCashbookRow(f.kind, r.values, year, r.numbers);
        if (res.ok) valid.push({ file: f.filename, row: r.rowNumber, entry: res.entry });
        else results.push({ file: f.filename, row: r.rowNumber, ok: false, message: res.errors.join(' ') });
      }
    }
    const [batch] = await db
      .insert(importBatches)
      .values({ officeId: user.officeId, kind: `cashbook:${customer.id}:${year}`, total, succeeded: valid.length, failed: total - valid.length, createdByUserId: user.userId })
      .returning();
    if (valid.length) {
      await db.insert(cashbookEntries).values(
        valid.map((v) => ({
          officeId: user.officeId,
          customerId: customer.id,
          year,
          kind: v.entry.kind,
          entryDate: v.entry.entryDate,
          code: v.entry.code,
          description: v.entry.description,
          valueCents: v.entry.valueCents,
          counterpartyCpf: v.entry.counterpartyCpf,
          extra: v.entry.extra as Record<string, unknown>,
          importBatchId: batch.id,
        })),
      );
    }
    for (const v of valid) results.push({ file: v.file, row: v.row, ok: true, message: `Lançamento incluído (${v.entry.code}).` });
    results.sort((a, b) => a.file.localeCompare(b.file) || a.row - b.row);
    await db
      .update(importBatches)
      .set({ results: results.map((r) => ({ row: r.row, ok: r.ok, message: `${r.file}: ${r.message}` })) })
      .where(eq(importBatches.id, batch.id));
    await audit(req, 'import', 'cashbook', customer.id, { year, total, succeeded: valid.length });
    reply.status(201);
    return { batchId: batch.id, total, succeeded: valid.length, failed: total - valid.length, results };
  });

  app.get('/customers/:id/cashbook/batches/:batchId', { preHandler: guard('cashbook.use') }, async (req) => {
    const user = requireUser(req);
    const { id, batchId } = parse(z.object({ id: z.uuid(), batchId: z.uuid() }), req.params);
    const customer = await getCustomerForUser(app.ctx, user, id);
    const batch = await db.query.importBatches.findFirst({ where: and(eq(importBatches.id, batchId), eq(importBatches.officeId, user.officeId)) });
    if (!batch || !batch.kind.startsWith(`cashbook:${customer.id}:`)) throw notFound('Envio');
    return batch;
  });

  /** Desfaz um envio: remove os lançamentos que ele incluiu. */
  app.delete('/customers/:id/cashbook/batches/:batchId', { preHandler: guard('cashbook.use') }, async (req) => {
    const user = requireUser(req);
    const { id, batchId } = parse(z.object({ id: z.uuid(), batchId: z.uuid() }), req.params);
    const customer = await getCustomerForUser(app.ctx, user, id);
    const batch = await db.query.importBatches.findFirst({ where: and(eq(importBatches.id, batchId), eq(importBatches.officeId, user.officeId)) });
    if (!batch || !batch.kind.startsWith(`cashbook:${customer.id}:`)) throw notFound('Envio');
    const removed = await db
      .delete(cashbookEntries)
      .where(and(eq(cashbookEntries.officeId, user.officeId), eq(cashbookEntries.customerId, customer.id), eq(cashbookEntries.importBatchId, batchId)))
      .returning({ id: cashbookEntries.id });
    await db.delete(importBatches).where(eq(importBatches.id, batchId));
    await audit(req, 'undo_import', 'cashbook', customer.id, { batchId, removed: removed.length });
    return { ok: true, removed: removed.length };
  });

  app.delete('/cashbook/entries/:id', { preHandler: guard('cashbook.use') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const row = await db.query.cashbookEntries.findFirst({ where: and(eq(cashbookEntries.id, id), eq(cashbookEntries.officeId, user.officeId)) });
    if (!row) throw notFound('Lançamento');
    await getCustomerForUser(app.ctx, user, row.customerId);
    await db.delete(cashbookEntries).where(eq(cashbookEntries.id, id));
    return { ok: true };
  });

  /** CSV no layout de importação do Carnê-Leão Web (ZIP quando passa de 1.000 linhas). */
  app.get('/customers/:id/cashbook/export', { preHandler: guard('cashbook.use') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const q = parse(
      z.object({ year: calendarYear, kind: z.enum(['income', 'payment']).optional(), month: z.coerce.number().int().min(1).max(12).optional() }),
      req.query,
    );
    const customer = await getCustomerForUser(app.ctx, user, id);
    const conds = [eq(cashbookEntries.officeId, user.officeId), eq(cashbookEntries.customerId, customer.id), eq(cashbookEntries.year, q.year)];
    if (q.kind) conds.push(eq(cashbookEntries.kind, q.kind));
    if (q.month) {
      const mm = String(q.month).padStart(2, '0');
      const next = q.month === 12 ? `${q.year + 1}-01-01` : `${q.year}-${String(q.month + 1).padStart(2, '0')}-01`;
      conds.push(gte(cashbookEntries.entryDate, `${q.year}-${mm}-01`), lt(cashbookEntries.entryDate, next));
    }
    const rows = await db.select().from(cashbookEntries).where(and(...conds));
    if (!rows.length) throw badRequest('Não há lançamentos para exportar.');
    const base = `carne-leao-${q.year}${q.month ? `-${String(q.month).padStart(2, '0')}` : ''}${q.kind === 'income' ? '-rendimentos' : q.kind === 'payment' ? '-pagamentos' : ''}`;
    const out = carneLeaoFiles(
      rows.map((r) => ({ kind: r.kind as 'income' | 'payment', entryDate: String(r.entryDate), code: r.code, description: r.description ?? '', valueCents: r.valueCents, counterpartyCpf: r.counterpartyCpf, extra: r.extra as CashbookEntryData['extra'] })),
      base,
    );
    await audit(req, 'export', 'cashbook', customer.id, { year: q.year, rows: rows.length });
    if (out.length === 1) {
      return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${out[0].filename}"`).send(Buffer.from(out[0].content, 'utf8'));
    }
    const zip = new JSZip();
    for (const f of out) zip.file(f.filename, f.content);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${base}.zip"`).send(buf);
  });
}
