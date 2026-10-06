import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs } from '../db/schema';

export type JobRow = typeof jobs.$inferSelect;
export type JobHandler = (job: JobRow, helpers: { progress: (pct: number) => Promise<void> }) => Promise<Record<string, unknown> | void>;

/** Quantas vezes tentar e quanto esperar entre as tentativas. */
export interface RetryPolicy {
  /** Tentativas quando quem enfileira não informa `maxAttempts`. */
  maxAttempts?: number;
  /** Espera antes da próxima tentativa, depois da `attempt`-ésima falha (1, 2, ...). */
  backoffMs?: (attempt: number) => number;
}

/** Padrão: 10 s, 20 s, 40 s... até 10 min (3 tentativas, salvo indicação). */
export const DEFAULT_RETRY: Required<RetryPolicy> = {
  maxAttempts: 3,
  backoffMs: (attempt) => Math.min(2 ** attempt * 5000, 10 * 60_000),
};

const MINUTE = 60_000;
const EXTERNAL_STEPS = [1, 5, 15, 30, 60, 120, 240, 480, 720].map((m) => m * MINUTE);

/**
 * Jobs que falam com serviço externo (e-mail, WhatsApp, Asaas/Omie): uma queda de alguns minutos
 * (ou a integração ainda não ativada) não pode esgotar as tentativas. Repete em 1, 5, 15, 30 min,
 * 1, 2, 4, 8 e 12 h (10 tentativas, cerca de 28 h no total).
 */
export const EXTERNAL_SERVICE_RETRY: Required<RetryPolicy> = {
  maxAttempts: 10,
  backoffMs: (attempt) => EXTERNAL_STEPS[Math.min(attempt, EXTERNAL_STEPS.length) - 1] ?? EXTERNAL_STEPS[0],
};

/** Política por tipo de job (pode ser trocada no `register`). */
export const JOB_RETRY_POLICIES: Record<string, RetryPolicy> = {
  'delivery.send': EXTERNAL_SERVICE_RETRY,
  'mailing.deliver': EXTERNAL_SERVICE_RETRY,
  'billing.sync_external': EXTERNAL_SERVICE_RETRY,
};

export interface JobQueueOptions {
  /** Jobs executados ao mesmo tempo por processo (`JOB_CONCURRENCY`). */
  concurrency?: number;
  /**
   * Máximo de jobs de um mesmo escritório rodando ao mesmo tempo (`JOB_OFFICE_CONCURRENCY`);
   * padrão: `concurrency - 1` (mínimo 1), para sempre sobrar vaga para os outros escritórios.
   */
  officeConcurrency?: number;
  /**
   * Prazo da "posse" de um job em execução (`JOB_LEASE_SECONDS`). O executor renova a posse
   * (`locked_at`) periodicamente; um job em `running` sem renovação dentro do prazo é de um
   * processo que caiu e volta para a fila (ou falha, se acabaram as tentativas).
   */
  leaseMs?: number;
  /** Intervalo da renovação da posse; padrão: um quarto do prazo. */
  heartbeatMs?: number;
}

interface ActiveJob {
  job: JobRow;
  promise: Promise<void>;
}

const INTERRUPTED = 'A tarefa foi interrompida (o servidor parou ou reiniciou durante a execução).';

/**
 * Fila de tarefas guardada no próprio PostgreSQL.
 * Envio de e-mail/WhatsApp, exportações, análises de IA e sincronizações passam por aqui,
 * com repetição automática e chave de idempotência para não duplicar envios.
 *
 * - Posse com prazo: o job em execução renova `locked_at`; se o processo cai (deploy, OOM), o job
 *   volta para a fila quando o prazo vence, contando a tentativa (`recoverStale`).
 * - Cada execução só grava o próprio resultado enquanto ainda é dona do job (mesmo `attempts` e
 *   status `running`): uma execução que perdeu a posse não sobrescreve a seguinte.
 * - Concorrência configurável e justiça entre escritórios: um escritório não ocupa todas as vagas
 *   (`officeConcurrency`) e, havendo jobs de vários escritórios, eles se revezam.
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private policies = new Map<string, RetryPolicy>(Object.entries(JOB_RETRY_POLICIES));
  private timer: NodeJS.Timeout | null = null;
  /** Ocupação de vagas em andamento (uma por vez). */
  private filling: Promise<void> | null = null;
  private stopping = false;
  private active = new Map<string, ActiveJob>();
  /** Escritórios já atendidos nesta "rodada" do revezamento. */
  private servedThisRound = new Set<string>();
  private lastRecovery = 0;
  readonly concurrency: number;
  readonly officeConcurrency: number;
  readonly leaseMs: number;
  private heartbeatMs: number;

  constructor(
    private db: Db,
    opts: JobQueueOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
    this.officeConcurrency = Math.max(1, Math.floor(opts.officeConcurrency ?? this.concurrency - 1));
    this.leaseMs = Math.max(1000, opts.leaseMs ?? 5 * MINUTE);
    this.heartbeatMs = Math.max(250, opts.heartbeatMs ?? Math.floor(this.leaseMs / 4));
  }

  register(type: string, handler: JobHandler, policy?: RetryPolicy) {
    this.handlers.set(type, handler);
    if (policy) this.policies.set(type, policy);
  }

  /**
   * Enfileira um job. Com `idempotencyKey`, repetir a chamada devolve o job existente (na fila,
   * rodando ou concluído); se ele falhou de vez, é reaberto com o novo payload e tentativas zeradas.
   */
  async enqueue(
    type: string,
    payload: Record<string, unknown>,
    opts: { officeId?: string | null; runAt?: Date; idempotencyKey?: string; maxAttempts?: number; userId?: string | null } = {},
  ): Promise<JobRow> {
    const maxAttempts = opts.maxAttempts ?? this.policies.get(type)?.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
    const values = {
      type,
      payload,
      officeId: opts.officeId ?? null,
      runAt: opts.runAt ?? new Date(),
      idempotencyKey: opts.idempotencyKey ?? null,
      maxAttempts,
      createdByUserId: opts.userId ?? null,
    };
    if (!opts.idempotencyKey) {
      const [row] = await this.db.insert(jobs).values(values).returning();
      return row;
    }
    const key = and(eq(jobs.type, type), eq(jobs.idempotencyKey, opts.idempotencyKey));
    for (let i = 0; i < 3; i++) {
      const existing = await this.db.query.jobs.findFirst({ where: key });
      if (existing?.status === 'failed') {
        const [reopened] = await this.db
          .update(jobs)
          .set({ status: 'queued', payload, attempts: 0, maxAttempts, runAt: values.runAt, lockedAt: null, finishedAt: null, progress: 0, error: null, result: null })
          .where(and(eq(jobs.id, existing.id), eq(jobs.status, 'failed')))
          .returning();
        if (reopened) return reopened;
        continue; // outra chamada reabriu ao mesmo tempo: relê
      }
      if (existing) return existing;
      // duas chamadas simultâneas com a mesma chave: o índice único decide, a outra relê
      const [row] = await this.db.insert(jobs).values(values).onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] }).returning();
      if (row) return row;
    }
    const row = await this.db.query.jobs.findFirst({ where: key });
    if (!row) throw new Error(`Não foi possível enfileirar o job "${type}".`);
    return row;
  }

  /**
   * Devolve à fila os jobs em `running` cuja posse venceu (processo que caiu ou foi encerrado à
   * força). A tentativa interrompida conta: sem tentativas restantes, o job falha.
   */
  async recoverStale(): Promise<{ requeued: number; failed: number }> {
    const res = await this.db.execute(sql`
      update jobs set
        status = case when attempts >= max_attempts then 'failed' else 'queued' end,
        error = ${INTERRUPTED},
        locked_at = null,
        run_at = now(),
        finished_at = case when attempts >= max_attempts then now() else null end
      where status = 'running'
        and coalesce(locked_at, created_at) < now() - ${this.leaseMs}::int * interval '1 millisecond'
      returning status`);
    const rows = (res as unknown as { rows: { status: string }[] }).rows ?? [];
    this.lastRecovery = Date.now();
    return { requeued: rows.filter((r) => r.status === 'queued').length, failed: rows.filter((r) => r.status === 'failed').length };
  }

  /** Pega o próximo job pronto e o executa até o fim. Retorna false quando a fila está vazia. */
  async runNext(): Promise<boolean> {
    await this.recoverStale();
    const job = await this.claimNext();
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Processa até esvaziar a fila (útil em testes). */
  async drain(max = 100) {
    for (let i = 0; i < max; i++) if (!(await this.runNext())) return;
  }

  /**
   * Reivindica o próximo job pronto, com revezamento entre escritórios:
   * 1. primeiro, escritórios sem job rodando e ainda não atendidos nesta rodada;
   * 2. senão, qualquer escritório abaixo do limite de jobs simultâneos (e começa nova rodada).
   * Jobs sem escritório (do sistema) entram sempre.
   */
  private async claimNext(): Promise<JobRow | null> {
    const busy = await this.runningByOffice();
    const atCap = [...busy].filter(([, n]) => n >= this.officeConcurrency).map(([id]) => id);
    const preferredExclude = [...new Set([...busy.keys(), ...this.servedThisRound])];
    let claimed = await this.claim(preferredExclude);
    if (!claimed) {
      this.servedThisRound.clear();
      const sameQuery = preferredExclude.length === atCap.length && atCap.every((id) => preferredExclude.includes(id));
      if (!sameQuery) claimed = await this.claim(atCap);
    }
    if (!claimed) return null;
    if (claimed.officeId) this.servedThisRound.add(claimed.officeId);
    return (await this.db.query.jobs.findFirst({ where: eq(jobs.id, claimed.id) })) ?? null;
  }

  private async runningByOffice(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ officeId: jobs.officeId, n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(eq(jobs.status, 'running'), sql`${jobs.officeId} is not null`))
      .groupBy(jobs.officeId);
    return new Map(rows.map((r) => [r.officeId as string, Number(r.n)]));
  }

  private async claim(excludeOffices: string[]): Promise<{ id: string; officeId: string | null } | null> {
    const exclude = excludeOffices.length
      ? sql`and (office_id is null or office_id not in (${sql.join(
          excludeOffices.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}))`
      : sql``;
    const res = await this.db.execute(sql`
      update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
      where id = (
        select id from jobs
        where status = 'queued' and run_at <= now() ${exclude}
        order by run_at, created_at
        limit 1
        for update skip locked
      )
      returning id, office_id`);
    const row = ((res as unknown as { rows: { id: string; office_id: string | null }[] }).rows ?? [])[0];
    return row ? { id: row.id, officeId: row.office_id } : null;
  }

  /** Executa um job reivindicado, renovando a posse enquanto roda. */
  private async execute(job: JobRow): Promise<void> {
    // só grava enquanto for dona do job: se a posse venceu e outro processo o pegou, attempts mudou
    const owned = and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.attempts, job.attempts));
    const beat = setInterval(() => {
      this.db
        .update(jobs)
        .set({ lockedAt: sql`now()` })
        .where(owned)
        .catch(() => undefined);
    }, this.heartbeatMs);
    beat.unref?.();
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`Nenhum executor para o job "${job.type}".`);
      const result = await handler(job, {
        progress: async (pct) => {
          await this.db
            .update(jobs)
            .set({ progress: Math.max(0, Math.min(100, Math.round(pct))), lockedAt: sql`now()` })
            .where(owned);
        },
      });
      await this.db
        .update(jobs)
        .set({ status: 'done', progress: 100, result: result ?? {}, error: null, lockedAt: null, finishedAt: new Date() })
        .where(owned);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = job.attempts < job.maxAttempts;
      const backoff = this.policies.get(job.type)?.backoffMs ?? DEFAULT_RETRY.backoffMs;
      await this.db
        .update(jobs)
        .set({
          status: retry ? 'queued' : 'failed',
          error: message,
          lockedAt: null,
          runAt: retry ? new Date(Date.now() + backoff(job.attempts)) : job.runAt,
          finishedAt: retry ? null : new Date(),
        })
        .where(owned)
        .catch(() => undefined); // banco fora do ar: a posse vence e recoverStale devolve o job
    } finally {
      clearInterval(beat);
    }
  }

  /** Inicia o processamento contínuo (até `concurrency` jobs ao mesmo tempo). */
  start(intervalMs = 1000) {
    if (this.timer) return;
    this.stopping = false;
    void this.fill();
    this.timer = setInterval(() => void this.fill(), intervalMs);
  }

  /** Ocupa as vagas livres com jobs prontos. */
  private fill(): Promise<void> {
    if (this.filling || this.stopping) return this.filling ?? Promise.resolve();
    // o `finally` do .then roda sempre depois desta atribuição, mesmo se não houver nada a fazer
    const run = this.fillSlots().finally(() => {
      if (this.filling === run) this.filling = null;
    });
    this.filling = run;
    return run;
  }

  private async fillSlots() {
    try {
      if (Date.now() - this.lastRecovery >= Math.min(this.leaseMs / 2, 30_000)) await this.recoverStale();
      while (!this.stopping && this.active.size < this.concurrency) {
        const job = await this.claimNext();
        if (!job) break;
        const promise = this.execute(job).finally(() => {
          this.active.delete(job.id);
          void this.fill();
        });
        this.active.set(job.id, { job, promise });
      }
    } catch (err) {
      console.error('[verifco] fila de tarefas:', err instanceof Error ? err.message : err);
    }
  }

  /** Jobs em execução neste processo. */
  get running(): number {
    return this.active.size;
  }

  /**
   * Para de pegar jobs novos e espera os que estão rodando por até `timeoutMs`. Os que não
   * terminarem a tempo voltam para a fila na hora (sem gastar tentativa), para outro processo
   * retomar sem esperar o prazo da posse.
   */
  async stop(opts: { timeoutMs?: number } = {}): Promise<{ finished: number; released: number }> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.filling; // um job reivindicado neste instante também entra na espera
    const pending = [...this.active.values()];
    if (!pending.length) return { finished: 0, released: 0 };
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(pending.map((p) => p.promise)).then(() => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(true), opts.timeoutMs ?? 25_000);
      }),
    ]);
    clearTimeout(timeout);
    if (!timedOut) return { finished: pending.length, released: 0 };
    const left = [...this.active.values()];
    const released = left.length ? await this.release(left.map((a) => a.job)) : 0;
    return { finished: pending.length - left.length, released };
  }

  /** Devolve à fila jobs deste processo interrompidos pelo desligamento (a tentativa não conta). */
  private async release(list: JobRow[]): Promise<number> {
    let n = 0;
    for (const job of list) {
      const rows = await this.db
        .update(jobs)
        // attempts não volta (é a "senha" de posse de cada execução): devolvemos a tentativa em max_attempts
        .set({ status: 'queued', lockedAt: null, runAt: new Date(), maxAttempts: sql`${jobs.maxAttempts} + 1` })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.attempts, job.attempts)))
        .returning({ id: jobs.id });
      n += rows.length;
    }
    return n;
  }

  /** Jobs ainda pendentes (na fila ou rodando) de um tipo e escritório, para deduplicar pedidos. */
  async pending(officeId: string, type: string) {
    await this.recoverStale();
    return this.db.query.jobs.findFirst({
      where: and(eq(jobs.officeId, officeId), eq(jobs.type, type), inArray(jobs.status, ['queued', 'running'])),
    });
  }
}
