import JSZip from 'jszip';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  CHECKLIST_FILLABLE_SECTIONS,
  CHECKLIST_SECTIONS,
  CHECKLIST_SECTION_HINTS,
  buildChecklistDrafts,
  checklistLock,
  checklistProgress,
  type ChecklistLock,
  type ChecklistSection,
} from '@verifco/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { checklistItems, checklistSections, checklists, customers, declarations, documents, files } from '../../db/schema';
import { randomCode, randomToken, sha256 } from '../../lib/crypto';
import { conflict } from '../../lib/errors';
import { getOrCreateDeclaration, listItems } from '../../services/declarations';
import { getOfficeSettings } from '../../services/settings';
import { notify } from '../../services/notify';
import { safeFilename, type UploadedFile } from '../../services/uploads';

export type ChecklistRow = typeof checklists.$inferSelect;
export type SectionRow = typeof checklistSections.$inferSelect;
export type ItemRow = typeof checklistItems.$inferSelect;
export type DeclarationRow = typeof declarations.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;

export const sectionOrder = (s: string) => {
  const i = CHECKLIST_FILLABLE_SECTIONS.indexOf(s as ChecklistSection);
  return i < 0 ? 99 : i;
};

/** Hash do código: amarrado ao checklist, como o código do portal é amarrado ao cliente. */
export const checklistCodeHash = (checklistId: string, code: string) => sha256(`${checklistId}:${code}`);

/** Linhas da declaração do exercício anterior (base do checklist). */
export async function previousYearItems(db: Db, customerId: string, exerciseYear: number) {
  const prev = await db.query.declarations.findFirst({
    where: and(eq(declarations.customerId, customerId), eq(declarations.exerciseYear, exerciseYear - 1)),
  });
  const items = prev ? await listItems(db, prev.id) : [];
  return { declaration: prev ?? null, items };
}

/**
 * Cria o checklist do exercício com os dados do ano anterior no momento da criação.
 * Mudanças posteriores nos dados do ano anterior não entram no checklist já criado.
 */
export async function createChecklist(db: Db, input: { officeId: string; customer: CustomerRow; declaration: DeclarationRow }) {
  const existing = await db.query.checklists.findFirst({ where: eq(checklists.declarationId, input.declaration.id) });
  if (existing) throw conflict('O checklist deste exercício já foi criado.');
  const prev = await previousYearItems(db, input.customer.id, input.declaration.exerciseYear);
  const drafts = buildChecklistDrafts(prev.items, { customerCpf: input.customer.cpfCnpj, hasPreviousDeclaration: Boolean(prev.declaration) });
  return db.transaction(async (tx) => {
    // token e código iniciais ficam inutilizáveis: o acesso real é gerado no envio
    const [row] = await tx
      .insert(checklists)
      .values({ officeId: input.officeId, declarationId: input.declaration.id, accessTokenHash: sha256(randomToken()), accessCodeHash: sha256(randomToken()) })
      .returning();
    await tx.insert(checklistSections).values(CHECKLIST_FILLABLE_SECTIONS.map((section) => ({ checklistId: row.id, section })));
    if (drafts.length) {
      await tx.insert(checklistItems).values(
        drafts.map((d, i) => ({
          checklistId: row.id,
          section: d.section,
          title: d.title,
          description: d.description,
          ownerName: d.ownerName,
          ownerCpf: d.ownerCpf,
          fromPreviousYear: d.fromPreviousYear,
          createdBy: 'system',
          sortOrder: i,
        })),
      );
    }
    return { checklist: row, fromPreviousYear: drafts.filter((d) => d.fromPreviousYear).length, total: drafts.length };
  });
}

/** Por quantos dias o link e o código do checklist valem depois de gerados. */
export const CHECKLIST_ACCESS_TTL_DAYS = 30;

/** O link e o código atuais ainda valem? Sem validade gravada, o link nunca foi enviado. */
export function checklistAccessValid(c: { accessExpiresAt: Date | null }, now = new Date()): boolean {
  return Boolean(c.accessExpiresAt && c.accessExpiresAt.getTime() > now.getTime());
}

/** Gera um novo link e código, válidos por {@link CHECKLIST_ACCESS_TTL_DAYS} dias (os anteriores deixam de valer). */
export async function rotateAccess(db: Db, checklistId: string) {
  const token = randomToken(24);
  const code = randomCode(6);
  const expiresAt = new Date(Date.now() + CHECKLIST_ACCESS_TTL_DAYS * 86_400_000);
  await db
    .update(checklists)
    .set({ accessTokenHash: sha256(token), accessCodeHash: checklistCodeHash(checklistId, code), accessExpiresAt: expiresAt })
    .where(eq(checklists.id, checklistId));
  return { token, code, expiresAt };
}

/** Endereço do checklist para o cliente entrar com CPF e código. */
export const checklistLink = (ctx: AppContext, token: string) => `${ctx.config.WEB_URL.replace(/\/$/, '')}/checklist/${token}`;

/**
 * Checklist do exercício do cliente com um novo link e código de acesso. Cria o checklist (com os
 * dados do ano anterior, como em "Criar checklist") se ainda não existir, gera o par novo (os
 * anteriores deixam de valer) e, com `markSent`, registra a data do envio. É o mesmo caminho do
 * envio do acesso na etapa Documentação e da mala direta "Checklist digital".
 */
export async function issueChecklistAccess(ctx: AppContext, input: { officeId: string; customer: CustomerRow; year: number; markSent: boolean }) {
  const { db } = ctx;
  const declaration = await getOrCreateDeclaration(db, input.officeId, input.customer.id, input.year);
  let checklist = await db.query.checklists.findFirst({ where: eq(checklists.declarationId, declaration.id) });
  let created = false;
  if (!checklist) {
    try {
      checklist = (await createChecklist(db, { officeId: input.officeId, customer: input.customer, declaration })).checklist;
      created = true;
    } catch (err) {
      // criado ao mesmo tempo por outra requisição: segue com o que ficou gravado
      checklist = await db.query.checklists.findFirst({ where: eq(checklists.declarationId, declaration.id) });
      if (!checklist) throw err;
    }
  }
  const { token, code, expiresAt } = await rotateAccess(db, checklist.id);
  if (input.markSent) await db.update(checklists).set({ sentAt: new Date() }).where(eq(checklists.id, checklist.id));
  return { checklist, declaration, created, token, code, expiresAt, link: checklistLink(ctx, token) };
}

export interface ChecklistDoc {
  id: string;
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedBy: string;
  createdAt: Date;
  checklistItemId: string | null;
}

/** Seções, itens e arquivos do checklist. */
export async function loadBundle(db: Db, checklistId: string) {
  const sections = (await db.select().from(checklistSections).where(eq(checklistSections.checklistId, checklistId))).sort((a, b) => sectionOrder(a.section) - sectionOrder(b.section));
  const items = await db.select().from(checklistItems).where(eq(checklistItems.checklistId, checklistId)).orderBy(asc(checklistItems.sortOrder), asc(checklistItems.createdAt));
  const docs: ChecklistDoc[] = items.length
    ? await db
        .select({
          id: documents.id,
          fileId: documents.fileId,
          filename: files.filename,
          mimeType: files.mimeType,
          size: files.size,
          uploadedBy: documents.uploadedBy,
          createdAt: documents.createdAt,
          checklistItemId: documents.checklistItemId,
        })
        .from(documents)
        .innerJoin(files, eq(files.id, documents.fileId))
        .where(inArray(
          documents.checklistItemId,
          items.map((i) => i.id),
        ))
        .orderBy(asc(documents.createdAt))
    : [];
  return { sections, items, docs };
}

export async function lockOf(db: Db, officeId: string, declaration: { substatus: string; checklistLocked?: boolean | null }): Promise<ChecklistLock> {
  const settings = await getOfficeSettings(db, officeId);
  return checklistLock(settings, declaration);
}

const docView = (d: ChecklistDoc) => ({ id: d.id, filename: d.filename, mimeType: d.mimeType, size: d.size, uploadedBy: d.uploadedBy, createdAt: d.createdAt });

function itemView(item: ItemRow, docs: ChecklistDoc[]) {
  return {
    id: item.id,
    section: item.section,
    title: item.title,
    description: item.description,
    ownerName: item.ownerName,
    ownerCpf: item.ownerCpf,
    fromPreviousYear: item.fromPreviousYear,
    status: item.status,
    customerNote: item.customerNote,
    createdBy: item.createdBy,
    files: docs.filter((d) => d.checklistItemId === item.id).map(docView),
  };
}

function sectionsView(bundle: Awaited<ReturnType<typeof loadBundle>>) {
  return bundle.sections.map((s) => {
    const items = bundle.items.filter((i) => i.section === s.section);
    return {
      section: s.section,
      label: CHECKLIST_SECTIONS[s.section as ChecklistSection] ?? s.section,
      hint: CHECKLIST_SECTION_HINTS[s.section as ChecklistSection] ?? '',
      status: s.status,
      note: s.note,
      finishedAt: s.finishedAt,
      progress: checklistProgress(items),
      items: items.map((i) => itemView(i, bundle.docs)),
    };
  });
}

/** Visão do escritório: tudo, inclusive datas de envio e acesso. */
export function officeView(c: ChecklistRow, bundle: Awaited<ReturnType<typeof loadBundle>>) {
  return {
    id: c.id,
    createdAt: c.createdAt,
    sentAt: c.sentAt,
    accessExpiresAt: c.accessExpiresAt,
    lastCustomerAccessAt: c.lastCustomerAccessAt,
    finishedAt: c.finishedAt,
    progress: checklistProgress(bundle.items),
    fromPreviousYear: bundle.items.filter((i) => i.fromPreviousYear).length,
    filesCount: bundle.docs.length,
    sections: sectionsView(bundle),
  };
}

/** Visão do cliente: sem dados internos do escritório. */
export function customerView(
  c: ChecklistRow,
  bundle: Awaited<ReturnType<typeof loadBundle>>,
  extra: { exerciseYear: number; officeName: string; customerName: string; lock: ChecklistLock },
) {
  return {
    id: c.id,
    exerciseYear: extra.exerciseYear,
    officeName: extra.officeName,
    customerFirstName: extra.customerName.trim().split(/\s+/)[0] ?? '',
    readOnly: extra.lock.readOnly,
    readOnlyReason: extra.lock.customerReason,
    finishedAt: c.finishedAt,
    progress: checklistProgress(bundle.items),
    sections: sectionsView(bundle),
  };
}

/** Marca o checklist como concluído quando todas as seções foram finalizadas (e desfaz ao reabrir). */
export async function refreshFinished(db: Db, checklistId: string): Promise<boolean> {
  const sections = await db.select().from(checklistSections).where(eq(checklistSections.checklistId, checklistId));
  const done = sections.length > 0 && sections.every((s) => s.status !== 'open');
  const current = await db.query.checklists.findFirst({ where: eq(checklists.id, checklistId) });
  if (done && !current?.finishedAt) {
    await db.update(checklists).set({ finishedAt: new Date() }).where(eq(checklists.id, checklistId));
    return true;
  }
  if (!done && current?.finishedAt) await db.update(checklists).set({ finishedAt: null }).where(eq(checklists.id, checklistId));
  return false;
}

/** Notificação para o responsável pelo cliente (ou o escritório todo, se não houver). */
export async function notifyOffice(db: Db, customer: CustomerRow, title: string, body: string | null, link: string) {
  await notify(db, { officeId: customer.officeId, userId: customer.responsibleUserId ?? null, customerId: customer.id, title, body: body ?? undefined, link });
}

/** Grava os arquivos enviados e os vincula ao item do checklist. */
export async function attachFiles(
  ctx: AppContext,
  input: { officeId: string; customerId: string; declarationId: string; itemId: string; uploadedBy: 'office' | 'customer'; userId?: string | null; uploads: UploadedFile[] },
) {
  const created: string[] = [];
  for (const u of input.uploads) {
    const saved = await ctx.files.save({ officeId: input.officeId, data: u.data, filename: u.filename, mimeType: u.mimeType, userId: input.userId ?? null });
    const [doc] = await ctx.db
      .insert(documents)
      .values({
        officeId: input.officeId,
        customerId: input.customerId,
        declarationId: input.declarationId,
        checklistItemId: input.itemId,
        fileId: saved.id,
        category: 'checklist',
        uploadedBy: input.uploadedBy,
      })
      .returning();
    created.push(doc.id);
  }
  return created;
}

/** Remove o documento e o arquivo; se o item ficou sem arquivos, volta a "pendente". */
export async function removeDocument(ctx: AppContext, officeId: string, doc: { id: string; fileId: string; checklistItemId: string | null }) {
  await ctx.db.delete(documents).where(eq(documents.id, doc.id));
  await ctx.files.remove(officeId, doc.fileId);
  if (doc.checklistItemId) {
    const left = await ctx.db.select({ id: documents.id }).from(documents).where(eq(documents.checklistItemId, doc.checklistItemId)).limit(1);
    if (!left.length) {
      await ctx.db.update(checklistItems).set({ status: 'pending' }).where(and(eq(checklistItems.id, doc.checklistItemId), eq(checklistItems.status, 'sent')));
    }
  }
}

/** Pacote .zip com os arquivos do checklist, organizados por seção e item. */
export async function buildZip(ctx: AppContext, officeId: string, bundle: Awaited<ReturnType<typeof loadBundle>>) {
  const zip = new JSZip();
  const used = new Set<string>();
  const unique = (path: string) => {
    let p = path;
    let n = 2;
    while (used.has(p.toLowerCase())) {
      const dot = path.lastIndexOf('.');
      p = dot > path.lastIndexOf('/') ? `${path.slice(0, dot)} (${n})${path.slice(dot)}` : `${path} (${n})`;
      n++;
    }
    used.add(p.toLowerCase());
    return p;
  };
  const folder = (s: string) => safeFilename(s).replace(/\./g, ' ').slice(0, 80).trim() || 'item';
  let count = 0;
  for (const item of bundle.items) {
    const docs = bundle.docs.filter((d) => d.checklistItemId === item.id);
    if (!docs.length) continue;
    const sec = `${String(sectionOrder(item.section) + 1).padStart(2, '0')} ${CHECKLIST_SECTIONS[item.section as ChecklistSection] ?? item.section}`;
    const owner = item.ownerName ? ` (${item.ownerName})` : '';
    for (const d of docs) {
      const { data } = await ctx.files.get(officeId, d.fileId);
      zip.file(unique(`${folder(sec)}/${folder(item.title + owner)}/${safeFilename(d.filename)}`), data);
      count++;
    }
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, count };
}
