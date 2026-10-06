import { and, eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CHECKLIST_FILLABLE_SECTIONS, CHECKLIST_ITEM_STATUS, isValidCpf, onlyDigits, type ChecklistItemStatus, type ChecklistSection } from '@verifco/shared';
import type { AuthUser } from '../../context';
import { checklistItems, checklistSections, checklists, declarations, documents } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { audit, emptyToNull, guard, parse, requirePermission, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { getOrCreateDeclaration } from '../../services/declarations';
import { queueDelivery } from '../../services/delivery';
import { buildChecklistPdf, pdfItems } from './pdf';
import { checklistPublicRoutes } from './public';
import {
  attachFiles,
  buildZip,
  createChecklist,
  loadBundle,
  lockOf,
  officeView,
  previousYearItems,
  refreshFinished,
  removeDocument,
  rotateAccess,
} from './service';
import { readChecklistUploads, sendStoredFile } from './uploads';

const sectionEnum = z.enum(CHECKLIST_FILLABLE_SECTIONS as [ChecklistSection, ...ChecklistSection[]]);
const itemStatusEnum = z.enum(Object.keys(CHECKLIST_ITEM_STATUS) as [ChecklistItemStatus, ...ChecklistItemStatus[]]);
const nullableText = (maxLen: number) => z.preprocess(emptyToNull, z.string().trim().max(maxLen).nullable().optional());

const itemBody = z.object({
  section: sectionEnum,
  title: z.string().trim().min(2, 'Informe o documento').max(200),
  description: nullableText(1000),
  ownerName: nullableText(200),
  ownerCpf: z.preprocess(emptyToNull, z.string().refine(isValidCpf, 'CPF inválido').nullable().optional()),
  status: itemStatusEnum.optional(),
});

const yearQuery = z.object({ year: yearSchema });
const checklistParam = z.object({ checklistId: z.uuid() });
const itemParam = checklistParam.extend({ itemId: z.uuid() });
const docParam = checklistParam.extend({ docId: z.uuid() });

/**
 * Checklist DIRPF digital e em PDF (lado do escritório).
 * As rotas do cliente (link do checklist e portal) ficam em `public.ts`.
 */
export async function checklistRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  await app.register(checklistPublicRoutes);

  /** Carrega o checklist garantindo escritório e visibilidade do cliente para o usuário. */
  async function loadForUser(user: AuthUser, checklistId: string) {
    const [row] = await db
      .select({ checklist: checklists, declaration: declarations })
      .from(checklists)
      .innerJoin(declarations, eq(declarations.id, checklists.declarationId))
      .where(and(eq(checklists.id, checklistId), eq(checklists.officeId, user.officeId)))
      .limit(1);
    if (!row) throw notFound('Checklist');
    const customer = await getCustomerForUser(ctx, user, row.declaration.customerId);
    return { ...row, customer };
  }

  async function itemOf(checklistId: string, itemId: string) {
    const item = await db.query.checklistItems.findFirst({ where: and(eq(checklistItems.id, itemId), eq(checklistItems.checklistId, checklistId)) });
    if (!item) throw notFound('Item');
    return item;
  }

  async function fullView(checklistId: string) {
    const c = await db.query.checklists.findFirst({ where: eq(checklists.id, checklistId) });
    if (!c) throw notFound('Checklist');
    return officeView(c, await loadBundle(db, checklistId));
  }

  // ------------------------------------------------------------------ leitura
  app.get('/customers/:id/checklist', { preHandler: guard('checklist_digital.view', 'checklist_pdf.view') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(yearQuery, req.query);
    const customer = await getCustomerForUser(ctx, user, id);
    const declaration = await db.query.declarations.findFirst({ where: and(eq(declarations.customerId, customer.id), eq(declarations.exerciseYear, year)) });
    const checklist = declaration ? await db.query.checklists.findFirst({ where: eq(checklists.declarationId, declaration.id) }) : null;
    const prev = await previousYearItems(db, customer.id, year);
    return {
      exerciseYear: year,
      declaration: declaration ? { id: declaration.id, stage: declaration.stage, substatus: declaration.substatus, checklistLocked: declaration.checklistLocked } : null,
      lock: await lockOf(db, user.officeId, declaration ?? { substatus: 'not_started', checklistLocked: false }),
      previous: { exerciseYear: year - 1, hasDeclaration: Boolean(prev.declaration), items: prev.items.length },
      contact: { email: customer.email, mobile: customer.mobile },
      checklist: checklist ? officeView(checklist, await loadBundle(db, checklist.id)) : null,
    };
  });

  // ------------------------------------------------------------------ criação e exclusão
  app.post('/customers/:id/checklist', { preHandler: guard('checklist_digital.create') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(yearQuery, req.body);
    const customer = await getCustomerForUser(ctx, user, id);
    const declaration = await getOrCreateDeclaration(db, user.officeId, customer.id, year);
    const created = await createChecklist(db, { officeId: user.officeId, customer, declaration });
    await audit(req, 'create', 'checklist', created.checklist.id, { year, items: created.total, fromPreviousYear: created.fromPreviousYear });
    reply.status(201);
    return fullView(created.checklist.id);
  });

  app.delete('/checklists/:checklistId', { preHandler: guard('checklist_digital.create') }, async (req) => {
    const user = requireUser(req);
    const { checklistId } = parse(checklistParam, req.params);
    const { checklist, customer } = await loadForUser(user, checklistId);
    // os arquivos já enviados continuam nos documentos do cliente
    await db.delete(checklists).where(eq(checklists.id, checklist.id));
    await audit(req, 'delete', 'checklist', checklist.id, { customerId: customer.id });
    return { ok: true };
  });

  // ------------------------------------------------------------------ itens
  app.post('/checklists/:checklistId/items', { preHandler: guard('checklist_digital.edit') }, async (req, reply) => {
    const user = requireUser(req);
    const { checklistId } = parse(checklistParam, req.params);
    const body = parse(itemBody, req.body);
    await loadForUser(user, checklistId);
    const [{ last }] = await db.select({ last: max(checklistItems.sortOrder) }).from(checklistItems).where(eq(checklistItems.checklistId, checklistId));
    await db.insert(checklistItems).values({
      checklistId,
      section: body.section,
      title: body.title,
      description: body.description ?? null,
      ownerName: body.ownerName ?? null,
      ownerCpf: body.ownerCpf ? onlyDigits(body.ownerCpf) : null,
      status: body.status ?? 'pending',
      createdBy: 'office',
      sortOrder: (last ?? 0) + 1,
    });
    reply.status(201);
    return fullView(checklistId);
  });

  app.put('/checklists/:checklistId/items/:itemId', { preHandler: guard('checklist_digital.edit') }, async (req) => {
    const user = requireUser(req);
    const { checklistId, itemId } = parse(itemParam, req.params);
    const body = parse(itemBody.partial(), req.body);
    await loadForUser(user, checklistId);
    await itemOf(checklistId, itemId);
    await db
      .update(checklistItems)
      .set({
        ...(body.section !== undefined && { section: body.section }),
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.ownerName !== undefined && { ownerName: body.ownerName }),
        ...(body.ownerCpf !== undefined && { ownerCpf: body.ownerCpf ? onlyDigits(body.ownerCpf) : null }),
        ...(body.status !== undefined && { status: body.status }),
      })
      .where(eq(checklistItems.id, itemId));
    return fullView(checklistId);
  });

  app.delete('/checklists/:checklistId/items/:itemId', { preHandler: guard('checklist_digital.edit') }, async (req) => {
    const user = requireUser(req);
    const { checklistId, itemId } = parse(itemParam, req.params);
    await loadForUser(user, checklistId);
    const item = await itemOf(checklistId, itemId);
    // documentos enviados continuam guardados nos documentos do cliente (vínculo é desfeito)
    await db.delete(checklistItems).where(eq(checklistItems.id, item.id));
    await audit(req, 'delete_item', 'checklist', checklistId, { title: item.title });
    return fullView(checklistId);
  });

  // ------------------------------------------------------------------ arquivos
  app.post('/checklists/:checklistId/items/:itemId/files', { preHandler: guard('checklist_digital.upload') }, async (req, reply) => {
    const user = requireUser(req);
    const { checklistId, itemId } = parse(itemParam, req.params);
    const { declaration, customer } = await loadForUser(user, checklistId);
    const item = await itemOf(checklistId, itemId);
    const uploads = await readChecklistUploads(req);
    await attachFiles(ctx, { officeId: user.officeId, customerId: customer.id, declarationId: declaration.id, itemId: item.id, uploadedBy: 'office', userId: user.userId, uploads });
    if (item.status === 'pending') await db.update(checklistItems).set({ status: 'sent' }).where(eq(checklistItems.id, item.id));
    reply.status(201);
    return fullView(checklistId);
  });

  async function docOf(checklistId: string, docId: string) {
    const [row] = await db
      .select({ doc: documents, item: checklistItems })
      .from(documents)
      .innerJoin(checklistItems, eq(checklistItems.id, documents.checklistItemId))
      .where(and(eq(documents.id, docId), eq(checklistItems.checklistId, checklistId)))
      .limit(1);
    if (!row) throw notFound('Arquivo');
    return row.doc;
  }

  app.get('/checklists/:checklistId/files/:docId', { preHandler: guard('checklist_digital.download') }, async (req, reply) => {
    const user = requireUser(req);
    const { checklistId, docId } = parse(docParam, req.params);
    await loadForUser(user, checklistId);
    const doc = await docOf(checklistId, docId);
    const { row, data } = await ctx.files.get(user.officeId, doc.fileId);
    return sendStoredFile(reply, row, data, (req.query as Record<string, string>).inline === '1');
  });

  app.delete('/checklists/:checklistId/files/:docId', { preHandler: guard('checklist_digital.upload') }, async (req) => {
    const user = requireUser(req);
    const { checklistId, docId } = parse(docParam, req.params);
    await loadForUser(user, checklistId);
    const doc = await docOf(checklistId, docId);
    await removeDocument(ctx, user.officeId, doc);
    await audit(req, 'delete_file', 'checklist', checklistId, { documentId: doc.id });
    return fullView(checklistId);
  });

  app.get('/checklists/:checklistId/zip', { preHandler: guard('checklist_digital.download') }, async (req, reply) => {
    const user = requireUser(req);
    const { checklistId } = parse(checklistParam, req.params);
    const { declaration, customer } = await loadForUser(user, checklistId);
    const { buffer, count } = await buildZip(ctx, user.officeId, await loadBundle(db, checklistId));
    if (!count) throw badRequest('Ainda não há arquivos neste checklist.');
    const name = `checklist-${declaration.exerciseYear}-${customer.name.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'cliente'}.zip`;
    await audit(req, 'download_zip', 'checklist', checklistId, { files: count });
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${name}"`).send(buffer);
  });

  // ------------------------------------------------------------------ seções, bloqueio e acesso
  app.post('/checklists/:checklistId/sections/:section/reopen', { preHandler: guard('checklist_digital.edit') }, async (req) => {
    const user = requireUser(req);
    const { checklistId, section } = parse(checklistParam.extend({ section: sectionEnum }), req.params);
    await loadForUser(user, checklistId);
    const updated = await db
      .update(checklistSections)
      .set({ status: 'open', finishedAt: null })
      .where(and(eq(checklistSections.checklistId, checklistId), eq(checklistSections.section, section)))
      .returning();
    if (!updated.length) throw notFound('Seção');
    await refreshFinished(db, checklistId);
    await audit(req, 'reopen_section', 'checklist', checklistId, { section });
    return fullView(checklistId);
  });

  app.put('/checklists/:checklistId/lock', { preHandler: guard('checklist_digital.edit') }, async (req) => {
    const user = requireUser(req);
    const { checklistId } = parse(checklistParam, req.params);
    const { locked } = parse(z.object({ locked: z.boolean() }), req.body);
    const { declaration } = await loadForUser(user, checklistId);
    const [d] = await db.update(declarations).set({ checklistLocked: locked, updatedAt: new Date() }).where(eq(declarations.id, declaration.id)).returning();
    await audit(req, locked ? 'lock' : 'unlock', 'checklist', checklistId);
    return { locked: d.checklistLocked, lock: await lockOf(db, user.officeId, d) };
  });

  /**
   * Gera um novo link e código de acesso e envia pelos canais escolhidos.
   * Só os hashes ficam gravados; por isso cada envio gera um par novo e os anteriores deixam de valer.
   * Sem canais, apenas gera (para o escritório repassar ao cliente).
   */
  app.post('/checklists/:checklistId/access', { preHandler: guard('checklist_digital.send') }, async (req) => {
    const user = requireUser(req);
    const { checklistId } = parse(checklistParam, req.params);
    const { channels } = parse(z.object({ channels: z.array(z.enum(['email', 'whatsapp'])).max(2).default([]) }), req.body);
    const { declaration, customer } = await loadForUser(user, checklistId);
    const unique = [...new Set(channels)];
    if (unique.includes('email') && !customer.email) throw badRequest('O cliente não tem e-mail cadastrado.');
    if (unique.includes('whatsapp') && !customer.mobile) throw badRequest('O cliente não tem celular cadastrado.');
    const { token, code } = await rotateAccess(db, checklistId);
    const link = `${ctx.config.WEB_URL.replace(/\/$/, '')}/checklist/${token}`;
    for (const channel of unique) {
      await queueDelivery(ctx, {
        officeId: user.officeId,
        customerId: customer.id,
        channel,
        templateKey: 'checklist_digital',
        values: { LINK: link, CODIGO: code },
        exerciseYear: declaration.exerciseYear,
        userId: user.userId,
      });
    }
    if (unique.length) await db.update(checklists).set({ sentAt: new Date() }).where(eq(checklists.id, checklistId));
    await audit(req, unique.length ? 'send_access' : 'regenerate_access', 'checklist', checklistId, { channels: unique });
    return { link, code, channels: unique };
  });

  // ------------------------------------------------------------------ checklist em PDF
  app.get('/customers/:id/checklist-pdf', async (req, reply) => {
    const q = parse(yearQuery.extend({ inline: z.enum(['0', '1']).optional() }), req.query);
    const inline = q.inline === '1';
    const user = requirePermission(req, inline ? 'checklist_pdf.view' : 'checklist_pdf.download');
    const { id } = parse(uuidParam, req.params);
    const customer = await getCustomerForUser(ctx, user, id);
    const declaration = await db.query.declarations.findFirst({ where: and(eq(declarations.customerId, customer.id), eq(declarations.exerciseYear, q.year)) });
    const pdf = await buildChecklistPdf(ctx, customer, q.year, await pdfItems(ctx, customer, declaration ?? null, q.year));
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="checklist-irpf-${q.year}.pdf"`)
      .send(pdf);
  });

  app.post('/customers/:id/checklist-pdf/send', { preHandler: guard('checklist_pdf.send') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ year: yearSchema, channel: z.enum(['email', 'whatsapp']) }), req.body);
    const customer = await getCustomerForUser(ctx, user, id);
    if (body.channel === 'email' && !customer.email) throw badRequest('O cliente não tem e-mail cadastrado.');
    if (body.channel === 'whatsapp' && !customer.mobile) throw badRequest('O cliente não tem celular cadastrado.');
    const declaration = await db.query.declarations.findFirst({ where: and(eq(declarations.customerId, customer.id), eq(declarations.exerciseYear, body.year)) });
    const pdf = await buildChecklistPdf(ctx, customer, body.year, await pdfItems(ctx, customer, declaration ?? null, body.year));
    const filename = `checklist-irpf-${body.year}.pdf`;
    const saved = await ctx.files.save({ officeId: user.officeId, data: pdf, filename, mimeType: 'application/pdf', userId: user.userId });
    const delivery = await queueDelivery(ctx, {
      officeId: user.officeId,
      customerId: customer.id,
      channel: body.channel,
      templateKey: 'checklist_pdf',
      exerciseYear: body.year,
      attachments: [{ fileId: saved.id, filename }],
      userId: user.userId,
    });
    await audit(req, 'send_pdf', 'checklist', null, { customerId: customer.id, year: body.year, channel: body.channel });
    return { ok: true, deliveryId: delivery.id };
  });
}
