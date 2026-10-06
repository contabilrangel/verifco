/**
 * Regressões de segurança do acesso: limite de tentativas no banco (vale entre instâncias),
 * "esqueci minha senha" pela fila, configuração de produção, mensagens de erro em português.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { exposeDevSecrets, loadConfig, parseTrustProxy, type Config } from '../src/config';
import { fastifyTrustProxy, isInternalAddress } from '../src/lib/proxy';
import { jobs } from '../src/db/schema';
import { MemoryProviders } from '../src/integrations/providers';
import { currentExerciseYear } from '@verifco/shared';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { issueAccess, officeWithCustomer } from './portal-helpers';

/** Ambiente de teste com configuração própria (ex.: limite de tentativas ligado). */
async function envWith(overrides: Partial<Config>): Promise<TestEnv> {
  const providers = new MemoryProviders();
  const { ctx, close } = await createContext({ DATABASE_URL: 'pglite:memory', NODE_ENV: 'test', RUN_WORKER: false, ...overrides }, { providers, memoryStorage: true });
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    providers,
    close: async () => {
      await app.close();
      await close();
    },
  };
}

let env: TestEnv;
let limited: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
  limited = await envWith({ RATE_LIMIT: true });
});
afterAll(async () => {
  await env.close();
  await limited.close();
});

const login = (e: TestEnv, email: string, password: string, ip = '10.1.1.1') =>
  e.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: ip });

describe('limite de tentativas (SEG-7, DAD-11)', () => {
  it('bloqueia o e-mail depois de 10 falhas, mesmo com a senha certa, e avisa o dono da conta', async () => {
    const o = await registerOffice(limited);
    for (let i = 0; i < 10; i++) expect((await login(limited, o.email, 'errada', `10.0.${i}.1`)).statusCode).toBe(401);
    const blocked = await login(limited, o.email, 'senha-forte-123', '10.9.9.9');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Muitas tentativas/);
    await limited.ctx.jobs.drain();
    expect(limited.providers.sentEmails.some((m) => m.to === o.email && m.subject.includes('bloqueadas'))).toBe(true);
  });

  it('limita as falhas por IP em vários e-mails e vale para outra instância no mesmo banco', async () => {
    const ip = '172.20.0.9';
    for (let i = 0; i < 20; i++) expect((await login(limited, `naoexiste${i}@teste.com`, 'x', ip)).statusCode).toBe(401);
    expect((await login(limited, 'outro@teste.com', 'x', ip)).statusCode).toBe(429);
    // segunda instância da API apontando para o mesmo banco: o contador é compartilhado
    const second = await buildApp(limited.ctx);
    await second.ready();
    const res = await second.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'mais@teste.com', password: 'x' }, remoteAddress: ip });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    await second.close();
  });

  it('esqueci a senha: um e-mail por conta a cada 5 minutos, pela fila, sem guardar o token', async () => {
    const o = await registerOffice(limited);
    const ask = () => limited.app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: o.email }, remoteAddress: '10.2.2.2' });
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
    const before = limited.providers.sentEmails.filter((m) => m.to === o.email).length;
    await limited.ctx.jobs.drain();
    const sent = limited.providers.sentEmails.filter((m) => m.to === o.email && m.subject.includes('Redefinição'));
    expect(sent).toHaveLength(1);
    expect(before).toBe(0);
    const job = await limited.ctx.db.query.jobs.findFirst({ where: eq(jobs.type, 'auth.password_reset') });
    expect(job!.payload).not.toHaveProperty('token');
    // muitas chamadas do mesmo IP param com 429
    for (let i = 0; i < 8; i++) await ask();
    expect((await ask()).statusCode).toBe(429);
  });

  it('portal: limite por IP também em CPFs diferentes', async () => {
    const ip = '192.0.2.50';
    for (let i = 0; i < 30; i++) {
      const r = await limited.app.inject({ method: 'POST', url: '/api/portal/login', payload: { cpf: VALID_CPFS[i % VALID_CPFS.length], code: '000000' }, remoteAddress: ip });
      expect(r.statusCode).toBe(401);
    }
    const r = await limited.app.inject({ method: 'POST', url: '/api/portal/login', payload: { cpf: VALID_CPFS[0], code: '123456' }, remoteAddress: ip });
    expect(r.statusCode).toBe(429);
  });

  it('portal e link do checklist: falhas por CPF/link ficam no banco e somam entre instâncias (SEG-7b)', async () => {
    // CPFs fora de VALID_CPFS: a chave `portal:<cpf>` não se mistura com os outros testes deste ambiente
    const cpf = '46815392791';
    const o = await officeWithCustomer(limited, cpf, 'Paula Lima');
    const code = (await o.api.post(`/api/customers/${o.customerId}/portal-access`)).body.code as string;
    const wrong = code === '000000' ? '111111' : '000000';
    // outra instância da API: contexto próprio (como outro processo), mesmo banco
    const second = await buildApp({ ...limited.ctx });
    await second.ready();
    try {
      const portal = (app: typeof second, c: string, n: number) =>
        app.inject({ method: 'POST', url: '/api/portal/login', payload: { cpf, code: c }, remoteAddress: `198.18.0.${n}` });
      // 3 falhas numa instância e 2 na outra, de IPs diferentes: o CPF fica bloqueado nas duas
      for (let i = 0; i < 3; i++) expect((await portal(limited.app, wrong, i)).statusCode).toBe(401);
      for (let i = 3; i < 5; i++) expect((await portal(second, wrong, i)).statusCode).toBe(401);
      const stored = (await limited.ctx.db.execute(sql`select count from rate_limits where key = ${`portal:${cpf}`}`)) as unknown as { rows: { count: number }[] };
      expect(Number(stored.rows[0]?.count)).toBe(5);
      for (const app of [limited.app, second]) {
        const blocked = await portal(app, code, 9);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json().error).toMatch(/Aguarde/);
        expect(blocked.headers['retry-after']).toBeDefined();
      }
      // outro CPF não é afetado
      const other = await officeWithCustomer(limited, '73529184691');
      const otherCode = (await other.api.post(`/api/customers/${other.customerId}/portal-access`)).body.code as string;
      const ok = await second.inject({ method: 'POST', url: '/api/portal/login', payload: { cpf: '73529184691', code: otherCode }, remoteAddress: '198.18.0.20' });
      expect(ok.statusCode).toBe(200);

      // link do checklist: a chave é o link, também somada entre as instâncias
      const checklist = await other.api.post(`/api/customers/${other.customerId}/checklist`, { year: currentExerciseYear() });
      expect(checklist.status).toBe(201);
      const access = await issueAccess(other.api, checklist.body.id);
      const wrongCode = access.code === '000000' ? '111111' : '000000';
      const link = (app: typeof second, c: string, n: number) =>
        app.inject({ method: 'POST', url: '/api/portal/checklist-login', payload: { token: access.token, cpf: '73529184691', code: c }, remoteAddress: `198.18.1.${n}` });
      for (let i = 0; i < 2; i++) expect((await link(limited.app, wrongCode, i)).statusCode).toBe(401);
      for (let i = 2; i < 5; i++) expect((await link(second, wrongCode, i)).statusCode).toBe(401);
      expect((await link(limited.app, access.code, 9)).statusCode).toBe(429);
      expect((await link(second, access.code, 9)).statusCode).toBe(429);
    } finally {
      await second.close();
    }
  });

  it('cadastro aberto: até 10 escritórios por IP por hora', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < 10; i++) {
      const r = await limited.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { officeName: 'Escritório', name: 'Ana', email: `cad${i}-${Date.now()}@teste.com`, password: 'senha-forte-123' },
        remoteAddress: ip,
      });
      expect(r.statusCode).toBe(201);
    }
    const r = await limited.app.inject({ method: 'POST', url: '/api/auth/register', payload: { officeName: 'X', name: 'Ana', email: 'cad-extra@teste.com', password: 'senha-forte-123' }, remoteAddress: ip });
    expect(r.statusCode).toBe(429);
  });

  it('JSON acima do limite geral é recusado em português', async () => {
    const big = JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(3 * 1024 * 1024) });
    const r = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: big, headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toMatch(/tamanho permitido/);
  });
});

describe('configuração de produção (SEG-11, DAD-15)', () => {
  const prod = {
    NODE_ENV: 'production',
    JWT_SECRET: 'k'.repeat(48),
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://u:p@db:5432/verifco',
  };

  it('recusa segredo de exemplo, segredo curto e PGlite', () => {
    expect(() => loadConfig(prod)).not.toThrow();
    expect(() => loadConfig({ ...prod, JWT_SECRET: 'troque-esta-chave-com-pelo-menos-32-caracteres' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...prod, JWT_SECRET: 'curta-mas-com-16-chars' })).toThrow(/32 caracteres/);
    expect(() => loadConfig({ ...prod, ENCRYPTION_KEY: undefined })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: 'pglite:/dados', ALLOW_PGLITE: 'true' })).not.toThrow();
    expect(() => loadConfig({ ...prod, DEV_SHOW_ACCESS_CODES: 'true' })).toThrow(/DEV_SHOW_ACCESS_CODES/);
  });

  it('código do portal e convite só voltam na resposta nos testes ou com a flag de desenvolvimento', async () => {
    expect(exposeDevSecrets({ NODE_ENV: 'production', DEV_SHOW_ACCESS_CODES: false })).toBe(false);
    expect(exposeDevSecrets({ NODE_ENV: 'development', DEV_SHOW_ACCESS_CODES: false })).toBe(false);
    expect(exposeDevSecrets({ NODE_ENV: 'development', DEV_SHOW_ACCESS_CODES: true })).toBe(true);
    const dev = await envWith({ NODE_ENV: 'development' });
    try {
      const o = await registerOffice(dev);
      const c = await o.api.post('/api/customers', { name: 'Cliente', cpfCnpj: VALID_CPFS[2], email: 'c@cliente.com' });
      const access = await o.api.post(`/api/customers/${c.body.id}/portal-access`);
      expect(access.status).toBe(200);
      expect(access.body.code).toBeUndefined();
      const roles = (await o.api.get('/api/roles')).body;
      const emp = await o.api.post('/api/employees', { name: 'Colab', email: 'colab-dev@teste.com', roleId: roles.find((r: any) => !r.isSystem).id });
      expect(emp.body.inviteLink).toBeUndefined();
    } finally {
      await dev.close();
    }
  });
});

describe('TRUST_PROXY atrás de proxy reverso (SEG-7)', () => {
  /** App com a configuração de produção pedida, sobre o mesmo banco dos testes. */
  async function prodApp(trustProxy: Config['TRUST_PROXY'], nodeEnv: Config['NODE_ENV'] = 'production') {
    const app = await buildApp({ ...env.ctx, config: { ...env.ctx.config, NODE_ENV: nodeEnv, TRUST_PROXY: trustProxy } });
    await app.ready();
    return app;
  }
  const viaProxy = (app: Awaited<ReturnType<typeof prodApp>>, ip: string) =>
    app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': ip }, remoteAddress: '10.0.0.2' });

  it('avisa uma vez no console quando chega X-Forwarded-For com TRUST_PROXY desligado em produção', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const apps = [await prodApp(false), await prodApp(1), await prodApp(false, 'development')];
    try {
      const [untrusted, trusted, dev] = apps;
      expect((await untrusted.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect(warn).not.toHaveBeenCalled();
      expect((await viaProxy(untrusted, '203.0.113.7')).statusCode).toBe(200);
      await viaProxy(untrusted, '203.0.113.8');
      const proxyWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes('TRUST_PROXY'));
      expect(proxyWarnings()).toHaveLength(1);
      expect(String(proxyWarnings()[0][0])).toContain('10.0.0.2');
      // com TRUST_PROXY=1 o IP vem do cabeçalho; fora de produção não há aviso
      await viaProxy(trusted, '203.0.113.9');
      await viaProxy(dev, '203.0.113.9');
      expect(proxyWarnings()).toHaveLength(1);
    } finally {
      warn.mockRestore();
      for (const app of apps) await app.close();
    }
  });

  it('aceita número de saltos ou IPs/CIDRs; true continua aceito, com aviso', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy(' 10.0.0.0/8, 192.168.1.10 ,::1 ')).toBe('10.0.0.0/8,192.168.1.10,::1');
    expect(parseTrustProxy('loopback,uniquelocal')).toBe('loopback,uniquelocal');
    expect(() => parseTrustProxy('proxy.interno')).toThrow(/TRUST_PROXY inválido/);
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrow(/TRUST_PROXY inválido/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
      expect(warn).not.toHaveBeenCalled();
      expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/todos os saltos.*TRUST_PROXY=1/);
    } finally {
      warn.mockRestore();
    }
  });

  it('com TRUST_PROXY=1 o IP é o acrescentado pelo proxy: forjar o primeiro valor do X-Forwarded-For não escapa do 429', async () => {
    const app = await buildApp({ ...limited.ctx, config: { ...limited.ctx.config, TRUST_PROXY: 1 } });
    await app.ready();
    try {
      const forgot = (xff: string) =>
        app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'ninguem@teste.com' }, headers: { 'x-forwarded-for': xff }, remoteAddress: '10.0.0.2' });
      // "esqueci a senha": 10 por IP a cada 15 minutos; o cliente troca o primeiro valor a cada tentativa
      for (let i = 0; i < 10; i++) expect((await forgot(`6.6.6.${i}, 203.0.113.50`)).statusCode).toBe(200);
      expect((await forgot('6.6.6.6, 203.0.113.50')).statusCode).toBe(429);
      expect((await forgot('7.7.7.7, 8.8.8.8, 203.0.113.50')).statusCode).toBe(429);
      expect((await forgot('203.0.113.50')).statusCode).toBe(429);
      // a chave é o IP do cliente visto pelo proxy, não o valor forjado
      const keys = await limited.ctx.db.execute(sql`select key, count from rate_limits where key like 'forgot:%'`);
      const rows = (keys as unknown as { rows: { key: string; count: number }[] }).rows;
      expect(rows.find((r) => r.key === 'forgot:203.0.113.50')?.count).toBeGreaterThanOrEqual(10);
      expect(rows.some((r) => r.key.startsWith('forgot:6.6.6.'))).toBe(false);
      // outro cliente atrás do mesmo proxy continua livre
      expect((await forgot('6.6.6.6, 203.0.113.51')).statusCode).toBe(200);
      // conexão direta de fora da rede interna: o cabeçalho é ignorado e vale o IP da conexão
      const direct = await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: 'ninguem@teste.com' },
        headers: { 'x-forwarded-for': '203.0.113.77' },
        remoteAddress: '198.51.100.99',
      });
      expect(direct.statusCode).toBe(200);
      const after = (await limited.ctx.db.execute(sql`select key from rate_limits where key like 'forgot:%'`)) as unknown as { rows: { key: string }[] };
      expect(after.rows.map((r) => r.key)).toContain('forgot:198.51.100.99');
      expect(after.rows.map((r) => r.key)).not.toContain('forgot:203.0.113.77');
    } finally {
      await app.close();
    }
  });

  it('número de saltos vira função que só confia no proxy da frente em rede interna', () => {
    expect(fastifyTrustProxy(false)).toBe(false);
    expect(fastifyTrustProxy(true)).toBe(true);
    expect(fastifyTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    const one = fastifyTrustProxy(1) as (addr: string, hop: number) => boolean;
    expect(one('10.0.0.2', 0)).toBe(true);
    expect(one('::ffff:192.168.0.5', 0)).toBe(true);
    expect(one('::1', 0)).toBe(true);
    expect(one('198.51.100.99', 0)).toBe(false);
    expect(one('10.0.0.3', 1)).toBe(false);
    const two = fastifyTrustProxy(2) as (addr: string, hop: number) => boolean;
    expect(two('172.16.4.4', 0)).toBe(true);
    expect(two('203.0.113.9', 1)).toBe(true);
    expect(two('203.0.113.9', 2)).toBe(false);
    expect(isInternalAddress('172.32.0.1')).toBe(false);
    expect(isInternalAddress('fd12::1')).toBe(true);
    expect(isInternalAddress(undefined)).toBe(false);
  });

  it('avisa em produção quando TRUST_PROXY=1 recebe o cabeçalho de conexão fora da rede interna', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await prodApp(1);
    try {
      await viaProxy(app, '203.0.113.9');
      expect(warn).not.toHaveBeenCalled();
      await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '203.0.113.9' }, remoteAddress: '198.51.100.99' });
      await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '203.0.113.9' }, remoteAddress: '198.51.100.98' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/198\.51\.100\.99.*IPs\/CIDRs/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
});

describe('mensagens da API em português (TEL-4, CON-6)', () => {
  it('validação sem nome técnico nem texto em inglês', async () => {
    const reset = await env.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: null, password: 'senha-forte-123' } });
    expect(reset.statusCode).toBe(400);
    expect(reset.json().error).toBe('Link inválido ou expirado.');
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@escritorio', password: 'x' } });
    expect(login.json().error).toBe('Informe um e-mail válido.');
    const reg = await env.app.inject({ method: 'POST', url: '/api/auth/register', payload: { officeName: 'A', name: 'B', email: 'x', password: '1' } });
    const msg = reg.json().error as string;
    expect(msg).toMatch(/^Dados inválidos: /);
    expect(msg).toContain('Nome do escritório: use ao menos 2 caracteres.');
    expect(msg).toContain('E-mail inválido.');
    expect(msg).not.toMatch(/Too small|Invalid|expected|officeName/);
    const pub = await env.app.inject({ method: 'POST', url: '/api/portal/checklist-link', payload: { token: 'curto' } });
    expect(pub.json().error).toBe('Link: use ao menos 16 caracteres.');
  });

  it('erros do Fastify e do upload chegam traduzidos', async () => {
    const o = await registerOffice(env);
    const bad = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: '{"email":', headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/JSON válido/);
    const xml = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: '<a/>', headers: { 'content-type': 'text/xml' } });
    expect(xml.statusCode).toBe(415);
    expect(xml.json().error).toBe('Formato de envio não suportado.');
    const c = await o.api.post('/api/customers', { name: 'Cliente', cpfCnpj: VALID_CPFS[3] });
    const notMultipart = await o.api.post(`/api/customers/${c.body.id}/documents?year=2026`, { a: 1 });
    expect(notMultipart.status).toBe(400);
    expect(notMultipart.body.error).toBe('Envie o arquivo pelo formulário de upload.');
    const missing = await o.api.get('/api/nao-existe');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Rota não encontrada.' });

    const boundary = '----grande';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="grande.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n`),
      Buffer.alloc(26 * 1024 * 1024, 32),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const big = await env.app.inject({
      method: 'POST',
      url: `/api/customers/${c.body.id}/documents?year=2026`,
      payload,
      headers: { authorization: `Bearer ${o.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toMatch(/passa de 25 MB/);
  });
});
