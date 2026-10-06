import { declarationItems } from '../src/db/schema';
import { getOrCreateDeclaration, setDeclarationSubstatus } from '../src/services/declarations';
import type { DeclarationSubstatus } from '@verifco/shared';
import { client, registerOffice, type TestEnv } from './helpers';

/** Apoio aos testes do checklist e do portal (uploads multipart e dados de declaração). */
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

export function multipart(files: { name: string; data: Buffer; type?: string }[]) {
  const boundary = `----vf${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function upload(env: TestEnv, token: string, url: string, files: { name: string; data: Buffer; type?: string }[]) {
  const { payload, contentType } = multipart(files);
  const res = await env.app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType, authorization: `Bearer ${token}` } });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body };
}

/** Escritório com uma cliente (e-mail e celular) pronta para os testes. */
export async function officeWithCustomer(env: TestEnv, cpf: string, name = 'Maria Souza') {
  const office = await registerOffice(env);
  const created = await office.api.post('/api/customers', { name, cpfCnpj: cpf, email: `${cpf}@cliente.com` });
  if (created.status !== 201) throw new Error(`cliente: ${JSON.stringify(created.body)}`);
  await office.api.put(`/api/customers/${created.body.id}/identification`, { name, email: `${cpf}@cliente.com`, mobile: '11987654321' });
  return { ...office, customerId: created.body.id as string, customerEmail: `${cpf}@cliente.com` };
}

export async function addPreviousYear(env: TestEnv, officeId: string, customerId: string, year: number, items: Partial<typeof declarationItems.$inferInsert>[]) {
  const d = await getOrCreateDeclaration(env.ctx.db, officeId, customerId, year);
  if (items.length) await env.ctx.db.insert(declarationItems).values(items.map((i) => ({ kind: 'income_pj', ...i, officeId, declarationId: d.id })));
  return d;
}

export async function setSubstatus(env: TestEnv, officeId: string, customerId: string, year: number, s: DeclarationSubstatus) {
  const d = await getOrCreateDeclaration(env.ctx.db, officeId, customerId, year);
  return setDeclarationSubstatus(env.ctx.db, d.id, s);
}

/** Envia o acesso e devolve o token (do link) e o código. */
export async function issueAccess(api: ReturnType<typeof client>, checklistId: string, channels: string[] = []) {
  const res = await api.post(`/api/checklists/${checklistId}/access`, { channels });
  if (res.status !== 200) throw new Error(`acesso: ${JSON.stringify(res.body)}`);
  return { link: res.body.link as string, token: (res.body.link as string).split('/checklist/')[1], code: res.body.code as string };
}

export async function customerLogin(env: TestEnv, token: string, cpf: string, code: string) {
  const res = await env.app.inject({ method: 'POST', url: '/api/portal/checklist-login', payload: { token, cpf, code } });
  return { status: res.statusCode, body: res.json(), api: res.statusCode === 200 ? client(env, res.json().token) : null };
}
