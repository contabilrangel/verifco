import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { parseBrDate } from '@verifco/shared';
import type { Db } from '../../db/client';
import { jobs } from '../../db/schema';
import { activeJob } from '../../jobs/queue';

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

/**
 * Job ainda pendente (na fila ou executando) com o mesmo tipo e payload. O de um processo que caiu
 * só conta enquanto a fila ainda vai retomá-lo (lease vigente ou tentativas sobrando).
 */
export async function pendingJob(db: Db, officeId: string, type: string, payload: Record<string, string>) {
  const conds: SQL[] = [eq(jobs.officeId, officeId), eq(jobs.type, type), activeJob()];
  for (const [k, v] of Object.entries(payload)) conds.push(sql`${jobs.payload}->>${k} = ${v}`);
  const [row] = await db.select().from(jobs).where(and(...conds)).limit(1);
  return row ?? null;
}

/**
 * Andamento de um job dividido em um job por cliente (ex.: `ecac.sync_office`), guardado no
 * payload do pai: a fila regrava `result` e `progress` do pai quando ele termina, o payload não.
 */
export interface Fanout {
  total: number;
  ok: number;
  failed: number;
  errors: { customerId: string; name: string; error: string }[];
  /** Quando o último filho terminou (e o aviso de conclusão foi enviado). */
  finishedAt?: string | null;
}

export function fanoutOf(job: JobRow): Fanout | null {
  const f = job.payload?.fanout as Partial<Fanout> | undefined;
  if (!f || typeof f.total !== 'number') return null;
  return { total: f.total, ok: Number(f.ok ?? 0), failed: Number(f.failed ?? 0), errors: Array.isArray(f.errors) ? f.errors : [], finishedAt: f.finishedAt ?? null };
}

/**
 * Visão do pai de um job dividido: segue "executando" até o último filho terminar, com o progresso
 * deles. Numa rodada agendada, vale o horário marcado (o job é criado um dia antes).
 */
export function summarizeOfficeChildren(children: JobRow[]): Fanout {
  const failed = children.filter((k) => k.status === 'failed');
  return {
    total: children.length,
    ok: children.filter((k) => k.status === 'done').length,
    failed: failed.length,
    errors: failed.slice(0, 50).map((k) => ({ customerId: String(k.payload.customerId), name: String(k.payload.customerName ?? k.payload.customerId), error: k.error ?? 'A sincronização foi interrompida.' })),
  };
}

export async function fanoutJobView(db: Db, job: JobRow | null | undefined) {
  const base = jobView(job);
  const view = base && job!.runAt > job!.createdAt ? { ...base, createdAt: job!.runAt } : base;
  if (!view) return view;
  const children = await db.select().from(jobs).where(eq(jobs.parentId, job!.id));
  const stored = fanoutOf(job!);
  const fan = children.length ? { ...summarizeOfficeChildren(children), finishedAt: stored?.finishedAt } : stored;
  if (!fan || job!.status === 'failed') return view;
  const finished = fan.ok + fan.failed;
  const running = finished < fan.total;
  return {
    ...view,
    status: running || job!.status !== 'done' ? 'running' : 'done',
    progress: fan.total ? Math.floor((finished / fan.total) * 100) : 100,
    result: { ...(view.result ?? {}), total: fan.total, ok: fan.ok, failed: fan.failed, errors: fan.errors },
    finishedAt: running ? null : fan.finishedAt ? new Date(fan.finishedAt) : view.finishedAt,
  };
}

/** Normaliza datas vindas de fontes externas (AAAA-MM-DD, AAAAMMDD ou DD/MM/AAAA). */
export function normalizeDate(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  return parseBrDate(compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : s);
}
