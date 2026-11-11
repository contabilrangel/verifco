import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CHECKLIST_UPLOAD_TYPES } from '@verifco/shared';
import type { AppContext } from '../../context';
import { badRequest, notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import { readUploads, type UploadedFile } from '../../services/uploads';

/** Anexos por mensagem e tamanho de cada um (a tela do chat confere os mesmos limites antes de enviar). */
export const MESSAGE_MAX_ATTACHMENTS = 5;
export const MESSAGE_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MESSAGE_MAX_LENGTH = 4000;

/** O que fica em `messages.attachments` (e o que as listagens devolvem). */
export interface MessageAttachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
}

const inputSchema = z.object({
  body: z.string().trim().max(MESSAGE_MAX_LENGTH, 'Mensagem muito longa (máximo de 4.000 caracteres)').default(''),
  whatsapp: z.boolean().default(false),
});

export interface MessageInput {
  body: string;
  whatsapp: boolean;
  files: UploadedFile[];
}

/**
 * Lê uma mensagem nova: JSON `{ body, whatsapp? }` (só texto) ou multipart com os campos `body` e
 * `whatsapp` e até 5 arquivos (`file`) de até 10 MB, dos tipos aceitos no checklist (PDF, imagem
 * ou planilha). Vale mensagem só com texto ou só com anexo; sem nenhum dos dois, 400.
 */
export async function readMessageInput(req: FastifyRequest): Promise<MessageInput> {
  let raw: unknown = req.body;
  let files: UploadedFile[] = [];
  if (req.isMultipart()) {
    const read = await readUploads(req, {
      types: CHECKLIST_UPLOAD_TYPES,
      maxBytes: MESSAGE_MAX_ATTACHMENT_BYTES,
      maxFiles: MESSAGE_MAX_ATTACHMENTS,
      accepted: 'PDF, imagem (JPG, PNG, HEIC) ou planilha (XLSX, XLS, ODS, CSV)',
      rejectEmpty: true,
    });
    files = read.files;
    raw = { body: read.fields.body ?? '', whatsapp: ['true', '1'].includes(read.fields.whatsapp ?? '') };
  }
  const input = parse(inputSchema, raw);
  if (!input.body && !files.length) throw badRequest('Escreva a mensagem ou anexe um arquivo.');
  return { ...input, files };
}

/** Grava os arquivos da mensagem e devolve o que vai para `messages.attachments`. */
export async function saveAttachments(ctx: AppContext, officeId: string, files: UploadedFile[], userId: string | null = null): Promise<MessageAttachment[]> {
  const saved: MessageAttachment[] = [];
  try {
    for (const f of files) {
      const row = await ctx.files.save({ officeId, data: f.data, filename: f.filename, mimeType: f.mimeType, userId });
      saved.push({ fileId: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size });
    }
  } catch (err) {
    await removeAttachments(ctx, officeId, saved);
    throw err;
  }
  return saved;
}

/** Desfaz a gravação quando a mensagem não pôde ser registrada (não deixa arquivo sem mensagem). */
export async function removeAttachments(ctx: AppContext, officeId: string, attachments: MessageAttachment[]) {
  for (const a of attachments) await ctx.files.remove(officeId, a.fileId).catch(() => {});
}

/** Só os campos públicos de cada anexo (o JSON gravado pode trazer mais coisa de outra origem). */
export function publicAttachments(list: unknown): MessageAttachment[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a): a is MessageAttachment => Boolean(a) && typeof a.fileId === 'string')
    .map((a) => ({ fileId: a.fileId, filename: String(a.filename ?? 'arquivo'), mimeType: String(a.mimeType ?? 'application/octet-stream'), size: Number(a.size) || 0 }));
}

/** O anexo `fileId` da mensagem, ou 404 (o arquivo só sai por uma mensagem que o cita). */
export function attachmentOf(message: { attachments: unknown } | undefined, fileId: string): MessageAttachment {
  const found = message ? publicAttachments(message.attachments).find((a) => a.fileId === fileId) : undefined;
  if (!found) throw notFound('Anexo');
  return found;
}

/** Resumo da mensagem para listas e notificações: o texto cortado ou, sem texto, os anexos. */
export function messagePreview(body: string, attachments: number, max = 140): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  if (attachments > 1) return `${attachments} anexos`;
  return attachments ? 'Anexo' : '';
}
