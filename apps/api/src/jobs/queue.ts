import { and, eq, gt, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs } from '../db/schema';

export type JobRow = typeof jobs.$inferSelect;

/**
 * Devolvido pelo executor que criou filhos com `spawn`: o job sai do worker e espera todos os
 * filhos terminarem; aí a fila o executa de novo (com `children()` preenchido) para juntar os resultados.
 */
export const WAIT_FOR_CHILDREN = Symbol('jobs.waitForChildren');

export interface ChildJob {
  type: string;
  payload: Record<string, unknown>;
  /** Única por filho (ex.: `<id do pai>:<cliente>`): repetir o fan-out não duplica. */
  idempotencyKey: string;
  maxAttempts?: number;
  priority?: number;
}

export interface JobHelpers {
  /** Progresso de 0 a 100 (também renova o lease). */
  progress: (pct: number) => Promise<void>;
  /** Fan-out: cria todos os filhos de uma vez (numa transação; chame uma vez só). */
  spawn: (children: ChildJob[]) => Promise<void>;
  /** Filhos já criados por este job. */
  children: () => Promise<JobRow[]>;
}

export type JobHandler = (job: JobRow, helpers: JobHelpers) => Promise<Record<string, unknown> | void | typeof WAIT_FOR_CHILDREN>;

/** Prioridades usuais (maior sai primeiro). */
export const JOB_PRIORITY = { high: 10, normal: 0, low: -10 } as const;

export interface JobTypeOptions {
  /** Ordem na fila (padrão 0; veja `JOB_PRIORITY`). */
  priority?: number;
  /** Máximo deste tipo em execução ao mesmo tempo no mesmo escritório. */
  perOffice?: number;
  /** Tarefa longa: nunca ocupa a última vaga do worker, que fica para envios e cobranças. */
  heavy?: boolean;
  /** Tentativas quando quem enfileira não informa (padrão 3). */
  maxAttempts?: number;
  /** Espera (ms) antes da próxima tentativa, pelo número da tentativa que falhou (1, 2...). */
  backoff?: (attempt: number) => number;
  /** Chamado uma vez quando o job falha de vez (tentativas esgotadas, erro permanente ou interrompido). */
  onFailed?: (job: JobRow, error: string) => Promise<void> | void;
}

export interface EnqueueOptions {
  officeId?: string | null;
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
  priority?: number;
  userId?: string | null;
}

/**
 * Erro que não se resolve repetindo (credencial recusada, integração desligada, dado inválido):
 * o job falha na hora, sem novas tentativas.
 */
export class PermanentJobError extends Error {
  readonly permanent = true;
}

/**
 * Sem renovação (heartbeat) por este tempo, o job "em execução" é considerado abandonado (o
 * processo caiu ou foi reiniciado): volta para a fila, contando a tentativa, ou falha se acabaram.
 */
export const JOB_LEASE_MS = 5 * 60_000;
const HEARTBEAT_MS = 30_000;
const SWEEP_EVERY_MS = 30_000;
export const INTERRUPTED_ERROR = 'A tarefa foi interrompida (o servidor reiniciou ou parou de responder) e as tentativas acabaram.';

/** Padrão: 10 s, 20 s, 40 s... até 1 hora. */
const defaultBackoff = (attempt: number) => Math.min(2 ** attempt * 5000, 3600_000);
/** Esperas em degraus; depois do último, repete o último (o teto). */
export const steppedBackoff = (steps: number[]) => (attempt: number) => steps[Math.min(Math.max(attempt, 1), steps.length) - 1];

/**
 * Job que a fila ainda vai executar: na fila, em execução dentro do lease, esperando os filhos ou
 * abandonado com tentativas sobrando (será retomado). Use nas deduplicações ("já em andamento"):
 * um job abandonado sem tentativas não segura mais nada.
 */
export function isJobActive(job: Pick<JobRow, 'status' | 'lockedAt' | 'attempts' | 'maxAttempts'>, now = Date.now()) {
  if (job.status === 'queued') return true;
  if (job.status !== 'running') return false;
  return !job.lockedAt || job.lockedAt.getTime() > now - JOB_LEASE_MS || job.attempts < job.maxAttempts;
}

/** `isJobActive` em SQL, para filtrar consultas na tabela `jobs`. */
export function activeJob(): SQL {
  return sql`(${jobs.status} = 'queued' or (${jobs.status} = 'running' and (${jobs.lockedAt} is null or ${jobs.lockedAt} > now() - (${JOB_LEASE_MS}::int * interval '1 millisecond') or ${jobs.attempts} < ${jobs.maxAttempts})))`;
}

const isPermanent = (err: unknown) => err instanceof PermanentJobError || (typeof err === 'object' && err !== null && (err as { permanent?: unknown }).permanent === true);
/** Cerca da rodada: só quem fez este claim (token) grava; se outro worker retomou o job, nada muda. */
const ownRound = (job: JobRow): SQL => (job.lockToken ? and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.lockToken, job.lockToken))! : sql`false`);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const clampPct = (pct: number) => Math.max(0, Math.min(100, Math.round(pct)));

interface Running {
  job: JobRow;
  heavy: boolean;
  done: Promise<void>;
}

/**
 * Fila de tarefas guardada no próprio PostgreSQL.
 * Envio de e-mail/WhatsApp, exportações, análises de IA e sincronizações passam por aqui,
 * com repetição automática e chave de idempotência para não duplicar envios.
 *
 * - Cada processo executa até `concurrency` jobs ao mesmo tempo; o claim respeita a prioridade e
 *   o limite por escritório de cada tipo, e as tarefas longas nunca ocupam a última vaga.
 * - Lease: o job em execução renova `locked_at` (heartbeat e `progress`); se o processo cai, outro
 *   worker retoma o job quando o lease vence. Só quem tem a rodada atual (`lock_token`) grava o resultado.
 * - `stop()` para de pegar jobs e espera os que estão rodando; no prazo esgotado, devolve-os à fila.
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private types = new Map<string, JobTypeOptions>();
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private filling: Promise<void> | null = null;
  private refill = false;
  private lastSweep = 0;
  private running = new Map<string, Running>();

  constructor(
    private db: Db,
    opts: { concurrency?: number; leaseMs?: number; heartbeatMs?: number; policies?: Record<string, JobTypeOptions> } = {},
  ) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
    this.leaseMs = opts.leaseMs ?? JOB_LEASE_MS;
    this.heartbeatMs = opts.heartbeatMs ?? Math.min(HEARTBEAT_MS, Math.floor(this.leaseMs / 4));
    for (const [type, options] of Object.entries(opts.policies ?? {})) this.configure(type, options);
  }

  register(type: string, handler: JobHandler, options?: JobTypeOptions) {
    this.handlers.set(type, handler);
    if (options) this.configure(type, options);
  }

  /** Prioridade, limites e tentativas do tipo (somados ao que já estava configurado). */
  configure(type: string, options: JobTypeOptions) {
    this.types.set(type, { ...this.types.get(type), ...options });
  }

  private rowValues(type: string, payload: Record<string, unknown>, opts: EnqueueOptions) {
    const policy = this.types.get(type) ?? {};
    return {
      type,
      payload,
      officeId: opts.officeId ?? null,
      runAt: opts.runAt ?? new Date(),
      idempotencyKey: opts.idempotencyKey ?? null,
      maxAttempts: opts.maxAttempts ?? policy.maxAttempts ?? 3,
      priority: opts.priority ?? policy.priority ?? 0,
      createdByUserId: opts.userId ?? null,
    };
  }

  /**
   * Enfileira. Com `idempotencyKey`, repetir devolve o job existente; se ele falhou de vez, é
   * reaberto (nova rodada de tentativas, mesmo payload).
   */
  async enqueue(type: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<JobRow> {
    const values = this.rowValues(type, payload, opts);
    if (!opts.idempotencyKey) {
      const [row] = await this.db.insert(jobs).values(values).returning();
      return row;
    }
    const [row] = await this.db.insert(jobs).values(values).onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] }).returning();
    if (row) return row;
    const existing = await this.db.query.jobs.findFirst({ where: and(eq(jobs.type, type), eq(jobs.idempotencyKey, opts.idempotencyKey)) });
    if (!existing) return this.enqueue(type, payload, opts);
    if (existing.status !== 'failed') return existing;
    return (await this.reopen(and(eq(jobs.id, existing.id), eq(jobs.status, 'failed'))!, values))[0] ?? existing;
  }

  /**
   * Pede a execução já dos jobs com estas chaves (ex.: "Emitir novamente", "Reenviar"): cria os que
   * não existem, reabre os que terminaram (falharam ou concluíram) ou foram abandonados (lease
   * vencido) e antecipa os que esperam nova tentativa, com tentativas zeradas. Os que estão em
   * execução ficam como estão. Mantém o payload.
   */
  async retryNow(type: string, items: { idempotencyKey: string; payload: Record<string, unknown>; officeId?: string | null }[], opts: { userId?: string | null } = {}) {
    for (let i = 0; i < items.length; i += 500) {
      const part = items.slice(i, i + 500);
      const keys = part.map((p) => p.idempotencyKey);
      const base = this.rowValues(type, {}, { userId: opts.userId });
      const existing = and(eq(jobs.type, type), inArray(jobs.idempotencyKey, keys));
      const abandoned = and(eq(jobs.status, 'running'), sql`${jobs.lockedAt} < now() - (${this.leaseMs}::int * interval '1 millisecond')`);
      await this.reopen(and(existing, or(inArray(jobs.status, ['failed', 'done']), abandoned))!, base);
      await this.db
        .update(jobs)
        .set({ runAt: new Date(), attempts: 0 })
        .where(and(existing, eq(jobs.status, 'queued'), gt(jobs.runAt, new Date())));
      await this.db
        .insert(jobs)
        .values(part.map((p) => this.rowValues(type, p.payload, { officeId: p.officeId, idempotencyKey: p.idempotencyKey, userId: opts.userId })))
        .onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] });
    }
  }

  private async reopen(where: SQL, values: { maxAttempts: number; priority: number; createdByUserId: string | null }) {
    return this.db
      .update(jobs)
      .set({
        status: 'queued',
        attempts: 0,
        maxAttempts: values.maxAttempts,
        priority: values.priority,
        runAt: new Date(),
        lockedAt: null,
        lockToken: null,
        progress: 0,
        result: null,
        error: null,
        finishedAt: null,
        ...(values.createdByUserId ? { createdByUserId: values.createdByUserId } : {}),
      })
      .where(where)
      .returning();
  }

  /** Encerra os irmãos ainda na fila (mesmo pai) com esta mensagem: o lote para no erro que afetaria todos. */
  async cancelSiblings(job: Pick<JobRow, 'id' | 'parentId'>, message: string) {
    if (!job.parentId) return 0;
    const rows = await this.db
      .update(jobs)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(and(eq(jobs.parentId, job.parentId), eq(jobs.status, 'queued'), ne(jobs.id, job.id)))
      .returning({ id: jobs.id });
    await this.refreshParent(job.parentId);
    return rows.length;
  }

  /** Pega o próximo job pronto e o executa. Retorna false quando a fila está vazia. */
  async runNext(): Promise<boolean> {
    await this.sweep();
    const job = await this.claim(true);
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Processa até esvaziar a fila (útil em testes). */
  async drain(max = 100) {
    for (let i = 0; i < max; i++) if (!(await this.runNext())) return;
  }

  start(intervalMs = 1000) {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.kick();
  }

  /**
   * Para de pegar jobs e devolve a promise dos que estão em execução. Com `graceMs`, espera no
   * máximo esse tempo: os que não terminaram voltam para a fila (sem esperar o lease vencer) e
   * outra instância continua.
   */
  async stop(opts: { graceMs?: number } = {}): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.filling;
    const current = [...this.running.values()];
    if (!current.length) return;
    const all = Promise.allSettled(current.map((r) => r.done)).then(() => true);
    if (opts.graceMs === undefined) {
      await all;
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    const finished = await Promise.race([all, new Promise<false>((resolve) => (timeout = setTimeout(() => resolve(false), opts.graceMs)))]);
    clearTimeout(timeout);
    if (!finished) await this.release([...this.running.values()].map((r) => r.job));
  }

  /** Pega jobs enquanto houver vaga (no intervalo e sempre que um job termina). */
  private kick() {
    if (this.stopping) return;
    if (this.filling) {
      this.refill = true;
      return;
    }
    this.filling = this.fill().finally(() => {
      this.filling = null;
      if (this.refill) {
        this.refill = false;
        this.kick();
      }
    });
  }

  private async fill() {
    try {
      if (Date.now() - this.lastSweep >= SWEEP_EVERY_MS) await this.sweep();
      while (!this.stopping && this.running.size < this.concurrency) {
        const heavyRunning = [...this.running.values()].filter((r) => r.heavy).length;
        const job = await this.claim(heavyRunning < Math.max(1, this.concurrency - 1));
        if (!job) break;
        const heavy = Boolean(this.types.get(job.type)?.heavy);
        const done = this.execute(job)
          .catch(() => undefined)
          .finally(() => {
            this.running.delete(job.id);
            this.kick();
          });
        this.running.set(job.id, { job, heavy, done });
      }
    } catch {
      /* banco indisponível: tenta de novo no próximo intervalo */
    }
  }

  /** Jobs abandonados sem tentativas sobrando: falham de vez (e avisam como qualquer falha final). */
  private async sweep() {
    this.lastSweep = Date.now();
    const dead = await this.db
      .update(jobs)
      .set({ status: 'failed', error: INTERRUPTED_ERROR, finishedAt: new Date(), lockToken: null })
      .where(
        and(
          eq(jobs.status, 'running'),
          isNotNull(jobs.lockedAt),
          sql`${jobs.lockedAt} < now() - (${this.leaseMs}::int * interval '1 millisecond')`,
          sql`${jobs.attempts} >= ${jobs.maxAttempts}`,
        ),
      )
      .returning();
    for (const job of dead) await this.afterFailure(job, INTERRUPTED_ERROR);
  }

  /**
   * Reivindica o próximo job: pronto na fila, abandonado (lease vencido, com tentativas) ou pai
   * cujos filhos terminaram. Ordem: prioridade, depois `run_at`. Só tipos com executor neste processo.
   * Os claims de todos os workers passam por uma trava curta, para o limite por escritório valer
   * mesmo com várias instâncias.
   */
  private async claim(allowHeavy: boolean): Promise<JobRow | null> {
    const types = [...this.handlers.keys()];
    if (!types.length) return null;
    const lease = sql`(${this.leaseMs}::int * interval '1 millisecond')`;
    const limited = [...this.types].filter(([type, o]) => o.perOffice && this.handlers.has(type));
    const limit = limited.length ? sql`(case j.type ${sql.join(limited.map(([type, o]) => sql`when ${type} then ${o.perOffice}::int`), sql` `)} end)` : sql`null::int`;
    const heavy = [...this.types].filter(([, o]) => o.heavy).map(([type]) => type);
    const skipHeavy = !allowHeavy && heavy.length ? sql`and j.type not in ${heavy}` : sql``;
    const claimSql = sql`
      update jobs set
        status = 'running',
        locked_at = now(),
        lock_token = gen_random_uuid(),
        attempts = case when jobs.status = 'running' and jobs.locked_at is null then jobs.attempts else jobs.attempts + 1 end
      where jobs.id = (
        select j.id from jobs j
        left join (
          select r.office_id, r.type, count(*)::int as n from jobs r
          where r.status = 'running' and r.locked_at > now() - ${lease}
          group by r.office_id, r.type
        ) busy on busy.office_id = j.office_id and busy.type = j.type
        where j.type in ${types}
          and (
            (j.status = 'queued' and j.run_at <= now())
            or (j.status = 'running' and j.locked_at < now() - ${lease} and j.attempts < j.max_attempts)
            or (j.status = 'running' and j.locked_at is null
                and not exists (select 1 from jobs k where k.parent_id = j.id and k.status in ('queued', 'running')))
          )
          and (j.office_id is null or ${limit} is null or coalesce(busy.n, 0) < ${limit})
          ${skipHeavy}
        order by j.priority desc, j.run_at, j.id
        limit 1
        for update of j skip locked
      )
      returning jobs.id, jobs.lock_token`;
    const claimed = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('jobs:claim', 0))`);
      return tx.execute(claimSql);
    });
    const rows = (claimed as unknown as { rows: { id: string; lock_token: string }[] }).rows ?? [];
    if (!rows.length) return null;
    const job = await this.db.query.jobs.findFirst({ where: eq(jobs.id, rows[0].id) });
    // reaberto por outro pedido logo depois do claim: a rodada não é mais desta instância
    return job && job.lockToken === rows[0].lock_token ? job : null;
  }

  private async execute(job: JobRow) {
    const mine = ownRound(job);
    const heartbeat = setInterval(() => {
      this.db
        .update(jobs)
        .set({ lockedAt: sql`now()` })
        .where(mine)
        .catch(() => undefined);
    }, this.heartbeatMs);
    heartbeat.unref?.();
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`Nenhum executor para o job "${job.type}".`);
      const result = await handler(job, {
        progress: async (pct) => {
          await this.db.update(jobs).set({ progress: clampPct(pct), lockedAt: sql`now()` }).where(mine);
        },
        spawn: (children) => this.spawn(job, children),
        children: () => this.db.select().from(jobs).where(eq(jobs.parentId, job.id)),
      });
      clearInterval(heartbeat);
      if (result === WAIT_FOR_CHILDREN) {
        // sai do worker: a fila o pega de novo quando não houver filho pendente
        await this.db.update(jobs).set({ lockedAt: null, lockToken: null }).where(mine);
        return;
      }
      const [done] = await this.db
        .update(jobs)
        .set({ status: 'done', progress: 100, result: result ?? {}, error: null, finishedAt: new Date() })
        .where(mine)
        .returning();
      if (done?.parentId) await this.refreshParent(done.parentId);
    } catch (err) {
      clearInterval(heartbeat);
      const message = errorText(err);
      if (!isPermanent(err) && job.attempts < job.maxAttempts) {
        const wait = (this.types.get(job.type)?.backoff ?? defaultBackoff)(job.attempts);
        await this.db
          .update(jobs)
          .set({ status: 'queued', error: message, runAt: new Date(Date.now() + wait), lockedAt: null, lockToken: null, finishedAt: null })
          .where(mine)
          .catch(() => undefined);
        return;
      }
      const [failed] = await this.db
        .update(jobs)
        .set({ status: 'failed', error: message, finishedAt: new Date() })
        .where(mine)
        .returning()
        .catch(() => [] as JobRow[]);
      if (failed) await this.afterFailure(failed, message);
    }
  }

  private async spawn(parent: JobRow, children: ChildJob[]) {
    if (!children.length) return;
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < children.length; i += 500) {
        const values = children.slice(i, i + 500).map((c) => ({
          ...this.rowValues(c.type, c.payload, { officeId: parent.officeId, idempotencyKey: c.idempotencyKey, maxAttempts: c.maxAttempts, priority: c.priority, userId: parent.createdByUserId }),
          parentId: parent.id,
        }));
        await tx.insert(jobs).values(values).onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] });
      }
    });
  }

  private async afterFailure(job: JobRow, message: string) {
    try {
      await this.types.get(job.type)?.onFailed?.(job, message);
    } catch {
      /* o aviso não pode travar a fila */
    }
    if (job.parentId) await this.refreshParent(job.parentId);
  }

  /** Progresso do pai = filhos terminados / total (100 só quando o próprio pai conclui). */
  private async refreshParent(parentId: string) {
    await this.db
      .execute(
        sql`update jobs set progress = (
              select least(99, (100 * count(*) filter (where k.status in ('done', 'failed')) / greatest(count(*), 1))::int)
              from jobs k where k.parent_id = ${parentId})
            where id = ${parentId} and status = 'running'`,
      )
      .catch(() => undefined);
  }

  /** Devolve à fila os jobs que este processo não vai terminar (desligamento). */
  private async release(list: JobRow[]) {
    for (const job of list) {
      await this.db
        .update(jobs)
        .set({ status: 'queued', lockedAt: null, lockToken: null, runAt: new Date() })
        .where(ownRound(job))
        .catch(() => undefined);
    }
  }
}
