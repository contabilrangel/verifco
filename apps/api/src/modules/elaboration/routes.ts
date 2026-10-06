import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ELABORATION_STATUS, ITEM_KINDS, type DeclarationItem, type ElaborationStatus } from '@verifco/shared';
import type { DbOrTx } from '../../db/client';
import { customers, declarationItems, declarations, documents, files, jobs } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { customerScope, getCustomerForUser } from '../../services/customers';
import { listItems, refreshDeclaration } from '../../services/declarations';
import { jobView } from '../ecac/util';
import { safeZipName, sendStoredFile } from '../../services/uploads';
import { MAX_ZIP_DOWNLOAD_BYTES, zipStoredFiles } from '../../storage/zip';
import {
  computeElaborationStatus,
  docCounts,
  fillElaborationCounts,
  getExtraction,
  isExtractable,
  listElaboration,
  loadDocStats,
  refreshElaborationStatus,
  saveExtraction,
  sameLine,
  sameValues,
  type DocStat,
} from './service';

const LIST_PERMS = ['elaboration.export', 'elaboration.process', 'pre_declaration.view'];
const STATUS_KEYS = Object.keys(ELABORATION_STATUS) as [ElaborationStatus, ...ElaborationStatus[]];

const listQuery = z.object({
  year: yearSchema,
  search: z.string().trim().optional(),
  status: z.enum(STATUS_KEYS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const selectionSchema = z.object({
  year: yearSchema,
  customerIds: z.array(z.uuid()).min(1).max(500),
  force: z.boolean().optional(),
});

/** Central de elaboração: processamento dos documentos com IA, validação e exportação. */
export async function elaborationRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  /**
   * Clientes do escopo com a declaração do ano, situação e contadores gravados na declaração
   * (ver `listElaboration`); a página não lê os documentos.
   */
  app.get('/elaboration', { preHandler: guard(...LIST_PERMS) }, async (req) => {
    const q = parse(listQuery, req.query);
    const user = requireUser(req);
    // contadores ainda vazios (declarações anteriores aos contadores ou sem documento) são calculados uma vez
    await fillElaborationCounts(db, user.officeId, q.year);
    return listElaboration(db, await customerScope(app.ctx, user), q);
  });

  /** Documentos e linhas extraídas de uma declaração (para conferir e resolver conflitos). */
  app.get('/elaboration/customers/:id', { preHandler: guard(...LIST_PERMS) }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(z.object({ year: yearSchema }), req.query);
    const c = await getCustomerForUser(app.ctx, user, id);
    const decl = await db.query.declarations.findFirst({ where: and(eq(declarations.customerId, c.id), eq(declarations.exerciseYear, year)) });
    const docs = decl ? ((await loadDocStats(db, [decl.id])).get(decl.id) ?? []) : [];
    const items = decl ? await listItems(db, decl.id) : [];
    return {
      customer: { id: c.id, name: c.name, cpfCnpj: c.cpfCnpj },
      declarationId: decl?.id ?? null,
      status: computeElaborationStatus(decl?.elaborationStatus ?? 'no_files', docs),
      counts: docCounts(docs),
      itemsCount: items.length,
      documents: docs.map((d) => {
        const ex = getExtraction(d.extracted);
        return {
          id: d.id,
          fileId: d.fileId,
          filename: d.filename,
          mimeType: d.mimeType,
          category: d.category,
          uploadedBy: d.uploadedBy,
          createdAt: d.createdAt,
          extractable: isExtractable(d.mimeType),
          processingStatus: d.processingStatus,
          error: ex?.error ?? null,
          notes: ex?.notes ?? null,
          discarded: ex?.discarded ?? 0,
          lines: (ex?.lines ?? []).map((l, index) => ({ index, ...l, kindLabel: ITEM_KINDS[l.item.kind]?.label ?? l.item.kind })),
        };
      }),
    };
  });

  app.post('/elaboration/process', { preHandler: guard('elaboration.process', 'pre_declaration.create') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(selectionSchema, req.body);
    const ids = await scopedIds(req, body.customerIds);
    const job = await app.ctx.jobs.enqueue('elaboration.process', { year: body.year, customerIds: ids, force: Boolean(body.force) }, { officeId: user.officeId, userId: user.userId, maxAttempts: 2 });
    await audit(req, 'elaboration_process', 'declaration', null, { year: body.year, count: ids.length });
    reply.status(202);
    return { job: jobView(job) };
  });

  app.post('/elaboration/export', { preHandler: guard('elaboration.export') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(selectionSchema, req.body);
    const ids = await scopedIds(req, body.customerIds);
    const job = await app.ctx.jobs.enqueue('elaboration.export', { year: body.year, customerIds: ids }, { officeId: user.officeId, userId: user.userId, maxAttempts: 2 });
    await audit(req, 'elaboration_export', 'declaration', null, { year: body.year, count: ids.length });
    reply.status(202);
    return { job: jobView(job) };
  });

  /** Clientes da seleção que o usuário pode ver; 404 se nenhum. */
  async function scopedIds(req: Parameters<typeof requireUser>[0], ids: string[]) {
    const user = requireUser(req);
    const rows = await db.select({ id: customers.id }).from(customers).where(and(await customerScope(app.ctx, user), inArray(customers.id, ids)));
    if (!rows.length) throw notFound('Cliente');
    return rows.map((r) => r.id);
  }

  /** Decisão sobre uma linha extraída (aceitar/recusar), usada para resolver conflitos. */
  app.put('/elaboration/documents/:id/lines/:index', { preHandler: guard('elaboration.process', 'pre_declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const params = parse(z.object({ id: z.uuid(), index: z.coerce.number().int().min(0) }), req.params);
    const body = parse(z.object({ decision: z.enum(['accept', 'reject']).nullable() }), req.body);
    const doc = await db.query.documents.findFirst({ where: and(eq(documents.id, params.id), eq(documents.officeId, user.officeId)) });
    if (!doc) throw notFound('Documento');
    await getCustomerForUser(app.ctx, user, doc.customerId);
    const ex = getExtraction(doc.extracted);
    const line = ex?.lines[params.index];
    if (!ex || !line) throw notFound('Linha');
    if (line.appliedAt) throw badRequest('Esta linha já foi aplicada na declaração.');
    line.decision = body.decision;
    await saveExtraction(db, doc, doc.processingStatus, ex);
    const status = doc.declarationId ? await refreshElaborationStatus(db, doc.declarationId) : null;
    return { ok: true, status };
  });

  /**
   * Validar: aplica nas linhas da declaração as linhas extraídas aceitas.
   * Novas → incluídas; conflito aceito → substitui os valores da linha existente;
   * conflito sem decisão → fica pendente; recusadas e repetidas → ignoradas.
   * Cada declaração é aplicada numa transação, sob trava da declaração e relendo linhas e extrações
   * dentro dela: validações simultâneas (botão do cliente, validação em lote de um colega, duplo
   * clique) esperam a vez e não duplicam linhas; uma falha no meio desfaz a declaração inteira.
   */
  app.post('/elaboration/validate', { preHandler: guard('elaboration.process', 'pre_declaration.create') }, async (req) => {
    const user = requireUser(req);
    const body = parse(selectionSchema, req.body);
    const ids = await scopedIds(req, body.customerIds);
    const decls = await db
      .select({ d: declarations, name: customers.name })
      .from(declarations)
      .innerJoin(customers, eq(customers.id, declarations.customerId))
      .where(and(eq(declarations.officeId, user.officeId), eq(declarations.exerciseYear, body.year), inArray(declarations.customerId, ids), isNull(customers.deletedAt)));
    const results = [];
    for (const { d, name } of decls) {
      const r = await db.transaction(async (tx) => {
        // trava a declaração até o fim da transação; documentos e linhas são lidos já sob a trava
        await tx.select({ id: declarations.id }).from(declarations).where(eq(declarations.id, d.id)).for('update');
        const docs = (await loadDocStats(tx, [d.id])).get(d.id) ?? [];
        const applied = await applyLines(tx, user.officeId, d.id, docs);
        // totais e saldo de caixa (alerta do dashboard) acompanham as linhas
        if (applied.inserted || applied.updated) await refreshDeclaration({ db: tx }, d.id);
        return { ...applied, status: await refreshElaborationStatus(tx, d.id) };
      });
      results.push({ customerId: d.customerId, name, ...r });
    }
    await audit(req, 'elaboration_validate', 'declaration', null, { year: body.year, count: results.length });
    return { results };
  });

  async function applyLines(tx: DbOrTx, officeId: string, declarationId: string, docs: DocStat[]) {
    const items = await listItems(tx, declarationId);
    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let pendingConflicts = 0;
    for (const doc of docs) {
      const ex = getExtraction(doc.extracted);
      if (!ex || doc.processingStatus !== 'processed') continue;
      let changed = false;
      for (const line of ex.lines) {
        if (line.appliedAt || line.decision === 'reject' || line.match === 'duplicate') continue;
        const item = line.item;
        if (line.match === 'conflict') {
          if (line.decision !== 'accept') {
            pendingConflicts++;
            continue;
          }
          const target = items.find((i) => i.id === line.existingItemId);
          if (target?.id) {
            const set = {
              valueCents: item.valueCents ?? 0,
              ...(item.withheldCents !== undefined ? { withheldCents: item.withheldCents } : {}),
              ...(item.prevValueCents !== undefined ? { prevValueCents: item.prevValueCents } : {}),
              ...(item.description ? { description: item.description } : {}),
              ...(item.counterpartyName ? { counterpartyName: item.counterpartyName } : {}),
            };
            await tx.update(declarationItems).set(set).where(eq(declarationItems.id, target.id));
            Object.assign(target, set);
            updated++;
          } else {
            items.push(await insertItem(tx, officeId, declarationId, item, doc));
            inserted++;
          }
        } else {
          // linha nova: confere de novo contra o que já foi aplicado (documentos repetidos)
          const found = items.find((i) => sameLine(item, i));
          if (found && sameValues(item, found)) {
            line.match = 'duplicate';
            line.existingItemId = found.id ?? null;
            changed = true;
            continue;
          }
          if (found) {
            line.match = 'conflict';
            line.existingItemId = found.id ?? null;
            line.existing = { valueCents: found.valueCents ?? 0, withheldCents: found.withheldCents ?? 0, prevValueCents: found.prevValueCents ?? 0, description: found.description ?? null };
            line.decision = null;
            pendingConflicts++;
            changed = true;
            continue;
          }
          items.push(await insertItem(tx, officeId, declarationId, item, doc));
          inserted++;
        }
        line.appliedAt = now;
        changed = true;
      }
      if (changed) await saveExtraction(tx, doc, doc.processingStatus, ex);
    }
    return { inserted, updated, pendingConflicts };
  }

  async function insertItem(tx: DbOrTx, officeId: string, declarationId: string, item: DeclarationItem, doc: DocStat): Promise<DeclarationItem> {
    const [row] = await tx
      .insert(declarationItems)
      .values({
        officeId,
        declarationId,
        kind: item.kind,
        code: item.code ?? null,
        groupCode: item.groupCode ?? null,
        description: item.description ?? null,
        ownerCpf: item.ownerCpf ?? null,
        ownerName: item.ownerName ?? null,
        counterpartyDoc: item.counterpartyDoc ?? null,
        counterpartyName: item.counterpartyName ?? null,
        prevValueCents: item.prevValueCents ?? 0,
        valueCents: item.valueCents ?? 0,
        withheldCents: item.withheldCents ?? 0,
        extra: { ...(item.extra ?? {}), documentId: doc.id, documentName: doc.filename },
        source: 'document',
      })
      .returning();
    return { ...row, kind: row.kind as DeclarationItem['kind'] };
  }

  /** Baixa os pacotes exportados das declarações selecionadas (um .zip; vários viram um .zip de .zips). */
  app.post('/elaboration/download', { preHandler: guard('elaboration.export') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(selectionSchema, req.body);
    const ids = await scopedIds(req, body.customerIds);
    const packages = await db
      .select({ filename: files.filename, size: files.size, storageKey: files.storageKey, createdAt: files.createdAt })
      .from(declarations)
      .innerJoin(files, and(eq(files.id, declarations.exportedFileId), eq(files.officeId, user.officeId)))
      .where(and(eq(declarations.officeId, user.officeId), eq(declarations.exerciseYear, body.year), inArray(declarations.customerId, ids)));
    if (!packages.length) throw notFound('Pacote exportado');
    // em stream: um pacote sai como está; vários viram um .zip montado enquanto é baixado
    if (packages.length === 1) {
      const [p] = packages;
      return sendStoredFile(reply, { filename: p.filename, mimeType: 'application/zip', size: p.size }, await app.ctx.files.stream(p));
    }
    if (packages.reduce((a, p) => a + p.size, 0) > MAX_ZIP_DOWNLOAD_BYTES) throw badRequest('Os pacotes passam de 1 GB. Selecione menos clientes.');
    const used = new Set<string>();
    const entries = packages.map((p) => {
      const base = safeZipName(p.filename);
      let path = base;
      for (let n = 2; used.has(path.toLowerCase()); n++) path = base.replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`);
      used.add(path.toLowerCase());
      return { path, file: p };
    });
    // os pacotes já são .zip: entram sem comprimir de novo
    return sendStoredFile(reply, { filename: `conferencia-${body.year}.zip`, mimeType: 'application/zip' }, zipStoredFiles(app.ctx.files, entries, { compress: false }));
  });

  /** Últimas tarefas de processamento/exportação do escritório. */
  app.get('/elaboration/jobs', { preHandler: guard(...LIST_PERMS) }, async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.officeId, user.officeId), inArray(jobs.type, ['elaboration.process', 'elaboration.export'])))
      .orderBy(desc(jobs.createdAt))
      .limit(5);
    return rows.map(jobView);
  });
}
