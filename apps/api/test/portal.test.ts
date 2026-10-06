import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { currentExerciseYear } from '@verifco/shared';
import { backlogs, customers, declarations, documents, messages } from '../src/db/schema';
import { sha256 } from '../src/lib/crypto';
import { getOrCreateDeclaration } from '../src/services/declarations';
import { VALID_CPFS, client, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { PDF, customerLogin, issueAccess, officeWithCustomer, setSubstatus } from './portal-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const YEAR = currentExerciseYear();

async function portalLogin(cpf: string, code: string, officeId?: string) {
  const res = await env.app.inject({ method: 'POST', url: '/api/portal/login', payload: { cpf, code, ...(officeId ? { officeId } : {}) } });
  return { status: res.statusCode, body: res.json() };
}

/** Escritório + cliente com acesso ao portal liberado; devolve o cliente HTTP do portal. */
async function withPortal(cpf: string, name?: string) {
  const o = await officeWithCustomer(env, cpf, name);
  const access = await o.api.post(`/api/customers/${o.customerId}/portal-access`);
  const login = await portalLogin(cpf, access.body.code);
  if (login.status !== 200) throw new Error(JSON.stringify(login.body));
  return { ...o, code: access.body.code as string, portalToken: login.body.token as string, portal: client(env, login.body.token) };
}

async function shareDoc(officeId: string, customerId: string, filename: string, opts: { category?: string; uploadedBy?: string } = {}) {
  const f = await env.ctx.files.save({ officeId, data: PDF, filename, mimeType: 'application/pdf' });
  const [d] = await env.ctx.db
    .insert(documents)
    .values({ officeId, customerId, fileId: f.id, category: opts.category ?? 'shared_with_customer', uploadedBy: opts.uploadedBy ?? 'office' })
    .returning();
  return d.id;
}

describe('login do portal', () => {
  it('entra com CPF e código e recusa erros', async () => {
    const o = await officeWithCustomer(env, VALID_CPFS[0], 'Carla Mendes');
    const access = await o.api.post(`/api/customers/${o.customerId}/portal-access`);
    const code = access.body.code as string;
    const wrong = code === '000000' ? '111111' : '000000';

    expect((await portalLogin('123.456.789-00', code)).status).toBe(400);
    const ok = await portalLogin('529.982.247-25', code);
    expect(ok.status).toBe(200);
    expect(ok.body.customer.firstName).toBe('Carla');
    expect(ok.body.office.name).toBe('Escritório Teste');
    const me = await client(env, ok.body.token).get('/api/portal/me');
    expect(me.body.customer.cpf).toBe('***.982.247-**');

    // o limite de falhas por CPF (no banco, entre instâncias) é testado em security-auth.test.ts
    expect((await portalLogin(VALID_CPFS[0], wrong)).status).toBe(401);

    // cliente sem acesso liberado não entra
    const o2 = await officeWithCustomer(env, VALID_CPFS[1]);
    expect((await portalLogin(VALID_CPFS[1], '123456')).status).toBe(401);

    // código vencido
    const acc2 = await o2.api.post(`/api/customers/${o2.customerId}/portal-access`);
    await env.ctx.db.update(customers).set({ portalCodeExpiresAt: new Date(Date.now() - 1000) }).where(eq(customers.id, o2.customerId));
    const expired = await portalLogin(VALID_CPFS[1], acc2.body.code);
    expect(expired.status).toBe(401);
    expect(expired.body.error).toMatch(/expirou/);

    // o código fica guardado só como hash
    const row = await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, o.customerId) });
    expect(row!.portalCodeHash).toBe(sha256(`${o.customerId}:${code}`));
  });

  it('CPF em mais de um escritório: escolhe o escritório pelo nome', async () => {
    const a = await officeWithCustomer(env, VALID_CPFS[2]);
    const b = await registerOffice(env, 'Contabilidade Beta');
    const cb = await b.api.post('/api/customers', { name: 'Maria Souza', cpfCnpj: VALID_CPFS[2], email: 'maria@beta.com' });
    // códigos diferentes: o código já indica o escritório
    const accA = await a.api.post(`/api/customers/${a.customerId}/portal-access`);
    const accB = await b.api.post(`/api/customers/${cb.body.id}/portal-access`);
    const loginB = await portalLogin(VALID_CPFS[2], accB.body.code);
    expect(loginB.body.office.name).toBe('Contabilidade Beta');
    if (accA.body.code === accB.body.code) return;

    // mesmo código nos dois: pergunta o escritório
    const same = '424242';
    await env.ctx.db.update(customers).set({ portalCodeHash: sha256(`${a.customerId}:${same}`) }).where(eq(customers.id, a.customerId));
    await env.ctx.db.update(customers).set({ portalCodeHash: sha256(`${cb.body.id}:${same}`) }).where(eq(customers.id, cb.body.id));
    const choose = await portalLogin(VALID_CPFS[2], same);
    expect(choose.status).toBe(200);
    expect(choose.body.needsOffice).toBe(true);
    expect(choose.body.offices.map((x: any) => x.name)).toEqual(['Contabilidade Beta', 'Escritório Teste']);
    expect(choose.body.token).toBeUndefined();
    const chosen = await portalLogin(VALID_CPFS[2], same, b.officeId);
    expect(chosen.status).toBe(200);
    expect(chosen.body.office.name).toBe('Contabilidade Beta');
  });
});

describe('início do portal', () => {
  it('mostra declarações, pendências, checklist e documentos só do próprio cliente', async () => {
    const a = await withPortal(VALID_CPFS[3], 'Ana Lima');
    const b = await withPortal(VALID_CPFS[4], 'Bruno Reis');

    const cur = await setSubstatus(env, a.officeId, a.customerId, YEAR, 'missing_documents');
    const prev = await setSubstatus(env, a.officeId, a.customerId, YEAR - 1, 'finished');
    await env.ctx.db.update(declarations).set({ refundCents: 123456 }).where(eq(declarations.id, prev!.id));
    await env.ctx.db.insert(backlogs).values({ officeId: a.officeId, customerId: a.customerId, declarationId: cur!.id, description: 'Informe do banco X', dueDate: `${YEAR}-05-10` });
    await env.ctx.db.insert(backlogs).values({ officeId: a.officeId, customerId: a.customerId, declarationId: cur!.id, description: 'Já resolvido', resolvedAt: new Date() });
    const declB = await getOrCreateDeclaration(env.ctx.db, b.officeId, b.customerId, YEAR);
    await env.ctx.db.insert(backlogs).values({ officeId: b.officeId, customerId: b.customerId, declarationId: declB.id, description: 'Pendência do Bruno' });

    const sharedA = await shareDoc(a.officeId, a.customerId, 'recibo-entrega.pdf');
    const internalA = await shareDoc(a.officeId, a.customerId, 'interno.pdf', { category: 'other' });
    const sharedB = await shareDoc(b.officeId, b.customerId, 'do-bruno.pdf');

    const created = await a.api.post(`/api/customers/${a.customerId}/checklist`, { year: YEAR });

    const ov = await a.portal.get('/api/portal/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.declarations.map((d: any) => d.exerciseYear)).toEqual([YEAR, YEAR - 1]);
    expect(ov.body.declarations[0].status.title).toBe('Faltam documentos');
    expect(ov.body.declarations[1].status.title).toBe('Concluída');
    expect(ov.body.declarations[1].refundCents).toBe(123456);
    expect(ov.body.declarations[0].refundCents).toBe(0);
    expect(ov.body.pendencies.map((p: any) => p.description)).toEqual(['Informe do banco X']);
    expect(ov.body.documents.map((d: any) => d.filename)).toEqual(['recibo-entrega.pdf']);
    expect(ov.body.checklist).toMatchObject({ id: created.body.id, exerciseYear: YEAR, sectionsDone: 0, sectionsTotal: 7, readOnly: false });

    const dl = await env.app.inject({ method: 'GET', url: `/api/portal/documents/${sharedA}`, headers: { authorization: `Bearer ${a.portalToken}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect((await a.portal.get(`/api/portal/documents/${internalA}`)).status).toBe(404);
    expect((await a.portal.get(`/api/portal/documents/${sharedB}`)).status).toBe(404);

    const ovB = await b.portal.get('/api/portal/overview');
    expect(ovB.body.pendencies.map((p: any) => p.description)).toEqual(['Pendência do Bruno']);
    expect(ovB.body.checklist).toBeNull();
    expect(ovB.body.declarations[1].status.title).toBe('Ainda não iniciada');

    // checklist pelo portal: o próprio sim, o de outro cliente não
    expect((await a.portal.get(`/api/portal/checklists/${created.body.id}`)).status).toBe(200);
    expect((await b.portal.get(`/api/portal/checklists/${created.body.id}`)).status).toBe(404);

    // token do portal não serve nas rotas do escritório
    expect((await a.portal.get(`/api/customers/${a.customerId}`)).status).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/api/portal/overview' })).statusCode).toBe(401);
    // token de usuário do escritório não serve no portal
    expect((await a.api.get('/api/portal/overview')).status).toBe(401);
  });
});

describe('documentos compartilhados com o cliente (INT-3)', () => {
  /** Upload pela etapa Documentos do IRPF, com a categoria no formulário. */
  async function officeUpload(token: string, customerId: string, filename: string, category: string) {
    const boundary = `----vf${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\n${category}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`),
      PDF,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/customers/${customerId}/documents?year=${YEAR}`,
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() };
  }

  it('o escritório marca e desmarca "Visível no portal" e o portal lista e libera o download', async () => {
    const a = await withPortal(VALID_CPFS[0], 'Helena Prado');
    const shared = await officeUpload(a.token, a.customerId, 'recibo-entrega.pdf', 'shared_with_customer');
    expect(shared.status).toBe(201);
    const internal = await officeUpload(a.token, a.customerId, 'planilha-interna.pdf', 'other');
    expect(internal.status).toBe(201);
    const sharedId = shared.body[0].id as string;
    const internalId = internal.body[0].id as string;

    let ov = await a.portal.get('/api/portal/overview');
    expect(ov.body.documents.map((d: any) => d.filename)).toEqual(['recibo-entrega.pdf']);
    expect(ov.body.documents[0].exerciseYear).toBe(YEAR);
    const dl = await env.app.inject({ method: 'GET', url: `/api/portal/documents/${sharedId}`, headers: { authorization: `Bearer ${a.portalToken}` } });
    expect(dl.statusCode).toBe(200);
    expect((await a.portal.get(`/api/portal/documents/${internalId}`)).status).toBe(404);

    // marcar depois do upload (a ação da etapa Documentos) e desmarcar
    expect((await a.api.patch(`/api/documents/${internalId}`, { category: 'shared_with_customer' })).status).toBe(200);
    ov = await a.portal.get('/api/portal/overview');
    expect(ov.body.documents.map((d: any) => d.filename).sort()).toEqual(['planilha-interna.pdf', 'recibo-entrega.pdf']);
    expect((await a.api.patch(`/api/documents/${sharedId}`, { category: 'other' })).status).toBe(200);
    ov = await a.portal.get('/api/portal/overview');
    expect(ov.body.documents.map((d: any) => d.filename)).toEqual(['planilha-interna.pdf']);
    expect((await a.portal.get(`/api/portal/documents/${sharedId}`)).status).toBe(404);
    const audits = await env.ctx.db.query.auditLogs.findMany({ where: (t, { eq: e }) => e(t.entityId, sharedId) });
    expect(audits.map((x) => x.action)).toContain('unshare_with_customer');

    // arquivo enviado pelo próprio cliente não é "do escritório"
    const fromCustomer = await shareDoc(a.officeId, a.customerId, 'meu-rg.pdf', { category: 'checklist', uploadedBy: 'customer' });
    const refused = await a.api.patch(`/api/documents/${fromCustomer}`, { category: 'shared_with_customer' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/próprio cliente/);
    // mesmo gravado direto no banco, não aparece
    const forced = await shareDoc(a.officeId, a.customerId, 'forcado.pdf', { uploadedBy: 'customer' });
    expect((await a.portal.get(`/api/portal/documents/${forced}`)).status).toBe(404);
    // o que vem da sincronização (recibo, declaração) pode ser compartilhado
    const synced = await shareDoc(a.officeId, a.customerId, 'recibo.rec.pdf', { category: 'irpf_receipt', uploadedBy: 'sync' });
    expect((await a.api.patch(`/api/documents/${synced}`, { category: 'shared_with_customer' })).status).toBe(200);
    expect((await a.portal.get('/api/portal/overview')).body.documents.map((d: any) => d.filename)).toContain('recibo.rec.pdf');

    // outro escritório e outro cliente
    const b = await withPortal(VALID_CPFS[1], 'Igor Lima');
    expect((await b.api.patch(`/api/documents/${internalId}`, { category: 'other' })).status).toBe(404);
    expect((await b.portal.get(`/api/portal/documents/${internalId}`)).status).toBe(404);
    expect((await b.portal.get('/api/portal/overview')).body.documents).toEqual([]);
  });
});

describe('mensagens', () => {
  it('escritório e cliente conversam; lidas, notificação e WhatsApp', async () => {
    const a = await withPortal(VALID_CPFS[5], 'Eva Prado');

    expect((await a.api.post(`/api/customers/${a.customerId}/messages`, { body: '   ' })).status).toBe(400);
    expect((await a.api.post(`/api/customers/${a.customerId}/messages`, { body: 'x'.repeat(4001) })).status).toBe(400);
    const sent = await a.api.post(`/api/customers/${a.customerId}/messages`, { body: 'Olá, Eva! Recebemos seus documentos.' });
    expect(sent.status).toBe(201);
    expect(sent.body.messages.at(-1)).toMatchObject({ direction: 'out', channel: 'portal', authorName: 'Ana Dona' });

    const inbox = await a.portal.get('/api/portal/messages');
    expect(inbox.body.unread).toBe(1);
    expect(inbox.body.messages[0]).toMatchObject({ fromMe: false, body: 'Olá, Eva! Recebemos seus documentos.' });
    expect((await a.portal.get('/api/portal/overview')).body.unreadMessages).toBe(1);
    await a.portal.post('/api/portal/messages/read');
    expect((await a.portal.get('/api/portal/messages')).body.unread).toBe(0);
    expect((await a.api.get(`/api/customers/${a.customerId}/messages`)).body.messages[0].readAt).not.toBeNull();

    // resposta do cliente notifica o escritório uma vez (enquanto não lida)
    const reply = await a.portal.post('/api/portal/messages', { body: 'Obrigada! Falta o informe do banco.' });
    expect(reply.status).toBe(201);
    expect(reply.body.messages.at(-1).fromMe).toBe(true);
    await a.portal.post('/api/portal/messages', { body: 'Mando amanhã.' });
    const notes = (await a.api.get('/api/notifications')).body.filter((n: any) => n.link === `/clientes/${a.customerId}/mensagens`);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Nova mensagem de Eva Prado');

    const conv = await a.api.get(`/api/customers/${a.customerId}/messages`);
    expect(conv.body.unread).toBe(2);
    expect(conv.body.portalEnabled).toBe(true);
    await a.api.post(`/api/customers/${a.customerId}/messages/read`);
    expect((await a.api.get(`/api/customers/${a.customerId}/messages`)).body.unread).toBe(0);

    // também por WhatsApp: entra na conversa uma vez, com o canal
    const wa = await a.api.post(`/api/customers/${a.customerId}/messages`, { body: 'Lembrete: prazo dia 30 & <não esqueça>' });
    expect(wa.status).toBe(201);
    const viaWa = await a.api.post(`/api/customers/${a.customerId}/messages`, { body: 'Pode me ligar? 1 < 2 & "ok"', whatsapp: true });
    expect(viaWa.status).toBe(201);
    await env.ctx.jobs.drain();
    const sentWa = env.providers.sentWhatsApp.find((m) => m.officeId === a.officeId);
    expect(sentWa?.text).toBe('Pode me ligar? 1 < 2 & "ok"');
    const rows = await env.ctx.db.select().from(messages).where(eq(messages.customerId, a.customerId));
    expect(rows.filter((r) => r.channel === 'whatsapp')).toHaveLength(1);
    expect(rows.find((r) => r.channel === 'whatsapp')!.body).toBe('Pode me ligar? 1 < 2 & "ok"');
    const latest = (await a.api.get(`/api/customers/${a.customerId}/messages`)).body.messages.at(-1);
    expect(latest).toMatchObject({ channel: 'whatsapp', deliveryStatus: 'sent' });
    // quebras de linha digitadas chegam iguais no WhatsApp (o texto passa pelo conversor HTML → texto)
    await a.api.post(`/api/customers/${a.customerId}/messages`, { body: 'Linha 1\nLinha 2\n\nD\'Ávila', whatsapp: true });
    await env.ctx.jobs.drain();
    expect(env.providers.sentWhatsApp.filter((m) => m.officeId === a.officeId).at(-1)?.text).toBe("Linha 1\nLinha 2\n\nD'Ávila");

    // sem celular não envia por WhatsApp
    const noPhone = await a.api.post('/api/customers', { name: 'Sem Celular', cpfCnpj: VALID_CPFS[6] });
    expect((await a.api.post(`/api/customers/${noPhone.body.id}/messages`, { body: 'Oi', whatsapp: true })).status).toBe(400);
  });

  it('permissões e isolamento', async () => {
    const a = await withPortal(VALID_CPFS[7], 'Fábio Nunes');
    const b = await withPortal(VALID_CPFS[6], 'Gabi Rocha'); // CPF fora dos testes de bloqueio
    await a.api.post(`/api/customers/${a.customerId}/messages`, { body: 'Mensagem para o Fábio' });

    const reader = await createEmployee(env, a.api, ['customer.list']);
    expect((await reader.api.get(`/api/customers/${a.customerId}/messages`)).status).toBe(200);
    expect((await reader.api.post(`/api/customers/${a.customerId}/messages`, { body: 'Oi' })).status).toBe(403);
    const sender = await createEmployee(env, a.api, ['customer.list', 'message.send']);
    expect((await sender.api.post(`/api/customers/${a.customerId}/messages`, { body: 'Oi' })).status).toBe(201);

    // outro escritório
    expect((await b.api.get(`/api/customers/${a.customerId}/messages`)).status).toBe(404);
    expect((await b.api.post(`/api/customers/${a.customerId}/messages`, { body: 'Invasão' })).status).toBe(404);
    expect((await b.api.post(`/api/customers/${a.customerId}/messages/read`)).status).toBe(404);

    // outro cliente não vê a conversa
    const inboxB = await b.portal.get('/api/portal/messages');
    expect(inboxB.body.messages).toHaveLength(0);
    await b.portal.post('/api/portal/messages', { body: 'Sou a Gabi' });
    const convA = (await a.api.get(`/api/customers/${a.customerId}/messages`)).body.messages;
    expect(convA.some((m: any) => m.body === 'Sou a Gabi')).toBe(false);

    // o token do link do checklist não abre as mensagens
    const created = await a.api.post(`/api/customers/${a.customerId}/checklist`, { year: YEAR });
    const acc = await issueAccess(a.api, created.body.id);
    const cust = await customerLogin(env, acc.token, VALID_CPFS[7], acc.code);
    expect((await cust.api!.get('/api/portal/messages')).status).toBe(403);
    expect((await cust.api!.post('/api/portal/messages', { body: 'Oi' })).status).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/portal/messages' })).statusCode).toBe(401);
  });
});
