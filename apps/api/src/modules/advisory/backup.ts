import { Readable } from 'node:stream';
import { and, asc, count, desc, eq, inArray, is, getTableColumns, notInArray, sql, type Column, type SQL } from 'drizzle-orm';
import { PgTable, getTableConfig, type PgColumn } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { isoDateInBrazil } from '@verifco/shared';
import type { AppContext } from '../../context';
import * as schema from '../../db/schema';
import { files as filesTable, jobs, procurators } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { notify } from '../../services/notify';
import { sendStoredFile } from '../../services/uploads';
import { ZipStream } from '../../services/zip';

/** Tabelas que não entram no backup (tokens de acesso e fila interna). */
const SKIP_TABLES = new Set(['password_resets', 'jobs']);
/** Colunas removidas de todas as tabelas: segredos cifrados, hashes e chaves internas. */
const isSecretColumn = (name: string) => /(_enc|_hash)$/.test(name) || ['webhook_token', 'token_version', 'storage_key'].includes(name);

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

/** Linhas lidas por consulta: o backup nunca carrega uma tabela inteira na memória. */
const PAGE_SIZE = 1000;

interface TablePlan {
  name: string;
  table: PgTable;
  /** Filtro das linhas do escritório (tabelas filhas seguem a chave estrangeira, por subconsulta). */
  where: SQL;
  /** Chave primária (para paginar em ordem estável) e o nome da propriedade de cada coluna na linha. */
  key: { column: Column; prop: string }[];
  /** Propriedades removidas de cada linha (segredos). */
  drop: string[];
}

/** Tabelas exportadas e o filtro de cada uma. */
function planTables(ctx: AppContext, officeId: string): TablePlan[] {
  const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
  const nameOf = (t: PgTable) => getTableConfig(t).name;
  const propOf = (t: PgTable, col: Column) => (Object.entries(getTableColumns(t)) as [string, Column][]).find(([, c]) => c.name === col.name)?.[0] ?? col.name;
  const plans = new Map<string, TablePlan>();
  const add = (t: PgTable, where: SQL) => {
    const cfg = getTableConfig(t);
    const pk = cfg.columns.filter((c) => c.primary);
    const keyCols = (pk.length ? pk : (cfg.primaryKeys[0]?.columns ?? [])) as Column[];
    const cols = Object.entries(getTableColumns(t)) as [string, Column][];
    plans.set(cfg.name, {
      name: cfg.name,
      table: t,
      where,
      key: keyCols.map((column) => ({ column, prop: propOf(t, column) })),
      drop: cols.filter(([, c]) => isSecretColumn(c.name)).map(([k]) => k),
    });
  };

  // 1) tabelas com office_id (e o próprio escritório)
  for (const t of tables) {
    const name = nameOf(t);
    if (SKIP_TABLES.has(name)) continue;
    const cols = getTableColumns(t) as Record<string, Column>;
    if (name === 'offices') add(t, eq(cols.id, officeId));
    else if (cols.officeId) add(t, eq(cols.officeId, officeId));
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
        const parentKeys = ctx.db
          .select({ k: ref.foreignColumns[0] as PgColumn })
          .from(parent.table as never)
          .where(parent.where);
        add(t, inArray(ref.columns[0] as Column, parentKeys));
        changed = true;
        break;
      }
    }
  }
  return [...plans.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Linhas da tabela em JSON (uma por linha do arquivo), lidas em páginas pela chave primária. */
async function* tableJson(ctx: AppContext, plan: TablePlan, counter: { rows: number }): AsyncGenerator<string> {
  yield '[';
  let after: unknown[] | null = null;
  for (;;) {
    const conds = [plan.where];
    if (after) {
      const cols = sql.join(
        plan.key.map((k) => sql`${k.column}`),
        sql`, `,
      );
      const vals = sql.join(
        after.map((v) => sql`${v}`),
        sql`, `,
      );
      conds.push(sql`(${cols}) > (${vals})`);
    }
    const rows = (await ctx.db
      .select()
      .from(plan.table as never)
      .where(and(...conds))
      .orderBy(...plan.key.map((k) => asc(k.column)))
      .limit(PAGE_SIZE)) as AnyRow[];
    if (!rows.length) break;
    let chunk = '';
    for (const r of rows) {
      const out = { ...r };
      for (const k of plan.drop) delete out[k];
      chunk += `${counter.rows++ ? ',' : ''}\n${JSON.stringify(out)}`;
    }
    yield chunk;
    if (rows.length < PAGE_SIZE || !plan.key.length) break;
    const last = rows[rows.length - 1];
    after = plan.key.map((k) => last[k.prop]);
  }
  yield '\n]\n';
}

/**
 * Escreve no .zip os dados e os arquivos do escritório, em fluxo: tabelas lidas em páginas e
 * arquivos lidos um de cada vez do armazenamento. A memória usada não depende do tamanho do
 * escritório, e o .zip passa de 4 GB (ZIP64) se preciso.
 */
export async function buildOfficeBackup(ctx: AppContext, officeId: string, zip: ZipStream, progress?: (pct: number) => Promise<void>) {
  const { db } = ctx;
  const generatedAt = new Date().toISOString();
  zip.addBuffer('LEIAME.txt', BACKUP_README);

  // 1) dados, uma tabela por arquivo
  const plans = planTables(ctx, officeId);
  const counts: Record<string, number> = {};
  for (const [i, plan] of plans.entries()) {
    const counter = { rows: 0 };
    await zip.addStream(`dados/${plan.name}.json`, Readable.from(tableJson(ctx, plan, counter)));
    counts[plan.name] = counter.rows;
    await progress?.(Math.round(((i + 1) / plans.length) * 30));
  }

  // 2) arquivos (sem certificados e sem backups anteriores)
  const certRows = await db.select({ id: procurators.certificateFileId }).from(procurators).where(eq(procurators.officeId, officeId));
  const certIds = certRows.map((r) => r.id).filter(Boolean) as string[];
  const previous = await db
    .select({ result: jobs.result })
    .from(jobs)
    .where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'backup.generate')));
  const backupIds = previous.map((p) => (p.result as { fileId?: string } | null)?.fileId).filter(Boolean) as string[];
  const excluded = [...new Set([...certIds, ...backupIds])];
  const fileFilter = and(eq(filesTable.officeId, officeId), excluded.length ? notInArray(filesTable.id, excluded) : undefined);
  const [{ total }] = await db.select({ total: count() }).from(filesTable).where(fileFilter);
  let done = 0;
  let after: string | null = null;
  for (;;) {
    const page = await db
      .select({ id: filesTable.id, filename: filesTable.filename, storageKey: filesTable.storageKey })
      .from(filesTable)
      .where(and(fileFilter, after ? sql`${filesTable.id} > ${after}` : undefined))
      .orderBy(asc(filesTable.id))
      .limit(PAGE_SIZE);
    for (const f of page) {
      const safe = String(f.filename).replace(/[\\/:*?"<>|]+/g, '_');
      await zip.addStoredFile(ctx, f, `arquivos/${f.id}-${safe}`);
      done++;
      if (done % 50 === 0) await progress?.(30 + Math.round((done / Math.max(1, total)) * 65));
    }
    if (page.length < PAGE_SIZE) break;
    after = page[page.length - 1].id;
  }
  const included = done - zip.missing.length;
  zip.addBuffer(
    'manifesto.json',
    JSON.stringify(
      {
        generatedAt,
        officeId,
        tables: counts,
        files: included,
        missingFiles: zip.missing,
        excludedFiles: { certificates: certIds.length, previousBackups: backupIds.length },
      },
      null,
      2,
    ),
  );
  zip.end();
  return { generatedAt, counts, files: included, missing: zip.missing };
}

/** Gera o backup gravando o .zip direto no armazenamento, enquanto ele é montado. */
export async function runBackupJob(ctx: AppContext, officeId: string, userId: string | null, progress?: (pct: number) => Promise<void>) {
  const filename = `backup-verifco-${isoDateInBrazil(new Date())}.zip`;
  const zip = new ZipStream();
  const saving = ctx.files.saveStream({ officeId, stream: zip.output, filename, mimeType: 'application/zip', userId });
  const building = buildOfficeBackup(ctx, officeId, zip, progress).catch((err) => {
    zip.abort(err);
    throw err;
  });
  const [built, saved] = await Promise.all([building, saving]);
  const sizeText =
    saved.size >= 1024 * 1024 ? `${(saved.size / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(saved.size / 1024))} KB`;
  await notify(ctx.db, { officeId, userId, title: 'Backup pronto para baixar', body: `${filename} (${sizeText})`, link: '/backup' });
  return { fileId: saved.id, filename, size: saved.size, tables: built.counts, files: built.files, missingFiles: built.missing.length };
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
    // `pending` devolve antes à fila um backup preso em "running" por um processo que caiu
    const pending = await app.ctx.jobs.pending(user.officeId, 'backup.generate');
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
    // em fluxo: o backup pode passar de 2 GB (o readFile do Node não lê) e não cabe na memória
    const { row, stream } = await app.ctx.files.open(user.officeId, fileId);
    await audit(req, 'download', 'backup', id);
    return sendStoredFile(reply, { filename: row.filename, mimeType: 'application/zip', size: row.size }, stream);
  });
}
