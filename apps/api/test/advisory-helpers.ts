import { eq } from 'drizzle-orm';
import { declarationItems, declarations, documents } from '../src/db/schema';
import { getOrCreateDeclaration } from '../src/services/declarations';
import type { TestEnv } from './helpers';

type ItemInput = Partial<typeof declarationItems.$inferInsert> & { kind: string };

/** Cria a declaração do exercício com as linhas informadas (direto no banco). */
export async function seedDeclaration(
  env: TestEnv,
  officeId: string,
  customerId: string,
  year: number,
  items: ItemInput[],
  fields: Partial<typeof declarations.$inferInsert> = {},
) {
  const d = await getOrCreateDeclaration(env.ctx.db, officeId, customerId, year);
  if (Object.keys(fields).length) await env.ctx.db.update(declarations).set(fields).where(eq(declarations.id, d.id));
  const rows = items.length
    ? await env.ctx.db
        .insert(declarationItems)
        .values(items.map((i) => ({ ...i, officeId, declarationId: d.id })))
        .returning()
    : [];
  return { declaration: d, items: rows };
}

/** Documento do cliente (arquivo + linha em `documents`). */
export async function seedDocument(env: TestEnv, officeId: string, customerId: string, filename: string, content: string | Buffer, mimeType: string) {
  const f = await env.ctx.files.save({ officeId, data: Buffer.isBuffer(content) ? content : Buffer.from(content), filename, mimeType });
  const [doc] = await env.ctx.db.insert(documents).values({ officeId, customerId, fileId: f.id, category: 'income_report' }).returning();
  return doc;
}

/** Corpo multipart/form-data para `app.inject`. */
export function multipart(files: { filename: string; content: string | Buffer; type?: string }[], fields: Record<string, string> = {}) {
  const boundary = `----verifco${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function upload(env: TestEnv, token: string, url: string, files: { filename: string; content: string | Buffer; type?: string }[]) {
  const m = multipart(files);
  const res = await env.app.inject({ method: 'POST', url, payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${token}` } });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res };
}

export const R = (reais: number) => Math.round(reais * 100);
