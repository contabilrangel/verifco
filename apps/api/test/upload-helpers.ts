import type { TestEnv } from './helpers';

export interface UploadFile {
  name: string;
  content: Buffer | string;
  type?: string;
}

/** Monta um corpo multipart/form-data para `app.inject`. */
export function multipartBody(files: UploadFile[], fields: Record<string, string> = {}) {
  const boundary = `----verifco${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Envia arquivos autenticado como o dono do token. */
export async function upload(env: TestEnv, token: string, url: string, files: UploadFile[], fields: Record<string, string> = {}) {
  const { payload, contentType } = multipartBody(files, fields);
  const res = await env.app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${token}`, 'content-type': contentType } });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res };
}

/** PDF mínimo válido o bastante para os testes (começa com %PDF). */
export const FAKE_PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
