import { and, eq, isNull } from 'drizzle-orm';
import {
  SYNC_FILE_CATEGORY,
  SYNC_FILE_TYPE_LIST,
  exerciseYearFromPath,
  isValidCpfCnpj,
  onlyDigits,
  parseIrpfFileName,
  type SyncFileType,
} from '@verifco/shared';
import type { AppContext } from '../../context';
import { auditLogs, customers, declarations, documents, files } from '../../db/schema';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { sha256 } from '../../lib/crypto';
import { getOrCreateDeclaration } from '../../services/declarations';
import type { CustomerRow } from '../../services/customers';
import { isExtractable, refreshElaborationStatus } from '../elaboration/service';
import type { MachineAuth } from './tokens';
import { guessMimeType, type UploadedFile } from './multipart';

/** Cliente do escritório pelo CPF/CNPJ (só dígitos); 404 quando não existe. */
export async function customerByDoc(ctx: AppContext, officeId: string, doc: string): Promise<CustomerRow> {
  const c = await ctx.db.query.customers.findFirst({
    where: and(eq(customers.officeId, officeId), eq(customers.cpfCnpj, doc), isNull(customers.deletedAt)),
  });
  if (!c) throw notFound(`Cliente com CPF/CNPJ ${doc}`);
  return c;
}

/**
 * Resolve CPF e ano de um arquivo enviado: campos explícitos têm prioridade; senão, o nome do
 * arquivo (padrão do programa IRPF) e a pasta `IRPF<ano>` do caminho original.
 */
export function resolveFileTarget(file: UploadedFile, fields: Record<string, string>) {
  const info = parseIrpfFileName(file.filename);
  const sentCpf = onlyDigits(fields.cpf);
  if (sentCpf && !isValidCpfCnpj(sentCpf)) throw badRequest('CPF/CNPJ informado é inválido.');
  const cpf = sentCpf || info.cpf;
  if (!cpf) {
    throw new HttpError(
      422,
      'CPF não identificado: o nome do arquivo não segue o padrão do programa IRPF (<CPF>-IRPF-...-<exercício>-<ano-calendário>-ORIGI.DEC) nem começa com o CPF. Informe o campo "cpf".',
    );
  }
  let year: number | null = null;
  if (fields.ano) {
    year = Number(fields.ano);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('Ano inválido: informe o ano-exercício com 4 dígitos.');
  } else {
    year = info.exerciseYear ?? exerciseYearFromPath(fields.caminho ?? '') ?? null;
  }
  if (!year) throw badRequest('Ano não identificado pelo nome do arquivo nem pela pasta: informe o campo "ano" (ano-exercício).');
  let type: SyncFileType = info.type;
  if (fields.tipo) {
    if (!SYNC_FILE_TYPE_LIST.includes(fields.tipo as SyncFileType)) throw badRequest(`Tipo inválido: use ${SYNC_FILE_TYPE_LIST.join(', ')}.`);
    type = fields.tipo as SyncFileType;
  }
  return { cpf, year, type, info };
}

/**
 * Recebe um arquivo do sincronizador: cria o documento do cliente/exercício (uploadedBy `sync`)
 * e, para a declaração (.DEC) ou a cópia de segurança (.DBK, se ainda não houver arquivo de
 * origem), atualiza `declarations.sourceFileId`. O mesmo conteúdo não é gravado duas vezes.
 *
 * PONTO DE EXTENSÃO: o conteúdo de .DEC/.REC/.DBK não é lido porque o layout desses arquivos
 * não é público. Um leitor validado com arquivos oficiais entraria logo depois de gravar o
 * documento (ex.: preencher `declarations.receiptNumber` a partir do .REC ou as linhas de
 * `declaration_items` a partir do .DEC, com `source = 'irpf_file'`).
 */
export async function ingestSyncFile(ctx: AppContext, auth: MachineAuth, file: UploadedFile, fields: Record<string, string>) {
  const { db } = ctx;
  const { cpf, year, type, info } = resolveFileTarget(file, fields);
  const customer = await customerByDoc(ctx, auth.officeId, cpf);
  const decl = await getOrCreateDeclaration(db, auth.officeId, customer.id, year);
  const hash = sha256(file.buffer);
  const [dup] = await db
    .select({ id: documents.id, fileId: documents.fileId })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(and(eq(documents.customerId, customer.id), eq(documents.declarationId, decl.id), eq(files.sha256, hash)))
    .limit(1);
  const base = { customer: { id: customer.id, name: customer.name }, year, type, cpf, pattern: info.pattern };
  if (dup) return { ...base, duplicate: true, documentId: dup.id, fileId: dup.fileId };

  const mimeType = guessMimeType(file.filename, file.mimeType);
  const saved = await ctx.files.save({ officeId: auth.officeId, data: file.buffer, filename: file.filename, mimeType });
  const [doc] = await db
    .insert(documents)
    .values({
      officeId: auth.officeId,
      customerId: customer.id,
      declarationId: decl.id,
      fileId: saved.id,
      category: SYNC_FILE_CATEGORY[type],
      uploadedBy: 'sync',
      processingStatus: isExtractable(mimeType) ? 'not_processed' : 'not_applicable',
      extracted: {
        sync: {
          type,
          originalPath: fields.caminho ? fields.caminho.slice(0, 500) : null,
          rectification: info.rectification,
          calendarYear: info.calendarYear,
          tokenName: auth.name,
        },
      },
    })
    .returning();
  if (type === 'dec' || (type === 'dbk' && !decl.sourceFileId)) {
    await db.update(declarations).set({ sourceFileId: saved.id, updatedAt: new Date() }).where(eq(declarations.id, decl.id));
  }
  const elaborationStatus = await refreshElaborationStatus(db, decl.id);
  await machineAudit(ctx, auth, 'sync_file', 'document', doc.id, { customerId: customer.id, year, type, filename: file.filename });
  return { ...base, duplicate: false, documentId: doc.id, fileId: saved.id, elaborationStatus };
}

/** Auditoria de ações feitas por token de máquina (sem usuário). */
export async function machineAudit(ctx: AppContext, auth: MachineAuth, action: string, entity: string, entityId: string | null, data: Record<string, unknown>) {
  await ctx.db.insert(auditLogs).values({
    officeId: auth.officeId,
    userId: null,
    action,
    entity,
    entityId,
    data: { ...data, tokenId: auth.tokenId, tokenName: auth.name, scope: auth.scope },
  });
}
