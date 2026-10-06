import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import JSZip from 'jszip';
import { z } from 'zod';
import {
  ITEM_KINDS,
  ITEM_KIND_LIST,
  formatCpfCnpj,
  onlyDigits,
  type DeclarationItem,
  type ElaborationStatus,
  type ItemKind,
} from '@verifco/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { declarations, documents, files } from '../../db/schema';
import type { CustomerRow } from '../../services/customers';
import type { DbExecutor, DeclarationRow } from '../../services/declarations';
import { listItems } from '../../services/declarations';
import { safeZipName } from '../../services/uploads';

/** Tipos de arquivo que a IA consegue ler (PDF e imagens). Os do programa IRPF não entram. */
const EXTRACTABLE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const EXTRACTABLE = new Set(EXTRACTABLE_TYPES);
export const isExtractable = (mimeType: string) => EXTRACTABLE.has(mimeType);

/** Categorias dos arquivos do programa IRPF recebidos do sincronizador (.DEC, .REC, .DBK). */
const PROGRAM_FILE_CATEGORIES = ['irpf_declaration', 'irpf_receipt', 'irpf_backup'];

export type LineMatch = 'new' | 'duplicate' | 'conflict';
export type LineDecision = 'accept' | 'reject';

/** Linha da DIRPF extraída de um documento, com a comparação com as linhas já lançadas. */
export interface ExtractedLine {
  item: DeclarationItem;
  match: LineMatch;
  existingItemId: string | null;
  existing: { valueCents: number; withheldCents: number; prevValueCents: number; description: string | null } | null;
  decision: LineDecision | null;
  appliedAt: string | null;
}

/** Resultado da extração guardado em `documents.extracted.elaboration`. */
export interface ElaborationExtraction {
  version: 1;
  processedAt: string;
  lines: ExtractedLine[];
  notes: string | null;
  discarded: number;
  error: string | null;
}

export interface DocStat {
  id: string;
  declarationId: string | null;
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  category: string;
  uploadedBy: string;
  processingStatus: string;
  extracted: Record<string, unknown> | null;
  createdAt: Date;
}

export function getExtraction(extracted: Record<string, unknown> | null | undefined): ElaborationExtraction | null {
  const e = extracted?.elaboration as ElaborationExtraction | undefined;
  return e && Array.isArray(e.lines) ? e : null;
}

/**
 * Documentos (com dados do arquivo e o JSON `extracted`) das declarações informadas. Use para UMA
 * declaração (drawer, validação, exportação); a listagem da central usa `docStatsSubquery`, que
 * conta no banco sem trazer o JSON.
 */
export async function loadDocStats(db: DbExecutor, declarationIds: string[]): Promise<Map<string, DocStat[]>> {
  const map = new Map<string, DocStat[]>();
  if (!declarationIds.length) return map;
  const rows = await db
    .select({
      id: documents.id,
      declarationId: documents.declarationId,
      fileId: documents.fileId,
      filename: files.filename,
      mimeType: files.mimeType,
      size: files.size,
      category: documents.category,
      uploadedBy: documents.uploadedBy,
      processingStatus: documents.processingStatus,
      extracted: documents.extracted,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(inArray(documents.declarationId, declarationIds))
    .orderBy(documents.createdAt);
  for (const r of rows) {
    const list = map.get(r.declarationId!);
    if (list) list.push(r);
    else map.set(r.declarationId!, [r]);
  }
  return map;
}

/**
 * Contagens dos documentos por declaração do escritório no exercício, calculadas no banco (sem
 * trazer `documents.extracted` para a API): as mesmas regras de `docCounts` e
 * `computeElaborationStatus`, para filtrar e paginar a central de elaboração em SQL.
 */
export function docStatsSubquery(db: Db, officeId: string, year: number) {
  const eligible = sql`${files.mimeType} in (${sql.join(EXTRACTABLE_TYPES.map((t) => sql`${t}`), sql`, `)})`;
  const lines = sql`(case when jsonb_typeof(${documents.extracted}->'elaboration'->'lines') = 'array' then ${documents.extracted}->'elaboration'->'lines' else '[]'::jsonb end)`;
  const countLines = (where: SQL) => sql`(select count(*) from jsonb_array_elements(${lines}) as l(line) where ${where})`;
  return db
    .select({
      declarationId: documents.declarationId,
      total: sql<number>`count(*)::int`.as('total'),
      eligible: sql<number>`(count(*) filter (where ${eligible}))::int`.as('eligible'),
      processed: sql<number>`(count(*) filter (where ${eligible} and ${documents.processingStatus} = 'processed'))::int`.as('processed'),
      errors: sql<number>`(count(*) filter (where ${eligible} and ${documents.processingStatus} = 'error'))::int`.as('errors'),
      programFiles: sql<number>`(count(*) filter (where ${documents.category} in (${sql.join(PROGRAM_FILE_CATEGORIES.map((c) => sql`${c}`), sql`, `)})))::int`.as('program_files'),
      lines: sql<number>`(coalesce(sum(jsonb_array_length(${lines})) filter (where ${eligible}), 0))::int`.as('lines'),
      conflicts: sql<number>`(coalesce(sum(${countLines(sql`line->>'match' = 'conflict' and line->>'decision' is null and line->>'appliedAt' is null`)}) filter (where ${eligible}), 0))::int`.as('conflicts'),
      pendingLines: sql<number>`(coalesce(sum(${countLines(sql`line->>'appliedAt' is null and coalesce(line->>'decision', '') <> 'reject' and coalesce(line->>'match', '') <> 'duplicate'`)}) filter (where ${eligible}), 0))::int`.as('pending_lines'),
    })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .innerJoin(declarations, and(eq(declarations.id, documents.declarationId), eq(declarations.officeId, officeId), eq(declarations.exerciseYear, year)))
    .groupBy(documents.declarationId)
    .as('doc_stats');
}

export type DocStatsSubquery = ReturnType<typeof docStatsSubquery>;

/** `computeElaborationStatus` em SQL (literais sem parâmetros: a expressão também vai no GROUP BY). */
export function elaborationStatusSql(ds: DocStatsSubquery) {
  return sql<ElaborationStatus>`(case
    when coalesce(${ds.total}, 0) = 0 then 'no_files'
    when ${ds.processed} < ${ds.eligible} then 'not_processed'
    when ${ds.conflicts} > 0 then 'conflict'
    when ${ds.pendingLines} > 0 then 'awaiting_validation'
    when ${declarations.elaborationStatus} = 'exported' then 'exported'
    else 'ok' end)`;
}

/** Contagens de `docCounts` a partir da linha da subconsulta (declaração sem documentos = zeros). */
export function countsFromStats(r: { total: number | null; eligible: number | null; processed: number | null; errors: number | null; programFiles: number | null; lines: number | null; conflicts: number | null; pendingLines: number | null }) {
  return {
    total: r.total ?? 0,
    eligible: r.eligible ?? 0,
    processed: r.processed ?? 0,
    errors: r.errors ?? 0,
    programFiles: r.programFiles ?? 0,
    lines: r.lines ?? 0,
    conflicts: r.conflicts ?? 0,
    pendingLines: r.pendingLines ?? 0,
  };
}

/**
 * Situação da elaboração a partir dos documentos:
 * sem documentos → `no_files`; documento legível ainda não processado (ou com erro) →
 * `not_processed`; divergência sem decisão → `conflict`; linhas aceitas não aplicadas →
 * `awaiting_validation`; tudo aplicado → `ok` (ou `exported`, se já exportada e nada mudou).
 */
export function computeElaborationStatus(stored: string, docs: DocStat[]): ElaborationStatus {
  if (!docs.length) return 'no_files';
  const eligible = docs.filter((d) => isExtractable(d.mimeType));
  if (eligible.some((d) => d.processingStatus !== 'processed')) return 'not_processed';
  const lines = eligible.flatMap((d) => getExtraction(d.extracted)?.lines ?? []);
  if (lines.some((l) => l.match === 'conflict' && !l.decision && !l.appliedAt)) return 'conflict';
  if (lines.some((l) => !l.appliedAt && l.decision !== 'reject' && l.match !== 'duplicate')) return 'awaiting_validation';
  return stored === 'exported' ? 'exported' : 'ok';
}

export function docCounts(docs: DocStat[]) {
  const eligible = docs.filter((d) => isExtractable(d.mimeType));
  const lines = eligible.flatMap((d) => getExtraction(d.extracted)?.lines ?? []);
  return {
    total: docs.length,
    eligible: eligible.length,
    processed: eligible.filter((d) => d.processingStatus === 'processed').length,
    errors: eligible.filter((d) => d.processingStatus === 'error').length,
    programFiles: docs.filter((d) => PROGRAM_FILE_CATEGORIES.includes(d.category)).length,
    lines: lines.length,
    conflicts: lines.filter((l) => l.match === 'conflict' && !l.decision && !l.appliedAt).length,
    pendingLines: lines.filter((l) => !l.appliedAt && l.decision !== 'reject' && l.match !== 'duplicate').length,
  };
}

/** Recalcula e grava a situação da elaboração da declaração. */
export async function refreshElaborationStatus(db: DbExecutor, declarationId: string): Promise<ElaborationStatus> {
  const decl = await db.query.declarations.findFirst({ where: eq(declarations.id, declarationId) });
  if (!decl) return 'no_files';
  const docs = (await loadDocStats(db, [declarationId])).get(declarationId) ?? [];
  const status = computeElaborationStatus(decl.elaborationStatus, docs);
  if (status !== decl.elaborationStatus) {
    await db.update(declarations).set({ elaborationStatus: status, updatedAt: new Date() }).where(eq(declarations.id, declarationId));
  }
  return status;
}

// ---------------------------------------------------------------------------
// Comparação com as linhas já lançadas
// ---------------------------------------------------------------------------
const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Mesma linha da DIRPF: mesmo tipo e mesma fonte/beneficiário (ou mesma descrição, quando não há documento). */
export function sameLine(a: DeclarationItem, b: DeclarationItem): boolean {
  if (a.kind !== b.kind) return false;
  const ad = onlyDigits(a.counterpartyDoc);
  const bd = onlyDigits(b.counterpartyDoc);
  if (ad || bd) {
    if (ad !== bd) return false;
    if (a.code && b.code && a.code !== b.code) return false;
    const ao = onlyDigits(a.ownerCpf);
    const bo = onlyDigits(b.ownerCpf);
    return !ao || !bo || ao === bo;
  }
  const an = norm(a.description);
  return Boolean(an) && an === norm(b.description);
}

/** Valores iguais (só compara retido e valor anterior quando o documento os informa). */
export function sameValues(extracted: DeclarationItem, existing: DeclarationItem): boolean {
  if ((extracted.valueCents ?? 0) !== (existing.valueCents ?? 0)) return false;
  if (extracted.withheldCents !== undefined && extracted.withheldCents !== (existing.withheldCents ?? 0)) return false;
  if (extracted.prevValueCents !== undefined && extracted.prevValueCents !== (existing.prevValueCents ?? 0)) return false;
  return true;
}

export function matchLine(item: DeclarationItem, existing: DeclarationItem[]): Pick<ExtractedLine, 'match' | 'existingItemId' | 'existing'> {
  const found = existing.find((e) => sameLine(item, e));
  if (!found) return { match: 'new', existingItemId: null, existing: null };
  return {
    match: sameValues(item, found) ? 'duplicate' : 'conflict',
    existingItemId: found.id ?? null,
    existing: { valueCents: found.valueCents ?? 0, withheldCents: found.withheldCents ?? 0, prevValueCents: found.prevValueCents ?? 0, description: found.description ?? null },
  };
}

// ---------------------------------------------------------------------------
// Extração por IA
// ---------------------------------------------------------------------------
const cents = z.number().int().min(0).max(1e13);
const shortText = (max: number) => z.string().trim().max(max).nullish();
const aiItemSchema = z.object({
  kind: z.enum(ITEM_KIND_LIST as [ItemKind, ...ItemKind[]]),
  code: shortText(20),
  groupCode: shortText(20),
  description: shortText(500),
  ownerCpf: shortText(20),
  ownerName: shortText(200),
  counterpartyDoc: shortText(20),
  counterpartyName: shortText(200),
  prevValueCents: cents.nullish(),
  valueCents: cents.nullish(),
  withheldCents: cents.nullish(),
  extra: z.record(z.string(), z.unknown()).nullish(),
});

export function extractionPrompt(year: number) {
  const kinds = ITEM_KIND_LIST.map((k) => `- ${k}: ${ITEM_KINDS[k].label} (ficha "${ITEM_KINDS[k].ficha}")`).join('\n');
  return [
    `Você extrai dados de documentos para a Declaração de Ajuste Anual do Imposto de Renda Pessoa Física (DIRPF) do Brasil, exercício ${year}, ano-calendário ${year - 1}.`,
    'Responda SOMENTE com um objeto JSON, sem texto antes ou depois, no formato:',
    '{"items":[{"kind":"income_pj","counterpartyDoc":"00000000000191","counterpartyName":"Empresa","valueCents":1234567,"withheldCents":12345,"description":"..."}],"notes":"observações curtas ou null"}',
    'Campos de cada item: kind (obrigatório), code, groupCode, description, ownerCpf, ownerName, counterpartyDoc (CPF/CNPJ da fonte pagadora ou do beneficiário, só dígitos), counterpartyName, prevValueCents (situação em 31/12 do ano anterior, para bens e dívidas), valueCents, withheldCents (imposto retido).',
    'Valores SEMPRE em centavos, como números inteiros (R$ 1.234,56 = 123456).',
    'Valores possíveis de kind:',
    kinds,
    'Não invente dados: se o documento não informar um campo, omita-o. Se não houver nada aproveitável, responda {"items":[],"notes":"motivo"}.',
  ].join('\n');
}

/** Lê a resposta da IA: o primeiro objeto JSON do texto, com itens validados. */
export function parseAiExtraction(text: string): { items: DeclarationItem[]; notes: string | null; discarded: number } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('A IA não devolveu um JSON válido.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('A IA não devolveu um JSON válido.');
  }
  const obj = parsed as { items?: unknown; notes?: unknown };
  if (!Array.isArray(obj.items)) throw new Error('A resposta da IA não tem a lista "items".');
  const items: DeclarationItem[] = [];
  let discarded = 0;
  for (const raw of obj.items) {
    const r = aiItemSchema.safeParse(raw);
    if (!r.success) {
      discarded++;
      continue;
    }
    const v = r.data;
    const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : undefined);
    items.push({
      kind: v.kind,
      code: clean(v.code),
      groupCode: clean(v.groupCode),
      description: clean(v.description),
      ownerCpf: clean(onlyDigits(v.ownerCpf)),
      ownerName: clean(v.ownerName),
      counterpartyDoc: clean(onlyDigits(v.counterpartyDoc)),
      counterpartyName: clean(v.counterpartyName),
      prevValueCents: v.prevValueCents ?? undefined,
      valueCents: v.valueCents ?? 0,
      withheldCents: v.withheldCents ?? undefined,
      extra: v.extra ?? undefined,
    });
  }
  return { items, notes: typeof obj.notes === 'string' && obj.notes.trim() ? obj.notes.trim().slice(0, 1000) : null, discarded };
}

/** Erro do provedor de IA (configuração ausente, indisponibilidade): interrompe o job. */
export class AiProviderError extends Error {}

/**
 * Extrai as linhas de um documento com `ctx.providers.ai`, compara com as linhas já lançadas
 * e grava o resultado em `documents.extracted.elaboration`.
 */
export async function extractDocument(
  ctx: AppContext,
  input: { officeId: string; customer: CustomerRow; decl: DeclarationRow; doc: DocStat; existing: DeclarationItem[] },
): Promise<ElaborationExtraction> {
  const { db } = ctx;
  const { data } = await ctx.files.get(input.officeId, input.doc.fileId);
  let text: string;
  try {
    const res = await ctx.providers.ai.complete(input.officeId, {
      system: extractionPrompt(input.decl.exerciseYear),
      maxTokens: 4000,
      messages: [
        {
          role: 'user',
          content: `Documento "${input.doc.filename}" do cliente ${input.customer.name} (CPF ${formatCpfCnpj(input.customer.cpfCnpj)}). Extraia as linhas da DIRPF.`,
          files: [{ filename: input.doc.filename, mimeType: input.doc.mimeType, data }],
        },
      ],
    });
    text = res.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await saveExtraction(db, input.doc, 'error', { version: 1, processedAt: new Date().toISOString(), lines: [], notes: null, discarded: 0, error: msg });
    throw new AiProviderError(`IA indisponível ou não configurada: ${msg}. Configure a IA em Administração › Integrações e tente de novo.`);
  }
  let extraction: ElaborationExtraction;
  try {
    const parsed = parseAiExtraction(text);
    extraction = {
      version: 1,
      processedAt: new Date().toISOString(),
      notes: parsed.notes,
      discarded: parsed.discarded,
      error: null,
      lines: parsed.items.map((item) => ({ item, ...matchLine(item, input.existing), decision: null, appliedAt: null })),
    };
    await saveExtraction(db, input.doc, 'processed', extraction);
  } catch (err) {
    extraction = { version: 1, processedAt: new Date().toISOString(), lines: [], notes: null, discarded: 0, error: err instanceof Error ? err.message : String(err) };
    await saveExtraction(db, input.doc, 'error', extraction);
  }
  return extraction;
}

export async function saveExtraction(db: DbExecutor, doc: Pick<DocStat, 'id' | 'extracted'>, status: string, extraction: ElaborationExtraction) {
  const extracted = { ...(doc.extracted ?? {}), elaboration: extraction };
  await db.update(documents).set({ processingStatus: status, extracted }).where(eq(documents.id, doc.id));
  doc.extracted = extracted;
}

// ---------------------------------------------------------------------------
// Pacote de conferência (.zip)
// ---------------------------------------------------------------------------
const money = (c: number | null | undefined) => ((c ?? 0) / 100).toFixed(2).replace('.', ',');
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function itemsToCsv(items: DeclarationItem[]): string {
  const header = ['Ficha', 'Tipo', 'Código', 'Grupo', 'Descrição', 'CPF do titular', 'Titular', 'CPF/CNPJ fonte ou beneficiário', 'Nome fonte ou beneficiário', 'Valor anterior', 'Valor', 'Imposto retido', 'Origem'];
  const rows = items.map((i) => [
    ITEM_KINDS[i.kind]?.ficha ?? i.kind,
    ITEM_KINDS[i.kind]?.label ?? i.kind,
    i.code,
    i.groupCode,
    i.description,
    i.ownerCpf ? formatCpfCnpj(i.ownerCpf) : '',
    i.ownerName,
    i.counterpartyDoc ? formatCpfCnpj(i.counterpartyDoc) : '',
    i.counterpartyName,
    money(i.prevValueCents),
    money(i.valueCents),
    money(i.withheldCents),
    (i as DeclarationItem & { source?: string }).source ?? '',
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

const README = (customer: CustomerRow, year: number) => `PACOTE DE CONFERÊNCIA — VERIFCO
Cliente: ${customer.name} (CPF ${formatCpfCnpj(customer.cpfCnpj)})
Exercício ${year} · ano-calendário ${year - 1}
Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}

Este pacote serve para CONFERIR e DIGITAR a declaração. Ele NÃO é um arquivo para restaurar
no programa IRPF: o formato das cópias de segurança (.DBK) do programa não é público.

Conteúdo:
- linhas.csv   linhas da declaração (separador ";", valores em reais), abre no Excel;
- linhas.json  as mesmas linhas em JSON, com os dados da declaração;
- documentos/  os documentos do cliente usados na elaboração.
`;

/** Gera o .zip de conferência de uma declaração (linhas em CSV/JSON + documentos). */
export async function buildExportPackage(ctx: AppContext, officeId: string, customer: CustomerRow, decl: DeclarationRow): Promise<Buffer> {
  const items = await listItems(ctx.db, decl.id);
  const docs = (await loadDocStats(ctx.db, [decl.id])).get(decl.id) ?? [];
  const zip = new JSZip();
  zip.file('LEIA-ME.txt', README(customer, decl.exerciseYear));
  zip.file('linhas.csv', itemsToCsv(items));
  zip.file(
    'linhas.json',
    JSON.stringify(
      {
        generator: 'Verifco',
        kind: 'pacote-de-conferencia',
        customer: { name: customer.name, cpf: customer.cpfCnpj },
        exerciseYear: decl.exerciseYear,
        calendarYear: decl.exerciseYear - 1,
        generatedAt: new Date().toISOString(),
        items: items.map((i) => ({
          kind: i.kind,
          code: i.code ?? null,
          groupCode: i.groupCode ?? null,
          description: i.description ?? null,
          ownerCpf: i.ownerCpf ?? null,
          ownerName: i.ownerName ?? null,
          counterpartyDoc: i.counterpartyDoc ?? null,
          counterpartyName: i.counterpartyName ?? null,
          prevValueCents: i.prevValueCents ?? 0,
          valueCents: i.valueCents ?? 0,
          withheldCents: i.withheldCents ?? 0,
          extra: i.extra ?? {},
          source: (i as DeclarationItem & { source?: string }).source ?? null,
        })),
        documents: docs.map((d) => ({ filename: d.filename, category: d.category, uploadedBy: d.uploadedBy, size: d.size })),
      },
      null,
      2,
    ),
  );
  const used = new Set<string>();
  for (const d of docs) {
    let name = safeZipName(d.filename);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = safeZipName(d.filename).replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`);
    used.add(name.toLowerCase());
    const { data } = await ctx.files.get(officeId, d.fileId);
    zip.file(`documentos/${name}`, data);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export const exportFileName = (customer: CustomerRow, year: number) => `conferencia-${safeZipName(customer.name).replace(/\s+/g, '-').toLowerCase()}-${customer.cpfCnpj}-${year}.zip`;
