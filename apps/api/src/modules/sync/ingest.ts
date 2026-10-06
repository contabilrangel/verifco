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
import { getOrCreateDeclaration, syncStatusWithEcac, type DeclarationRow } from '../../services/declarations';
import type { CustomerRow } from '../../services/customers';
import { isExtractable, refreshElaborationStatus } from '../elaboration/service';
import type { MachineAuth } from './tokens';
import type { UploadedFile } from '../../services/uploads';

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
 * Recibo de entrega (.REC): o programa IRPF grava o .REC ao transmitir, então a chegada dele
 * marca a declaração como transmitida (`markTransmittedByReceipt`): a data de transmissão vem da
 * data do arquivo informada pelo sincronizador (`modificadoEm`) e o .REC fica guardado como
 * documento "Recibo de entrega" da declaração (o GET da declaração devolve o arquivo).
 *
 * LIMITE (sem leiaute público): o CONTEÚDO de .DEC/.REC/.DBK não é lido. O número do recibo, as
 * linhas da DIRPF (`declaration_items` com `source = 'irpf_file'`) e os totais só poderiam vir de
 * um leitor validado com arquivos oficiais de cada exercício, que entraria logo depois de gravar o
 * documento. Até lá, o número do recibo é digitado no resumo da declaração ou chega pela extensão
 * (registro eCAC `declaration`), e as linhas vêm da digitação ou da extração por IA de PDFs.
 */
export async function ingestSyncFile(ctx: AppContext, auth: MachineAuth, file: UploadedFile, fields: Record<string, string>) {
  const { db } = ctx;
  const { cpf, year, type, info } = resolveFileTarget(file, fields);
  const customer = await customerByDoc(ctx, auth.officeId, cpf);
  const decl = await getOrCreateDeclaration(db, auth.officeId, customer.id, year);
  const hash = sha256(file.data);
  const [dup] = await db
    .select({ id: documents.id, fileId: documents.fileId })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(and(eq(documents.customerId, customer.id), eq(documents.declarationId, decl.id), eq(files.sha256, hash)))
    .limit(1);
  const base = { customer: { id: customer.id, name: customer.name }, year, type, cpf, pattern: info.pattern };
  const receipt = () => (type === 'rec' ? markTransmittedByReceipt(ctx, decl, { fileDate: fileDateOf(fields), rectification: info.rectification }) : undefined);
  if (dup) {
    // idempotente: um .REC reenviado ainda marca a transmissão, se faltar
    const transmission = await receipt();
    return { ...base, duplicate: true, documentId: dup.id, fileId: dup.fileId, ...(transmission ? { declaration: transmission } : {}) };
  }

  const { mimeType } = file;
  const saved = await ctx.files.save({ officeId: auth.officeId, data: file.data, filename: file.filename, mimeType });
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
  const transmission = await receipt();
  const elaborationStatus = await refreshElaborationStatus(db, decl.id);
  await machineAudit(ctx, auth, 'sync_file', 'document', doc.id, { customerId: customer.id, year, type, filename: file.filename });
  return { ...base, duplicate: false, documentId: doc.id, fileId: saved.id, elaborationStatus, ...(transmission ? { declaration: transmission } : {}) };
}

/**
 * Data do arquivo enviada pelo sincronizador (`modificadoEm`, ISO 8601). Datas inválidas, antes
 * de 2000 ou no futuro são ignoradas (vale a data do recebimento).
 */
export function fileDateOf(fields: Record<string, string>): Date | null {
  const raw = fields.modificadoEm?.trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getTime() > Date.now() + 86400_000) return null;
  return d;
}

/**
 * .REC recebido: a declaração foi transmitida. Grava a data de transmissão (se ainda não houver)
 * e leva a declaração para "Transmitida" no subestado da situação eCAC atual, pelas mesmas
 * regras do resumo e dos registros do eCAC (finalizada não regride). Recibo de retificadora
 * (nome "...-RETIF.REC") marca a declaração como retificadora.
 */
export async function markTransmittedByReceipt(ctx: AppContext, decl: DeclarationRow, opts: { fileDate: Date | null; rectification: boolean | null }) {
  const { db } = ctx;
  const set: Partial<DeclarationRow> = {};
  if (!decl.transmittedAt) set.transmittedAt = opts.fileDate ?? new Date();
  if (opts.rectification === true && !decl.isRectification) set.isRectification = true;
  let row = decl;
  if (Object.keys(set).length) {
    [row] = await db.update(declarations).set({ ...set, updatedAt: new Date() }).where(eq(declarations.id, decl.id)).returning();
  }
  row = await syncStatusWithEcac(db, decl, row, { transmitted: true });
  return { stage: row.stage, substatus: row.substatus, transmittedAt: row.transmittedAt };
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
