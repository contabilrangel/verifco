/**
 * Regressões de segurança do acesso: limite de tentativas no banco (vale entre instâncias),
 * "esqueci minha senha" pela fila, configuração de produção, mensagens de erro em português.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { exposeDevSecrets, loadConfig, type Config } from '../src/config';
import { jobs } from '../src/db/schema';
import { MemoryProviders } from '../src/integrations/providers';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';

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
  async function prodApp(trustProxy: boolean, nodeEnv: Config['NODE_ENV'] = 'production') {
    const app = await buildApp({ ...env.ctx, config: { ...env.ctx.config, NODE_ENV: nodeEnv, TRUST_PROXY: trustProxy } });
    await app.ready();
    return app;
  }
  const viaProxy = (app: Awaited<ReturnType<typeof prodApp>>, ip: string) =>
    app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': ip }, remoteAddress: '10.0.0.2' });

  it('avisa uma vez no console quando chega X-Forwarded-For com TRUST_PROXY desligado em produção', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const apps = [await prodApp(false), await prodApp(true), await prodApp(false, 'development')];
    try {
      const [untrusted, trusted, dev] = apps;
      expect((await untrusted.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect(warn).not.toHaveBeenCalled();
      expect((await viaProxy(untrusted, '203.0.113.7')).statusCode).toBe(200);
      await viaProxy(untrusted, '203.0.113.8');
      const proxyWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes('TRUST_PROXY'));
      expect(proxyWarnings()).toHaveLength(1);
      expect(String(proxyWarnings()[0][0])).toContain('10.0.0.2');
      // com TRUST_PROXY=true o IP vem do cabeçalho; fora de produção não há aviso
      await viaProxy(trusted, '203.0.113.9');
      await viaProxy(dev, '203.0.113.9');
      expect(proxyWarnings()).toHaveLength(1);
    } finally {
      warn.mockRestore();
      for (const app of apps) await app.close();
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
