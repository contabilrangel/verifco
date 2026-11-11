/**
 * Índices oficiais por mês (tabela `tax_indices`). Hoje: a taxa Selic mensal, a "Selic acumulada
 * no mês" da série 4390 do Banco Central (SGS), a mesma que a Receita soma nos juros das quotas do
 * DARF. Um job semanal busca a série e grava os meses fechados; as regras leem primeiro o banco e
 * depois a tabela fixa de `packages/shared/src/darf.ts` (`SELIC_MONTHLY_PERCENT`). Mês sem taxa em
 * nenhuma das duas continua sem taxa: nada é estimado.
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import { addDaysIso, todayIso, weekdayIso, type SelicTable } from '@verifco/shared';
import type { AppContext } from '../context';
import type { DbOrTx } from '../db/client';
import { jobs, taxIndices } from '../db/schema';

export const SELIC_CODE = 'selic';
/** Job semanal que atualiza a Selic mensal (sem escritório: vale para a instalação inteira). */
export const SELIC_JOB = 'indices.selic';
/** Série 4390 do SGS (Selic acumulada no mês, % a.m.), desde 2024: `[{ data: "01/10/2026", valor: "1.28" }]`. */
export const SELIC_SERIES_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.4390/dados?formato=json&dataInicial=01/01/2024';
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_MS = 60 * 60_000;
/** Taxa mensal acima disto não é Selic: a resposta veio em outra unidade ou corrompida. */
const MAX_MONTHLY_PERCENT = 15;

/** Linha de log das rotinas automáticas (JSON, como o log da fila); calada nos testes. */
export function logRoutine(ctx: Pick<AppContext, 'config'>, level: 'info' | 'warn', msg: string, data: Record<string, unknown> = {}) {
  if (ctx.config.NODE_ENV === 'test') return;
  const line = JSON.stringify({ level: level === 'warn' ? 40 : 30, time: Date.now(), msg, ...data });
  if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface SelicMonth {
  /** Mês de referência `AAAA-MM`. */
  period: string;
  /** Taxa do mês em % (ex.: 1.28). */
  value: number;
}

/**
 * Meses fechados da resposta do SGS. O mês corrente (Brasília) fica de fora: nele a série traz só
 * o acumulado até o dia. Itens fora do formato são ignorados; uma resposta que não é lista dá `[]`.
 */
export function parseSelicSeries(payload: unknown, today = todayIso()): SelicMonth[] {
  if (!Array.isArray(payload)) return [];
  const currentMonth = today.slice(0, 7);
  const byPeriod = new Map<string, number>();
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const { data, valor } = item as { data?: unknown; valor?: unknown };
    const m = typeof data === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(data.trim()) : null;
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) continue;
    const text = typeof valor === 'number' ? String(valor) : typeof valor === 'string' ? valor.trim().replace(',', '.') : '';
    if (!/^\d+(\.\d+)?$/.test(text)) continue;
    const value = Number(text);
    if (!Number.isFinite(value) || value > MAX_MONTHLY_PERCENT) continue;
    const period = `${m[3]}-${m[2]}`;
    if (period >= currentMonth) continue;
    byPeriod.set(period, value);
  }
  return [...byPeriod].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
}

const cache = new WeakMap<object, { at: number; table: SelicTable }>();

/**
 * Selic mensal gravada no banco (`AAAA-MM` → % a.m.), guardada em memória por uma hora. Passe o
 * resultado em `extraSelic` de `darfQuotaAmount`/`darfPayable`/`darfValueText`: os meses do banco
 * valem primeiro e a tabela fixa cobre os demais.
 */
export async function selicTable(db: DbOrTx, now = Date.now()): Promise<SelicTable> {
  const hit = cache.get(db);
  if (hit && now - hit.at < CACHE_MS) return hit.table;
  const rows = await db.select({ period: taxIndices.period, value: taxIndices.value }).from(taxIndices).where(eq(taxIndices.code, SELIC_CODE));
  const table: Record<string, number> = {};
  for (const r of rows) {
    const value = Number(r.value);
    if (/^\d{4}-\d{2}$/.test(r.period) && r.value.trim() !== '' && Number.isFinite(value)) table[r.period] = value;
  }
  cache.set(db, { at: now, table });
  return table;
}

export type SelicRefreshResult = { ok: true; months: number; latest: string | null } | { ok: false; error: string };

/**
 * Busca a série no Banco Central e grava os meses fechados (inclui ou atualiza). Falha de rede,
 * resposta com erro ou fora do formato não lança: registra no log e devolve `ok: false` (a rodada
 * da semana seguinte tenta de novo; os meses já gravados e a tabela fixa continuam valendo).
 */
export async function refreshSelic(ctx: AppContext, opts: { today?: string } = {}): Promise<SelicRefreshResult> {
  let payload: unknown;
  try {
    const res = await ctx.providers.fetch(SELIC_SERIES_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`o Banco Central respondeu HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logRoutine(ctx, 'warn', 'Selic: consulta ao Banco Central falhou; nova tentativa na próxima semana', { error });
    return { ok: false, error };
  }
  const months = parseSelicSeries(payload, opts.today);
  if (!months.length) {
    const error = 'resposta do Banco Central sem meses reconhecidos';
    logRoutine(ctx, 'warn', `Selic: ${error}; nova tentativa na próxima semana`);
    return { ok: false, error };
  }
  await ctx.db
    .insert(taxIndices)
    .values(months.map((m) => ({ code: SELIC_CODE, period: m.period, value: String(m.value) })))
    .onConflictDoUpdate({ target: [taxIndices.code, taxIndices.period], set: { value: sql`excluded.value`, fetchedAt: new Date() } });
  cache.delete(ctx.db);
  return { ok: true, months: months.length, latest: months.at(-1)!.period };
}

/** Brasília não tem horário de verão desde 2019: UTC−3. */
const BRASILIA_OFFSET_MS = 3 * 3600_000;
/** Segunda-feira às 6h (Brasília): o mês fechado sai no SGS no primeiro dia útil do mês seguinte. */
const SELIC_WEEKDAY = 1;
const SELIC_HOUR = 6;

const selicRunAt = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, SELIC_HOUR) + BRASILIA_OFFSET_MS);
};

/** Próxima rodada semanal depois de `now` (e num dia depois de `afterDay`). */
export function nextSelicRun(now = new Date(), afterDay?: string): Date {
  let day = todayIso(now);
  if (afterDay && day <= afterDay) day = addDaysIso(afterDay, 1);
  // no máximo 7 dias até a próxima segunda-feira ainda por vir
  while (weekdayIso(day) !== SELIC_WEEKDAY || selicRunAt(day) <= now) day = addDaysIso(day, 1);
  return selicRunAt(day);
}

/**
 * Agenda a rodada semanal: no máximo uma na fila, com chave de idempotência pelo dia (vários
 * workers não duplicam). Ao encadear, `afterDay` é o dia da rodada em andamento.
 */
export async function scheduleSelicRefresh(ctx: AppContext, opts: { now?: Date; afterDay?: string } = {}) {
  const now = opts.now ?? new Date();
  const queued = await ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, SELIC_JOB), eq(jobs.status, 'queued'), gt(jobs.runAt, now), sql`${jobs.payload} ->> 'day' is not null`) });
  if (queued) return queued;
  let afterDay = opts.afterDay;
  for (let i = 0; i < 3; i++) {
    const runAt = nextSelicRun(now, afterDay);
    const day = todayIso(runAt);
    const job = await ctx.jobs.enqueue(SELIC_JOB, { day }, { runAt, idempotencyKey: `selic:${day}`, maxAttempts: 1 });
    if (job.status === 'queued') return job;
    afterDay = day;
  }
  return null;
}

/**
 * Ao subir: garante a rodada semanal e, sem nenhum mês gravado (instalação nova), pede uma busca
 * já (uma por dia de Brasília, até a primeira dar certo).
 */
export async function ensureSelicSchedule(ctx: AppContext, opts: { now?: Date } = {}) {
  await scheduleSelicRefresh(ctx, opts);
  const [any] = await ctx.db.select({ period: taxIndices.period }).from(taxIndices).where(eq(taxIndices.code, SELIC_CODE)).limit(1);
  if (!any) await ctx.jobs.enqueue(SELIC_JOB, {}, { idempotencyKey: `selic:inicial:${todayIso(opts.now)}`, maxAttempts: 1 });
}

/** Executor do job semanal: agenda a próxima rodada antes de buscar, para a cadeia não parar. */
export async function runSelicJob(ctx: AppContext, payload: Record<string, unknown>) {
  await scheduleSelicRefresh(ctx, { afterDay: typeof payload.day === 'string' ? payload.day : undefined });
  return refreshSelic(ctx);
}
