import { and, eq, or, sql } from 'drizzle-orm';
import { IMPORT_KINDS, type ImportKind } from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import {
  aiAnalyses,
  aiAttachments,
  aiConversations,
  aiMessages,
  billings,
  darfs,
  declarations,
  deliveries,
  documents,
  ecacRecords,
  importBatches,
  installments,
  jobs,
  offices,
  prefilledStatements,
  procurators,
} from '../../db/schema';
import { HttpError, forbidden, notFound } from '../../lib/errors';
import { can } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { getOfficeSettings } from '../../services/settings';

/** Quem enxerga os documentos do cliente em alguma tela (documentos, checklist, elaboração). */
const DOCUMENT_PERMS = ['declaration.view', 'customer.download_documents', 'checklist_digital.view', 'elaboration.process', 'elaboration.export', 'pre_declaration.view'];
const ELABORATION_PERMS = ['elaboration.export', 'elaboration.process', 'pre_declaration.view'];
const RECEIPT_PERMS = ['budget.list', 'billing.edit', 'billing.receive', 'billing.receipt_generate', 'billing.receipt_send'];
const AI_PERMS = ['ai.use', 'irpfm.view', 'copilot.use'];

interface Owner {
  /** Permissões que dão acesso (basta uma); vazio = qualquer usuário do escritório. */
  perms: string[];
  /** Cliente a que o arquivo pertence (aplica a restrição "contadores veem só seus clientes"). */
  customerId?: string | null;
}

/**
 * Descobre a que registros o arquivo pertence. Arquivos sensíveis (certificado A1 do procurador
 * e .zip de backup) não saem por esta rota: devolvem `null` como se não existissem.
 */
async function ownersOf(ctx: AppContext, officeId: string, fileId: string): Promise<Owner[] | null> {
  const { db } = ctx;
  const certificate = await db.query.procurators.findFirst({ where: and(eq(procurators.officeId, officeId), eq(procurators.certificateFileId, fileId)) });
  if (certificate) return null;
  // o backup tem rota própria (/backups/:id/download, com backup.download)
  const backup = await db.query.jobs.findFirst({ where: and(eq(jobs.officeId, officeId), eq(jobs.type, 'backup.generate'), sql`${jobs.result}->>'fileId' = ${fileId}`) });
  if (backup) return null;

  const owners: Owner[] = [];
  const office = await db.query.offices.findFirst({ where: and(eq(offices.id, officeId), eq(offices.logoFileId, fileId)) });
  if (office) owners.push({ perms: [] });

  for (const d of await db.select({ customerId: documents.customerId, category: documents.category }).from(documents).where(and(eq(documents.officeId, officeId), eq(documents.fileId, fileId)))) {
    owners.push({ perms: d.category === 'copilot' ? [...DOCUMENT_PERMS, 'copilot.use'] : DOCUMENT_PERMS, customerId: d.customerId });
  }
  for (const d of await db.select({ customerId: darfs.customerId }).from(darfs).where(and(eq(darfs.officeId, officeId), eq(darfs.fileId, fileId)))) {
    owners.push({ perms: ['darf.view', 'darf.edit', 'darf.send'], customerId: d.customerId });
  }
  const receipts = await db
    .select({ customerId: billings.customerId })
    .from(installments)
    .innerJoin(billings, eq(billings.id, installments.billingId))
    .where(and(eq(installments.officeId, officeId), eq(installments.receiptFileId, fileId)));
  for (const r of receipts) owners.push({ perms: RECEIPT_PERMS, customerId: r.customerId });

  for (const r of await db.select({ customerId: ecacRecords.customerId }).from(ecacRecords).where(and(eq(ecacRecords.officeId, officeId), eq(ecacRecords.fileId, fileId)))) {
    owners.push({ perms: ['ecac.view'], customerId: r.customerId });
  }
  for (const r of await db
    .select({ customerId: prefilledStatements.customerId })
    .from(prefilledStatements)
    .where(and(eq(prefilledStatements.officeId, officeId), eq(prefilledStatements.fileId, fileId)))) {
    owners.push({ perms: ['prefilled.download', ...ELABORATION_PERMS], customerId: r.customerId });
  }
  for (const r of await db
    .select({ customerId: declarations.customerId })
    .from(declarations)
    .where(and(eq(declarations.officeId, officeId), or(eq(declarations.exportedFileId, fileId), eq(declarations.sourceFileId, fileId))))) {
    owners.push({ perms: ELABORATION_PERMS, customerId: r.customerId });
  }
  // anexos de envios (DARF, recibo, relatórios, checklist em PDF, mala direta)
  for (const r of await db
    .select({ customerId: deliveries.customerId })
    .from(deliveries)
    .where(and(eq(deliveries.officeId, officeId), sql`${deliveries.attachments} @> ${JSON.stringify([{ fileId }])}::jsonb`))) {
    owners.push({ perms: ['mailing.list'], customerId: r.customerId });
  }
  for (const r of await db.select({ kind: importBatches.kind }).from(importBatches).where(and(eq(importBatches.officeId, officeId), eq(importBatches.fileId, fileId)))) {
    owners.push({ perms: [IMPORT_KINDS[r.kind as ImportKind]?.permission ?? 'worksheet.budget'] });
  }
  for (const r of await db.select({ customerId: aiAttachments.customerId }).from(aiAttachments).where(and(eq(aiAttachments.officeId, officeId), eq(aiAttachments.fileId, fileId)))) {
    owners.push({ perms: AI_PERMS, customerId: r.customerId });
  }
  for (const r of await db.select({ customerId: aiAnalyses.customerId }).from(aiAnalyses).where(and(eq(aiAnalyses.officeId, officeId), eq(aiAnalyses.fileId, fileId)))) {
    owners.push({ perms: ['ai.use'], customerId: r.customerId });
  }
  const aiMsgs = await db
    .select({ customerId: aiConversations.customerId })
    .from(aiMessages)
    .innerJoin(aiConversations, eq(aiConversations.id, aiMessages.conversationId))
    .where(and(eq(aiConversations.officeId, officeId), sql`${aiMessages.attachments} @> ${JSON.stringify([{ fileId }])}::jsonb`));
  for (const r of aiMsgs) owners.push({ perms: AI_PERMS, customerId: r.customerId });
  return owners;
}

/** O usuário enxerga o cliente (ou o registro sem cliente, se o escritório não restringe)? */
async function canSeeCustomer(ctx: AppContext, user: AuthUser, customerId: string | null | undefined, restricted: boolean): Promise<boolean> {
  if (customerId === undefined) return true;
  if (customerId === null) return !restricted;
  try {
    await getCustomerForUser(ctx, user, customerId);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) return false;
    throw err;
  }
}

/**
 * Libera o download de um arquivo pela rota genérica só se ele pertence a algo que o usuário
 * pode ver: aplica a permissão e o escopo de cliente da tela de origem. Sem dono reconhecido,
 * ou sendo certificado/backup, responde 404.
 */
export async function assertCanDownloadFile(ctx: AppContext, user: AuthUser, fileId: string) {
  const owners = await ownersOf(ctx, user.officeId, fileId);
  if (!owners?.length) throw notFound('Arquivo');
  const restricted = !user.isOwner && (await getOfficeSettings(ctx.db, user.officeId)).restrictCustomersToResponsible === true;
  let visible = false;
  for (const o of owners) {
    if (!(await canSeeCustomer(ctx, user, o.customerId, restricted))) continue;
    visible = true;
    if (!o.perms.length || o.perms.some((p) => can(user, p))) return;
  }
  // existe e está no escopo, mas falta permissão; fora do escopo, nem confirma que existe
  throw visible ? forbidden() : notFound('Arquivo');
}
