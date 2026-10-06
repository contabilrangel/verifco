/**
 * Upload e download seguros de arquivos. Todo upload passa por `readUploads` e todo download
 * de arquivo gravado sai por `sendStoredFile`.
 *
 * - O tipo gravado vem da extensão conferida com a assinatura do conteúdo, nunca do
 *   `Content-Type` que o navegador (ou quem chama a API) informa.
 * - Na entrega, só PDF e imagens (sem SVG) abrem no navegador; o resto vai como anexo, com
 *   `nosniff` e CSP `sandbox`, e tipos fora da lista viram `application/octet-stream`.
 *   Assim um HTML ou SVG enviado como "documento" não roda script na origem do Verifco.
 */
import type { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fileExtension } from '@verifco/shared';
import { HttpError, badRequest } from '../lib/errors';

export interface UploadedFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export const OCTET_STREAM = 'application/octet-stream';

/** Extensões conhecidas → tipo MIME gravado. */
export const KNOWN_FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
  txt: 'text/plain',
  xml: 'application/xml',
  ofx: 'application/x-ofx',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  zip: 'application/zip',
  pfx: 'application/x-pkcs12',
  p12: 'application/x-pkcs12',
};

/** Subconjunto de `KNOWN_FILE_TYPES` (extensão → MIME) para o `types` do `readUploads`. */
export const fileTypes = (...exts: string[]): Record<string, string> => Object.fromEntries(exts.map((e) => [e, KNOWN_FILE_TYPES[e]]));

/** Documentos do cliente enviados pela equipe: tudo o que é conhecido (o resto vira octet-stream). */
export const DOCUMENT_TYPES = fileTypes('pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'xls', 'xlsx', 'ods', 'csv', 'txt', 'xml', 'ofx', 'doc', 'docx', 'odt', 'zip');
/** Anexos que a IA consegue ler. */
export const AI_ATTACHMENT_TYPES = fileTypes('pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'csv', 'txt', 'xlsx');
/** Planilhas de importação. */
export const SHEET_TYPES = fileTypes('xlsx', 'csv');
/** Certificado digital A1. */
export const CERTIFICATE_TYPES = fileTypes('pfx', 'p12');
/** Só PDF (ex.: guia do DARF). */
export const PDF_TYPES = fileTypes('pdf');
/** Logo do escritório: os PDFs só desenham PNG/JPG (SVG ainda pode carregar script). */
export const LOGO_TYPES = fileTypes('png', 'jpg', 'jpeg');

/** Tipos que podem abrir no navegador (sem script). */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Tipos que a API entrega com o próprio Content-Type; os demais saem como octet-stream. */
const SERVABLE_TYPES = new Set(Object.values(KNOWN_FILE_TYPES));

/** Nome seguro para gravar e devolver no download (sem caminho nem caracteres de controle). */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'arquivo';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'arquivo';
  if (cleaned.length <= 180) return cleaned;
  const ext = fileExtension(cleaned);
  return `${cleaned.slice(0, 170).trimEnd()}${ext ? `.${ext}` : ''}`;
}

/**
 * Nome seguro para pastas e arquivos dentro de um .zip (e cabeçalhos de download): troca
 * separadores de caminho e caracteres proibidos por `_`, mantendo o resto do texto
 * (ex.: o CNPJ "12.345.678/0001-90" vira "12.345.678_0001-90").
 */
export function safeZipName(name: string, maxLength = 150): string {
  return (
    name
      .normalize('NFC')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength) || 'arquivo'
  );
}

/**
 * Quantos bytes do começo do arquivo `contentMatches` olha (no máximo). O `readUploads` confere o
 * tipo assim que eles chegam, sem esperar o resto do arquivo.
 */
export const SIGNATURE_BYTES = 8192;

/** Confere a assinatura do arquivo com a extensão (evita, por ex., um HTML renomeado para .pdf). */
export function contentMatches(ext: string, buf: Buffer): boolean {
  const head = buf.subarray(0, 16);
  const ascii = (from: number, to: number) => head.subarray(from, to).toString('latin1');
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isOle = head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const isText = () => !buf.subarray(0, SIGNATURE_BYTES).includes(0);
  switch (ext) {
    case 'pdf':
      return buf.subarray(0, 1024).includes('%PDF-');
    case 'png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
    case 'jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'gif':
      return ascii(0, 4) === 'GIF8';
    case 'webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'heic':
    case 'heif':
      return ascii(4, 8) === 'ftyp';
    case 'xlsx':
    case 'ods':
    case 'docx':
    case 'odt':
    case 'zip':
      return isZip;
    case 'xls':
    case 'doc':
      return isOle;
    case 'csv':
    case 'txt':
    case 'xml':
    case 'ofx':
      return isText();
    case 'pfx':
    case 'p12':
      // PKCS#12 em DER começa com SEQUENCE (0x30)
      return head[0] === 0x30;
    default:
      return false;
  }
}

/**
 * Tipo a gravar para um arquivo: o da extensão quando ela está em `types` e o conteúdo confere;
 * `null` quando não confere. Nunca usa o tipo informado por quem enviou.
 */
export function detectMime(filename: string, data: Buffer, types: Record<string, string> = KNOWN_FILE_TYPES): string | null {
  const ext = fileExtension(filename);
  const mime = types[ext];
  if (!mime) return null;
  return contentMatches(ext, data) ? mime : null;
}

/** Tipo pelo nome e conteúdo, ou `application/octet-stream` (para arquivos vindos do robô e afins). */
export function mimeForStoredFile(filename: string, data: Buffer): string {
  return detectMime(filename, data) ?? OCTET_STREAM;
}

/**
 * Arquivo recebido em base64 dentro de um JSON (ex.: PDFs da extensão do eCAC), com as mesmas
 * regras do `readUploads`: nome seguro e tipo pela extensão conferida com o conteúdo (o tipo
 * informado por quem enviou é ignorado).
 */
export function uploadedFromBase64(filename: string, base64: string): UploadedFile {
  const name = safeFilename(filename || 'arquivo');
  const data = Buffer.from(base64, 'base64');
  return { filename: name, data, mimeType: mimeForStoredFile(name, data) };
}

export interface ReadUploadsOptions {
  /** Extensões aceitas (extensão → MIME). */
  types: Record<string, string>;
  /**
   * O que fazer com arquivo fora da lista ou com conteúdo que não confere:
   * `reject` recusa o envio; `octet-stream` aceita e grava como binário (download apenas).
   */
  unknown?: 'reject' | 'octet-stream';
  maxBytes?: number;
  maxFiles?: number;
  /** Descrição dos tipos aceitos, para a mensagem de erro (ex.: "PDF, imagem ou planilha"). */
  accepted?: string;
  /** Recusa arquivo vazio (padrão: ignora). */
  rejectEmpty?: boolean;
  /**
   * Soma máxima dos arquivos lidos para a memória num envio (padrão: 100 MB). Passou disso, o
   * resto do formulário é lido e descartado e o envio é recusado com 413.
   */
  maxTotalBytes?: number;
  /** Fica só com o primeiro arquivo: os demais são descartados (`resume`), sem ir para a memória. */
  firstFileOnly?: boolean;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const formatMb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Lê um formulário multipart: arquivos (validados por extensão e assinatura) e campos de texto.
 * Traduz os erros de limite do @fastify/multipart para mensagens em português.
 *
 * Os arquivos vêm para a memória (quem chama recebe o `Buffer`), com teto por arquivo
 * (`maxBytes`) e pela soma do envio (`maxTotalBytes`). O tipo é conferido nos primeiros bytes:
 * conteúdo que não confere é recusado antes de ler o resto do arquivo.
 */
export async function readUploads(req: FastifyRequest, opts: ReadUploadsOptions): Promise<{ files: UploadedFile[]; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw badRequest('Envie o arquivo pelo formulário de upload.');
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? 20;
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const strict = opts.unknown !== 'octet-stream';
  const files: UploadedFile[] = [];
  const fields: Record<string, string> = {};
  const tooLarge = (name: string) => new HttpError(413, `O arquivo “${name}” passa de ${formatMb(maxBytes)}. Envie um arquivo menor.`);
  let current = 'arquivo';
  let total = 0;
  let overTotal = false;
  try {
    for await (const part of req.parts({ limits: { fileSize: maxBytes, files: maxFiles } })) {
      if (part.type !== 'file') {
        fields[part.fieldname] = String(part.value ?? '');
        continue;
      }
      const filename = safeFilename(part.filename || 'arquivo');
      current = filename;
      // arquivo que não vai ser usado: descarta sem guardar, lendo até o fim para o formulário seguir
      if (overTotal || (opts.firstFileOnly && files.length)) {
        part.file.resume();
        continue;
      }
      // extensão fora da lista: recusa antes de ler o conteúdo
      if (strict && !opts.types[fileExtension(filename)]) {
        throw badRequest(`O arquivo “${filename}” não é aceito.${opts.accepted ? ` Envie ${opts.accepted}.` : ''}`);
      }
      const typeOf = (head: Buffer) => {
        const mime = detectMime(filename, head, opts.types);
        if (!mime && strict) throw badRequest(`O conteúdo de “${filename}” não corresponde ao tipo do arquivo.`);
        return mime ?? OCTET_STREAM;
      };
      const chunks: Buffer[] = [];
      let size = 0;
      // conferido assim que chegam os primeiros SIGNATURE_BYTES (ou no fim, se o arquivo for menor)
      let mimeType: string | undefined;
      for await (const chunk of part.file as AsyncIterable<Buffer>) {
        if (overTotal) continue;
        size += chunk.length;
        if (total + size > maxTotal) {
          overTotal = true;
          chunks.length = 0;
          continue;
        }
        chunks.push(chunk);
        if (mimeType === undefined && size >= SIGNATURE_BYTES) mimeType = typeOf(Buffer.concat(chunks, size));
      }
      if (overTotal) continue;
      // o @fastify/multipart corta o arquivo no limite e marca `truncated`
      if ((part.file as { truncated?: boolean }).truncated) throw tooLarge(filename);
      const data = Buffer.concat(chunks, size);
      if (!data.length) {
        if (opts.rejectEmpty) throw badRequest(`O arquivo “${filename}” está vazio.`);
        continue;
      }
      mimeType ??= typeOf(data);
      total += data.length;
      files.push({ filename, mimeType, data });
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(current);
    if (code === 'FST_FILES_LIMIT') throw new HttpError(413, `Envie no máximo ${maxFiles === 1 ? 'um arquivo' : `${maxFiles} arquivos`} por vez.`);
    throw err;
  }
  if (overTotal) throw new HttpError(413, `Os arquivos enviados passam de ${formatMb(maxTotal)} juntos. Envie menos arquivos por vez.`);
  return { files, fields };
}

/** Tipo com que um arquivo gravado é entregue: só os conhecidos; o resto vira octet-stream. */
export function servedMimeType(stored: string): string {
  return SERVABLE_TYPES.has(stored) ? stored : OCTET_STREAM;
}

/** Pode abrir no navegador (PDF e imagens sem script). */
export const isInlineType = (mime: string) => INLINE_TYPES.has(mime);

/**
 * Entrega um arquivo gravado sem permitir execução de conteúdo: tipo da lista branca,
 * `inline` só para PDF e imagens, `nosniff`, CSP `sandbox` e sem cache compartilhado
 * (`cacheControl` só muda o cache, ex.: o logo público do escritório).
 *
 * O conteúdo vai de preferência em stream (`ctx.files.open`), sem carregar o arquivo na
 * memória; com o `size` do registro, a resposta leva `Content-Length`. Um .zip montado na hora
 * (`zipStoredFiles`) vai sem `size`, em partes.
 */
export function sendStoredFile(
  reply: FastifyReply,
  file: { filename: string; mimeType: string; size?: number | null },
  data: Buffer | Readable,
  inline = false,
  cacheControl = 'private, no-store',
) {
  const type = servedMimeType(file.mimeType);
  const canInline = inline && isInlineType(type);
  reply
    .header('Content-Type', type)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', cacheControl)
    .header('Content-Disposition', `${canInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  // o visualizador de PDF do Chrome não abre em documento com sandbox
  if (type !== 'application/pdf') reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  if (!Buffer.isBuffer(data) && typeof file.size === 'number') reply.header('Content-Length', String(file.size));
  return reply.send(data);
}
