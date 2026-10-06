import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { jobs } from '../../db/schema';

export type JobRow = typeof jobs.$inferSelect;

/** Visão de um job para a interface (sem o payload completo). */
export function jobView(job: JobRow | null | undefined) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    error: job.error,
    result: job.result,
    attempts: job.attempts,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/** Último job de um dos tipos dados no escritório, opcionalmente filtrado por um campo do payload. */
export async function latestJob(db: Db, officeId: string, types: string[], payload?: Record<string, string>) {
  const conds: SQL[] = [eq(jobs.officeId, officeId), inArray(jobs.type, types)];
  for (const [k, v] of Object.entries(payload ?? {})) conds.push(sql`${jobs.payload}->>${k} = ${v}`);
  const [row] = await db.select().from(jobs).where(and(...conds)).orderBy(desc(jobs.createdAt)).limit(1);
  return row ?? null;
}

/** Job ainda pendente (na fila ou executando) com o mesmo tipo e payload. */
export async function pendingJob(db: Db, officeId: string, type: string, payload: Record<string, string>) {
  const conds: SQL[] = [eq(jobs.officeId, officeId), eq(jobs.type, type), inArray(jobs.status, ['queued', 'running'])];
  for (const [k, v] of Object.entries(payload)) conds.push(sql`${jobs.payload}->>${k} = ${v}`);
  const [row] = await db.select().from(jobs).where(and(...conds)).limit(1);
  return row ?? null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Normaliza datas vindas de fontes externas (AAAA-MM-DD, AAAAMMDD ou DD/MM/AAAA). */
export function normalizeDate(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (DATE.test(s)) return s;
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4}-\d{2}-\d{2})T/.exec(s);
  if (m) return m[1];
  return null;
}
