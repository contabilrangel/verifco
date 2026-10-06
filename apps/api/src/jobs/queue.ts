import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs } from '../db/schema';

export type JobRow = typeof jobs.$inferSelect;
export type JobHandler = (job: JobRow, helpers: { progress: (pct: number) => Promise<void> }) => Promise<Record<string, unknown> | void>;

/**
 * Fila de tarefas guardada no próprio PostgreSQL.
 * Envio de e-mail/WhatsApp, exportações, análises de IA e sincronizações passam por aqui,
 * com repetição automática e chave de idempotência para não duplicar envios.
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private db: Db) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  async enqueue(
    type: string,
    payload: Record<string, unknown>,
    opts: { officeId?: string | null; runAt?: Date; idempotencyKey?: string; maxAttempts?: number; userId?: string | null } = {},
  ): Promise<JobRow> {
    const values = {
      type,
      payload,
      officeId: opts.officeId ?? null,
      runAt: opts.runAt ?? new Date(),
      idempotencyKey: opts.idempotencyKey ?? null,
      maxAttempts: opts.maxAttempts ?? 3,
      createdByUserId: opts.userId ?? null,
    };
    if (opts.idempotencyKey) {
      const existing = await this.db.query.jobs.findFirst({
        where: and(eq(jobs.type, type), eq(jobs.idempotencyKey, opts.idempotencyKey)),
      });
      if (existing) return existing;
    }
    const [row] = await this.db.insert(jobs).values(values).returning();
    return row;
  }

  /** Pega o próximo job pronto e o executa. Retorna false quando a fila está vazia. */
  async runNext(): Promise<boolean> {
    const claimed = await this.db.execute(sql`
      update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
      where id = (
        select id from jobs
        where status = 'queued' and run_at <= now()
        order by run_at
        limit 1
        for update skip locked
      )
      returning id`);
    const rows = (claimed as unknown as { rows: { id: string }[] }).rows ?? [];
    if (!rows.length) return false;
    const job = await this.db.query.jobs.findFirst({ where: eq(jobs.id, rows[0].id) });
    if (!job) return true;
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`Nenhum executor para o job "${job.type}".`);
      const result = await handler(job, {
        progress: async (pct) => {
          await this.db.update(jobs).set({ progress: Math.max(0, Math.min(100, Math.round(pct))) }).where(eq(jobs.id, job.id));
        },
      });
      await this.db
        .update(jobs)
        .set({ status: 'done', progress: 100, result: result ?? {}, error: null, finishedAt: new Date() })
        .where(eq(jobs.id, job.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = job.attempts < job.maxAttempts;
      await this.db
        .update(jobs)
        .set({
          status: retry ? 'queued' : 'failed',
          error: message,
          runAt: retry ? new Date(Date.now() + 2 ** job.attempts * 5000) : job.runAt,
          finishedAt: retry ? null : new Date(),
        })
        .where(eq(jobs.id, job.id));
    }
    return true;
  }

  /** Processa até esvaziar a fila (útil em testes). */
  async drain(max = 100) {
    for (let i = 0; i < max; i++) if (!(await this.runNext())) return;
  }

  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        while (await this.runNext()) {
          /* continua enquanto houver jobs */
        }
      } catch {
        /* erros já ficam registrados no job */
      } finally {
        this.running = false;
      }
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
