import { and, count, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CHECKLIST_FILLABLE_SECTIONS,
  CHECKLIST_FINISH_OPTIONS,
  CHECKLIST_SECTIONS,
  onlyDigits,
  stageOfSubstatus,
  type ChecklistSection,
  type DeclarationSubstatus,
} from '@verifco/shared';
import { checklistItems, checklistSections, checklists, customers, declarations, documents, offices } from '../../db/schema';
import { safeEqual, sha256 } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { emptyToNull, parse } from '../../lib/http';
import { signCustomerToken } from '../../plugins/auth';
import { setDeclarationSubstatus } from '../../services/declarations';
import { CUSTOMER_LOGIN_RULE, check, fail, resetLimit } from '../../services/rate-limit';
import { requireChecklistAccess } from '../portal/access';
import { attachFiles, checklistAccessValid, checklistCodeHash, customerView, loadBundle, lockOf, notifyOffice, refreshFinished, removeDocument } from './service';
import { sendStoredFile } from '../../services/uploads';
import { readChecklistUploads } from './uploads';

const sectionEnum = z.enum(CHECKLIST_FILLABLE_SECTIONS as [ChecklistSection, ...ChecklistSection[]]);
const idParam = z.object({ id: z.uuid() });
const itemParam = idParam.extend({ itemId: z.uuid() });
const docParam = idParam.extend({ docId: z.uuid() });
const sectionParam = idParam.extend({ section: sectionEnum });
const note = z.preprocess(emptyToNull, z.string().trim().max(2000).nullable().optional());

const MAX_CUSTOMER_ITEMS = 100;

/**
 * Checklist do lado do cliente. Entra-se pelo link (`/checklist/<token>`) com CPF + código,
 * ou pelo portal. O cliente só enxerga e altera o próprio checklist.
 */
export async function checklistPublicRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  async function byLinkToken(token: string) {
    const c = await db.query.checklists.findFirst({ where: eq(checklists.accessTokenHash, sha256(token)) });
    // link vencido vale como inexistente: o escritório precisa enviar um novo acesso
    if (!c || !checklistAccessValid(c)) return null;
    const declaration = await db.query.declarations.findFirst({ where: eq(declarations.id, c.declarationId) });
    const customer = declaration ? await db.query.customers.findFirst({ where: eq(customers.id, declaration.customerId) }) : null;
    if (!declaration || !customer || customer.deletedAt) return null;
    return { checklist: c, declaration, customer };
  }

  /** Checklist do cliente logado (token do link ou do portal). */
  async function loadForCustomer(req: FastifyRequest, checklistId: string) {
    const auth = requireChecklistAccess(req, checklistId);
    const [row] = await db
      .select({ checklist: checklists, declaration: declarations, customer: customers })
      .from(checklists)
      .innerJoin(declarations, eq(declarations.id, checklists.declarationId))
      .innerJoin(customers, eq(customers.id, declarations.customerId))
      .where(and(eq(checklists.id, checklistId), eq(checklists.officeId, auth.officeId), eq(declarations.customerId, auth.customerId)))
      .limit(1);
    if (!row) throw notFound('Checklist');
    // sessão aberta pelo link: termina junto com a validade do link (o portal tem acesso próprio)
    if (auth.scope !== 'portal' && !checklistAccessValid(row.checklist)) {
      throw unauthorized('O link do checklist venceu. Peça um novo acesso ao escritório.');
    }
    const lock = await lockOf(db, row.checklist.officeId, row.declaration);
    return { ...row, lock };
  }

  async function view(checklistId: string, req: FastifyRequest) {
    const { checklist, declaration, customer, lock } = await loadForCustomer(req, checklistId);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, checklist.officeId) });
    return customerView(checklist, await loadBundle(db, checklist.id), { exerciseYear: declaration.exerciseYear, officeName: office?.name ?? '', customerName: customer.name, lock });
  }

  type Loaded = Awaited<ReturnType<typeof loadForCustomer>>;

  function assertEditable(l: Loaded) {
    if (l.lock.readOnly) throw forbidden(l.lock.customerReason ?? 'O checklist está disponível só para consulta.');
  }

  async function openSection(l: Loaded, section: string) {
    const s = await db.query.checklistSections.findFirst({ where: and(eq(checklistSections.checklistId, l.checklist.id), eq(checklistSections.section, section)) });
    if (!s) throw notFound('Seção');
    if (s.status !== 'open') throw conflict('Esta seção já foi finalizada. Se precisar mudar algo, fale com o escritório.');
    return s;
  }

  async function itemOf(l: Loaded, itemId: string) {
    const item = await db.query.checklistItems.findFirst({ where: and(eq(checklistItems.id, itemId), eq(checklistItems.checklistId, l.checklist.id)) });
    if (!item) throw notFound('Item');
    return item;
  }

  // ------------------------------------------------------------------ entrada pelo link
  /** Dados públicos do link (escritório e ano), para a tela de entrada. */
  app.post('/portal/checklist-link', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(16).max(200) }), req.body);
    const found = await byLinkToken(token);
    if (!found) throw notFound('Link');
    const office = await db.query.offices.findFirst({ where: eq(offices.id, found.checklist.officeId) });
    return { officeName: office?.name ?? '', exerciseYear: found.declaration.exerciseYear };
  });

  app.post('/portal/checklist-login', async (req) => {
    const body = parse(z.object({ token: z.string().min(16).max(200), cpf: z.string().max(20), code: z.string().max(12) }), req.body);
    // falhas por link no banco (valem para todas as instâncias), além do limite por IP de app.ts
    const key = `checklist:${sha256(body.token)}`;
    await check(ctx, key, CUSTOMER_LOGIN_RULE);
    const found = await byLinkToken(body.token);
    if (!found) {
      await fail(ctx, key, CUSTOMER_LOGIN_RULE);
      throw notFound('Link');
    }
    const { checklist, customer } = found;
    const cpfOk = onlyDigits(body.cpf) === customer.cpfCnpj;
    const codeOk = safeEqual(checklist.accessCodeHash, checklistCodeHash(checklist.id, onlyDigits(body.code)));
    if (!cpfOk || !codeOk) {
      await fail(ctx, key, CUSTOMER_LOGIN_RULE);
      throw unauthorized('CPF ou código incorretos. Confira os dados que o escritório enviou.');
    }
    await resetLimit(ctx, key);
    await db.update(checklists).set({ lastCustomerAccessAt: new Date() }).where(eq(checklists.id, checklist.id));
    return { token: signCustomerToken(app, customer, `checklist:${checklist.id}`), checklistId: checklist.id };
  });

  // ------------------------------------------------------------------ consulta
  app.get('/portal/checklists/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const l = await loadForCustomer(req, id);
    await db.update(checklists).set({ lastCustomerAccessAt: new Date() }).where(eq(checklists.id, l.checklist.id));
    return view(id, req);
  });

  // ------------------------------------------------------------------ itens
  app.put('/portal/checklists/:id/items/:itemId', async (req) => {
    const { id, itemId } = parse(itemParam, req.params);
    const body = parse(z.object({ status: z.enum(['pending', 'sent', 'not_applicable', 'removed']).optional(), customerNote: note }), req.body);
    const l = await loadForCustomer(req, id);
    assertEditable(l);
    const item = await itemOf(l, itemId);
    await openSection(l, item.section);
    if (body.status === 'removed' && !item.fromPreviousYear) throw badRequest('Use “Não se aplica” para itens que não vieram do ano anterior.');
    await db
      .update(checklistItems)
      .set({
        ...(body.status !== undefined && { status: body.status }),
        ...(body.customerNote !== undefined && { customerNote: body.customerNote }),
      })
      .where(eq(checklistItems.id, item.id));
    return view(id, req);
  });

  /** "Outro documento": item criado pelo próprio cliente numa seção aberta. */
  app.post('/portal/checklists/:id/items', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ section: sectionEnum, title: z.string().trim().min(2, 'Diga que documento é este').max(200), description: z.preprocess(emptyToNull, z.string().trim().max(1000).nullable().optional()) }),
      req.body,
    );
    const l = await loadForCustomer(req, id);
    assertEditable(l);
    await openSection(l, body.section);
    const [{ n }] = await db.select({ n: count() }).from(checklistItems).where(and(eq(checklistItems.checklistId, l.checklist.id), eq(checklistItems.createdBy, 'customer')));
    if (n >= MAX_CUSTOMER_ITEMS) throw badRequest('Você já incluiu muitos documentos avulsos. Use os itens existentes ou fale com o escritório.');
    const [item] = await db
      .insert(checklistItems)
      .values({ checklistId: l.checklist.id, section: body.section, title: body.title, description: body.description ?? null, createdBy: 'customer', sortOrder: 10_000 + n })
      .returning();
    reply.status(201);
    return { itemId: item.id, checklist: await view(id, req) };
  });

  app.delete('/portal/checklists/:id/items/:itemId', async (req) => {
    const { id, itemId } = parse(itemParam, req.params);
    const l = await loadForCustomer(req, id);
    assertEditable(l);
    const item = await itemOf(l, itemId);
    if (item.createdBy !== 'customer') throw forbidden('Só é possível excluir documentos que você mesmo incluiu.');
    await openSection(l, item.section);
    const docs = await db.select().from(documents).where(eq(documents.checklistItemId, item.id));
    for (const d of docs) await removeDocument(ctx, l.checklist.officeId, d);
    await db.delete(checklistItems).where(eq(checklistItems.id, item.id));
    return view(id, req);
  });

  // ------------------------------------------------------------------ arquivos
  app.post('/portal/checklists/:id/items/:itemId/files', async (req, reply) => {
    const { id, itemId } = parse(itemParam, req.params);
    const l = await loadForCustomer(req, id);
    assertEditable(l);
    const item = await itemOf(l, itemId);
    await openSection(l, item.section);
    const uploads = await readChecklistUploads(req);
    await attachFiles(ctx, { officeId: l.checklist.officeId, customerId: l.customer.id, declarationId: l.declaration.id, itemId: item.id, uploadedBy: 'customer', uploads });
    await db.update(checklistItems).set({ status: 'sent' }).where(eq(checklistItems.id, item.id));
    reply.status(201);
    return view(id, req);
  });

  async function docOf(l: Loaded, docId: string) {
    const items = await db.select({ id: checklistItems.id }).from(checklistItems).where(eq(checklistItems.checklistId, l.checklist.id));
    const doc = items.length
      ? await db.query.documents.findFirst({
          where: and(eq(documents.id, docId), eq(documents.customerId, l.customer.id), inArray(documents.checklistItemId, items.map((i) => i.id))),
        })
      : undefined;
    if (!doc) throw notFound('Arquivo');
    return doc;
  }

  app.get('/portal/checklists/:id/files/:docId', async (req, reply) => {
    const { id, docId } = parse(docParam, req.params);
    const l = await loadForCustomer(req, id);
    const doc = await docOf(l, docId);
    const { row, data } = await ctx.files.get(l.checklist.officeId, doc.fileId);
    return sendStoredFile(reply, row, data, (req.query as Record<string, string>).inline === '1');
  });

  app.delete('/portal/checklists/:id/files/:docId', async (req) => {
    const { id, docId } = parse(docParam, req.params);
    const l = await loadForCustomer(req, id);
    assertEditable(l);
    const doc = await docOf(l, docId);
    if (doc.uploadedBy !== 'customer') throw forbidden('Este arquivo foi enviado pelo escritório e não pode ser excluído.');
    const item = doc.checklistItemId ? await itemOf(l, doc.checklistItemId) : null;
    if (item) await openSection(l, item.section);
    await removeDocument(ctx, l.checklist.officeId, doc);
    return view(id, req);
  });

  // ------------------------------------------------------------------ finalização de seções
  app.post('/portal/checklists/:id/sections/:section/finish', async (req) => {
    const { id, section } = parse(sectionParam, req.params);
    const body = parse(
      z.object({ status: z.enum(CHECKLIST_FINISH_OPTIONS.map((o) => o.value) as ['done', 'pending_documents', 'no_documents']), note }),
      req.body,
    );
    const l = await loadForCustomer(req, id);
    assertEditable(l);
    await openSection(l, section);
    const items = await db.select().from(checklistItems).where(and(eq(checklistItems.checklistId, l.checklist.id), eq(checklistItems.section, section)));
    const pending = items.filter((i) => i.status === 'pending');
    if (body.status === 'done' && pending.length) {
      throw badRequest(`Ainda há ${pending.length} item(ns) pendente(s) nesta seção. Envie os documentos, marque “Não se aplica” ou finalize como “Com documentos pendentes”.`);
    }
    if (body.status === 'no_documents' && pending.length) {
      await db.update(checklistItems).set({ status: 'not_applicable' }).where(inArray(checklistItems.id, pending.map((i) => i.id)));
    }
    await db
      .update(checklistSections)
      .set({ status: body.status, note: body.note ?? null, finishedAt: new Date() })
      .where(and(eq(checklistSections.checklistId, l.checklist.id), eq(checklistSections.section, section)));

    // pendências: a declaração em preenchimento passa para "Documentos faltantes"
    if (body.status === 'pending_documents' && stageOfSubstatus(l.declaration.substatus as DeclarationSubstatus) === 'filling' && l.declaration.substatus !== 'missing_documents') {
      await setDeclarationSubstatus(db, l.declaration.id, 'missing_documents');
    }

    const label = CHECKLIST_SECTIONS[section];
    const statusLabel = CHECKLIST_FINISH_OPTIONS.find((o) => o.value === body.status)?.label ?? body.status;
    const link = `/clientes/${l.customer.id}/irpf/documentacao`;
    await notifyOffice(db, l.customer, `${l.customer.name} finalizou “${label}” no checklist`, `${statusLabel}${body.note ? ` — ${body.note.slice(0, 200)}` : ''}`, link);
    if (await refreshFinished(db, l.checklist.id)) {
      await notifyOffice(db, l.customer, `${l.customer.name} concluiu o checklist ${l.declaration.exerciseYear}`, 'Todas as seções foram finalizadas.', link);
    }
    return view(id, req);
  });

  /** O cliente pode voltar a uma seção que deixou "com documentos pendentes" para completar. */
  app.post('/portal/checklists/:id/sections/:section/reopen', async (req) => {
    const { id, section } = parse(sectionParam, req.params);
    const l = await loadForCustomer(req, id);
    assertEditable(l);
    const s = await db.query.checklistSections.findFirst({ where: and(eq(checklistSections.checklistId, l.checklist.id), eq(checklistSections.section, section)) });
    if (!s) throw notFound('Seção');
    if (s.status !== 'pending_documents') throw conflict('Só é possível retomar seções que ficaram com documentos pendentes. Para outras mudanças, fale com o escritório.');
    await db.update(checklistSections).set({ status: 'open', finishedAt: null }).where(eq(checklistSections.id, s.id));
    await refreshFinished(db, l.checklist.id);
    return view(id, req);
  });
}
