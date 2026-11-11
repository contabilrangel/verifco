/**
 * Rotinas automáticas do Verifco:
 * - `reminders.daily`: lembretes do escritório, um job por escritório, todo dia às 8h (Brasília);
 * - `reminders.ensure`: confere todo dia (7h30) se cada escritório tem a rodada agendada;
 * - `indices.selic`: Selic mensal do Banco Central, toda segunda-feira (`services/indices.ts`);
 * - `maintenance.recompute_declaration_totals`: recálculo único dos totais gravados nas declarações.
 */
import { and, eq, notExists, sql } from 'drizzle-orm';
import { addDaysIso, todayIso } from '@verifco/shared';
import type { AppContext } from '../../context';
import { jobs, offices, reminderMarks } from '../../db/schema';
import { JOB_PRIORITY, type JobHelpers, type JobRow } from '../../jobs/queue';
import { recomputeStoredTotals } from '../../services/declarations';
import { SELIC_JOB, ensureSelicSchedule, logRoutine, runSelicJob } from '../../services/indices';
import { runDailyReminders } from './service';

export const REMINDERS_DAILY = 'reminders.daily';
export const REMINDERS_ENSURE = 'reminders.ensure';
export const RECOMPUTE_TOTALS_JOB = 'maintenance.recompute_declaration_totals';
/** Chave fixa: o recálculo roda uma vez por instalação (uma regra nova pede uma chave nova). */
export const RECOMPUTE_TOTALS_KEY = 'totais-2026-11';
/**
 * Marca gravada em todos os escritórios quando o recálculo termina. A rotina de retenção apaga as
 * tarefas concluídas depois de alguns dias; a marca é o que impede o recálculo de voltar à fila.
 */
export const RECOMPUTE_TOTALS_MARK = `manutencao:${RECOMPUTE_TOTALS_KEY}`;

/** Brasília não tem horário de verão desde 2019: UTC−3. */
const BRASILIA_OFFSET_MS = 3 * 3600_000;
/** Minutos depois da meia-noite de Brasília. */
const REMINDERS_AT = 8 * 60;
const ENSURE_AT = 7 * 60 + 30;

const atMinutes = (day: string, minutes: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + minutes * 60_000 + BRASILIA_OFFSET_MS);
};

/** Próximo horário (minutos do dia de Brasília) depois de `now`, num dia depois de `afterDay`. */
function nextRunAt(minutes: number, now: Date, afterDay?: string): Date {
  const today = todayIso(now);
  let day = atMinutes(today, minutes) > now ? today : addDaysIso(today, 1);
  if (afterDay && day <= afterDay) day = addDaysIso(afterDay, 1);
  return atMinutes(day, minutes);
}

/** Próxima rodada de lembretes: 8h de Brasília. */
export const nextReminderRun = (now = new Date(), afterDay?: string) => nextRunAt(REMINDERS_AT, now, afterDay);

const reminderKey = (officeId: string, day: string) => `reminders:${officeId}:${day}`;
const queuedReminder = (officeId: string) => and(eq(jobs.type, REMINDERS_DAILY), eq(jobs.officeId, officeId), eq(jobs.status, 'queued'));
/** Dia (Brasília) da rodada: o gravado no payload ou o do horário marcado. */
const runDay = (job: JobRow) => (typeof job.payload.day === 'string' ? job.payload.day : todayIso(job.runAt));

/**
 * Agenda a rodada de lembretes do escritório (no padrão de `scheduleEcacAutoSync`): no máximo uma
 * na fila por escritório, com chave de idempotência por escritório e dia de Brasília, o que
 * impede duas rodadas no mesmo dia mesmo com vários workers. Ao encadear, `afterDay` é o dia da
 * rodada em andamento.
 */
export async function scheduleDailyReminders(ctx: AppContext, officeId: string, opts: { now?: Date; afterDay?: string } = {}) {
  const queued = await ctx.db.query.jobs.findFirst({ where: queuedReminder(officeId) });
  if (queued) return queued;
  let afterDay = opts.afterDay;
  for (let i = 0; i < 3; i++) {
    const runAt = nextReminderRun(opts.now, afterDay);
    const day = todayIso(runAt);
    const job = await ctx.jobs.enqueue(REMINDERS_DAILY, { day }, { officeId, runAt, idempotencyKey: reminderKey(officeId, day) });
    // a rodada deste dia já rodou (ou está rodando): fica para o dia seguinte
    if (job.status === 'queued') return job;
    afterDay = day;
  }
  return null;
}

/**
 * Escritórios sem rodada na fila (criados depois da última conferência, ou com a cadeia
 * interrompida) ganham a próxima, gravadas em lote. Roda ao subir a API e todo dia pelo job
 * `reminders.ensure`: o cadastro de um escritório não precisa agendar nada.
 */
export async function ensureReminderSchedules(ctx: AppContext, opts: { now?: Date } = {}): Promise<number> {
  const missing = await ctx.db
    .select({ id: offices.id })
    .from(offices)
    .where(notExists(ctx.db.select({ one: sql`1` }).from(jobs).where(and(eq(jobs.type, REMINDERS_DAILY), eq(jobs.officeId, offices.id), eq(jobs.status, 'queued')))));
  if (!missing.length) return 0;
  const runAt = nextReminderRun(opts.now);
  const day = todayIso(runAt);
  let created = 0;
  for (let i = 0; i < missing.length; i += 500) {
    // outra instância pode agendar ao mesmo tempo: a chave de idempotência recusa a duplicata
    const rows = await ctx.db
      .insert(jobs)
      .values(missing.slice(i, i + 500).map((o) => ctx.jobs.enqueueValues(REMINDERS_DAILY, { day }, { officeId: o.id, runAt, idempotencyKey: reminderKey(o.id, day) })))
      .onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] })
      .returning({ id: jobs.id });
    created += rows.length;
  }
  return created;
}

/** Agenda a conferência diária (uma na fila, com chave pelo dia). */
export async function scheduleReminderEnsure(ctx: AppContext, opts: { now?: Date; afterDay?: string } = {}) {
  const queued = await ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, REMINDERS_ENSURE), eq(jobs.status, 'queued')) });
  if (queued) return queued;
  let afterDay = opts.afterDay;
  for (let i = 0; i < 3; i++) {
    const runAt = nextRunAt(ENSURE_AT, opts.now ?? new Date(), afterDay);
    const day = todayIso(runAt);
    const job = await ctx.jobs.enqueue(REMINDERS_ENSURE, { day }, { runAt, idempotencyKey: `reminders-ensure:${day}`, maxAttempts: 1 });
    if (job.status === 'queued') return job;
    afterDay = day;
  }
  return null;
}

/**
 * Recálculo único dos totais gravados: enfileirado ao subir, com a chave fixa (a segunda vez
 * devolve o job já gravado). Já concluído nesta instalação (há a marca), não volta à fila: `null`.
 */
export async function enqueueTotalsRecompute(ctx: AppContext) {
  const [done] = await ctx.db
    .select({ id: offices.id })
    .from(offices)
    .innerJoin(reminderMarks, and(eq(reminderMarks.officeId, offices.id), eq(reminderMarks.key, RECOMPUTE_TOTALS_MARK)))
    .limit(1);
  if (done) return null;
  return ctx.jobs.enqueue(RECOMPUTE_TOTALS_JOB, {}, { idempotencyKey: RECOMPUTE_TOTALS_KEY });
}

/** Lotes de declarações por rodada do recálculo, do menor id para o maior. */
async function recomputeAllTotals(ctx: AppContext, helpers: JobHelpers, batchSize = 200) {
  let afterId: string | null = null;
  let scanned = 0;
  let updated = 0;
  for (;;) {
    const batch = await recomputeStoredTotals(ctx.db, { afterId, limit: batchSize });
    scanned += batch.scanned;
    updated += batch.updated;
    if (!batch.lastId) break;
    afterId = batch.lastId;
    // sem total conhecido: o andamento só renova o lease entre um lote e outro
    await helpers.progress(50);
  }
  await ctx.db.execute(sql`insert into ${reminderMarks} (office_id, key) select ${offices.id}, ${RECOMPUTE_TOTALS_MARK} from ${offices} on conflict do nothing`);
  logRoutine(ctx, 'info', 'Totais das declarações recalculados', { scanned, updated });
  return { scanned, updated };
}

export async function registerJobs(ctx: AppContext) {
  /**
   * Rodada do escritório. Agenda a do dia seguinte antes de começar, para a cadeia não parar se
   * esta falhar; a rodada usa o dia em que de fato roda (um worker parado não manda avisos de ontem).
   */
  ctx.jobs.register(
    REMINDERS_DAILY,
    async (job) => {
      const officeId = job.officeId;
      if (!officeId) throw new Error('Job sem escritório.');
      await scheduleDailyReminders(ctx, officeId, { afterDay: runDay(job) });
      const office = await ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId), columns: { blockedAt: true } });
      if (!office) return { skipped: true, reason: 'Escritório não encontrado.' };
      if (office.blockedAt) return { skipped: true, reason: 'Escritório bloqueado: nenhum lembrete enviado.' };
      return runDailyReminders(ctx, officeId);
    },
    { priority: JOB_PRIORITY.low, perOffice: 1 },
  );

  ctx.jobs.register(
    REMINDERS_ENSURE,
    async (job) => {
      await scheduleReminderEnsure(ctx, { afterDay: runDay(job) });
      return { scheduled: await ensureReminderSchedules(ctx) };
    },
    { priority: JOB_PRIORITY.low },
  );

  ctx.jobs.register(SELIC_JOB, async (job) => runSelicJob(ctx, job.payload), { priority: JOB_PRIORITY.low });

  ctx.jobs.register(RECOMPUTE_TOTALS_JOB, async (_job, helpers) => recomputeAllTotals(ctx, helpers), { priority: JOB_PRIORITY.low, heavy: true });

  // Só a instância que executa a fila agenda as rotinas (as que só atendem HTTP não precisam).
  if (ctx.config.RUN_WORKER) await scheduleRoutines(ctx).catch((err) => logRoutine(ctx, 'warn', 'Rotinas automáticas: falha ao agendar ao subir', { error: err instanceof Error ? err.message : String(err) }));
}

/** Ao subir a API: rodadas de lembretes de todos os escritórios, conferência diária, Selic semanal e o recálculo único. */
export async function scheduleRoutines(ctx: AppContext, opts: { now?: Date } = {}) {
  await ensureReminderSchedules(ctx, opts);
  await scheduleReminderEnsure(ctx, opts);
  await ensureSelicSchedule(ctx, opts);
  await enqueueTotalsRecompute(ctx);
}
