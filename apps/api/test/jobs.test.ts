import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { jobs } from '../src/db/schema';
import { DEFAULT_RETRY, EXTERNAL_SERVICE_RETRY, JobQueue, type JobRow } from '../src/jobs/queue';
import { loadConfig } from '../src/config';
import { createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
// cada teste começa com a fila vazia (as filas de teste reivindicam qualquer tipo de job)
beforeEach(async () => {
  await env.ctx.db.delete(jobs);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jobById = async (id: string) => (await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, id) }))!;
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('tempo esgotado esperando a condição');
    await sleep(20);
  }
}
/** Promessa que o teste libera quando quiser. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}
const newOffice = async () => (await registerOffice(env)).officeId;

describe('fila: posse com prazo e recuperação (DAD-1)', () => {
  it('job preso em "running" por um processo que caiu volta para a fila e termina', async () => {
    const q = new JobQueue(env.ctx.db, { leaseMs: 60_000 });
    const done: string[] = [];
    q.register('teste.ok', async (job) => {
      done.push(job.id);
    });
    const job = await q.enqueue('teste.ok', {});
    // simula o processo que reivindicou o job e morreu (deploy, OOM): running com posse vencida
    await env.ctx.db
      .update(jobs)
      .set({ status: 'running', attempts: 1, lockedAt: sql`now() - interval '10 minutes'` })
      .where(eq(jobs.id, job.id));
    // posse ainda válida não é tocada
    expect(await new JobQueue(env.ctx.db, { leaseMs: 60 * 60_000 }).recoverStale()).toEqual({ requeued: 0, failed: 0 });

    expect(await q.recoverStale()).toEqual({ requeued: 1, failed: 0 });
    const back = await jobById(job.id);
    expect(back).toMatchObject({ status: 'queued', attempts: 1, lockedAt: null });
    expect(back.error).toMatch(/interrompida/);
    await q.drain();
    expect(done).toEqual([job.id]);
    expect(await jobById(job.id)).toMatchObject({ status: 'done', attempts: 2, error: null });
  });

  it('sem tentativas restantes, o job interrompido falha (não fica "running" para sempre)', async () => {
    const q = new JobQueue(env.ctx.db, { leaseMs: 60_000 });
    const job = await q.enqueue('teste.unica', {}, { maxAttempts: 1 });
    await env.ctx.db
      .update(jobs)
      .set({ status: 'running', attempts: 1, lockedAt: sql`now() - interval '10 minutes'` })
      .where(eq(jobs.id, job.id));
    expect(await q.recoverStale()).toEqual({ requeued: 0, failed: 1 });
    const failed = await jobById(job.id);
    expect(failed.status).toBe('failed');
    expect(failed.finishedAt).not.toBeNull();
  });

  it('a renovação da posse mantém o job longo com o processo vivo', async () => {
    const q = new JobQueue(env.ctx.db, { leaseMs: 1000, heartbeatMs: 200 });
    const g = gate();
    q.register('teste.longo', async () => {
      await g.promise;
      return { ok: true };
    });
    const job = await q.enqueue('teste.longo', {});
    const running = q.runNext();
    await sleep(1600); // passa do prazo da posse, mas o executor a renova
    expect(await new JobQueue(env.ctx.db, { leaseMs: 1000 }).recoverStale()).toEqual({ requeued: 0, failed: 0 });
    expect((await jobById(job.id)).status).toBe('running');
    g.open();
    await running;
    expect(await jobById(job.id)).toMatchObject({ status: 'done', result: { ok: true } });
  });

  it('a execução que perdeu a posse não sobrescreve a que retomou o job', async () => {
    const stale = new JobQueue(env.ctx.db, { leaseMs: 1000, heartbeatMs: 60_000 });
    const g = gate();
    stale.register('teste.cerca', async () => {
      await g.promise;
      return { by: 'antiga' };
    });
    const job = await stale.enqueue('teste.cerca', {});
    const first = stale.runNext();
    await waitFor(async () => (await jobById(job.id)).status === 'running');
    // a renovação parou (processo travado): a posse vence e outro processo retoma
    await env.ctx.db
      .update(jobs)
      .set({ lockedAt: sql`now() - interval '1 minute'` })
      .where(eq(jobs.id, job.id));
    const fresh = new JobQueue(env.ctx.db, { leaseMs: 1000 });
    fresh.register('teste.cerca', async () => ({ by: 'nova' }));
    expect(await fresh.runNext()).toBe(true);
    expect(await jobById(job.id)).toMatchObject({ status: 'done', attempts: 2, result: { by: 'nova' } });
    g.open();
    await first;
    expect(await jobById(job.id)).toMatchObject({ status: 'done', attempts: 2, result: { by: 'nova' } });
  });

  it('pedido de backup com o anterior preso por queda do processo volta a funcionar', async () => {
    const o = await registerOffice(env);
    const first = await o.api.post('/api/backups');
    expect(first.status).toBe(202);
    await env.ctx.db
      .update(jobs)
      .set({ status: 'running', attempts: 1, lockedAt: sql`now() - interval '1 hour'` })
      .where(eq(jobs.id, first.body.id));
    // antes respondia "já em andamento" para sempre; agora o job volta para a fila e é processado
    const again = await o.api.post('/api/backups');
    expect(again.body).toMatchObject({ id: first.body.id, status: 'queued', alreadyRunning: true });
    await env.ctx.jobs.drain();
    expect((await o.api.get('/api/backups')).body[0]).toMatchObject({ id: first.body.id, status: 'done' });
  });
});

describe('fila: desligamento gracioso (DAD-1)', () => {
  it('espera o job em andamento terminar', async () => {
    const q = new JobQueue(env.ctx.db, { concurrency: 2 });
    q.register('teste.rapido', async () => {
      await sleep(150);
      return { ok: 1 };
    });
    const job = await q.enqueue('teste.rapido', {});
    q.start(20);
    await waitFor(() => q.running === 1);
    expect(await q.stop({ timeoutMs: 5000 })).toEqual({ finished: 1, released: 0 });
    expect((await jobById(job.id)).status).toBe('done');
  });

  it('devolve à fila, sem gastar tentativa, o job que não termina no prazo', async () => {
    const q = new JobQueue(env.ctx.db, { concurrency: 2 });
    const g = gate();
    q.register('teste.travado', async () => {
      await g.promise;
      return { by: 'interrompido' };
    });
    const job = await q.enqueue('teste.travado', {}, { maxAttempts: 1 });
    q.start(20);
    await waitFor(() => q.running === 1);
    expect(await q.stop({ timeoutMs: 100 })).toEqual({ finished: 0, released: 1 });
    expect(await jobById(job.id)).toMatchObject({ status: 'queued', attempts: 1, maxAttempts: 2, lockedAt: null });
    // o executor antigo termina depois, mas não é mais dono do job
    g.open();
    await sleep(50);
    expect((await jobById(job.id)).status).toBe('queued');
    // outro processo retoma na hora e conclui
    const next = new JobQueue(env.ctx.db);
    next.register('teste.travado', async () => ({ by: 'retomado' }));
    await next.drain();
    expect(await jobById(job.id)).toMatchObject({ status: 'done', attempts: 2, result: { by: 'retomado' } });
  });
});

describe('fila: concorrência e justiça entre escritórios (DAD-2)', () => {
  it('JOB_CONCURRENCY e JOB_OFFICE_CONCURRENCY vêm da configuração', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', JOB_CONCURRENCY: '6', JOB_OFFICE_CONCURRENCY: '2', JOB_LEASE_SECONDS: '120' });
    expect(cfg).toMatchObject({ JOB_CONCURRENCY: 6, JOB_OFFICE_CONCURRENCY: 2, JOB_LEASE_SECONDS: 120 });
    const defaults = loadConfig({ NODE_ENV: 'test' });
    expect(defaults).toMatchObject({ JOB_CONCURRENCY: 4, JOB_LEASE_SECONDS: 300, SHUTDOWN_TIMEOUT_SECONDS: 25 });
    expect(defaults.JOB_OFFICE_CONCURRENCY).toBeUndefined();
    // vazio no .env conta como não informado
    expect(loadConfig({ NODE_ENV: 'test', JOB_OFFICE_CONCURRENCY: '', JOB_CONCURRENCY: '' })).toMatchObject({ JOB_CONCURRENCY: 4 });
    expect(() => loadConfig({ NODE_ENV: 'test', JOB_CONCURRENCY: '0' })).toThrow();
    const q = new JobQueue(env.ctx.db, { concurrency: 6 });
    expect([q.concurrency, q.officeConcurrency]).toEqual([6, 5]);
    expect(new JobQueue(env.ctx.db, { concurrency: 1 }).officeConcurrency).toBe(1);
  });

  it('executa até JOB_CONCURRENCY jobs ao mesmo tempo', async () => {
    const q = new JobQueue(env.ctx.db, { concurrency: 3 });
    let now = 0;
    let peak = 0;
    q.register('teste.paralelo', async () => {
      now++;
      peak = Math.max(peak, now);
      await sleep(120);
      now--;
    });
    const list = await Promise.all(Array.from({ length: 7 }, () => q.enqueue('teste.paralelo', {})));
    q.start(20);
    await waitFor(async () => (await Promise.all(list.map((j) => jobById(j.id)))).every((j) => j.status === 'done'), 10_000);
    await q.stop();
    expect(peak).toBe(3);
  });

  it('um escritório com muitos jobs não ocupa todas as vagas: o job de outro escritório entra', async () => {
    const [a, b] = [await newOffice(), await newOffice()];
    const q = new JobQueue(env.ctx.db, { concurrency: 3 }); // no máximo 2 por escritório
    const g = gate();
    const ran: string[] = [];
    q.register('teste.pesado', async (job) => {
      ran.push(String(job.officeId));
      await g.promise;
    });
    q.register('teste.envio', async (job) => {
      ran.push(`envio:${job.officeId}`);
    });
    for (let i = 0; i < 6; i++) await q.enqueue('teste.pesado', {}, { officeId: a });
    q.start(20);
    await waitFor(() => q.running === 2);
    await sleep(100);
    expect(q.running).toBe(2); // a terceira vaga fica para os outros escritórios
    await q.enqueue('teste.envio', {}, { officeId: b });
    await waitFor(() => ran.includes(`envio:${b}`));
    expect(ran.filter((x) => x === a)).toHaveLength(2);
    g.open();
    await waitFor(async () => (await env.ctx.db.select().from(jobs)).every((j) => j.status === 'done'), 10_000);
    await q.stop();
  });

  it('jobs de vários escritórios se revezam, mesmo com um só executor', async () => {
    const [a, b, c] = [await newOffice(), await newOffice(), await newOffice()];
    const q = new JobQueue(env.ctx.db, { concurrency: 1 });
    const order: string[] = [];
    const names = new Map([
      [a, 'A'],
      [b, 'B'],
      [c, 'C'],
    ]);
    q.register('teste.mala', async (job: JobRow) => {
      order.push(names.get(job.officeId!)!);
    });
    // a mala direta do escritório A entra antes; B e C pedem um envio depois
    for (let i = 0; i < 5; i++) await q.enqueue('teste.mala', {}, { officeId: a });
    await q.enqueue('teste.mala', {}, { officeId: b });
    await q.enqueue('teste.mala', {}, { officeId: c });
    await q.drain();
    expect(order).toEqual(['A', 'B', 'C', 'A', 'A', 'A', 'A']);
  });
});

describe('fila: repetição e chave de idempotência (DAD-4, parte da fila)', () => {
  it('um job que falhou de vez pode ser reenfileirado com a mesma chave', async () => {
    const q = new JobQueue(env.ctx.db);
    let fail = true;
    let calls = 0;
    q.register('teste.cobranca', async () => {
      calls++;
      if (fail) throw new Error('Integração não configurada');
      return { ok: true };
    });
    const first = await q.enqueue('teste.cobranca', { v: 1 }, { idempotencyKey: 'billing-1', maxAttempts: 1 });
    await q.drain();
    expect(await jobById(first.id)).toMatchObject({ status: 'failed', error: 'Integração não configurada' });

    fail = false;
    const again = await q.enqueue('teste.cobranca', { v: 2 }, { idempotencyKey: 'billing-1', maxAttempts: 1 });
    expect(again).toMatchObject({ id: first.id, status: 'queued', attempts: 0, payload: { v: 2 }, error: null });
    await q.drain();
    expect(await jobById(first.id)).toMatchObject({ status: 'done', result: { ok: true } });
    // concluído não roda de novo
    expect((await q.enqueue('teste.cobranca', {}, { idempotencyKey: 'billing-1' })).status).toBe('done');
    await q.drain();
    expect(calls).toBe(2);
  });

  it('chamadas simultâneas com a mesma chave criam um job só', async () => {
    const q = new JobQueue(env.ctx.db);
    const list = await Promise.all(Array.from({ length: 4 }, () => q.enqueue('teste.unico', {}, { idempotencyKey: 'mesma-chave' })));
    expect(new Set(list.map((j) => j.id)).size).toBe(1);
    expect(await env.ctx.db.select().from(jobs).where(eq(jobs.type, 'teste.unico'))).toHaveLength(1);
  });

  it('serviços externos repetem com espera crescente até 12 h; o padrão continua curto', async () => {
    expect([1, 2, 3, 4, 5, 9, 12].map((n) => EXTERNAL_SERVICE_RETRY.backoffMs(n) / 60_000)).toEqual([1, 5, 15, 30, 60, 720, 720]);
    expect(EXTERNAL_SERVICE_RETRY.maxAttempts).toBe(10);
    expect([1, 2, 3].map((n) => DEFAULT_RETRY.backoffMs(n))).toEqual([10_000, 20_000, 40_000]);
    expect(DEFAULT_RETRY.backoffMs(20)).toBe(10 * 60_000);

    // e-mail, mala direta e cobrança integrada usam a política longa (sem mudar quem enfileira)
    const office = await newOffice();
    for (const type of ['delivery.send', 'mailing.deliver', 'billing.sync_external']) {
      expect((await env.ctx.jobs.enqueue(type, {}, { officeId: office })).maxAttempts).toBe(10);
    }
    expect((await env.ctx.jobs.enqueue('backup.generate', {}, { officeId: office })).maxAttempts).toBe(3);
    await env.ctx.db.delete(jobs);

    // queda do provedor: a cobrança volta em 1 min, não em 10 s
    const q = new JobQueue(env.ctx.db);
    q.register('billing.sync_external', async () => {
      throw new Error('Asaas fora do ar');
    });
    const job = await q.enqueue('billing.sync_external', {}, { officeId: office });
    const before = Date.now();
    await q.drain();
    const after = await jobById(job.id);
    expect(after).toMatchObject({ status: 'queued', attempts: 1, error: 'Asaas fora do ar' });
    expect(after.runAt.getTime() - before).toBeGreaterThanOrEqual(59_000);
  });
});
