import type { FastifyRequest } from 'fastify';
import { badRequest } from '../../lib/errors';

export interface UploadedFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * Lê um formulário multipart com no máximo um arquivo (campo `file`) e campos de texto.
 * O limite de tamanho é o do plugin multipart (25 MB).
 */
export async function readMultipart(req: FastifyRequest): Promise<{ file: UploadedFile | null; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw badRequest('Envie o formulário como multipart/form-data.');
  const fields: Record<string, string> = {};
  let file: UploadedFile | null = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (file) continue; // só o primeiro arquivo é considerado
      file = { buffer, filename: part.filename || 'arquivo', mimeType: part.mimetype || 'application/octet-stream' };
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }
  return { file, fields };
}

/** Tipo MIME pelo nome quando o cliente manda `application/octet-stream`. */
export function guessMimeType(filename: string, sent: string): string {
  if (sent && sent !== 'application/octet-stream') return sent;
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    xml: 'application/xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    zip: 'application/zip',
    txt: 'text/plain',
  };
  return (ext && map[ext]) || 'application/octet-stream';
}

/** Nome seguro para entradas de .zip e cabeçalhos de download. */
export function safeName(name: string): string {
  return (
    name
      .normalize('NFC')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150) || 'arquivo'
  );
}
