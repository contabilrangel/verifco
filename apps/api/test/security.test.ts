/**
 * Regressões de segurança: download pela rota genérica de arquivos, tipos de arquivo,
 * procuradores, escalada de privilégio entre colaboradores, códigos de acesso no histórico,
 * notificações por escopo e conta do usuário.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { currentExerciseYear } from '@verifco/shared';
import { checklists, customers, darfs, deliveries, documents, ecacRecords, importBatches, jobs, messages, passwordResets, procurators, users } from '../src/db/schema';
import { signCustomerToken } from '../src/plugins/auth';
import { notify } from '../src/services/notify';
import { buildWorkbook } from '../src/services/xlsx';
import { guessMimeType } from '../src/modules/sync/multipart';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { PDF } from './portal-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const YEAR = currentExerciseYear();
/** Começo de um PKCS#12 em DER (SEQUENCE). */
const PFX = Buffer.concat([Buffer.from([0x30, 0x82, 0x0a, 0x10]), Buffer.from('PFX-BYTES-SECRETOS')]);

async function uploadAs(token: string, url: string, files: { name: string; data: Buffer; type?: string }[], fields: Record<string, string> = {}) {
  const boundary = `----sec${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const res = await env.app.inject({
    method: 'POST',
    url,
    payload: Buffer.concat(chunks),
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res };
}

async function officeWithCustomer(cpf: string) {
  const o = await registerOffice(env);
  const c = await o.api.post('/api/customers', { name: 'Cliente Seguro', cpfCnpj: cpf, email: `${cpf}@cliente.com` });
  await o.api.put(`/api/customers/${c.body.id}/identification`, { name: 'Cliente Seguro', email: `${cpf}@cliente.com`, mobile: '11987654321' });
  return { ...o, customerId: c.body.id as string };
}

async function procuratorWithCertificate(o: Awaited<ReturnType<typeof registerOffice>>, userId?: string) {
  const p = await o.api.post('/api/procurators', { name: 'Procurador A1', cpfCnpj: '11.222.333/0001-81', ...(userId ? { userId } : {}) });
  const up = await uploadAs(o.token, `/api/procurators/${p.body.id}/certificate`, [{ name: 'cert.pfx', data: PFX, type: 'application/x-pkcs12' }], { password: 'senha-do-pfx' });
  expect(up.status).toBe(200);
  const row = await env.ctx.db.query.procurators.findFirst({ where: eq(procurators.id, p.body.id) });
  return { id: p.body.id as string, fileId: row!.certificateFileId! };
}

describe('GET /files/:id (SEG-1, INT-4)', () => {
  it('não entrega o certificado A1 a ninguém e GET /procurators não expõe o id do arquivo', async () => {
    const o = await registerOffice(env);
    const cert = await procuratorWithCertificate(o);
    const emp = await createEmployee(env, o.api, []);
    const list = await emp.api.get('/api/procurators');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([{ id: cert.id, name: 'Procurador A1' }]);
    const full = await o.api.get('/api/procurators');
    expect(JSON.stringify(full.body)).not.toContain(cert.fileId);
    expect(full.body[0]).toMatchObject({ hasCertificate: true });
    expect(full.body[0]).not.toHaveProperty('certificateFileId');
    expect(full.body[0]).not.toHaveProperty('certificatePasswordEnc');
    // nem o colaborador sem permissão nem o dono baixam o .pfx pela rota genérica
    expect((await emp.api.get(`/api/files/${cert.fileId}`)).status).toBe(404);
    expect((await o.api.get(`/api/files/${cert.fileId}`)).status).toBe(404);
  });

  it('POST e PUT de procurador não devolvem segredos', async () => {
    const o = await registerOffice(env);
    const created = await o.api.post('/api/procurators', { name: 'Proc', cpfCnpj: VALID_CPFS[0] });
    expect(created.body).not.toHaveProperty('certificatePasswordEnc');
    expect(created.body).not.toHaveProperty('certificateFileId');
    const upd = await o.api.put(`/api/procurators/${created.body.id}`, { name: 'Proc 2', cpfCnpj: VALID_CPFS[0] });
    expect(upd.body).not.toHaveProperty('certificatePasswordEnc');
    expect(upd.body).not.toHaveProperty('certificateFileId');
  });

  it('aplica permissão e escopo do cliente aos documentos', async () => {
    const o = await officeWithCustomer(VALID_CPFS[1]);
    const up = await uploadAs(o.token, `/api/customers/${o.customerId}/documents?year=${YEAR}`, [{ name: 'informe.pdf', data: PDF, type: 'application/pdf' }]);
    expect(up.status).toBe(201);
    const fileId = up.body[0].fileId as string;
    const noPerm = await createEmployee(env, o.api, ['customer.list']);
    expect((await noPerm.api.get(`/api/files/${fileId}`)).status).toBe(403);
    const reader = await createEmployee(env, o.api, ['declaration.view', 'customer.download_documents']);
    expect((await reader.api.get(`/api/files/${fileId}`)).status).toBe(200);
    // escritório restringe os contadores aos próprios clientes: o mesmo 404 da rota de documentos
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    expect((await reader.api.get(`/api/documents/${up.body[0].id}/file`)).status).toBe(404);
    expect((await reader.api.get(`/api/files/${fileId}`)).status).toBe(404);
    await env.ctx.db.update(customers).set({ responsibleUserId: reader.userId }).where(eq(customers.id, o.customerId));
    expect((await reader.api.get(`/api/files/${fileId}`)).status).toBe(200);
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: false });
  });

  it('entrega logo a qualquer usuário, recusa backup e arquivo sem dono', async () => {
    const o = await registerOffice(env);
    const emp = await createEmployee(env, o.api, []);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    const logo = await uploadAs(o.token, '/api/office/logo', [{ name: 'logo.png', data: png, type: 'image/png' }]);
    expect((await emp.api.get(`/api/files/${logo.body.logoFileId}?inline=1`)).status).toBe(200);

    const backupFile = await env.ctx.files.save({ officeId: o.officeId, data: Buffer.from('PK'), filename: 'backup.zip', mimeType: 'application/zip' });
    await env.ctx.db.insert(jobs).values({ officeId: o.officeId, type: 'backup.generate', status: 'done', result: { fileId: backupFile.id } });
    expect((await o.api.get(`/api/files/${backupFile.id}`)).status).toBe(404);

    const orphan = await env.ctx.files.save({ officeId: o.officeId, data: PDF, filename: 'solto.pdf', mimeType: 'application/pdf' });
    expect((await o.api.get(`/api/files/${orphan.id}`)).status).toBe(404);
  });

  it('anexo de envio sai para quem consulta os envios; registro do eCAC exige ecac.view', async () => {
    const o = await officeWithCustomer(VALID_CPFS[2]);
    const att = await env.ctx.files.save({ officeId: o.officeId, data: PDF, filename: 'darf.pdf', mimeType: 'application/pdf' });
    await env.ctx.db.insert(deliveries).values({ officeId: o.officeId, customerId: o.customerId, channel: 'email', toAddress: 'x@y.com', body: 'oi', attachments: [{ fileId: att.id, filename: 'darf.pdf' }] });
    const mailing = await createEmployee(env, o.api, ['mailing.list']);
    const other = await createEmployee(env, o.api, ['customer.list']);
    expect((await mailing.api.get(`/api/files/${att.id}`)).status).toBe(200);
    expect((await other.api.get(`/api/files/${att.id}`)).status).toBe(403);

    const rec = await env.ctx.files.save({ officeId: o.officeId, data: PDF, filename: 'situacao.pdf', mimeType: 'application/pdf' });
    await env.ctx.db.insert(ecacRecords).values({ officeId: o.officeId, customerId: o.customerId, kind: 'tax_situation', fileId: rec.id });
    const ecac = await createEmployee(env, o.api, ['ecac.view']);
    expect((await ecac.api.get(`/api/files/${rec.id}`)).status).toBe(200);
    expect((await mailing.api.get(`/api/files/${rec.id}`)).status).toBe(403);
  });

  it('DARF gerada pelo escritório abre para quem vê a aba eCAC (ecac.view), sem precisar de darf.*', async () => {
    const o = await officeWithCustomer(VALID_CPFS[3]);
    const pdf = await env.ctx.files.save({ officeId: o.officeId, data: PDF, filename: 'darf-quota-1.pdf', mimeType: 'application/pdf' });
    await env.ctx.db.insert(darfs).values({ officeId: o.officeId, customerId: o.customerId, valueCents: 12_345, dueDate: `${YEAR}-05-29`, source: 'office', fileId: pdf.id });
    const ecac = await createEmployee(env, o.api, ['customer.list', 'ecac.view']);
    // a aba eCAC devolve a DARF com o fileId usado pelo botão "Abrir PDF"
    const panel = await ecac.api.get(`/api/customers/${o.customerId}/ecac`);
    expect(panel.status).toBe(200);
    expect(JSON.stringify(panel.body)).toContain(pdf.id);
    const opened = await ecac.api.get(`/api/files/${pdf.id}?inline=1`);
    expect(opened.status).toBe(200);
    expect(opened.raw.headers['content-type']).toContain('application/pdf');
    const darfReader = await createEmployee(env, o.api, ['darf.view']);
    expect((await darfReader.api.get(`/api/files/${pdf.id}`)).status).toBe(200);
    const none = await createEmployee(env, o.api, ['customer.list', 'mailing.list']);
    expect((await none.api.get(`/api/files/${pdf.id}`)).status).toBe(403);
  });

  it('não aceita o token de sessão na URL (CON-14)', async () => {
    const o = await registerOffice(env);
    const res = await env.app.inject({ method: 'GET', url: `/api/auth/me?token=${o.token}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('tipos de arquivo e entrega segura (SEG-3, CON-3)', () => {
  it('grava pela extensão conferida e nunca serve HTML/SVG para abrir no navegador', async () => {
    const o = await officeWithCustomer(VALID_CPFS[3]);
    const html = Buffer.from('<html><script>alert(localStorage.getItem("verifco.token"))</script></html>');
    const up = await uploadAs(o.token, `/api/customers/${o.customerId}/documents?year=${YEAR}`, [
      { name: 'extrato.html', data: html, type: 'text/html' },
      { name: 'disfarce.pdf', data: html, type: 'application/pdf' },
      { name: 'img.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), type: 'image/svg+xml' },
      { name: 'informe.pdf', data: PDF, type: 'text/html' },
    ]);
    expect(up.status).toBe(201);
    expect(up.body.map((d: any) => [d.filename, d.mimeType])).toEqual([
      ['extrato.html', 'application/octet-stream'],
      ['disfarce.pdf', 'application/octet-stream'],
      ['img.svg', 'application/octet-stream'],
      ['informe.pdf', 'application/pdf'],
    ]);
    const asHtml = await o.api.get(`/api/documents/${up.body[0].id}/file?inline=1`);
    expect(asHtml.raw.headers['content-type']).toBe('application/octet-stream');
    expect(String(asHtml.raw.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(asHtml.raw.headers['x-content-type-options']).toBe('nosniff');
    expect(String(asHtml.raw.headers['content-security-policy'])).toContain('sandbox');
    const pdf = await o.api.get(`/api/files/${up.body[3].fileId}?inline=1`);
    expect(pdf.raw.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.raw.headers['content-disposition'])).toMatch(/^inline;/);
  });

  it('arquivo antigo gravado como text/html é entregue como binário', async () => {
    const o = await officeWithCustomer(VALID_CPFS[4]);
    const f = await env.ctx.files.save({ officeId: o.officeId, data: Buffer.from('<script>x</script>'), filename: 'velho.html', mimeType: 'text/html' });
    await env.ctx.db.insert(documents).values({ officeId: o.officeId, customerId: o.customerId, fileId: f.id });
    const res = await o.api.get(`/api/files/${f.id}?inline=1`);
    expect(res.status).toBe(200);
    expect(res.raw.headers['content-type']).toBe('application/octet-stream');
    expect(String(res.raw.headers['content-disposition'])).toMatch(/^attachment;/);
  });

  it('importação de orçamentos grava o tipo da planilha, não o informado pelo navegador', async () => {
    const o = await officeWithCustomer(VALID_CPFS[5]);
    const sheet = await buildWorkbook([{ name: 'Orçamentos', columns: [{ header: 'CPF/CNPJ', key: 'cpf' }, { header: 'Valor', key: 'valor' }], rows: [{ cpf: VALID_CPFS[5], valor: '500,00' }] }]);
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const ok = await uploadAs(o.token, '/api/finance/budget-import', [{ name: 'orcamentos.xlsx', data: sheet, type: 'text/html' }], { year: String(YEAR) });
    expect(ok.status).toBe(200);
    const batch = await env.ctx.db.query.importBatches.findFirst({ where: eq(importBatches.id, ok.body.id) });
    const stored = await env.ctx.files.get(o.officeId, batch!.fileId!);
    expect(stored.row.mimeType).toBe(XLSX);
    const served = await o.api.get(`/api/files/${batch!.fileId}?inline=1`);
    expect(served.status).toBe(200);
    expect(served.raw.headers['content-type']).toBe(XLSX);
    expect(String(served.raw.headers['content-disposition'])).toMatch(/^attachment;/);
    // HTML disfarçado de planilha e extensão fora da lista são recusados antes de gravar
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const fake = await uploadAs(o.token, '/api/finance/budget-import', [{ name: 'orcamentos.xlsx', data: html, type: XLSX }], { year: String(YEAR) });
    expect(fake.status).toBe(400);
    expect(fake.body.error).toContain('não corresponde');
    const page = await uploadAs(o.token, '/api/finance/budget-import', [{ name: 'orcamentos.html', data: html, type: 'text/html' }], { year: String(YEAR) });
    expect(page.status).toBe(400);
    expect(page.body.error).toContain('.xlsx ou .csv');
  });

  it('robô e uploads manuais ignoram o tipo informado', () => {
    expect(guessMimeType('informe.pdf', 'text/html')).toBe('application/pdf');
    expect(guessMimeType('pagina.html', 'text/html')).toBe('application/octet-stream');
    expect(guessMimeType('img.svg', 'image/svg+xml')).toBe('application/octet-stream');
  });

  it('anexo da IA: só tipos legíveis e conteúdo conferido; anexo de outro cliente é recusado (SEG-5)', async () => {
    const o = await officeWithCustomer(VALID_CPFS[5]);
    const other = await o.api.post('/api/customers', { name: 'Outro Cliente', cpfCnpj: VALID_CPFS[6] });
    const bad = await uploadAs(o.token, `/api/customers/${o.customerId}/ai/attachments`, [{ name: 'x.html', data: Buffer.from('<b>oi</b>'), type: 'text/html' }]);
    expect(bad.status).toBe(400);
    const fake = await uploadAs(o.token, `/api/customers/${o.customerId}/ai/attachments`, [{ name: 'x.pdf', data: Buffer.from('<b>oi</b>'), type: 'application/pdf' }]);
    expect(fake.status).toBe(400);
    const ok = await uploadAs(o.token, `/api/customers/${other.body.id}/ai/attachments`, [{ name: 'extrato.csv', data: Buffer.from('a;b\n1;2'), type: 'text/html' }]);
    expect(ok.status).toBe(201);
    expect(ok.body[0].mimeType).toBe('text/csv');
    // o anexo foi enviado para o outro cliente: não vale na conversa deste
    const doc = await env.ctx.files.save({ officeId: o.officeId, data: PDF, filename: 'avulso.pdf', mimeType: 'application/pdf' });
    for (const fileId of [ok.body[0].fileId, doc.id]) {
      const r = await o.api.post(`/api/customers/${o.customerId}/ai/ir/messages`, { content: 'Resuma', year: YEAR, attachments: [fileId] });
      expect(r.status).toBe(404);
    }
    env.providers.aiReplies.push('ok');
    const mine = await o.api.post(`/api/customers/${other.body.id}/ai/ir/messages`, { content: 'Resuma', year: YEAR, attachments: [ok.body[0].fileId] });
    expect(mine.status).toBe(200);
  });
});

describe('colaboradores e funções (SEG-2)', () => {
  it('quem tem employee.edit não toma a conta do dono nem se promove', async () => {
    const o = await registerOffice(env);
    const roles = (await o.api.get('/api/roles')).body;
    const admin = roles.find((r: any) => r.isSystem);
    const emp = await createEmployee(env, o.api, ['employee.edit', 'employee.list', 'employee.create', 'role.create', 'role.edit', 'role.list']);
    const me = (await emp.api.get('/api/employees')).body.find((u: any) => u.id === emp.userId);

    const takeOwner = await emp.api.put(`/api/employees/${o.userId}`, { name: 'Ana Dona', email: 'atacante@evil.test', roleId: admin.id });
    expect(takeOwner.status).toBe(403);
    const promote = await emp.api.put(`/api/employees/${emp.userId}`, { name: me.name, email: me.email, roleId: admin.id });
    expect(promote.status).toBe(403);
    expect((await emp.api.put(`/api/employees/${emp.userId}`, { name: 'Novo Nome', email: me.email, roleId: emp.roleId })).status).toBe(200);
    expect((await emp.api.post('/api/employees', { name: 'Comparsa', email: 'comparsa@evil.test', roleId: admin.id })).status).toBe(403);
    expect((await emp.api.post('/api/roles', { name: 'Tudo', permissions: ['backup.download'] })).status).toBe(403);
    expect((await emp.api.put(`/api/roles/${emp.roleId}`, { name: 'Ampliada', permissions: ['employee.edit', 'integrations.manage'] })).status).toBe(403);
    // dentro das próprias permissões continua permitido
    expect((await emp.api.post('/api/roles', { name: 'Leitura', permissions: ['employee.list'] })).status).toBe(201);
    const owner = await env.ctx.db.query.users.findFirst({ where: eq(users.id, o.userId) });
    expect(owner!.email).toBe(o.email.toLowerCase());
  });

  it('trocar o e-mail de alguém derruba as sessões, invalida links de senha e avisa o e-mail antigo', async () => {
    const o = await registerOffice(env);
    const emp = await createEmployee(env, o.api, ['customer.list']);
    const before = (await o.api.get('/api/employees')).body.find((u: any) => u.id === emp.userId);
    await env.ctx.db.insert(passwordResets).values({ userId: emp.userId, tokenHash: 'pendente', expiresAt: new Date(Date.now() + 3600_000) });
    const res = await o.api.put(`/api/employees/${emp.userId}`, { name: before.name, email: 'novo-email@teste.com.br', roleId: emp.roleId });
    expect(res.status).toBe(200);
    expect((await emp.api.get('/api/auth/me')).status).toBe(401);
    const pending = await env.ctx.db.query.passwordResets.findMany({ where: eq(passwordResets.userId, emp.userId) });
    expect(pending.every((p) => p.usedAt !== null)).toBe(true);
    // o aviso sai pela fila (com repetição), não durante a requisição
    const isWarn = (m: { to: string; subject: string }) => m.to === before.email && m.subject.includes('e-mail de acesso');
    expect(env.providers.sentEmails.some(isWarn)).toBe(false);
    const queued = await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'auth.email_changed'), eq(jobs.officeId, o.officeId)) });
    expect(queued?.payload).toMatchObject({ userId: emp.userId, oldEmail: before.email, newEmail: 'novo-email@teste.com.br' });
    await env.ctx.jobs.drain();
    const warn = env.providers.sentEmails.find(isWarn);
    expect(warn?.html).toContain('novo-email@teste.com.br');
    expect(warn?.html).toContain('Ana Dona');
  });
});

describe('códigos de acesso no histórico (SEG-4)', () => {
  it('portal: o e-mail leva o código, o histórico guarda a versão mascarada; revogar invalida o código', async () => {
    const o = await officeWithCustomer(VALID_CPFS[7]);
    const res = await o.api.post(`/api/customers/${o.customerId}/portal-access`);
    const code = res.body.code as string;
    await env.ctx.jobs.drain();
    const mail = env.providers.sentEmails.find((m) => m.to === `${VALID_CPFS[7]}@cliente.com` && m.subject.includes('portal'));
    expect(mail?.html).toContain(code);
    const rows = await env.ctx.db.select().from(deliveries).where(eq(deliveries.customerId, o.customerId));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).not.toContain(code);
    expect(rows[0].body).toContain('••••••');
    const job = await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'delivery.send'), eq(jobs.idempotencyKey, rows[0].id)) });
    expect(job!.payload).not.toHaveProperty('sealed');
    const detail = await o.api.get(`/api/deliveries/${rows[0].id}`);
    expect(JSON.stringify(detail.body)).not.toContain(code);

    const login = (c: string) => env.app.inject({ method: 'POST', url: '/api/portal/login', payload: { cpf: VALID_CPFS[7], code: c } });
    expect((await o.api.del(`/api/customers/${o.customerId}/portal-access`)).status).toBe(200);
    expect((await login(code)).statusCode).toBe(401);
  });

  it('checklist: link e código não ficam em envios nem em mensagens', async () => {
    const o = await officeWithCustomer(VALID_CPFS[0]);
    const created = await o.api.post(`/api/customers/${o.customerId}/checklist`, { year: YEAR });
    const sent = await o.api.post(`/api/checklists/${created.body.id}/access`, { channels: ['email', 'whatsapp'] });
    expect(sent.status).toBe(200);
    const token = (sent.body.link as string).split('/checklist/')[1];
    await env.ctx.jobs.drain();
    const wa = env.providers.sentWhatsApp.find((m) => m.text.includes(token));
    expect(wa?.text).toContain(sent.body.code);
    const stored = JSON.stringify([
      await env.ctx.db.select().from(deliveries).where(eq(deliveries.customerId, o.customerId)),
      await env.ctx.db.select().from(messages).where(eq(messages.customerId, o.customerId)),
    ]);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(sent.body.code);
  });

  it('checklist: link e código valem 30 dias; vencidos, o link e o login são recusados', async () => {
    const o = await officeWithCustomer(VALID_CPFS[1]);
    const created = await o.api.post(`/api/customers/${o.customerId}/checklist`, { year: YEAR });
    const checklistId = created.body.id as string;
    // antes do primeiro envio o link não existe
    const fresh = await env.ctx.db.query.checklists.findFirst({ where: eq(checklists.id, checklistId) });
    expect(fresh!.accessExpiresAt).toBeNull();

    const sent = await o.api.post(`/api/checklists/${checklistId}/access`, { channels: [] });
    expect(sent.status).toBe(200);
    const token = (sent.body.link as string).split('/checklist/')[1];
    const days = (new Date(sent.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const office = await o.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`);
    expect(office.body.checklist.accessExpiresAt).toBe(new Date(sent.body.expiresAt).toISOString());

    const link = () => env.app.inject({ method: 'POST', url: '/api/portal/checklist-link', payload: { token } });
    const login = () => env.app.inject({ method: 'POST', url: '/api/portal/checklist-login', payload: { token, cpf: VALID_CPFS[1], code: sent.body.code } });
    expect((await link()).statusCode).toBe(200);
    const session = await login();
    expect(session.statusCode).toBe(200);
    const open = () =>
      env.app.inject({ method: 'GET', url: `/api/portal/checklists/${checklistId}`, headers: { authorization: `Bearer ${session.json().token}` } });
    expect((await open()).statusCode).toBe(200);

    await env.ctx.db.update(checklists).set({ accessExpiresAt: new Date(Date.now() - 1000) }).where(eq(checklists.id, checklistId));
    expect((await link()).statusCode).toBe(404);
    const expired = await login();
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error).toContain('Link');
    // a sessão aberta pelo link também termina com a validade
    const closed = await open();
    expect(closed.statusCode).toBe(401);
    expect(closed.json().error).toContain('venceu');
    // pelo portal (acesso próprio do cliente) o checklist continua disponível
    const portal = signCustomerToken(env.app, { id: o.customerId, officeId: o.officeId }, 'portal');
    const viaPortal = await env.app.inject({ method: 'GET', url: `/api/portal/checklists/${checklistId}`, headers: { authorization: `Bearer ${portal}` } });
    expect(viaPortal.statusCode).toBe(200);

    // um novo envio gera outro par, com nova validade
    const again = await o.api.post(`/api/checklists/${checklistId}/access`, { channels: [] });
    const token2 = (again.body.link as string).split('/checklist/')[1];
    const relogin = await env.app.inject({ method: 'POST', url: '/api/portal/checklist-login', payload: { token: token2, cpf: VALID_CPFS[1], code: again.body.code } });
    expect(relogin.statusCode).toBe(200);
  });
});

describe('notificações e painel do robô respeitam o escopo (INT-12, SEG-9)', () => {
  it('colaborador restrito não vê notificação de cliente alheio; leitura é por usuário', async () => {
    const o = await officeWithCustomer(VALID_CPFS[1]);
    const a = await createEmployee(env, o.api, ['customer.list']);
    const b = await createEmployee(env, o.api, ['customer.list']);
    await env.ctx.db.update(customers).set({ responsibleUserId: a.userId }).where(eq(customers.id, o.customerId));
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    await notify(env.ctx.db, { officeId: o.officeId, customerId: o.customerId, title: 'Pagamento recebido', body: 'Cliente Seguro: R$ 1.000,00' });
    await notify(env.ctx.db, { officeId: o.officeId, title: 'Aviso geral' });

    const titles = async (api: typeof a.api) => (await api.get('/api/notifications')).body.map((n: any) => n.title).sort();
    expect(await titles(a.api)).toEqual(['Aviso geral', 'Pagamento recebido']);
    expect(await titles(b.api)).toEqual(['Aviso geral']);
    expect(await titles(o.api)).toEqual(['Aviso geral', 'Pagamento recebido']);

    await a.api.post('/api/notifications/read-all');
    expect((await a.api.get('/api/notifications')).body.every((n: any) => n.readAt)).toBe(true);
    expect((await o.api.get('/api/notifications')).body.every((n: any) => !n.readAt)).toBe(true);
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: false });
  });

  it('atividade do robô some para quem não vê o cliente', async () => {
    const o = await officeWithCustomer(VALID_CPFS[2]);
    await env.ctx.db.insert(ecacRecords).values({ officeId: o.officeId, customerId: o.customerId, kind: 'tax_situation', source: 'extension' });
    const robot = await createEmployee(env, o.api, ['ecac.robot']);
    expect((await robot.api.get('/api/robot/overview')).body.activity).toHaveLength(1);
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    expect((await robot.api.get('/api/robot/overview')).body.activity).toHaveLength(0);
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: false });
  });
});

describe('permissões do catálogo conferidas no servidor (CON-17)', () => {
  it('procuradores, grupos e preferências completos só para quem tem a permissão', async () => {
    const o = await registerOffice(env);
    await o.api.post('/api/procurators', { name: 'Proc', cpfCnpj: VALID_CPFS[3] });
    await o.api.post('/api/customer-groups', { name: 'VIP' });
    await o.api.put('/api/office/settings', { whatsappServiceNumber: '11 99999-0000' });
    const basic = await createEmployee(env, o.api, ['customer.list']);
    expect(Object.keys((await basic.api.get('/api/procurators')).body[0]).sort()).toEqual(['id', 'name']);
    expect(Object.keys((await basic.api.get('/api/customer-groups')).body[0]).sort()).toEqual(['id', 'name']);
    expect((await basic.api.get('/api/office')).body).not.toHaveProperty('settings');
    expect((await basic.api.get('/api/auth/me')).body.office.settings).toEqual({});
    const viewer = await createEmployee(env, o.api, ['settings.view', 'procuration.list', 'customer_group.list']);
    expect((await viewer.api.get('/api/office')).body.settings.whatsappServiceNumber).toBe('11 99999-0000');
    expect((await viewer.api.get('/api/procurators')).body[0]).toHaveProperty('cpfCnpj');
    expect((await viewer.api.get('/api/customer-groups')).body[0]).toHaveProperty('customers');
  });
});

describe('conta do usuário (COB-15, COB-11)', () => {
  it('o próprio procurador configura forma de acesso e certificado; outros não', async () => {
    const o = await registerOffice(env);
    const emp = await createEmployee(env, o.api, ['customer.list']);
    const mine = await o.api.post('/api/procurators', { name: 'Colaborador Procurador', cpfCnpj: VALID_CPFS[4], userId: emp.userId });
    const other = await o.api.post('/api/procurators', { name: 'Outro', cpfCnpj: VALID_CPFS[5] });
    const own = await emp.api.get('/api/account/procurator');
    expect(own.body.map((p: any) => p.id)).toEqual([mine.body.id]);

    expect((await emp.api.patch(`/api/procurators/${mine.body.id}/auth-type`, { authType: 'certificate_cloud' })).status).toBe(200);
    expect((await emp.api.patch(`/api/procurators/${other.body.id}/auth-type`, { authType: 'govbr' })).status).toBe(403);
    const up = await uploadAs(await loginToken(emp), `/api/procurators/${mine.body.id}/certificate`, [{ name: 'meu.p12', data: PFX }], { password: 'senha' });
    expect(up.status).toBe(200);
    expect((await emp.api.get('/api/account/procurator')).body[0].hasCertificate).toBe(true);
    const otherUp = await uploadAs(await loginToken(emp), `/api/procurators/${other.body.id}/certificate`, [{ name: 'x.pfx', data: PFX }], { password: 'senha' });
    expect(otherUp.status).toBe(403);
    expect((await emp.api.del(`/api/procurators/${mine.body.id}/certificate`)).status).toBe(200);
    // arquivo que não é PKCS#12 é recusado
    const fake = await uploadAs(await loginToken(emp), `/api/procurators/${mine.body.id}/certificate`, [{ name: 'falso.pfx', data: Buffer.from('<html>') }], { password: 'senha' });
    expect(fake.status).toBe(400);
  });

  it('liga e revoga as notificações por navegador sem perder a preferência geral', async () => {
    const o = await registerOffice(env);
    const device = '8b7c5f8e-3f7e-4c1a-9a51-6f0b1c2d3e4f';
    const on = await o.api.post('/api/account/notification-devices', { deviceId: device });
    expect(on.body.user.notificationPrefs.devices).toEqual([device]);
    await o.api.put('/api/auth/preferences', { notificationsEnabled: false });
    const me = (await o.api.get('/api/auth/me')).body;
    expect(me.user.notificationPrefs).toEqual({ enabled: false, devices: [device] });
    const off = await o.api.del('/api/account/notification-devices');
    expect(off.body.user.notificationPrefs.devices).toEqual([]);
    expect((await o.api.post('/api/account/notification-devices', { deviceId: 'nao-e-uuid' })).status).toBe(400);
  });
});

/** Token de sessão de um colaborador criado por `createEmployee` (para uploads multipart). */
async function loginToken(emp: { userId: string }) {
  const u = await env.ctx.db.query.users.findFirst({ where: eq(users.id, emp.userId) });
  const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u!.email, password: 'senha-colab-123' } });
  return res.json().token as string;
}
