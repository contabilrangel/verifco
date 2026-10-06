import type { TestEnv } from './helpers';

/** Monta um corpo multipart/form-data para `app.inject`. */
export function multipart(fields: Record<string, string>, file?: { name: string; content: Buffer | string; type?: string }) {
  const boundary = `----verifco${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`),
    );
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Requisição autenticada com token de máquina (`vfk_...`) ou JWT de usuário. */
export async function send(
  env: TestEnv,
  token: string | null,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: { json?: unknown; multipart?: ReturnType<typeof multipart> },
) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const res = await env.app.inject({
    method,
    url,
    headers: { ...headers, ...(body?.multipart?.headers ?? {}) },
    payload: (body?.multipart?.payload ?? body?.json) as never,
  });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, body: json, raw: res };
}

/** Um PDF mínimo (o conteúdo não importa para a IA falsa dos testes). */
export const fakePdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
