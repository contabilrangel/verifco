/**
 * Segurança da conta: verificação em duas etapas (escritório e sistema), confirmação e troca de
 * e-mail, registro de auditoria, histórico do cliente e exclusão definitiva de um escritório.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { auditLogs, customers, files, jobs, offices, users } from '../src/db/schema';
import { platformUsers } from '../src/db/platform-schema';
import { base32Decode, base32Encode, hotp, otpauthUrl, totpAt, verifyTotp } from '../src/lib/totp';
import { VERIFY_EMAIL_JOB } from '../src/modules/auth/jobs';
import type { MemoryBlobStore } from '../src/storage';
import { VALID_CPFS, client, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';
import { fakePdf, multipart, send } from './robot-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const PASSWORD = 'senha-forte-123';

/** Colaborador com e-mail e senha conhecidos (sem a permissão de editar configurações). */
async function employee(owner: Api, permissions: string[] = ['customer.list']) {
  const role = await owner.post('/api/roles', { name: `Função ${Math.random().toString(36).slice(2, 8)}`, permissions });
  const email = `colab-${Math.random().toString(36).slice(2, 10)}@teste.com.br`;
  const password = 'senha-colab-123';
  const emp = await owner.post('/api/employees', { name: 'Colaborador', email, roleId: role.body.id });
  const token = new URL(emp.body.inviteLink).searchParams.get('token');
  await env.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password } });
  const session = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return { api: client(env, session.json().token), id: emp.body.id as string, email, password };
}
const login = (email: string, extra: Record<string, unknown> = {}, password = PASSWORD) => env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, ...extra } });

describe('TOTP (RFC 6238)', () => {
  it('reproduz os vetores de teste da RFC e aceita um passo de diferença no relógio', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    // RFC 6238, apêndice B (SHA-1), últimos 6 dígitos
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(totpAt(secret, 1111111109_000)).toBe('081804');
    expect(totpAt(secret, 1234567890_000)).toBe('005924');
    expect(totpAt(secret, 20000000000_000)).toBe('353130');
    // RFC 4226, apêndice D
    expect([0, 1, 9].map((c) => hotp(Buffer.from('12345678901234567890'), c))).toEqual(['755224', '287082', '520489']);
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, ` ${totpAt(secret, now).slice(0, 3)} ${totpAt(secret, now).slice(3)}`, now)).toBe(true);
    expect(verifyTotp(secret, '12345', now)).toBe(false);
    expect(otpauthUrl({ secret, account: 'ana@teste.com', issuer: 'Verifco' })).toBe(`otpauth://totp/Verifco%3Aana%40teste.com?secret=${secret}&issuer=Verifco&algorithm=SHA1&digits=6&period=30`);
  });
});

describe('verificação em duas etapas no escritório', () => {
  it('ativa com a senha e o código, exige o código no login, gasta o código de recuperação e desativa', async () => {
    const office = await registerOffice(env);
    expect((await office.api.get('/api/auth/me')).body.user.twoFactorEnabled).toBe(false);
    expect((await office.api.post('/api/auth/2fa/setup', { password: 'errada' })).status).toBe(400);
    const setup = await office.api.post('/api/auth/2fa/setup', { password: PASSWORD });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);
    // ainda não vale: o login continua só com a senha
    expect((await login(office.email)).statusCode).toBe(200);
    expect((await office.api.post('/api/auth/2fa/enable', { code: '000000' })).status).toBe(400);
    const enabled = await office.api.post('/api/auth/2fa/enable', { code: totpAt(setup.body.secret) });
    expect(enabled.status).toBe(200);
    expect(enabled.body.recoveryCodes).toHaveLength(8);
    expect(enabled.body.recoveryCodes[0]).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    const row = await env.ctx.db.query.users.findFirst({ where: eq(users.id, office.userId) });
    expect(row!.totpSecretEnc).not.toContain(setup.body.secret);
    expect(row!.totpRecoveryHashes).toHaveLength(8);
    expect(JSON.stringify(row!.totpRecoveryHashes)).not.toContain(enabled.body.recoveryCodes[0]);
    expect((await office.api.get('/api/auth/me')).body.user.twoFactorEnabled).toBe(true);

    // login: sem código pede o código; errado recusa; certo entra
    const asks = await login(office.email);
    expect(asks.statusCode).toBe(401);
    expect(asks.json()).toMatchObject({ details: { code: 'two_factor_required' } });
    expect(asks.json().token).toBeUndefined();
    const wrong = await login(office.email, { code: '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toMatch(/Código inválido/);
    expect((await login(office.email, { code: totpAt(setup.body.secret) })).statusCode).toBe(200);
    // senha errada com código certo continua recusada, sem dizer qual dos dois falhou
    expect((await login(office.email, { code: totpAt(setup.body.secret) }, 'errada')).json().error).toBe('E-mail ou senha incorretos.');

    // código de recuperação vale uma vez
    const recovery = enabled.body.recoveryCodes[0] as string;
    expect((await login(office.email, { code: recovery.toUpperCase() })).statusCode).toBe(200);
    expect((await login(office.email, { code: recovery })).statusCode).toBe(401);
    expect((await env.ctx.db.query.users.findFirst({ where: eq(users.id, office.userId) }))!.totpRecoveryHashes).toHaveLength(7);
    const trail = await env.ctx.db.select().from(auditLogs).where(eq(auditLogs.officeId, office.officeId));
    expect(trail.filter((t) => t.entity === 'session' && t.action === 'login').some((t) => (t.data as any).recoveryCode === true)).toBe(true);
    expect(trail.some((t) => t.entity === 'two_factor' && t.action === 'enable')).toBe(true);

    // desativar pede senha e código
    expect((await office.api.post('/api/auth/2fa/setup', { password: PASSWORD })).status).toBe(400);
    expect((await office.api.post('/api/auth/2fa/disable', { password: PASSWORD, code: '000000' })).status).toBe(400);
    expect((await office.api.post('/api/auth/2fa/disable', { password: PASSWORD, code: totpAt(setup.body.secret) })).status).toBe(200);
    expect((await login(office.email)).statusCode).toBe(200);
    expect(await env.ctx.db.query.users.findFirst({ where: eq(users.id, office.userId) })).toMatchObject({ totpSecretEnc: null, totpEnabledAt: null, totpRecoveryHashes: [] });
  });

  it('o dono desliga a segunda etapa de um colaborador que perdeu o celular; o suporte faz o mesmo pelo dono', async () => {
    const office = await registerOffice(env);
    const emp = await employee(office.api);
    const setup = await emp.api.post('/api/auth/2fa/setup', { password: emp.password });
    await emp.api.post('/api/auth/2fa/enable', { code: totpAt(setup.body.secret) });
    expect((await login(emp.email, {}, emp.password)).statusCode).toBe(401);
    expect((await emp.api.post(`/api/employees/${office.userId}/reset-2fa`)).status).toBe(403);
    expect((await office.api.post(`/api/employees/${office.userId}/reset-2fa`)).status).toBe(400);
    expect((await office.api.post(`/api/employees/${emp.id}/reset-2fa`)).status).toBe(200);
    expect((await emp.api.get('/api/auth/me')).status).toBe(401); // as sessões dele caíram
    expect((await login(emp.email, {}, emp.password)).statusCode).toBe(200);

    // dono sem celular e sem códigos: o suporte desliga pelo painel do sistema
    const ownerSetup = await office.api.post('/api/auth/2fa/setup', { password: PASSWORD });
    await office.api.post('/api/auth/2fa/enable', { code: totpAt(ownerSetup.body.secret) });
    const [platformOwner] = await env.ctx.platformDb.insert(platformUsers).values({ name: 'Suporte', email: `suporte-${Date.now()}@sistema.com`, passwordHash: 'x', role: 'owner' }).returning();
    const support = client(env, env.app.jwt.sign({ typ: 'platform', sub: platformOwner.id, tv: 0 }));
    expect((await support.post(`/api/platform/offices/${office.officeId}/reset-2fa`, { email: 'outra@pessoa.com' })).status).toBe(404);
    expect((await support.post(`/api/platform/offices/${office.officeId}/reset-2fa`, { email: office.email.toUpperCase() })).status).toBe(200);
    expect((await login(office.email)).statusCode).toBe(200);
  });
});

describe('verificação em duas etapas no painel do sistema', () => {
  it('ativa, exige no login e desativa', async () => {
    const email = `dona-${Date.now()}@sistema.com`;
    const password = 'senha-sistema-123';
    const [row] = await env.ctx.platformDb.insert(platformUsers).values({ name: 'Dona', email, passwordHash: await bcrypt.hash(password, 4), role: 'owner' }).returning();
    const platformLogin = (extra: Record<string, unknown> = {}) => env.app.inject({ method: 'POST', url: '/api/platform/login', payload: { email, password, ...extra } });
    const me = client(env, (await platformLogin()).json().token);
    expect((await me.get('/api/platform/me')).body.twoFactorEnabled).toBe(false);
    const setup = await me.post('/api/platform/2fa/setup', { password });
    expect(setup.status).toBe(200);
    const enabled = await me.post('/api/platform/2fa/enable', { code: totpAt(setup.body.secret) });
    expect(enabled.body.recoveryCodes).toHaveLength(8);
    expect((await me.get('/api/platform/me')).body.twoFactorEnabled).toBe(true);
    const asks = await platformLogin();
    expect(asks.statusCode).toBe(401);
    expect(asks.json()).toMatchObject({ details: { code: 'two_factor_required' } });
    expect((await platformLogin({ code: '111111' })).statusCode).toBe(401);
    expect((await platformLogin({ code: totpAt(setup.body.secret) })).statusCode).toBe(200);
    expect((await platformLogin({ code: enabled.body.recoveryCodes[3] })).statusCode).toBe(200);
    expect((await platformLogin({ code: enabled.body.recoveryCodes[3] })).statusCode).toBe(401);
    const listed = (await me.get('/api/platform/users')).body.find((u: any) => u.id === row.id);
    expect(listed.twoFactor).toBe(true);
    expect((await me.post('/api/platform/2fa/disable', { password, code: '000000' })).status).toBe(400);
    expect((await me.post('/api/platform/2fa/disable', { password, code: totpAt(setup.body.secret) })).status).toBe(200);
    expect((await platformLogin()).statusCode).toBe(200);
  });
});

describe('e-mail de acesso', () => {
  /** Roda o job de confirmação e devolve o token que foi no link. */
  async function confirmationToken(userId: string) {
    await env.ctx.jobs.drain();
    const mail = [...env.providers.sentEmails].reverse().find((m) => /confirmar-email\?token=/.test(m.html));
    const token = /confirmar-email\?token=([\w-]+)/.exec(mail!.html)![1];
    // enviado: o token não fica no job
    const job = (await env.ctx.db.select().from(jobs).where(eq(jobs.type, VERIFY_EMAIL_JOB))).filter((j) => j.payload.userId === userId).at(-1)!;
    expect(job.payload.token).toBeUndefined();
    return { token, mail: mail! };
  }

  it('troca do próprio e-mail só vale depois do link enviado ao endereço novo; o antigo é avisado', async () => {
    const office = await registerOffice(env);
    const novo = `novo-${Date.now()}@teste.com.br`;
    expect((await office.api.post('/api/auth/change-email', { newEmail: novo, password: 'errada' })).status).toBe(400);
    expect((await office.api.post('/api/auth/change-email', { newEmail: office.email, password: PASSWORD })).status).toBe(400);
    const other = await registerOffice(env);
    expect((await office.api.post('/api/auth/change-email', { newEmail: other.email, password: PASSWORD })).status).toBe(409);
    const asked = await office.api.post('/api/auth/change-email', { newEmail: novo.toUpperCase(), password: PASSWORD });
    expect(asked.body).toEqual({ ok: true, pendingEmail: novo });
    expect((await office.api.get('/api/auth/me')).body.user).toMatchObject({ email: office.email, pendingEmail: novo });
    // nada mudou ainda: o login segue pelo antigo
    expect((await login(office.email)).statusCode).toBe(200);
    expect((await login(novo)).statusCode).toBe(401);

    const { token, mail } = await confirmationToken(office.userId);
    expect(mail).toMatchObject({ to: novo, system: true });
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/confirm-email', payload: { token: 'token-que-nao-existe' } })).statusCode).toBe(400);
    const confirmed = await env.app.inject({ method: 'POST', url: '/api/auth/confirm-email', payload: { token } });
    expect(confirmed.json()).toEqual({ ok: true, changed: true, email: novo });
    expect((await office.api.get('/api/auth/me')).status).toBe(401); // sessões abertas caem
    expect((await login(office.email)).statusCode).toBe(401);
    expect((await login(novo)).statusCode).toBe(200);
    // o link vale uma vez
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/confirm-email', payload: { token } })).statusCode).toBe(400);
    await env.ctx.jobs.drain();
    expect(env.providers.sentEmails.at(-1)).toMatchObject({ to: office.email, subject: 'Seu e-mail de acesso ao Verifco foi alterado' });
    expect(await env.ctx.db.query.users.findFirst({ where: eq(users.id, office.userId) })).toMatchObject({ email: novo, pendingEmail: null, pendingEmailTokenHash: null, emailVerifiedAt: expect.any(Date) });
  });

  it('cadastro com e-mail do sistema pede a confirmação; sem ele, o endereço vale como informado', async () => {
    const plain = await registerOffice(env);
    expect((await plain.api.get('/api/auth/me')).body.user.emailVerified).toBe(true);
    env.ctx.config.SMTP_URL = 'smtp://smtp.sistema.com:587';
    try {
      const office = await registerOffice(env);
      expect((await office.api.get('/api/auth/me')).body.user).toMatchObject({ emailVerified: false, pendingEmail: null });
      const { token, mail } = await confirmationToken(office.userId);
      expect(mail).toMatchObject({ to: office.email, subject: 'Confirme seu e-mail — Verifco' });
      // pedir de novo logo em seguida é recusado (um envio a cada 5 minutos)
      env.ctx.config.RATE_LIMIT = true;
      try {
        expect((await office.api.post('/api/auth/verify-email/resend')).status).toBe(200);
        expect((await office.api.post('/api/auth/verify-email/resend')).status).toBe(429);
      } finally {
        env.ctx.config.RATE_LIMIT = false;
      }
      // o link anterior deixou de valer; o novo confirma sem derrubar a sessão
      expect((await env.app.inject({ method: 'POST', url: '/api/auth/confirm-email', payload: { token } })).statusCode).toBe(400);
      const fresh = await confirmationToken(office.userId);
      expect((await env.app.inject({ method: 'POST', url: '/api/auth/confirm-email', payload: { token: fresh.token } })).json()).toMatchObject({ ok: true, changed: false });
      expect((await office.api.get('/api/auth/me')).body.user.emailVerified).toBe(true);
      expect((await office.api.post('/api/auth/verify-email/resend')).body).toMatchObject({ alreadyVerified: true });
    } finally {
      env.ctx.config.SMTP_URL = undefined;
    }
  });
});

describe('auditoria e histórico', () => {
  it('lista quem fez o quê com filtros; o histórico do cliente junta cadastro, documentos e declarações dele', async () => {
    const office = await registerOffice(env);
    const other = await registerOffice(env);
    const emp = await employee(office.api);
    const c = await office.api.post('/api/customers', { name: 'Maria', cpfCnpj: VALID_CPFS[0] });
    expect((await office.api.post(`/api/customers/${c.body.id}/portal-access`)).status).toBe(400); // sem e-mail: nada registrado
    await office.api.del(`/api/customers/${c.body.id}`);
    await office.api.post(`/api/customers/${c.body.id}/restore`);
    const token = (await office.api.post('/api/robot/tokens', { name: 'Robô', scope: 'sync' })).body.token as string;
    const doc = await send(env, token, 'POST', '/api/sync/documents', { multipart: multipart({ cpf: VALID_CPFS[0], ano: '2026' }, { name: 'doc.pdf', content: fakePdf('a'), type: 'application/pdf' }) });
    expect(doc.status).toBe(201);
    await login(office.email);

    const all = await office.api.get('/api/audit');
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThanOrEqual(4);
    expect(all.body.entities).toEqual(expect.arrayContaining(['customer', 'session']));
    expect(all.body.data[0]).toMatchObject({ action: 'login', entity: 'session', userName: 'Ana Dona' });
    const onlyCustomers = await office.api.get('/api/audit?entity=customer&pageSize=1');
    expect(onlyCustomers.body.data).toHaveLength(1);
    expect(onlyCustomers.body.total).toBe(3);
    // do colaborador só há a própria entrada no sistema
    expect((await office.api.get(`/api/audit?userId=${emp.id}`)).body.data.map((r: any) => `${r.entity}:${r.action}`)).toEqual(['session:login']);
    expect((await office.api.get('/api/audit?from=2999-01-01')).body.total).toBe(0);
    expect((await office.api.get('/api/audit?from=01/01/2026')).status).toBe(400);
    // outro escritório não vê; quem não edita as configurações também não
    expect((await other.api.get('/api/audit?entity=customer')).body.total).toBe(0);
    expect((await emp.api.get('/api/audit')).status).toBe(403);

    const events = await office.api.get(`/api/customers/${c.body.id}/events`);
    expect(events.status).toBe(200);
    const kinds = events.body.map((e: any) => `${e.entity}:${e.action}`);
    expect(kinds).toEqual(expect.arrayContaining(['customer:create', 'customer:delete', 'customer:restore', 'document:sync_document']));
    expect(events.body.every((e: any) => e.entity !== 'session')).toBe(true);
    expect((await other.api.get(`/api/customers/${c.body.id}/events`)).status).toBe(404);
  });
});

describe('exclusão definitiva de um escritório pelo painel do sistema', () => {
  it('exige a suspensão e o nome digitado; apaga dados e arquivos sem tocar nos outros escritórios', async () => {
    const office = await registerOffice(env, 'Escritório Encerrado');
    const neighbor = await registerOffice(env, 'Vizinho');
    await office.api.post('/api/customers', { name: 'Cliente', cpfCnpj: VALID_CPFS[1] });
    const kept = await neighbor.api.post('/api/customers', { name: 'Cliente do vizinho', cpfCnpj: VALID_CPFS[1] });
    const saved = await env.ctx.files.save({ officeId: office.officeId, data: Buffer.from('conteudo'), filename: 'a.pdf', mimeType: 'application/pdf' });
    const neighborFile = await env.ctx.files.save({ officeId: neighbor.officeId, data: Buffer.from('vizinho'), filename: 'b.pdf', mimeType: 'application/pdf' });
    const [owner, dev] = await env.ctx.platformDb
      .insert(platformUsers)
      .values([
        { name: 'Dona', email: `dona-del-${Date.now()}@sistema.com`, passwordHash: 'x', role: 'owner' },
        { name: 'Dev', email: `dev-del-${Date.now()}@sistema.com`, passwordHash: 'x', role: 'developer' },
      ])
      .returning();
    const call = (id: string, body: unknown, who = owner) => env.app.inject({ method: 'DELETE', url: `/api/platform/offices/${id}`, payload: body as never, headers: { authorization: `Bearer ${env.app.jwt.sign({ typ: 'platform', sub: who.id, tv: 0 })}` } });
    expect((await call(office.officeId, { confirmName: 'Escritório Encerrado' }, dev)).statusCode).toBe(403);
    // sem suspender antes, recusa
    expect((await call(office.officeId, { confirmName: 'Escritório Encerrado' })).statusCode).toBe(400);
    await client(env, env.app.jwt.sign({ typ: 'platform', sub: owner.id, tv: 0 })).put(`/api/platform/offices/${office.officeId}/block`, { blocked: true, reason: 'Encerramento' });
    expect((await call(office.officeId, { confirmName: 'Outro nome' })).statusCode).toBe(400);
    const done = await call(office.officeId, { confirmName: 'escritório encerrado' });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ ok: true, files: 1 });

    expect(await env.ctx.db.query.offices.findFirst({ where: eq(offices.id, office.officeId) })).toBeUndefined();
    expect(await env.ctx.db.select().from(customers).where(eq(customers.officeId, office.officeId))).toEqual([]);
    expect(await env.ctx.db.select().from(users).where(eq(users.officeId, office.officeId))).toEqual([]);
    expect(await env.ctx.db.select().from(files).where(eq(files.officeId, office.officeId))).toEqual([]);
    const store = (env.ctx.files as unknown as { store: MemoryBlobStore }).store;
    await expect(store.get(saved.storageKey)).rejects.toThrow();
    expect((await login(office.email)).statusCode).toBe(401);
    // o vizinho segue inteiro
    expect((await neighbor.api.get(`/api/customers/${kept.body.id}`)).status).toBe(200);
    expect((await store.get(neighborFile.storageKey)).toString()).toBe('vizinho');
  });
});
