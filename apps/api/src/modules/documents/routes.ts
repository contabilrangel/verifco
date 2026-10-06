import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DOCUMENT_CATEGORY_LIST, formatCpfCnpj, type DocumentCategory } from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { customers, declarations, documents, files } from '../../db/schema';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { customerScope, getCustomerForUser } from '../../services/customers';
import { getOrCreateDeclaration } from '../../services/declarations';
import { DOCUMENT_TYPES, readUploads, sendStoredFile } from '../../services/uploads';
import { MAX_ZIP_DOWNLOAD_BYTES, zipStoredFiles, type StoredZipEntry } from '../../storage/zip';
import { refreshElaborationStatus } from '../elaboration/service';

const categoryEnum = z.enum(DOCUMENT_CATEGORY_LIST as [DocumentCategory, ...DocumentCategory[]]);

/** Nome seguro para pastas e arquivos dentro do .zip. */
const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'arquivo';

async function getDocumentForUser(ctx: AppContext, user: AuthUser, id: string) {
  const doc = await ctx.db.query.documents.findFirst({ where: and(eq(documents.id, id), eq(documents.officeId, user.officeId)) });
  if (!doc) throw notFound('Documento');
  await getCustomerForUser(ctx, user, doc.customerId).catch((err) => {
    throw err instanceof HttpError && err.statusCode === 404 ? notFound('Documento') : err;
  });
  return doc;
}

/**
 * Arquivos do cliente por exercício. A origem (`uploadedBy`) diz quem enviou:
 * escritório (aqui), cliente (checklist/portal) ou sincronização.
 */
export async function documentRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  const selectDocs = (where: SQL) =>
    db
      .select({
        id: documents.id,
        customerId: documents.customerId,
        declarationId: documents.declarationId,
        exerciseYear: declarations.exerciseYear,
        fileId: documents.fileId,
        filename: files.filename,
        mimeType: files.mimeType,
        size: files.size,
        category: documents.category,
        uploadedBy: documents.uploadedBy,
        processingStatus: documents.processingStatus,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .leftJoin(declarations, eq(declarations.id, documents.declarationId))
      .where(where);

  app.get('/customers/:id/documents', { preHandler: guard('declaration.view', 'customer.download_documents') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(z.object({ year: yearSchema.optional() }), req.query);
    const customer = await getCustomerForUser(app.ctx, user, id);
    const conds: SQL[] = [eq(documents.customerId, customer.id), eq(documents.officeId, user.officeId)];
    if (year) conds.push(eq(declarations.exerciseYear, year));
    return selectDocs(and(...conds)!).orderBy(desc(documents.createdAt));
  });

  /** Upload múltiplo. Campos do formulário: `category` (opcional) antes ou depois dos arquivos. */
  app.post('/customers/:id/documents', { preHandler: guard('declaration.edit') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(z.object({ year: yearSchema }), req.query);
    const customer = await getCustomerForUser(app.ctx, user, id);
    // o tipo gravado vem da extensão conferida com o conteúdo; desconhecidos viram binário (só download)
    const { files: received, fields } = await readUploads(req, { types: DOCUMENT_TYPES, unknown: 'octet-stream' });
    const category: DocumentCategory = fields.category ? parse(categoryEnum, fields.category) : 'other';
    if (!received.length) throw badRequest('Selecione ao menos um arquivo.');
    const declaration = await getOrCreateDeclaration(db, user.officeId, customer.id, year);
    const created = [];
    for (const f of received) {
      const saved = await app.ctx.files.save({ officeId: user.officeId, data: f.data, filename: f.filename, mimeType: f.mimeType, userId: user.userId });
      const [doc] = await db
        .insert(documents)
        .values({ officeId: user.officeId, customerId: customer.id, declarationId: declaration.id, fileId: saved.id, category, uploadedBy: 'office' })
        .returning();
      created.push({ ...doc, filename: saved.filename, mimeType: saved.mimeType, size: saved.size, exerciseYear: year });
    }
    await refreshElaborationStatus(db, declaration.id);
    await audit(req, 'upload', 'document', customer.id, { count: created.length, year });
    reply.status(201);
    return created;
  });

  app.patch('/documents/:id', { preHandler: guard('declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { category } = parse(z.object({ category: categoryEnum }), req.body);
    const doc = await getDocumentForUser(app.ctx, user, id);
    const [row] = await db.update(documents).set({ category }).where(eq(documents.id, doc.id)).returning();
    await audit(req, 'update', 'document', doc.id, { category, from: doc.category });
    // a categoria conta nos arquivos do programa IRPF da elaboração
    if (doc.declarationId) await refreshElaborationStatus(db, doc.declarationId);
    return row;
  });

  app.delete('/documents/:id', { preHandler: guard('declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const doc = await getDocumentForUser(app.ctx, user, id);
    // o documento é apagado em cascata com o arquivo
    await app.ctx.files.remove(user.officeId, doc.fileId);
    await db.delete(documents).where(eq(documents.id, doc.id));
    if (doc.declarationId) await refreshElaborationStatus(db, doc.declarationId);
    await audit(req, 'delete', 'document', doc.id);
    return { ok: true };
  });

  app.get('/documents/:id/file', { preHandler: guard('declaration.view', 'customer.download_documents') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const doc = await getDocumentForUser(app.ctx, user, id);
    const { row, stream } = await app.ctx.files.open(user.officeId, doc.fileId);
    return sendStoredFile(reply, row, stream, (req.query as Record<string, string>).inline === '1');
  });

  /** Baixa os documentos de vários clientes num .zip, com uma pasta por cliente. */
  app.post('/documents/zip', { preHandler: guard('customer.download_documents') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ customerIds: z.array(z.uuid()).min(1).max(2000), year: yearSchema.optional() }), req.body);
    const scope = await customerScope(app.ctx, user);
    const visible = await db
      .select({ id: customers.id, name: customers.name, cpfCnpj: customers.cpfCnpj })
      .from(customers)
      .where(and(scope, inArray(customers.id, body.customerIds)))
      .orderBy(asc(customers.name));
    if (!visible.length) throw notFound('Cliente');
    const conds: SQL[] = [eq(documents.officeId, user.officeId), inArray(documents.customerId, visible.map((c) => c.id))];
    if (body.year) conds.push(eq(declarations.exerciseYear, body.year));
    // a chave do armazenamento fica só aqui (a listagem não a devolve)
    const docs = await db
      .select({ customerId: documents.customerId, exerciseYear: declarations.exerciseYear, filename: files.filename, size: files.size, storageKey: files.storageKey, createdAt: files.createdAt })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .leftJoin(declarations, eq(declarations.id, documents.declarationId))
      .where(and(...conds))
      .orderBy(asc(documents.createdAt));
    if (!docs.length) throw badRequest(body.year ? `Nenhum documento do exercício ${body.year} para os clientes selecionados.` : 'Nenhum documento para os clientes selecionados.');
    const totalSize = docs.reduce((a, d) => a + d.size, 0);
    if (totalSize > MAX_ZIP_DOWNLOAD_BYTES) throw badRequest('Os arquivos passam de 1 GB. Selecione menos clientes.');

    const entries: StoredZipEntry[] = [];
    const used = new Set<string>();
    for (const c of visible) {
      const mine = docs.filter((d) => d.customerId === c.id);
      if (!mine.length) continue;
      const folder = safeName(`${c.name} - ${formatCpfCnpj(c.cpfCnpj)}`);
      for (const d of mine) {
        const sub = body.year ? '' : `${d.exerciseYear ?? 'sem-exercicio'}/`;
        const base = safeName(d.filename);
        const dot = base.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
        let path = `${folder}/${sub}${base}`;
        for (let n = 2; used.has(path.toLowerCase()); n++) path = `${folder}/${sub}${stem} (${n})${ext}`;
        used.add(path.toLowerCase());
        entries.push({ path, file: { storageKey: d.storageKey, createdAt: d.createdAt } });
      }
    }
    await audit(req, 'download_zip', 'document', null, { customers: visible.length, files: docs.length, year: body.year ?? null });
    const name = body.year ? `documentos-${body.year}.zip` : 'documentos.zip';
    // montado em stream enquanto é baixado: cada arquivo é lido do armazenamento na sua vez
    return sendStoredFile(reply, { filename: name, mimeType: 'application/zip' }, zipStoredFiles(app.ctx.files, entries));
  });
}
