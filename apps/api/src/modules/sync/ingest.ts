import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  SYNC_FILE_CATEGORY,
  SYNC_FILE_TYPE_LIST,
  exerciseYearFromPath,
  isValidCpfCnpj,
  onlyDigits,
  parseIrpfFileName,
  todayIso,
  type IrpfFileNameInfo,
  type SyncFileType,
} from '@verifco/shared';
import type { AppContext } from '../../context';
import type { DbOrTx } from '../../db/client';
import { auditLogs, customers, declarations, documents, files } from '../../db/schema';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { sha256 } from '../../lib/crypto';
import { getOrCreateDeclaration, syncDeclarationStage, transmittedAtOfDay, type DeclarationRow } from '../../services/declarations';
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
 * O recibo de entrega (.REC) fica guardado como documento "recibo" da declaração (categoria
 * `irpf_receipt`, devolvido no GET da declaração) e marca a declaração como transmitida
 * (`markTransmittedByReceipt`): grava a data da transmissão, se ainda não houver (o dia, em
 * Brasília, da data do arquivo enviada pelo sincronizador em `modificadoEm`; sem ela, o do
 * recebimento), marca a retificadora pelo nome (`RETIF`) e aplica a regra de etapa do resumo da
 * declaração (`syncDeclarationStage`). O número do recibo não aparece no nome do arquivo e o
 * conteúdo não é lido, então ele não é preenchido aqui (vem do eCAC ou da digitação).
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
  const hash = sha256(file.data);
  const [dup] = await db
    .select({ id: documents.id, fileId: documents.fileId })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(and(eq(documents.customerId, customer.id), eq(documents.declarationId, decl.id), eq(files.sha256, hash)))
    .limit(1);
  const base = { customer: { id: customer.id, name: customer.name }, year, type, cpf, pattern: info.pattern };
  if (dup) return { ...base, duplicate: true, documentId: dup.id, fileId: dup.fileId };

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
  let receipt: Awaited<ReturnType<typeof markTransmittedByReceipt>> | null = null;
  if (type === 'rec') {
    // recibo de entrega: a declaração foi transmitida (mesma regra do resumo da declaração)
    receipt = await markTransmittedByReceipt(db, decl, {
      fileDate: fileModifiedAt(fields, year),
      rectification: isRectificationReceiptName(file.filename, info),
    });
  }
  const elaborationStatus = await refreshElaborationStatus(db, decl.id);
  await machineAudit(ctx, auth, 'sync_file', 'document', doc.id, {
    customerId: customer.id,
    year,
    type,
    filename: file.filename,
    ...(receipt?.transmitted ? { transmitted: true } : {}),
    ...(receipt?.transmittedAtFrom ? { transmittedAtFrom: receipt.transmittedAtFrom } : {}),
    ...(receipt?.rectification ? { rectification: true } : {}),
  });
  return { ...base, duplicate: false, documentId: doc.id, fileId: saved.id, elaborationStatus };
}

/** Folga para o relógio do computador do sincronizador adiantado em relação ao servidor. */
export const FILE_DATE_CLOCK_SKEW_MS = 10 * 60_000;

const isoDateTime = z.iso.datetime({ offset: true });

/**
 * Data do arquivo enviada pelo sincronizador (`modificadoEm`, data e hora ISO 8601 com fuso;
 * sincronizadores antigos não enviam). Vale só uma data plausível para o recibo do exercício:
 * - formato inválido ou sem fuso: ignorada;
 * - no futuro além da folga de relógio (`FILE_DATE_CLOCK_SKEW_MS`): ignorada; dentro da folga,
 *   vale o instante do recebimento (a transmissão nunca fica no futuro);
 * - antes de 1º de janeiro do ano-exercício (dia de Brasília): ignorada, porque o programa do
 *   exercício só transmite a partir desse ano (cópia de arquivo com data errada).
 * Ignorada, vale a data do recebimento, como antes.
 */
export function fileModifiedAt(fields: Record<string, string>, exerciseYear: number, now: Date = new Date()): Date | null {
  const raw = fields.modificadoEm?.trim();
  if (!raw || raw.length > 40 || !isoDateTime.safeParse(raw).success) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() > now.getTime() + FILE_DATE_CLOCK_SKEW_MS) return null;
  if (todayIso(date) < `${exerciseYear}-01-01`) return null;
  return date.getTime() > now.getTime() ? now : date;
}

/** "RETIF" como palavra no nome (RETIF, RETIFICADORA, retificação...), sem pegar trechos de outras palavras. */
const RETIF_TOKEN = /(?:^|[^\p{L}\p{N}])RETIF\p{L}*(?=$|[^\p{L}\p{N}])/iu;

/**
 * Recibo de retificadora pelo nome do arquivo. No padrão do programa IRPF, o sufixo decide
 * (`-RETIF` = retificadora, `-ORIGI` = original); fora dele, só a palavra "RETIF..." no nome.
 */
export function isRectificationReceiptName(filename: string, info: Pick<IrpfFileNameInfo, 'rectification'>): boolean {
  if (info.rectification !== null) return info.rectification;
  const base = filename.split(/[\\/]/).pop() ?? '';
  return RETIF_TOKEN.test(base.replace(/\.[^.]*$/, ''));
}

/**
 * .REC recebido: a declaração foi transmitida.
 * - Data da transmissão: só se ainda não houver (a digitada no resumo ou vinda do eCAC fica),
 *   com o dia de Brasília da data do arquivo (`fileDate`) ou, sem ela, do recebimento.
 * - Retificadora: o recibo "RETIF" marca a declaração como retificadora; um recibo original não
 *   desmarca (pode ser o .REC antigo da original chegando depois).
 * - Etapa: `syncDeclarationStage` (finalizada não regride).
 */
export async function markTransmittedByReceipt(
  db: DbOrTx,
  decl: DeclarationRow,
  opts: { fileDate: Date | null; rectification: boolean; now?: Date },
) {
  const day = todayIso(opts.fileDate ?? opts.now ?? new Date());
  const setDate = !decl.transmittedAt;
  const setRectification = opts.rectification && !decl.isRectification;
  let updated = decl;
  if (setDate || setRectification) {
    [updated] = await db
      .update(declarations)
      .set({
        // coalesce: uma data gravada ao mesmo tempo (resumo, eCAC) não é sobrescrita
        ...(setDate ? { transmittedAt: sql`coalesce(${declarations.transmittedAt}, ${transmittedAtOfDay(day).toISOString()}::timestamptz)` } : {}),
        ...(setRectification ? { isRectification: true } : {}),
        updatedAt: new Date(),
      })
      .where(eq(declarations.id, decl.id))
      .returning();
  }
  const row = await syncDeclarationStage(db, decl, updated);
  return {
    row,
    transmitted: row.stage !== decl.stage,
    transmittedAtFrom: setDate ? (opts.fileDate ? ('file' as const) : ('received' as const)) : null,
    rectification: setRectification,
  };
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
