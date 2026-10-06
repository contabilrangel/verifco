import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { deliveries, jobs } from '../src/db/schema';
import { INTERRUPTED_ERROR, JOB_PRIORITY, JobQueue, PermanentJobError, WAIT_FOR_CHILDREN, isJobActive, steppedBackoff } from '../src/jobs/queue';
import { queueDelivery } from '../src/services/delivery';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { fakePdf, multipart, send } from './robot-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const getJob = async (id: string) => (await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, id) }))!;
/** Simula o processo que pegou o job e caiu: "em execução" com o lease vencido há uma hora. */
const abandon = (id: string, attempts: number) =>
  env.ctx.db
    .update(jobs)
    .set({ status: 'running', attempts, lockedAt: new Date(Date.now() - 3600_000) })
    .where(eq(jobs.id, id));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error('tempo esgotado esperando a condição');
}
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
let seq = 0;
/** Tipo exclusivo do teste: a fila de teste só pega o que ela mesma sabe executar. */
const testType = (name: string) => `teste.${name}.${++seq}`;

describe('fila: lease, parada e retomada (DAD-1)', () => {
  it('retoma o job de um processo que caiu depois do lease; sem tentativas, falha e avisa', async () => {
    const type = testType('lease');
    const q = new JobQueue(env.ctx.db);
    const failures: string[] = [];
    let calls = 0;
    q.register(
      type,
      async () => {
        calls++;
        return { ok: true };
      },
      { onFailed: (_job, error) => void failures.push(error) },
    );
    const a = await q.enqueue(type, {}, { maxAttempts: 2 });
    // dentro do lease ninguém pega: o processo pode estar vivo
    await env.ctx.db.update(jobs).set({ status: 'running', attempts: 1, lockedAt: new Date() }).where(eq(jobs.id, a.id));
    expect(await q.runNext()).toBe(false);
    expect(isJobActive(await getJob(a.id))).toBe(true);
    // lease vencido: outro worker retoma, contando a tentativa
    await abandon(a.id, 1);
    expect(isJobActive(await getJob(a.id))).toBe(true);
    expect(await q.runNext()).toBe(true);
    expect(await getJob(a.id)).toMatchObject({ status: 'done', attempts: 2 });

    // caiu na última tentativa: falha de vez (e chama o aviso da falha final)
    const b = await q.enqueue(type, {}, { maxAttempts: 2 });
    await abandon(b.id, 2);
    expect(isJobActive(await getJob(b.id))).toBe(false);
    expect(await q.runNext()).toBe(false);
    expect(await getJob(b.id)).toMatchObject({ status: 'failed', error: INTERRUPTED_ERROR });
    expect(failures).toEqual([INTERRUPTED_ERROR]);
    expect(calls).toBe(1);
  });

  it('heartbeat renova o lease; a rodada que outro worker retomou não é sobrescrita', async () => {
    const type = testType('heartbeat');
    const q = new JobQueue(env.ctx.db, { heartbeatMs: 20 });
    const gate = deferred<Record<string, unknown>>();
    q.register(type, () => gate.promise);
    const job = await q.enqueue(type, {});
    const run = q.runNext();
    await waitFor(async () => (await getJob(job.id)).status === 'running');
    const first = (await getJob(job.id)).lockedAt!.getTime();
    await waitFor(async () => (await getJob(job.id)).lockedAt!.getTime() > first);

    // outro worker assumiu a rodada seguinte (lease vencido): a antiga não grava mais nada
    await env.ctx.db.update(jobs).set({ attempts: 2, lockedAt: new Date(), lockToken: randomUUID() }).where(eq(jobs.id, job.id));
    gate.resolve({ antiga: true });
    await run;
    expect(await getJob(job.id)).toMatchObject({ status: 'running', attempts: 2, result: null });
  });

  it('stop() espera o job em andamento e não pega outro', async () => {
    const type = testType('stop');
    const q = new JobQueue(env.ctx.db, { concurrency: 1 });
    const gate = deferred();
    let started = 0;
    q.register(type, async () => {
      started++;
      await gate.promise;
      return { ok: true };
    });
    const a = await q.enqueue(type, {});
    q.start(10);
    await waitFor(() => started === 1);
    const b = await q.enqueue(type, {});
    let stopped = false;
    const stopping = q.stop().then(() => (stopped = true));
    await sleep(60);
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect((await getJob(a.id)).status).toBe('done');
    expect((await getJob(b.id)).status).toBe('queued');
    expect(started).toBe(1);
  });

  it('stop() com prazo devolve à fila o job que não terminou', async () => {
    const type = testType('prazo');
    const q = new JobQueue(env.ctx.db);
    const gate = deferred<Record<string, unknown>>();
    q.register(type, () => gate.promise);
    const a = await q.enqueue(type, {});
    q.start(10);
    await waitFor(async () => (await getJob(a.id)).status === 'running');
    await q.stop({ graceMs: 30 });
    expect(await getJob(a.id)).toMatchObject({ status: 'queued', lockedAt: null, attempts: 1 });
    // a execução que ficou para trás termina sem gravar por cima
    gate.resolve({ tarde: true });
    await sleep(30);
    expect(await getJob(a.id)).toMatchObject({ status: 'queued', result: null });
  });

  it('backup de processo que caiu é retomado e um novo pedido não fica "em andamento" para sempre', async () => {
    const o = await registerOffice(env);
    const first = await o.api.post('/api/backups');
    expect(first.status).toBe(202);
    // caiu na 1ª de 2 tentativas: a fila vai retomar, então o pedido repetido não duplica
    await abandon(first.body.id, 1);
    expect((await o.api.post('/api/backups')).body).toMatchObject({ id: first.body.id, alreadyRunning: true });
    await env.ctx.jobs.drain();
    expect(await getJob(first.body.id)).toMatchObject({ status: 'done', attempts: 2 });

    // caiu na última tentativa: o próximo pedido gera outro backup
    const second = await o.api.post('/api/backups');
    expect(second.body.alreadyRunning).toBe(false);
    await abandon(second.body.id, 2);
    const third = await o.api.post('/api/backups');
    expect(third.status).toBe(202);
    expect(third.body).toMatchObject({ alreadyRunning: false });
    expect(third.body.id).not.toBe(second.body.id);
    await env.ctx.jobs.drain();
    expect(await getJob(second.body.id)).toMatchObject({ status: 'failed', error: INTERRUPTED_ERROR });
    expect((await getJob(third.body.id)).status).toBe('done');
  });

  it('Radar e sincronização do eCAC: job abandonado sem tentativas não bloqueia novo pedido', async () => {
    const o = await registerOffice(env);
    const radar = await o.api.post('/api/radar/refresh', { year: 2026 });
    await abandon(radar.body.job.id, 2);
    const again = await o.api.post('/api/radar/refresh', { year: 2026 });
    expect(again.status).toBe(202);
    expect(again.body.alreadyRunning).toBe(false);

    const c = await o.api.post('/api/customers', { name: 'Rui Eca', cpfCnpj: VALID_CPFS[2] });
    const sync = await o.api.post(`/api/customers/${c.body.id}/ecac/sync`);
    // 1 tentativa só: abandonado, deixa de contar como pendente
    await abandon(sync.body.job.id, 1);
    const retry = await o.api.post(`/api/customers/${c.body.id}/ecac/sync`);
    expect(retry.status).toBe(202);
    expect(retry.body.alreadyQueued).toBe(false);
    const office = await o.api.post('/api/robot/sync-office');
    await abandon(office.body.job.id, 1);
    expect((await o.api.post('/api/robot/sync-office')).body.alreadyQueued).toBe(false);
    await env.ctx.jobs.drain();
  });

  it('envio parado na fila: o job interrompido vira falha; sem job ativo, pode ser reenviado', async () => {
    const o = await registerOffice(env);
    const c = await o.api.post('/api/customers', { name: 'Lia Envio', cpfCnpj: VALID_CPFS[1], email: 'lia@cliente.com' });
    const queue = () => queueDelivery(env.ctx, { officeId: o.officeId, customerId: c.body.id, channel: 'email', subject: 'Aviso', body: '<p>Olá</p>' });
    const sendJob = async (deliveryId: string) => (await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'delivery.send'), eq(jobs.idempotencyKey, deliveryId)) }))!;

    // o processo caiu na última tentativa do envio
    const d1 = await queue();
    const j1 = await sendJob(d1.id);
    await abandon(j1.id, j1.maxAttempts);
    await env.ctx.jobs.drain();
    expect((await o.api.get(`/api/deliveries/${d1.id}`)).body).toMatchObject({ status: 'failed', error: INTERRUPTED_ERROR, canResend: true });
    expect((await o.api.post(`/api/deliveries/${d1.id}/resend`)).status).toBe(200);
    await env.ctx.jobs.drain();
    expect((await o.api.get(`/api/deliveries/${d1.id}`)).body.status).toBe('sent');
    // o reenvio reabriu o job do próprio envio, sem criar outro
    expect(await env.ctx.db.select().from(jobs).where(and(eq(jobs.type, 'delivery.send'), eq(jobs.officeId, o.officeId)))).toHaveLength(1);

    // envio gravado sem job (o processo caiu entre gravar e enfileirar)
    const d2 = await queue();
    await env.ctx.db.delete(jobs).where(eq(jobs.id, (await sendJob(d2.id)).id));
    expect((await o.api.get(`/api/deliveries/${d2.id}`)).body).toMatchObject({ status: 'queued', canResend: true });
    expect((await o.api.post(`/api/deliveries/${d2.id}/resend`)).status).toBe(200);
    expect((await o.api.post(`/api/deliveries/${d2.id}/resend`)).status).toBe(409);
    await env.ctx.jobs.drain();
    expect((await o.api.get(`/api/deliveries/${d2.id}`)).body.status).toBe('sent');

    // na fila com job ativo: vai sair, não há o que reenviar
    const d3 = await queue();
    expect((await o.api.get(`/api/deliveries/${d3.id}`)).body.canResend).toBe(false);
    expect((await o.api.post(`/api/deliveries/${d3.id}/resend`)).status).toBe(409);
    await env.ctx.jobs.drain();
  });
});

describe('fila: prioridade, limites e concorrência (DAD-2)', () => {
  it('claim: prioridade primeiro e limite por escritório do tipo', async () => {
    const a = await registerOffice(env);
    const b = await registerOffice(env);
    const heavy = testType('pesado');
    const light = testType('envio');
    const q = new JobQueue(env.ctx.db, { policies: { [heavy]: { priority: JOB_PRIORITY.low, perOffice: 1 }, [light]: { priority: JOB_PRIORITY.high } } });
    const order: string[] = [];
    q.register(heavy, async (job) => void order.push(String(job.payload.n)));
    q.register(light, async (job) => void order.push(String(job.payload.n)));

    const a1 = await q.enqueue(heavy, { n: 'a1' }, { officeId: a.officeId });
    await q.enqueue(heavy, { n: 'a2' }, { officeId: a.officeId });
    await q.enqueue(heavy, { n: 'b1' }, { officeId: b.officeId });
    await q.enqueue(light, { n: 'envio' }, { officeId: a.officeId });
    expect((await getJob(a1.id)).priority).toBe(JOB_PRIORITY.low);

    // o envio passa na frente das tarefas longas, mesmo enfileirado por último
    await q.runNext();
    expect(order).toEqual(['envio']);
    // a1 em execução em outro worker: a2 (mesmo escritório) espera e b1 sai antes
    await env.ctx.db.update(jobs).set({ status: 'running', attempts: 1, lockedAt: new Date() }).where(eq(jobs.id, a1.id));
    await q.runNext();
    expect(order).toEqual(['envio', 'b1']);
    expect(await q.runNext()).toBe(false);
    await env.ctx.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, a1.id));
    await q.drain();
    expect(order).toEqual(['envio', 'b1', 'a2']);
  });

  it('executa em paralelo, a tarefa longa não ocupa a última vaga e só pega tipos conhecidos', async () => {
    const heavy = testType('longo');
    const light = testType('rapido');
    const unknown = testType('outro');
    const q = new JobQueue(env.ctx.db, { concurrency: 2, policies: { [heavy]: { heavy: true } } });
    const gate = deferred();
    let heavyStarted = 0;
    q.register(heavy, async () => {
      heavyStarted++;
      await gate.promise;
      return {};
    });
    q.register(light, async () => ({}));
    const h1 = await q.enqueue(heavy, {});
    const h2 = await q.enqueue(heavy, {});
    const l1 = await q.enqueue(light, {});
    const other = await q.enqueue(unknown, {});
    q.start(10);
    // com 2 vagas: uma tarefa longa e o envio rodam juntos; a 2ª longa espera a vaga reservada
    await waitFor(async () => (await getJob(l1.id)).status === 'done');
    expect(heavyStarted).toBe(1);
    expect((await getJob(h2.id)).status).toBe('queued');
    gate.resolve();
    await waitFor(async () => (await getJob(h2.id)).status === 'done');
    await q.stop();
    expect((await getJob(h1.id)).status).toBe('done');
    // sem executor neste processo: fica para quem souber executar
    expect((await getJob(other.id)).status).toBe('queued');
  });

  it('fan-out: o pai espera sem ocupar o worker e junta os resultados dos filhos', async () => {
    const parent = testType('pai');
    const child = testType('filho');
    const q = new JobQueue(env.ctx.db);
    q.register(parent, async (job, { spawn, children }) => {
      const kids = await children();
      if (!kids.length) {
        await spawn([1, 2, 3].map((n) => ({ type: child, payload: { n }, idempotencyKey: `${job.id}:${n}` })));
        return WAIT_FOR_CHILDREN;
      }
      return { total: kids.reduce((s, k) => s + Number(k.result?.n ?? 0), 0) };
    });
    q.register(child, async (job) => ({ n: job.payload.n }));
    const p = await q.enqueue(parent, {});
    await q.runNext();
    const waiting = await getJob(p.id);
    expect(waiting).toMatchObject({ status: 'running', lockedAt: null });
    expect(isJobActive(waiting)).toBe(true);
    expect(await env.ctx.db.select().from(jobs).where(eq(jobs.parentId, p.id))).toHaveLength(3);
    await q.runNext();
    expect((await getJob(p.id)).progress).toBe(33);
    await q.drain();
    expect(await getJob(p.id)).toMatchObject({ status: 'done', progress: 100, result: { total: 6 } });
  });

  it('elaboração em lote: um job por cliente e o lote com o total', async () => {
    const o = await registerOffice(env);
    const tok = (await o.api.post('/api/robot/tokens', { name: 'Sync', scope: 'sync' })).body.token as string;
    const ids: string[] = [];
    for (const i of [4, 5]) {
      const c = await o.api.post('/api/customers', { name: `Cliente ${i}`, cpfCnpj: VALID_CPFS[i] });
      ids.push(c.body.id);
      await send(env, tok, 'POST', '/api/sync/files', { multipart: multipart({ cpf: VALID_CPFS[i], ano: '2026' }, { name: `informe-${i}.pdf`, content: fakePdf(`i${i}`), type: 'application/pdf' }) });
    }
    const informe = JSON.stringify({ items: [{ kind: 'income_pj', counterpartyDoc: '11.222.333/0001-81', counterpartyName: 'Empresa', valueCents: 100_000, withheldCents: 0 }], notes: null });
    env.providers.aiReplies.push(informe, informe);
    const proc = await o.api.post('/api/elaboration/process', { year: 2026, customerIds: ids });
    expect(proc.status).toBe(202);
    await env.ctx.jobs.runNext();
    const kids = await env.ctx.db.select().from(jobs).where(eq(jobs.parentId, proc.body.job.id));
    expect(kids.map((k) => k.type)).toEqual(['elaboration.process_customer', 'elaboration.process_customer']);
    expect(kids.every((k) => k.priority === JOB_PRIORITY.low)).toBe(true);
    expect((await o.api.get('/api/elaboration/jobs')).body[0]).toMatchObject({ id: proc.body.job.id, status: 'running' });
    await env.ctx.jobs.drain();
    const done = (await o.api.get('/api/elaboration/jobs')).body[0];
    expect(done).toMatchObject({ id: proc.body.job.id, status: 'done', progress: 100 });
    expect(done.result).toMatchObject({ declarations: 2, processed: 2, failed: 0 });
  });
});

describe('fila: nova tentativa (DAD-4)', () => {
  it('reabre pela mesma chave o job que falhou; concluído não repete; retryNow reabre', async () => {
    const type = testType('chave');
    const q = new JobQueue(env.ctx.db);
    let fail = true;
    let calls = 0;
    q.register(type, async () => {
      calls++;
      if (fail) throw new Error('fora do ar');
      return { ok: true };
    });
    const first = await q.enqueue(type, { x: 1 }, { idempotencyKey: 'chave-1', maxAttempts: 1 });
    await q.runNext();
    expect(await getJob(first.id)).toMatchObject({ status: 'failed', error: 'fora do ar', attempts: 1 });
    fail = false;
    const again = await q.enqueue(type, { x: 1 }, { idempotencyKey: 'chave-1', maxAttempts: 1 });
    expect(again).toMatchObject({ id: first.id, status: 'queued', attempts: 0, error: null });
    await q.runNext();
    expect(await getJob(first.id)).toMatchObject({ status: 'done', attempts: 1 });
    // concluído: enfileirar de novo não repete
    expect((await q.enqueue(type, { x: 1 }, { idempotencyKey: 'chave-1' })).status).toBe('done');
    expect(await q.runNext()).toBe(false);
    // pedido explícito ("Emitir novamente"): reabre o mesmo job, com o payload original
    await q.retryNow(type, [{ idempotencyKey: 'chave-1', payload: { x: 2 } }]);
    expect(await getJob(first.id)).toMatchObject({ status: 'queued', payload: { x: 1 } });
    await q.runNext();
    expect(calls).toBe(3);
    expect(await env.ctx.db.select().from(jobs).where(and(eq(jobs.type, type), eq(jobs.idempotencyKey, 'chave-1')))).toHaveLength(1);
    // abandonado por um processo que caiu (lease vencido): o pedido explícito também o reabre
    await abandon(first.id, 1);
    await q.retryNow(type, [{ idempotencyKey: 'chave-1', payload: {} }]);
    expect(await getJob(first.id)).toMatchObject({ status: 'queued', attempts: 0, lockedAt: null, lockToken: null });
    await q.runNext();
    expect(await getJob(first.id)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('erro permanente não repete e avisa; a espera entre tentativas tem teto', async () => {
    const type = testType('permanente');
    const q = new JobQueue(env.ctx.db, { policies: { [type]: { maxAttempts: 5, backoff: steppedBackoff([60_000, 300_000]) } } });
    const failures: string[] = [];
    let permanent = false;
    q.register(
      type,
      async () => {
        throw permanent ? new PermanentJobError('Credenciais recusadas') : new Error('instável');
      },
      { onFailed: (_job, error) => void failures.push(error) },
    );
    const job = await q.enqueue(type, {});
    expect(job.maxAttempts).toBe(5);
    await q.runNext();
    const retry = await getJob(job.id);
    expect(retry).toMatchObject({ status: 'queued', attempts: 1, error: 'instável' });
    expect(retry.runAt.getTime() - Date.now()).toBeGreaterThan(50_000);
    expect(failures).toEqual([]);
    permanent = true;
    await env.ctx.db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, job.id));
    await q.runNext();
    expect(await getJob(job.id)).toMatchObject({ status: 'failed', attempts: 2, error: 'Credenciais recusadas' });
    expect(failures).toEqual(['Credenciais recusadas']);
    const wait = steppedBackoff([60_000, 300_000, 1_800_000]);
    expect([wait(1), wait(2), wait(3), wait(9)]).toEqual([60_000, 300_000, 1_800_000, 1_800_000]);
  });

  it('reenvio em massa: só os envios que falharam no escritório e dentro dos filtros', async () => {
    const a = await registerOffice(env);
    const b = await registerOffice(env);
    const customer = async (o: typeof a, i: number) =>
      (await o.api.post('/api/customers', { name: `Cliente Massa ${i}`, cpfCnpj: VALID_CPFS[i], email: `massa${i}@cliente.com` })).body.id as string;
    const failDelivery = async (o: typeof a, customerId: string, channel: 'email' | 'whatsapp' = 'email') => {
      const d = await queueDelivery(env.ctx, { officeId: o.officeId, customerId, channel, to: channel === 'whatsapp' ? '5511987654321' : undefined, subject: 'Mala', body: '<p>Oi</p>' });
      await env.ctx.db.update(deliveries).set({ status: 'failed', error: 'Caixa cheia' }).where(eq(deliveries.id, d.id));
      await env.ctx.db
        .update(jobs)
        .set({ status: 'failed', error: 'Caixa cheia', attempts: 3, finishedAt: new Date() })
        .where(and(eq(jobs.type, 'delivery.send'), eq(jobs.idempotencyKey, d.id)));
      return d.id;
    };
    const ca = await customer(a, 3);
    const emailA = await failDelivery(a, ca);
    const waA = await failDelivery(a, ca, 'whatsapp');
    const emailB = await failDelivery(b, await customer(b, 3));
    expect((await a.api.get('/api/deliveries')).body.failedCount).toBe(2);

    // sem permissão de envio: não reenvia
    const viewer = await createEmployee(env, a.api, ['mailing.list']);
    expect((await viewer.api.post('/api/deliveries/resend-failed', {})).status).toBe(403);

    // só os de e-mail (filtro da lista)
    expect((await a.api.post('/api/deliveries/resend-failed', { channel: 'email' })).body).toEqual({ queued: 1 });
    expect((await a.api.get(`/api/deliveries/${emailA}`)).body.status).toBe('queued');
    expect((await a.api.get(`/api/deliveries/${waA}`)).body.status).toBe('failed');
    expect((await a.api.get('/api/deliveries?status=sent')).body.failedCount).toBe(1);
    expect((await a.api.post('/api/deliveries/resend-failed', {})).body).toEqual({ queued: 1 });
    // repetir não reenvia de novo (já estão na fila)
    expect((await a.api.post('/api/deliveries/resend-failed', {})).body).toEqual({ queued: 0 });
    await env.ctx.jobs.drain();
    expect((await a.api.get(`/api/deliveries/${emailA}`)).body.status).toBe('sent');
    expect((await a.api.get(`/api/deliveries/${waA}`)).body.status).toBe('sent');
    expect(env.providers.sentEmails.filter((m) => m.to === 'massa3@cliente.com' && m.officeId === a.officeId)).toHaveLength(1);
    // o outro escritório fica como estava
    expect((await b.api.get(`/api/deliveries/${emailB}`)).body.status).toBe('failed');
    expect((await b.api.get('/api/deliveries')).body.failedCount).toBe(1);
  });
});
