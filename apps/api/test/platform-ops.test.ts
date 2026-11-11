import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { contracts, jobs, notifications, offices } from '../src/db/schema';
import { platformAuditLogs, platformSettings, platformUsers } from '../src/db/platform-schema';
import { createEmailSender, type MailTransport, type SmtpTransportOptions } from '../src/integrations/email';
import type { Providers } from '../src/integrations/providers';
import { PASSWORD_RESET_JOB } from '../src/modules/auth/jobs';
import { resetPlatformPassword } from '../src/modules/platform/recovery';
import { VALID_CPFS, client, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';
import { multipart, send } from './robot-helpers';

let env: TestEnv;
let owner: Api;
let developer: Api;
let ownerId: string;
let developerId: string;
const PASSWORD = 'senha-sistema-123';

beforeAll(async () => {
  env = await createTestEnv();
  const hash = await bcrypt.hash(PASSWORD, 4);
  const rows = await env.ctx.platformDb
    .insert(platformUsers)
    .values([
      { name: 'Proprietária', email: 'dona@sistema.com', passwordHash: hash, role: 'owner' },
      { name: 'Desenvolvedor', email: 'dev@sistema.com', passwordHash: hash, role: 'developer' },
    ])
    .returning();
  ownerId = rows[0].id;
  developerId = rows[1].id;
  owner = client(env, env.app.jwt.sign({ typ: 'platform', sub: ownerId, tv: 0 }));
  developer = client(env, env.app.jwt.sign({ typ: 'platform', sub: developerId, tv: 0 }));
});
afterAll(async () => env.close());

const platformLogin = (email: string, password: string) => env.app.inject({ method: 'POST', url: '/api/platform/login', payload: { email, password } });

/** Transporte SMTP falso que registra para onde cada mensagem foi. */
function fakeSmtp(fail: (opts: SmtpTransportOptions) => Error | null = () => null) {
  const sent: { host: string; to: unknown; subject: unknown }[] = [];
  const factory = (opts: SmtpTransportOptions): MailTransport => ({
    sendMail: async (mail) => {
      const err = fail(opts);
      if (err) throw err;
      sent.push({ host: opts.host, to: mail.to, subject: mail.subject });
      return { messageId: 'fake' };
    },
    verify: async () => {
      const err = fail(opts);
      if (err) throw err;
      return true;
    },
  });
  return { sent, factory };
}

describe('contas do sistema', () => {
  it('a própria conta troca a senha com a atual; as sessões antigas caem e o novo token vale', async () => {
    const created = await owner.post('/api/platform/users', { name: 'Troca', email: 'troca@sistema.com', password: 'senha-inicial-123', role: 'developer' });
    const login = (await platformLogin('troca@sistema.com', 'senha-inicial-123')).json();
    const me = client(env, login.token);
    expect((await me.post('/api/platform/change-password', { currentPassword: 'errada', newPassword: 'outra-senha-forte-1' })).status).toBe(400);
    expect((await me.post('/api/platform/change-password', { currentPassword: 'senha-inicial-123', newPassword: 'curta' })).status).toBe(400);
    const changed = await me.post('/api/platform/change-password', { currentPassword: 'senha-inicial-123', newPassword: 'outra-senha-forte-1' });
    expect(changed.status).toBe(200);
    expect((await me.get('/api/platform/me')).status).toBe(401);
    expect((await client(env, changed.body.token).get('/api/platform/me')).body.email).toBe('troca@sistema.com');
    expect((await platformLogin('troca@sistema.com', 'senha-inicial-123')).statusCode).toBe(401);
    expect((await platformLogin('troca@sistema.com', 'outra-senha-forte-1')).statusCode).toBe(200);
    const listed = (await owner.get('/api/platform/users')).body.find((u: any) => u.id === created.body.id);
    expect(listed.lastLoginAt).toBeTruthy();
    expect(listed).toMatchObject({ twoFactor: false, role: 'developer' });
  });

  it('o proprietário redefine a senha de outra conta e muda o papel; ninguém rebaixa o último proprietário nem a si mesmo', async () => {
    const created = await owner.post('/api/platform/users', { name: 'Alvo', email: 'alvo@sistema.com', password: 'senha-inicial-123', role: 'developer' });
    const id = created.body.id as string;
    const session = client(env, (await platformLogin('alvo@sistema.com', 'senha-inicial-123')).json().token);
    expect((await developer.put(`/api/platform/users/${id}/password`, { password: 'nova-senha-forte-12' })).status).toBe(403);
    expect((await owner.put(`/api/platform/users/${id}/password`, { password: 'curta' })).status).toBe(400);
    expect((await owner.put(`/api/platform/users/${ownerId}/password`, { password: 'nova-senha-forte-12' })).status).toBe(400);
    expect((await owner.put(`/api/platform/users/${id}/password`, { password: 'nova-senha-forte-12' })).status).toBe(200);
    expect((await session.get('/api/platform/me')).status).toBe(401);
    expect((await platformLogin('alvo@sistema.com', 'nova-senha-forte-12')).statusCode).toBe(200);

    // papel: promover, e então o rebaixamento do único proprietário restante é recusado
    expect((await owner.put(`/api/platform/users/${ownerId}`, { name: 'Proprietária', role: 'developer' })).status).toBe(400);
    expect((await owner.put(`/api/platform/users/${id}`, { name: 'Alvo Promovido', role: 'owner' })).status).toBe(200);
    const promoted = client(env, (await platformLogin('alvo@sistema.com', 'nova-senha-forte-12')).json().token);
    expect((await promoted.get('/api/platform/me')).body).toMatchObject({ name: 'Alvo Promovido', role: 'owner' });
    expect((await promoted.put(`/api/platform/users/${ownerId}`, { name: 'Proprietária', role: 'developer' })).status).toBe(200);
    expect((await promoted.put(`/api/platform/users/${ownerId}`, { name: 'Proprietária', role: 'owner' })).status).toBe(200);
    expect((await owner.put(`/api/platform/users/${id}`, { name: 'Alvo', role: 'developer' })).status).toBe(401); // a sessão do dono caiu ao mudar de papel
    owner = client(env, (await platformLogin('dona@sistema.com', PASSWORD)).json().token);
    expect((await owner.put(`/api/platform/users/${id}`, { name: 'Alvo', role: 'developer' })).status).toBe(200);
    expect((await owner.put(`/api/platform/users/${id}`, { name: 'Alvo', role: 'developer' })).status).toBe(200);
    const actions = (await env.ctx.platformDb.select().from(platformAuditLogs)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.password.change', 'platform.user.password', 'platform.user.update']));
  });
});

describe('recuperação de conta pela linha de comando', () => {
  it('troca a senha, encerra as sessões, libera o bloqueio de tentativas e, a pedido, desliga o 2FA e reativa', async () => {
    const created = await owner.post('/api/platform/users', { name: 'Perdida', email: 'perdida@sistema.com', password: 'senha-inicial-123', role: 'owner' });
    const id = created.body.id as string;
    const session = client(env, (await platformLogin('perdida@sistema.com', 'senha-inicial-123')).json().token);
    await env.ctx.platformDb.update(platformUsers).set({ totpEnabledAt: new Date(), totpSecretEnc: 'x', totpRecoveryHashes: ['h'], isActive: false }).where(eq(platformUsers.id, id));
    await expect(resetPlatformPassword(env.ctx.platformDb, { email: 'ninguem@sistema.com', password: 'nova-senha-forte-12' })).rejects.toThrow(/Não existe conta/);
    await expect(resetPlatformPassword(env.ctx.platformDb, { email: 'perdida@sistema.com', password: 'curta' })).rejects.toThrow(/12 caracteres/);

    const plain = await resetPlatformPassword(env.ctx.platformDb, { email: 'PERDIDA@sistema.com', password: 'nova-senha-forte-12' });
    expect(plain).toMatchObject({ isActive: false, twoFactorStillOn: true, twoFactorCleared: false, reactivated: false });
    const full = await resetPlatformPassword(env.ctx.platformDb, { email: 'perdida@sistema.com', password: 'nova-senha-forte-12', resetTwoFactor: true, reactivate: true });
    expect(full).toMatchObject({ isActive: true, twoFactorCleared: true, reactivated: true });
    const row = await env.ctx.platformDb.query.platformUsers.findFirst({ where: eq(platformUsers.id, id) });
    expect(row).toMatchObject({ isActive: true, totpEnabledAt: null, totpSecretEnc: null, totpRecoveryHashes: [] });
    expect((await session.get('/api/platform/me')).status).toBe(401);
    expect((await platformLogin('perdida@sistema.com', 'senha-inicial-123')).statusCode).toBe(401);
    expect((await platformLogin('perdida@sistema.com', 'nova-senha-forte-12')).statusCode).toBe(200);
    const audit = await env.ctx.platformDb.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, 'platform.password.cli'));
    expect(audit).toHaveLength(2);
    await owner.put(`/api/platform/users/${id}/active`, { isActive: false });
  });
});

describe('escritórios no painel do sistema', () => {
  it('lista com situação e busca; a ficha mostra responsáveis, uso e contratos, sem dados de clientes', async () => {
    const office = await registerOffice(env, 'Contabilidade Horizonte');
    await office.api.post('/api/customers', { name: 'Cliente sigiloso', cpfCnpj: VALID_CPFS[0] });
    const list = (await developer.get('/api/platform/offices?search=horizonte')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: office.officeId, customers: 1, collaborators: 1, blockedAt: null });
    expect(list[0].contractExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await developer.get(`/api/platform/offices?search=${encodeURIComponent(office.email)}`)).body).toHaveLength(1);
    expect((await developer.get('/api/platform/offices?search=%25')).body).toEqual([]);

    const detail = await developer.get(`/api/platform/offices/${office.officeId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.owners).toEqual([expect.objectContaining({ email: office.email })]);
    expect(detail.body.usage).toMatchObject({ activeUsers: 1, customers: 1, declarations: 0, storageBytes: 0 });
    expect(detail.body.contracts).toEqual([expect.objectContaining({ plan: 'trial', status: 'active' })]);
    expect(JSON.stringify(detail.body)).not.toContain('Cliente sigiloso');
    expect((await developer.get(`/api/platform/contracts?officeId=${office.officeId}`)).body).toHaveLength(1);
    expect((await developer.get('/api/platform/offices/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('suspender tira do ar colaboradores, portal do cliente e robôs; liberar devolve o acesso sem perder nada', async () => {
    const office = await registerOffice(env, 'Suspenso');
    const customer = await office.api.post('/api/customers', { name: 'Cliente', cpfCnpj: VALID_CPFS[1] });
    const token = (await office.api.post('/api/robot/tokens', { name: 'Sync', scope: 'sync' })).body.token as string;
    expect((await developer.put(`/api/platform/offices/${office.officeId}/block`, { blocked: true, reason: 'Inadimplência' })).status).toBe(403);
    expect((await owner.put(`/api/platform/offices/${office.officeId}/block`, { blocked: true })).status).toBe(400);
    expect((await owner.put(`/api/platform/offices/${office.officeId}/block`, { blocked: true, reason: 'Inadimplência' })).status).toBe(200);

    const blockedMe = await office.api.get('/api/auth/me');
    expect(blockedMe.status).toBe(403);
    expect(blockedMe.body.error).toMatch(/suspenso/);
    expect((await office.api.get('/api/customers')).status).toBe(403);
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: office.email, password: 'senha-forte-123' } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toMatch(/suspenso/);
    expect((await send(env, token, 'GET', '/api/sync/whoami')).status).toBe(403);
    expect((await send(env, token, 'POST', '/api/sync/inbox', { multipart: multipart({ motivo: 'sem_cpf' }, { name: 'a.pdf', content: 'x' }) })).status).toBe(403);
    // os outros escritórios seguem normais
    const other = await registerOffice(env, 'Normal');
    expect((await other.api.get('/api/auth/me')).status).toBe(200);
    expect((await owner.get('/api/platform/overview')).body.blocked_offices).toBeGreaterThanOrEqual(1);
    expect((await owner.get(`/api/platform/offices/${office.officeId}`)).body).toMatchObject({ blockedReason: 'Inadimplência' });

    expect((await owner.put(`/api/platform/offices/${office.officeId}/block`, { blocked: false })).status).toBe(200);
    expect((await office.api.get(`/api/customers/${customer.body.id}`)).status).toBe(200);
    expect((await send(env, token, 'GET', '/api/sync/whoami')).status).toBe(200);
    const row = await env.ctx.db.query.offices.findFirst({ where: eq(offices.id, office.officeId) });
    expect(row).toMatchObject({ blockedAt: null, blockedReason: null });
    const audit = await env.ctx.platformDb.select().from(platformAuditLogs).where(eq(platformAuditLogs.entityId, office.officeId));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['office.block', 'office.unblock']));
  });
});

describe('fila de tarefas no painel', () => {
  it('lista as falhas com o escritório, recoloca na fila e dispensa; o conteúdo do job não aparece', async () => {
    const office = await registerOffice(env, 'Fila');
    const [failed] = await env.ctx.db
      .insert(jobs)
      .values({ officeId: office.officeId, type: 'teste.falha', payload: { segredo: 'nao-pode-sair' }, status: 'failed', attempts: 3, error: 'servidor fora do ar', finishedAt: new Date() })
      .returning();
    const [done] = await env.ctx.db.insert(jobs).values({ officeId: office.officeId, type: 'teste.ok', status: 'done', finishedAt: new Date() }).returning();
    const list = await developer.get(`/api/platform/jobs?officeId=${office.officeId}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ id: failed.id, type: 'teste.falha', officeName: 'Fila', error: 'servidor fora do ar', attempts: 3 })]);
    expect(JSON.stringify(list.body)).not.toContain('nao-pode-sair');
    expect((await developer.get(`/api/platform/jobs?status=done&officeId=${office.officeId}`)).body).toHaveLength(1);
    expect((await developer.get('/api/platform/jobs?status=qualquer')).status).toBe(400);

    expect((await developer.post(`/api/platform/jobs/${failed.id}/retry`)).status).toBe(403);
    expect((await owner.post(`/api/platform/jobs/${done.id}/retry`)).status).toBe(404);
    expect((await owner.post(`/api/platform/jobs/${failed.id}/retry`)).status).toBe(200);
    expect(await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, failed.id) })).toMatchObject({ status: 'queued', attempts: 0, error: null, finishedAt: null });

    await env.ctx.db.update(jobs).set({ status: 'failed', finishedAt: new Date() }).where(eq(jobs.id, failed.id));
    const dismissed = await owner.post('/api/platform/jobs/dismiss', { ids: [failed.id, done.id] });
    expect(dismissed.body).toEqual({ removed: 1 });
    expect(await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, done.id) })).toBeTruthy();

    const overview = (await owner.get('/api/platform/overview')).body;
    expect(overview).toMatchObject({ queue: { worker: false }, email: false });
    expect(overview.failed_jobs).toEqual(expect.any(Number));
  });
});

describe('configurações do sistema', () => {
  it('fecha o cadastro, define a avaliação e os termos; a tela de entrada lê sem login', async () => {
    const initial = await env.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(initial.json()).toEqual({ signupEnabled: true, trialDays: 30, supportEmail: null, termsUrl: null, privacyUrl: null });
    const body = { signupEnabled: null, trialDays: 14, trialDeclarationLimit: 5, supportEmail: 'suporte@verifco.com.br', termsUrl: 'https://verifco.com.br/termos-v2', privacyUrl: null };
    expect((await developer.put('/api/platform/settings', body)).status).toBe(403);
    expect((await owner.put('/api/platform/settings', { ...body, termsUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await owner.put('/api/platform/settings', { ...body, trialDays: 0 })).status).toBe(400);
    expect((await owner.put('/api/platform/settings', body)).body).toMatchObject({ signupEnabled: true, trialDays: 14, trialDeclarationLimit: 5, supportEmail: 'suporte@verifco.com.br' });
    expect((await developer.get('/api/platform/settings')).body).toMatchObject({ stored: { trialDays: 14, signupEnabled: null }, effective: { trialDays: 14 }, environment: { signupEnabled: true } });

    const register = (extra: Record<string, unknown> = {}) =>
      env.app.inject({ method: 'POST', url: '/api/auth/register', payload: { officeName: 'Novo Escritório', name: 'Bia', email: `bia${Math.random().toString(16).slice(2)}@teste.com.br`, password: 'senha-forte-123', ...extra } });
    // com termos publicados, o aceite é obrigatório e fica registrado com a versão
    expect((await register()).statusCode).toBe(400);
    const ok = await register({ acceptTerms: true });
    expect(ok.statusCode).toBe(201);
    const officeId = ok.json().office.id as string;
    expect(await env.ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId) })).toMatchObject({ termsVersion: 'https://verifco.com.br/termos-v2', termsAcceptedAt: expect.any(Date) });
    const [trial] = await env.ctx.db.select().from(contracts).where(eq(contracts.officeId, officeId));
    expect(trial.declarationLimit).toBe(5);
    expect(Math.round((Date.parse(trial.expiresAt) - Date.parse(trial.startsAt)) / 86400000)).toBe(14);
    expect((await client(env, ok.json().token).get('/api/plan/status')).body.supportEmail).toBe('suporte@verifco.com.br');

    // cadastro fechado pelo painel
    await owner.put('/api/platform/settings', { ...body, signupEnabled: false });
    expect((await env.app.inject({ method: 'GET', url: '/api/auth/config' })).json()).toMatchObject({ signupEnabled: false, termsUrl: 'https://verifco.com.br/termos-v2' });
    const closed = await register({ acceptTerms: true });
    expect(closed.statusCode).toBe(403);
    expect(closed.json().error).toMatch(/cadastro de novos escritórios está fechado.*suporte@verifco\.com\.br/);
    // a variável do servidor fecha de vez: o painel não reabre
    await owner.put('/api/platform/settings', { ...body, signupEnabled: true, termsUrl: null });
    env.ctx.config.SIGNUP_ENABLED = false;
    try {
      expect((await register()).statusCode).toBe(403);
    } finally {
      env.ctx.config.SIGNUP_ENABLED = true;
    }
    expect((await register()).statusCode).toBe(201);
    await env.ctx.platformDb.delete(platformSettings);
  });
});

describe('e-mail do sistema', () => {
  it('mostra a situação sem a senha e testa o envio', async () => {
    expect((await developer.get('/api/platform/email')).body).toMatchObject({ configured: false, host: null, accountMailFailures7d: expect.any(Number) });
    const none = await owner.post('/api/platform/email/test', {});
    expect(none.body).toMatchObject({ ok: false });
    expect(none.body.message).toMatch(/SMTP_URL/);

    env.ctx.config.SMTP_URL = 'smtps://usuario:segredo-smtp@smtp.sistema.com:465';
    const smtp = fakeSmtp();
    (env.ctx.providers as Providers).smtpTransport = smtp.factory;
    try {
      const info = await developer.get('/api/platform/email');
      expect(info.body).toMatchObject({ configured: true, host: 'smtp.sistema.com', port: 465, secure: true });
      expect(JSON.stringify(info.body)).not.toContain('segredo-smtp');
      expect((await developer.post('/api/platform/email/test', { to: 'x@teste.com' })).status).toBe(403);
      const sent = await owner.post('/api/platform/email/test', { to: 'destino@teste.com' });
      expect(sent.body).toMatchObject({ ok: true });
      expect(smtp.sent).toEqual([expect.objectContaining({ host: 'smtp.sistema.com', to: 'destino@teste.com' })]);
      (env.ctx.providers as Providers).smtpTransport = fakeSmtp(() => Object.assign(new Error('535'), { code: 'EAUTH' })).factory;
      const bad = await owner.post('/api/platform/email/test', {});
      expect(bad.body).toMatchObject({ ok: false });
      expect(bad.body.message).toMatch(/recusou o usuário ou a senha/);
    } finally {
      env.ctx.config.SMTP_URL = undefined;
      (env.ctx.providers as Providers).smtpTransport = undefined;
    }
  });

  it('e-mail da conta sai pelo sistema e cai no do escritório se o do sistema falhar; e-mail comum usa o do escritório', async () => {
    const office = await registerOffice(env, 'Com SMTP próprio');
    const saved = await office.api.put('/api/integrations/smtp', {
      enabled: true,
      config: { host: 'smtp.escritorio.com.br', port: 587, security: 'starttls', username: 'u', fromEmail: 'contato@escritorio.com.br' },
      secrets: { password: 'p' },
    });
    expect(saved.status).toBe(200);
    env.ctx.config.SMTP_URL = 'smtp://smtp.sistema.com:587';
    try {
      const ok = fakeSmtp();
      const sender = createEmailSender(env.ctx, ok.factory);
      await sender.send(office.officeId, { to: 'a@teste.com', subject: 'Conta', html: 'x', system: true });
      await sender.send(office.officeId, { to: 'b@teste.com', subject: 'Comum', html: 'x' });
      expect(ok.sent.map((m) => [m.subject, m.host])).toEqual([['Conta', 'smtp.sistema.com'], ['Comum', 'smtp.escritorio.com.br']]);

      const platformDown = fakeSmtp((o) => (o.host === 'smtp.sistema.com' ? Object.assign(new Error('fora'), { code: 'ECONNECTION' }) : null));
      await createEmailSender(env.ctx, platformDown.factory).send(office.officeId, { to: 'c@teste.com', subject: 'Reserva', html: 'x', system: true });
      expect(platformDown.sent).toEqual([expect.objectContaining({ subject: 'Reserva', host: 'smtp.escritorio.com.br' })]);

      // tudo fora: o erro relatado é o do caminho preferido
      const allDown = fakeSmtp(() => Object.assign(new Error('fora'), { code: 'ECONNECTION' }));
      await expect(createEmailSender(env.ctx, allDown.factory).send(office.officeId, { to: 'd@teste.com', subject: 'x', html: 'x', system: true })).rejects.toThrow(/Não foi possível conectar/);
    } finally {
      env.ctx.config.SMTP_URL = undefined;
    }
  });

  it('convite que não sai devolve o link a quem convidou; redefinição que falha avisa o escritório e apaga o token', async () => {
    const office = await registerOffice(env, 'Sem e-mail');
    const roles = (await office.api.get('/api/roles')).body;
    const roleId = roles.find((r: any) => r.name === 'Contador').id;
    const original = env.providers.email.send;
    env.providers.email.send = async () => {
      throw new Error('smtp fora do ar');
    };
    env.ctx.config.NODE_ENV = 'production';
    try {
      const created = await office.api.post('/api/employees', { name: 'Caio', email: `caio${Date.now()}@teste.com.br`, roleId });
      expect(created.status).toBe(201);
      expect(created.body.emailSent).toBe(false);
      expect(created.body.inviteLink).toMatch(/\/redefinir-senha\?token=.+&convite=1$/);
      const again = await office.api.post(`/api/employees/${created.body.id}/invite`);
      expect(again.body).toMatchObject({ ok: true, emailSent: false });
      expect(again.body.inviteLink).not.toBe(created.body.inviteLink);

      env.providers.email.send = original;
      const sent = await office.api.post(`/api/employees/${created.body.id}/invite`);
      expect(sent.body).toEqual({ ok: true, emailSent: true });
      expect(env.providers.sentEmails.at(-1)).toMatchObject({ system: true });
    } finally {
      env.providers.email.send = original;
      env.ctx.config.NODE_ENV = 'test';
    }

    // redefinição de senha: esgotadas as tentativas, o token cifrado sai do job e o sino avisa
    env.providers.email.send = async () => {
      throw new Error('smtp fora do ar');
    };
    try {
      await env.app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: office.email } });
      const queued = (await env.ctx.db.select().from(jobs).where(eq(jobs.type, PASSWORD_RESET_JOB))).find((j) => j.payload.userId === office.userId)!;
      expect(queued.payload.token).toBeTruthy();
      await env.ctx.db.update(jobs).set({ maxAttempts: 1 }).where(eq(jobs.id, queued.id));
      await env.ctx.jobs.drain();
      const after = await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, queued.id) });
      expect(after).toMatchObject({ status: 'failed', payload: { userId: office.userId } });
      const bell = await env.ctx.db.select().from(notifications).where(eq(notifications.officeId, office.officeId));
      expect(bell.filter((n) => n.title === 'E-mail da conta não enviado')).toHaveLength(1);
      expect(bell.find((n) => n.title === 'E-mail da conta não enviado')!.body).toContain(office.email);
    } finally {
      env.providers.email.send = original;
    }
  });
});
