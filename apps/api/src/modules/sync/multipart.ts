import type { FastifyRequest } from 'fastify';
import { KNOWN_FILE_TYPES, readUploads, type UploadedFile } from '../../services/uploads';

/**
 * Formulário multipart do robô, da extensão e dos envios manuais (eCAC, pré-preenchidas):
 * o primeiro arquivo (campo `file`) e os campos de texto, lidos por `readUploads`. Aceita
 * qualquer extensão (os .DEC/.REC/.DBK do programa IRPF não têm assinatura conhecida): o que não
 * está na lista de tipos ou não confere com o conteúdo é gravado como binário, só para download.
 */
export async function readMultipart(req: FastifyRequest): Promise<{ file: UploadedFile | null; fields: Record<string, string> }> {
  const { files, fields } = await readUploads(req, { types: KNOWN_FILE_TYPES, unknown: 'octet-stream' });
  return { file: files[0] ?? null, fields };
}
