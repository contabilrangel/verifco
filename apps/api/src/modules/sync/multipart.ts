import type { FastifyRequest } from 'fastify';
import { badRequest } from '../../lib/errors';
import { fileExtension } from '@verifco/shared';
import { KNOWN_FILE_TYPES, OCTET_STREAM } from '../../services/uploads';

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

/**
 * Tipo MIME gravado para arquivos do robô e uploads manuais (eCAC, pré-preenchidas): só pela
 * extensão, numa lista de tipos sem script. O tipo informado por quem enviou é ignorado (um
 * .html enviado como "application/pdf" vira binário, só para download).
 */
export function guessMimeType(filename: string, _sent?: string): string {
  return KNOWN_FILE_TYPES[fileExtension(filename)] ?? OCTET_STREAM;
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
