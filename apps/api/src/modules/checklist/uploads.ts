import type { FastifyReply, FastifyRequest } from 'fastify';
import { CHECKLIST_MAX_UPLOAD_BYTES, checklistUploadMime, fileExtension } from '@verifco/shared';
import { HttpError, badRequest } from '../../lib/errors';

export interface UploadedFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

const MAX_FILES_PER_REQUEST = 10;

/** Nome seguro para gravar e devolver no download (sem caminho nem caracteres de controle). */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'arquivo';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'arquivo';
  if (cleaned.length <= 180) return cleaned;
  const ext = fileExtension(cleaned);
  return `${cleaned.slice(0, 170).trimEnd()}${ext ? `.${ext}` : ''}`;
}

/** Confere a assinatura do arquivo com a extensão (evita, por ex., um executável renomeado para .pdf). */
export function contentMatches(ext: string, buf: Buffer): boolean {
  const head = buf.subarray(0, 16);
  const ascii = (from: number, to: number) => head.subarray(from, to).toString('latin1');
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
      return head[0] === 0x50 && head[1] === 0x4b;
    case 'xls':
      return head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    case 'csv':
      return !buf.subarray(0, 8192).includes(0);
    default:
      return false;
  }
}

/**
 * Lê os arquivos de um upload multipart do checklist: só PDF, imagens e planilhas,
 * até 20 MB cada e 10 por envio. O tipo gravado vem da extensão conferida, não do navegador.
 */
export async function readChecklistUploads(req: FastifyRequest): Promise<UploadedFile[]> {
  if (!req.isMultipart()) throw badRequest('Envie o arquivo pelo formulário de upload.');
  const out: UploadedFile[] = [];
  const parts = req.files({ limits: { fileSize: CHECKLIST_MAX_UPLOAD_BYTES, files: MAX_FILES_PER_REQUEST } });
  let current = 'arquivo';
  try {
    for await (const part of parts) {
      const filename = safeFilename(part.filename || 'arquivo');
      current = filename;
      const mimeType = checklistUploadMime(filename);
      if (!mimeType) throw badRequest(`O arquivo “${filename}” não é aceito. Envie PDF, imagem (JPG, PNG, HEIC) ou planilha (XLSX, XLS, ODS, CSV).`);
      const data = await part.toBuffer();
      if (!data.length) throw badRequest(`O arquivo “${filename}” está vazio.`);
      if (!contentMatches(fileExtension(filename), data)) throw badRequest(`O conteúdo de “${filename}” não corresponde ao tipo do arquivo.`);
      out.push({ filename, mimeType, data });
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, `O arquivo “${current}” passa de 20 MB. Envie um arquivo menor.`);
    if (code === 'FST_FILES_LIMIT') throw new HttpError(413, `Envie no máximo ${MAX_FILES_PER_REQUEST} arquivos por vez.`);
    throw err;
  }
  if (!out.length) throw badRequest('Selecione ao menos um arquivo.');
  return out;
}

/** Envia um arquivo do checklist para o navegador sem permitir execução de conteúdo. */
export function sendStoredFile(reply: FastifyReply, file: { filename: string; mimeType: string }, data: Buffer, inline: boolean) {
  const canInline = inline && /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(file.mimeType);
  return reply
    .header('Content-Type', file.mimeType)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', `${canInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
    .send(data);
}
