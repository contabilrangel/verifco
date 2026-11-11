/** Operação: prontidão, situação do plano, monitoramento de erros e validações de configuração. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { addDaysIso, todayIso } from '@verifco/shared';
import { loadConfig } from '../src/config';
import { contracts } from '../src/db/schema';
import { JobQueue } from '../src/jobs/queue';
import { createErrorReporter, parseSentryDsn, sentryEnvelope } from '../src/lib/observability';
import { createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const prod = {
  NODE_ENV: 'production',
  JWT_SECRET: 'k'.repeat(48),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATABASE_URL: 'postgres://offices:secret@db:5432/offices',
  PLATFORM_DATABASE_URL: 'postgres://owner:other@db:5432/platform',
  SMTP_URL: 'smtp://user:pass@smtp.exemplo.com.br:587',
  WEB_URL: 'https://app.exemplo.com.br',
};

describe('prontidão', () => {
  it('/health responde sem consultar nada e /ready confere os dois bancos e a fila', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
    const ready = await env.app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, database: true, platform: true, queue: { worker: false, alive: true } });
  });

  it('a fila iniciada só conta como viva depois de falar com o banco, e avisa quando o banco some', async () => {
    const errors: string[] = [];
    const q = new JobQueue(env.ctx.db, { logger: { loopError: (e) => errors.push(e) } });
    expect(q.health()).toMatchObject({ started: false, alive: true });
    q.start(10);
    await new Promise((r) => setTimeout(r, 80));
    expect(q.health()).toMatchObject({ started: true, alive: true });
    await q.stop();

    // banco fora do ar: qualquer acesso falha
    const down = new Proxy({}, { get: () => () => { throw new Error('sem banco'); } });
    const broken = new JobQueue(down as never, { logger: { loopError: (e) => errors.push(e) } });
    broken.register('teste.qualquer', async () => undefined);
    broken.start(10);
    await new Promise((r) => setTimeout(r, 60));
    expect(broken.health()).toMatchObject({ started: true, alive: false });
    await broken.stop();
    expect(errors).toEqual(['sem banco']);
  });

  it('falha final de tarefa vai para o log da fila', async () => {
    const failed: string[] = [];
    const q = new JobQueue(env.ctx.db, { logger: { jobFailed: (job, error) => failed.push(`${job.type}: ${error}`) } });
    const type = `teste.falha.${Date.now()}`;
    q.register(type, async () => {
      throw new Error('quebrou');
    });
    await q.enqueue(type, {}, { maxAttempts: 1 });
    await q.drain();
    expect(failed).toEqual([`${type}: quebrou`]);
  });
});

describe('situação do plano para toda a equipe', () => {
  it('qualquer pessoa da equipe vê vigência e modo só consulta, sem os detalhes dos contratos', async () => {
    const office = await registerOffice(env);
    const viewer = await createEmployee(env, office.api, ['customer.list']);
    const active = (await viewer.api.get('/api/plan/status')).body;
    expect(active).toMatchObject({ hasContracts: true, readOnly: false, supportEmail: null });
    expect(active.daysLeft).toBeGreaterThan(0);
    expect((await viewer.api.get('/api/office/contracts')).status).toBe(403);

    const yesterday = addDaysIso(todayIso(), -1);
    await env.ctx.db.update(contracts).set({ expiresAt: yesterday }).where(eq(contracts.officeId, office.officeId));
    env.ctx.config.SUPPORT_EMAIL = 'suporte@exemplo.com.br';
    try {
      expect((await viewer.api.get('/api/plan/status')).body).toMatchObject({ readOnly: true, lastExpiredAt: yesterday, validUntil: null, supportEmail: 'suporte@exemplo.com.br' });
    } finally {
      env.ctx.config.SUPPORT_EMAIL = undefined;
    }
  });
});

describe('monitoramento de erros', () => {
  it('interpreta o DSN e monta o envelope sem dados da requisição', async () => {
    expect(parseSentryDsn('https://chave@o1.ingest.sentry.io/42')).toEqual({ url: 'https://o1.ingest.sentry.io/api/42/envelope/', key: 'chave' });
    expect(parseSentryDsn('nada')).toBeNull();
    expect(parseSentryDsn(undefined)).toBeNull();
    const { body } = sentryEnvelope(new Error('falhou'), { source: 'http', route: '/api/x', method: 'POST', requestId: 'req-1' }, 'production');
    const [, , event] = body.trim().split('\n').map((l) => JSON.parse(l));
    expect(event).toMatchObject({ level: 'error', environment: 'production', exception: { values: [{ value: 'falhou' }] }, tags: { source: 'http', route: '/api/x' }, extra: { requestId: 'req-1' } });

    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response('{}');
    }) as unknown as typeof fetch;
    createErrorReporter({ SENTRY_DSN: 'https://chave@sentry.exemplo.com/7', NODE_ENV: 'production' }, fake)(new Error('x'), { source: 'job', jobType: 'a.b' });
    createErrorReporter({ SENTRY_DSN: undefined, NODE_ENV: 'production' }, fake)(new Error('x'), { source: 'job' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sentry.exemplo.com/api/7/envelope/');
    expect(calls[0].headers['X-Sentry-Auth']).toContain('sentry_key=chave');
  });

  it('o erro 500 devolve o código da requisição para o suporte', async () => {
    const office = await registerOffice(env);
    const original = env.ctx.db.query.offices.findFirst;
    env.ctx.db.query.offices.findFirst = (() => {
      throw new Error('falha simulada');
    }) as never;
    try {
      const res = await env.app.inject({ method: 'GET', url: '/api/office', headers: { authorization: `Bearer ${office.token}` } });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: 'Erro interno. Tente novamente em instantes.', requestId: expect.any(String) });
    } finally {
      env.ctx.db.query.offices.findFirst = original;
    }
  });
});

describe('configuração de produção', () => {
  it('exige SMTP quando SMTP_REQUIRED está ligado e as chaves do S3 quando o armazenamento é s3', () => {
    expect(() => loadConfig(prod)).not.toThrow();
    expect(() => loadConfig({ ...prod, SMTP_URL: undefined, SMTP_REQUIRED: 'true' })).toThrow(/SMTP_URL/);
    expect(() => loadConfig({ ...prod, SMTP_URL: 'servidor:25' })).toThrow(/smtp:\/\//);
    expect(() => loadConfig({ ...prod, STORAGE_DRIVER: 's3' })).toThrow(/S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
    expect(loadConfig({ ...prod, STORAGE_DRIVER: 's3', S3_ENDPOINT: 'https://s3.exemplo.com', S3_BUCKET: 'verifco', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' })).toMatchObject({
      STORAGE_DRIVER: 's3',
      S3_FORCE_PATH_STYLE: true,
      SIGNUP_ENABLED: true,
      RETENTION_JOBS_DAYS: 30,
    });
  });
});
