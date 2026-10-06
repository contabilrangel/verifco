import { Readable } from 'node:stream';
import { and, asc, desc, eq, gt, inArray, is, isNotNull, or, getTableColumns, type Column, type SQL } from 'drizzle-orm';
import { PgTable, getTableConfig, type PgColumn } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import * as schema from '../../db/schema';
import { files, jobs, procurators } from '../../db/schema';
import { activeJob } from '../../jobs/queue';
import { badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { notify } from '../../services/notify';
import { sendStoredFile } from '../../services/uploads';
import { ZipWriter } from '../../storage/zip';

/** Tabelas que não entram no backup (tokens de acesso e fila interna). */
const SKIP_TABLES = new Set(['password_resets', 'jobs']);
/** Colunas removidas de todas as tabelas: segredos cifrados, hashes e chaves internas. */
const isSecretColumn = (name: string) => /(_enc|_hash)$/.test(name) || ['webhook_token', 'token_version', 'storage_key'].includes(name);
/** Linhas por consulta: cada lote vai para o .zip e sai da memória antes do próximo. */
const BATCH_ROWS = 500;

export const BACKUP_README = `BACKUP DO ESCRITÓRIO — VERIFCO

O que está neste arquivo
- dados/<tabela>.json: todos os registros do escritório, uma tabela por arquivo (clientes, declarações e
  suas linhas, documentos, checklist, orçamentos, faturamento, parcelas, DARFs, mensagens, envios,
  templates, Radar, conversas e análises de IA, holding, livro caixa, copiloto, auditoria etc.).
- arquivos/: os arquivos enviados ao Verifco (documentos dos clientes, PDFs gerados, logo).
- manifesto.json: data de geração, contagem de registros por tabela e arquivos incluídos.

O que NÃO está (por segurança)
- Senhas e credenciais: senhas de usuários, logins e senhas do eCAC/gov.br e do INSS, senhas de
  certificados digitais, chaves de API de integrações e tokens de acesso (colunas cifradas ou com hash).
- Arquivos de certificados digitais (.pfx/.p12) dos procuradores.
- Backups anteriores e a fila interna de tarefas.

Guarde este arquivo em local seguro: ele contém dados pessoais e fiscais dos clientes (LGPD).
`;

type AnyRow = Record<string, unknown>;
type Db = AppContext['db'];

function sanitize(table: PgTable, rows: AnyRow[]) {
  const cols = Object.entries(getTableColumns(table)) as [string, Column][];
  const drop = cols.filter(([, c]) => isSecretColumn(c.name)).map(([k]) => k);
  return rows.map((r) => {
    const out = { ...r };
    for (const k of drop) delete out[k];
    return out;
  });
}

interface TablePlan {
  name: string;
  table: PgTable;
  /** Linhas do escritório: `office_id` ou, nas tabelas filhas, subconsulta na tabela mãe. */
  where: SQL;
}

/** Tabelas que entram no backup e o filtro de cada uma, sem carregar linhas. */
function planTables(db: Db, officeId: string): TablePlan[] {
  const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
  const nameOf = (t: PgTable) => getTableConfig(t).name;
  const plans = new Map<string, TablePlan>();

  // 1) tabelas com office_id (e o próprio escritório)
  for (const t of tables) {
    const name = nameOf(t);
    if (SKIP_TABLES.has(name)) continue;
    const cols = getTableColumns(t) as Record<string, Column>;
    if (name === 'offices') plans.set(name, { name, table: t, where: eq(cols.id, officeId) });
    else if (cols.officeId) plans.set(name, { name, table: t, where: eq(cols.officeId, officeId) });
  }
  // 2) tabelas filhas sem office_id, ligadas por chave estrangeira a uma tabela já exportada
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tables) {
      const name = nameOf(t);
      if (SKIP_TABLES.has(name) || plans.has(name)) continue;
      for (const fk of getTableConfig(t).foreignKeys) {
        const ref = fk.reference();
        const parent = plans.get(nameOf(ref.foreignTable as PgTable));
        if (!parent || ref.columns.length !== 1) continue;
        const parentKeys = db
          .select({ key: ref.foreignColumns[0] as PgColumn })
          .from(parent.table as never)
          .where(parent.where);
        plans.set(name, { name, table: t, where: inArray(ref.columns[0] as Column, parentKeys) });
        changed = true;
        break;
      }
    }
  }
  return [...plans.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Linhas da tabela em lotes, na ordem da chave primária (sem carregar a tabela inteira). */
async function* tableRows(db: Db, plan: TablePlan): AsyncGenerator<AnyRow[]> {
  const cols = Object.entries(getTableColumns(plan.table)) as [string, Column][];
  const pkCols = getTableConfig(plan.table).primaryKeys[0]?.columns ?? cols.filter(([, c]) => c.primary).map(([, c]) => c);
  const pk = pkCols.map((c) => cols.find(([, col]) => col.name === c.name)!);
  if (!pk.length) {
    yield await db.select().from(plan.table as never).where(plan.where);
    return;
  }
  // depois da última linha lida: (c1, c2...) > (v1, v2...)
  const after = (last: AnyRow, i = 0): SQL => {
    const [key, col] = pk[i];
    if (i === pk.length - 1) return gt(col, last[key]);
    return or(gt(col, last[key]), and(eq(col, last[key]), after(last, i + 1)))!;
  };
  let last: AnyRow | null = null;
  for (;;) {
    const rows: AnyRow[] = await db
      .select()
      .from(plan.table as never)
      .where(last ? and(plan.where, after(last)) : plan.where)
      .orderBy(...pk.map(([, col]) => asc(col)))
      .limit(BATCH_ROWS);
    if (rows.length) yield rows;
    if (rows.length < BATCH_ROWS) return;
    last = rows[rows.length - 1];
  }
}

/** dados/<tabela>.json em stream: o mesmo texto de `JSON.stringify(linhas, null, 2)`, lote a lote. */
function tableJson(db: Db, plan: TablePlan, onRows: (n: number) => void): Readable {
  async function* json() {
    let first = true;
    yield Buffer.from('[');
    for await (const rows of tableRows(db, plan)) {
      let out = '';
      for (const r of sanitize(plan.table, rows)) {
        out += `${first ? '\n' : ',\n'}  ${JSON.stringify(r, null, 2).replace(/\n/g, '\n  ')}`;
        first = false;
      }
      onRows(rows.length);
      yield Buffer.from(out);
    }
    yield Buffer.from(first ? ']' : '\n]');
  }
  return Readable.from(json(), { objectMode: false });
}

/**
 * Escreve no .zip os dados do escritório (uma tabela por arquivo, lida em lotes) e os arquivos
 * (cada um lido em stream). Nada fica inteiro na memória: o .zip anda no ritmo de quem grava o
 * `zip.output`.
 */
export async function buildOfficeBackup(ctx: AppContext, officeId: string, zip: ZipWriter, generatedAt: string, progress?: (pct: number) => Promise<void>) {
  const { db } = ctx;
  const plans = planTables(db, officeId);
  const counts: Record<string, number> = {};
  for (const [i, plan] of plans.entries()) {
    counts[plan.name] = 0;
    await zip.addStream(`dados/${plan.name}.json`, tableJson(db, plan, (n) => (counts[plan.name] += n)));
    await progress?.(Math.round(((i + 1) / plans.length) * 30));
  }

  // 3) arquivos (sem certificados e sem backups anteriores), lidos em lotes pela chave
  const certs = await db
    .select({ id: procurators.certificateFileId })
    .from(procurators)
    .where(and(eq(procurators.officeId, officeId), isNotNull(procurators.certificateFileId)));
  const certIds = new Set(certs.map((r) => r.id as string));
  const previous = await db.select({ result: jobs.result }).from(jobs).where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'backup.generate')));
  const backupIds = new Set(previous.map((p) => (p.result as { fileId?: string } | null)?.fileId).filter(Boolean) as string[]);
  const total = counts.files ?? 0;
  const missing: string[] = [];
  let included = 0;
  let i = 0;
  let lastId: string | null = null;
  for (;;) {
    const batch = await db
      .select({ id: files.id, filename: files.filename, storageKey: files.storageKey, createdAt: files.createdAt })
      .from(files)
      .where(and(eq(files.officeId, officeId), lastId ? gt(files.id, lastId) : undefined))
      .orderBy(asc(files.id))
      .limit(BATCH_ROWS);
    for (const f of batch) {
      i++;
      if (i % 50 === 0 && total) await progress?.(30 + Math.round((Math.min(i, total) / total) * 60));
      if (certIds.has(f.id) || backupIds.has(f.id)) continue;
      let source: Readable;
      try {
        source = await ctx.files.stream(f);
      } catch {
        missing.push(f.id);
        continue;
      }
      const safe = String(f.filename).replace(/[\\/:*?"<>|]+/g, '_');
      await zip.addStream(`arquivos/${f.id}-${safe}`, source, { mtime: f.createdAt });
      included++;
    }
    if (batch.length < BATCH_ROWS) break;
    lastId = batch[batch.length - 1].id;
  }
  zip.addBuffer('LEIAME.txt', BACKUP_README);
  zip.addBuffer(
    'manifesto.json',
    JSON.stringify({ generatedAt, officeId, tables: counts, files: included, missingFiles: missing, excludedFiles: { certificates: certIds.size, previousBackups: backupIds.size } }, null, 2),
  );
  return { counts, files: included, missing };
}

/** Tamanho legível para a notificação (o backup pode passar de alguns GB). */
const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Um backup gerado por vez neste processo: cada um lê todos os arquivos de um escritório e grava
 * um .zip do mesmo tamanho. Os pedidos seguintes esperam a vez (veja RUN_WORKER em ARQUITETURA.md).
 */
let backupSlot: Promise<unknown> = Promise.resolve();
function oneBackupAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = backupSlot.then(fn, fn);
  backupSlot = run.catch(() => undefined);
  return run;
}

export async function runBackupJob(ctx: AppContext, officeId: string, userId: string | null, progress?: (pct: number) => Promise<void>) {
  return oneBackupAtATime(async () => {
    const generatedAt = new Date().toISOString();
    const filename = `backup-verifco-${generatedAt.slice(0, 10)}.zip`;
    // o .zip vai direto para o armazenamento enquanto é montado (tamanho e sha256 no caminho)
    const zip = new ZipWriter();
    const saving = ctx.files.saveStream({ officeId, stream: zip.output, filename, mimeType: 'application/zip', userId });
    saving.catch(() => undefined);
    let built: Awaited<ReturnType<typeof buildOfficeBackup>>;
    try {
      built = await buildOfficeBackup(ctx, officeId, zip, generatedAt, progress);
      zip.end();
    } catch (err) {
      zip.abort(err instanceof Error ? err : new Error(String(err)));
      await saving.catch(() => undefined);
      throw err;
    }
    const saved = await saving;
    await progress?.(95);
    await notify(ctx.db, { officeId, userId, title: 'Backup pronto para baixar', body: `${filename} (${formatSize(saved.size)})`, link: '/backup' });
    return { fileId: saved.id, filename, size: saved.size, tables: built.counts, files: built.files, missingFiles: built.missing.length };
  });
}

export async function backupRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.get('/backups', { preHandler: guard('backup.download') }, async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.officeId, user.officeId), eq(jobs.type, 'backup.generate')))
      .orderBy(desc(jobs.createdAt))
      .limit(30);
    return rows.map((j) => ({ id: j.id, status: j.status, progress: j.progress, error: j.error, result: j.result, createdAt: j.createdAt, finishedAt: j.finishedAt }));
  });

  app.post('/backups', { preHandler: guard('backup.download') }, async (req, reply) => {
    const user = requireUser(req);
    // job de processo que caiu não segura o botão: só conta se a fila ainda vai executá-lo
    const pending = await db.query.jobs.findFirst({
      where: and(eq(jobs.officeId, user.officeId), eq(jobs.type, 'backup.generate'), activeJob()),
    });
    if (pending) return { id: pending.id, status: pending.status, alreadyRunning: true };
    const job = await app.ctx.jobs.enqueue('backup.generate', { officeId: user.officeId, userId: user.userId }, { officeId: user.officeId, userId: user.userId, maxAttempts: 2 });
    await audit(req, 'generate', 'backup', job.id);
    reply.status(202);
    return { id: job.id, status: job.status, alreadyRunning: false };
  });

  app.get('/backups/:id/download', { preHandler: guard('backup.download') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const job = await db.query.jobs.findFirst({ where: and(eq(jobs.id, id), eq(jobs.officeId, user.officeId), eq(jobs.type, 'backup.generate')) });
    if (!job) throw notFound('Backup');
    const fileId = (job.result as { fileId?: string } | null)?.fileId;
    if (job.status !== 'done' || !fileId) throw badRequest('O backup ainda não foi concluído.');
    // em stream e com Content-Length: o .zip pode passar de 2 GB (o readFile recusa)
    const { row, stream } = await app.ctx.files.open(user.officeId, fileId);
    await audit(req, 'download', 'backup', id).catch((err) => {
      stream.destroy();
      throw err;
    });
    return sendStoredFile(reply, { filename: row.filename, mimeType: 'application/zip', size: row.size }, stream);
  });
}
