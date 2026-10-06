import type { FastifyRequest } from 'fastify';
import { CHECKLIST_MAX_UPLOAD_BYTES, CHECKLIST_UPLOAD_TYPES } from '@verifco/shared';
import { badRequest } from '../../lib/errors';
import { readUploads, type UploadedFile } from '../../services/uploads';

const MAX_FILES_PER_REQUEST = 10;

/**
 * Lê os arquivos de um upload multipart do checklist (`readUploads` com as regras do checklist):
 * só PDF, imagens e planilhas, até 20 MB cada e 10 por envio, sem arquivo vazio. O tipo gravado
 * vem da extensão conferida com o conteúdo, não do navegador.
 */
export async function readChecklistUploads(req: FastifyRequest): Promise<UploadedFile[]> {
  const { files } = await readUploads(req, {
    types: CHECKLIST_UPLOAD_TYPES,
    maxBytes: CHECKLIST_MAX_UPLOAD_BYTES,
    maxFiles: MAX_FILES_PER_REQUEST,
    accepted: 'PDF, imagem (JPG, PNG, HEIC) ou planilha (XLSX, XLS, ODS, CSV)',
    rejectEmpty: true,
  });
  if (!files.length) throw badRequest('Selecione ao menos um arquivo.');
  return files;
}
