/**
 * Rotina diária de retenção: apaga o que já cumpriu o prazo de guarda, para o banco e o
 * armazenamento não crescerem para sempre e para a exclusão de um cliente ser de fato definitiva.
 *
 * | O quê                                   | Prazo                                   |
 * |-----------------------------------------|-----------------------------------------|
 * | Tarefas concluídas ou com falha         | RETENTION_JOBS_DAYS (30)                |
 * | Backups do escritório (.zip e registro) | RETENTION_BACKUPS_DAYS (30)             |
 * | Clientes na lixeira (com os arquivos)   | RETENTION_DELETED_CUSTOMERS_DAYS (90)   |
 * | Links de senha e convite vencidos       | 7 dias depois de vencer ou de usados    |
 * | Contadores de tentativas                | 1 dia                                   |
 * | Avisos do sino já lidos                 | 180 dias                                |
 *
 * Auditoria, documentos, declarações e cobranças não têm prazo aqui: ficam até o cliente ou o
 * escritório serem apagados.
 */
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { addDaysIso, todayIso } from '@verifco/shared';
import type { AppContext } from '../../context';
import { customers, jobs, notifications, passwordResets } from '../../db/schema';
import { purgeCustomer } from '../../services/purge';

export const RETENTION_JOB = 'maintenance.retention';
const BACKUP_JOB = 'backup.generate';
/** 3h40 de Brasília (UTC-3), fora do horário de uso. */
const RUN_AT_UTC_MINUTES = 6 * 60 + 40;
/** Clientes eliminados por rodada: a rotina volta no dia seguinte para o resto. */
const PURGE_BATCH = 200;

const daysAgo = (days: number, now: Date) => new Date(now.getTime() - days * 86_400_000);

export function nextRetentionRun(now = new Date()): Date {
  // dia de Brasília D às 3h40 = D às 6h40 UTC
  const at = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + RUN_AT_UTC_MINUTES * 60_000);
  const today = todayIso(now);
  const candidate = at(today);
  return candidate > now ? candidate : at(addDaysIso(today, 1));
}

/** Agenda a próxima rodada (uma por dia, pela chave); chamar de novo não duplica. */
export async function scheduleRetention(ctx: AppContext, now = new Date()) {
  const runAt = nextRetentionRun(now);
  return ctx.jobs.enqueue(RETENTION_JOB, {}, { runAt, idempotencyKey: `retention:${todayIso(runAt)}`, maxAttempts: 2 });
}

export interface RetentionResult extends Record<string, unknown> {
  jobs: number;
  backups: number;
  customers: number;
  customerFiles: number;
  passwordResets: number;
  rateLimits: number;
  notifications: number;
}

export async function runRetention(ctx: AppContext, now = new Date()): Promise<RetentionResult> {
  const { db, config } = ctx;
  const result: RetentionResult = { jobs: 0, backups: 0, customers: 0, customerFiles: 0, passwordResets: 0, rateLimits: 0, notifications: 0 };

  // 1. backups: o .zip sai do armazenamento junto com o registro
  const oldBackups = await db
    .select({ id: jobs.id, officeId: jobs.officeId, result: jobs.result })
    .from(jobs)
    .where(and(eq(jobs.type, BACKUP_JOB), inArray(jobs.status, ['done', 'failed']), lt(jobs.finishedAt, daysAgo(config.RETENTION_BACKUPS_DAYS, now))));
  for (const b of oldBackups) {
    const fileId = (b.result as { fileId?: string } | null)?.fileId;
    if (fileId && b.officeId) await ctx.files.remove(b.officeId, fileId).catch(() => {});
    await db.delete(jobs).where(eq(jobs.id, b.id));
    result.backups += 1;
  }

  // 2. tarefas terminadas (os filhos saem com o pai; o backup tem prazo próprio, acima)
  const goneJobs = await db
    .delete(jobs)
    .where(and(inArray(jobs.status, ['done', 'failed']), lt(jobs.finishedAt, daysAgo(config.RETENTION_JOBS_DAYS, now)), sql`${jobs.type} <> ${BACKUP_JOB}`))
    .returning({ id: jobs.id });
  result.jobs = goneJobs.length;

  // 3. clientes na lixeira há mais tempo que o prazo: eliminação definitiva, com os arquivos
  const expired = await db
    .select({ id: customers.id, officeId: customers.officeId })
    .from(customers)
    .where(and(isNotNull(customers.deletedAt), lt(customers.deletedAt, daysAgo(config.RETENTION_DELETED_CUSTOMERS_DAYS, now))))
    .limit(PURGE_BATCH);
  for (const c of expired) {
    const purged = await purgeCustomer(ctx, c.officeId, c.id);
    if (purged) {
      result.customers += 1;
      result.customerFiles += purged.files;
    }
  }

  // 4. links de senha/convite vencidos ou já usados
  const weekAgo = daysAgo(7, now);
  const goneResets = await db
    .delete(passwordResets)
    .where(sql`${passwordResets.expiresAt} < ${weekAgo} or ${passwordResets.usedAt} < ${weekAgo}`)
    .returning({ id: passwordResets.id });
  result.passwordResets = goneResets.length;

  // 5. contadores de tentativas (nos dois bancos)
  const dayAgo = daysAgo(1, now);
  const r1 = await db.execute<{ key: string }>(sql`delete from rate_limits where window_started_at < ${dayAgo} returning key`);
  const r2 = await ctx.platformDb.execute<{ key: string }>(sql`delete from rate_limits where window_started_at < ${dayAgo} returning key`);
  result.rateLimits = r1.rows.length + r2.rows.length;

  // 6. avisos do sino já lidos
  const goneNotices = await db
    .delete(notifications)
    .where(and(isNotNull(notifications.readAt), lt(notifications.createdAt, daysAgo(180, now))))
    .returning({ id: notifications.id });
  result.notifications = goneNotices.length;

  return result;
}

export async function registerJobs(ctx: AppContext) {
  ctx.jobs.register(RETENTION_JOB, async () => {
    // a próxima rodada é agendada antes do trabalho: uma falha hoje não interrompe a rotina
    await scheduleRetention(ctx, new Date(Date.now() + 60_000));
    const result = await runRetention(ctx);
    if (ctx.config.NODE_ENV !== 'test') console.log(JSON.stringify({ level: 30, time: Date.now(), msg: 'rotina de retenção', ...result }));
    return result;
  });
  // só a instância que executa a fila agenda (as que só atendem HTTP não precisam)
  if (ctx.config.RUN_WORKER) {
    await scheduleRetention(ctx).catch((err) => console.warn(`[verifco] rotina de retenção: falha ao agendar ao subir (${err instanceof Error ? err.message : String(err)})`));
  }
}
