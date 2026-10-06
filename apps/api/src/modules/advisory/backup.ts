import JSZip from 'jszip';
import { and, desc, eq, inArray, is, getTableColumns, type Column } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import * as schema from '../../db/schema';
import { jobs } from '../../db/schema';
import { activeJob } from '../../jobs/queue';
import { badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { notify } from '../../services/notify';
import { sendStoredFile } from '../../services/uploads';

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

function sanitize(table: PgTable, rows: AnyRow[]) {
  const cols = Object.entries(getTableColumns(table)) as [string, Column][];
  const drop = cols.filter(([, c]) => isSecretColumn(c.name)).map(([k]) => k);
  return rows.map((r) => {
    const out = { ...r };
    for (const k of drop) delete out[k];
    return out;
  });
}

/** Monta o .zip com os dados do escritório e os arquivos. */
export async function buildOfficeBackup(ctx: AppContext, officeId: string, progress?: (pct: number) => Promise<void>) {
  const { db } = ctx;
  const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
  const nameOf = (t: PgTable) => getTableConfig(t).name;
  const exported = new Map<string, { table: PgTable; rows: AnyRow[] }>();
  const keyOf = (t: PgTable, col: Column) => (Object.entries(getTableColumns(t)) as [string, Column][]).find(([, c]) => c.name === col.name)?.[0];

  // 1) tabelas com office_id (e o próprio escritório)
  for (const t of tables) {
    const name = nameOf(t);
    if (SKIP_TABLES.has(name)) continue;
    const cols = getTableColumns(t) as Record<string, Column>;
    let rows: AnyRow[] | null = null;
    if (name === 'offices') rows = await db.select().from(t as never).where(eq(cols.id, officeId));
    else if (cols.officeId) rows = await db.select().from(t as never).where(eq(cols.officeId, officeId));
    if (rows) exported.set(name, { table: t, rows });
  }
  // 2) tabelas filhas sem office_id, ligadas por chave estrangeira a uma tabela já exportada
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tables) {
      const name = nameOf(t);
      if (SKIP_TABLES.has(name) || exported.has(name)) continue;
      for (const fk of getTableConfig(t).foreignKeys) {
        const ref = fk.reference();
        const parent = exported.get(nameOf(ref.foreignTable as PgTable));
        if (!parent || ref.columns.length !== 1) continue;
        const parentKey = keyOf(parent.table, ref.foreignColumns[0] as Column);
        const ids = [...new Set(parent.rows.map((r) => r[parentKey ?? 'id']).filter(Boolean))] as string[];
        const rows: AnyRow[] = [];
        for (let i = 0; i < ids.length; i += 1000) {
          rows.push(...(await db.select().from(t as never).where(inArray(ref.columns[0] as Column, ids.slice(i, i + 1000)))));
        }
        exported.set(name, { table: t, rows });
        changed = true;
        break;
      }
    }
  }
  await progress?.(30);

  const zip = new JSZip();
  const counts: Record<string, number> = {};
  for (const [name, { table, rows }] of [...exported.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    counts[name] = rows.length;
    zip.file(`dados/${name}.json`, JSON.stringify(sanitize(table, rows), null, 2));
  }

  // 3) arquivos (sem certificados e sem backups anteriores)
  const certIds = new Set((exported.get('procurators')?.rows ?? []).map((r) => r.certificateFileId).filter(Boolean) as string[]);
  const previous = await db.select({ result: jobs.result }).from(jobs).where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'backup.generate')));
  const backupIds = new Set(previous.map((p) => (p.result as { fileId?: string } | null)?.fileId).filter(Boolean) as string[]);
  const fileRows = (exported.get('files')?.rows ?? []).filter((f) => !certIds.has(f.id as string) && !backupIds.has(f.id as string));
  const missing: string[] = [];
  let i = 0;
  for (const f of fileRows) {
    try {
      const { data } = await ctx.files.get(officeId, f.id as string);
      const safe = String(f.filename).replace(/[\\/:*?"<>|]+/g, '_');
      zip.file(`arquivos/${f.id}-${safe}`, data);
    } catch {
      missing.push(f.id as string);
    }
    i++;
    if (i % 50 === 0) await progress?.(30 + Math.round((i / fileRows.length) * 60));
  }
  const generatedAt = new Date().toISOString();
  zip.file('LEIAME.txt', BACKUP_README);
  zip.file(
    'manifesto.json',
    JSON.stringify({ generatedAt, officeId, tables: counts, files: fileRows.length - missing.length, missingFiles: missing, excludedFiles: { certificates: certIds.size, previousBackups: backupIds.size } }, null, 2),
  );
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await progress?.(95);
  return { data, generatedAt, counts, files: fileRows.length - missing.length, missing };
}

export async function runBackupJob(ctx: AppContext, officeId: string, userId: string | null, progress?: (pct: number) => Promise<void>) {
  const built = await buildOfficeBackup(ctx, officeId, progress);
  const filename = `backup-verifco-${built.generatedAt.slice(0, 10)}.zip`;
  const saved = await ctx.files.save({ officeId, data: built.data, filename, mimeType: 'application/zip', userId });
  await notify(ctx.db, { officeId, userId, title: 'Backup pronto para baixar', body: `${filename} (${Math.round(saved.size / 1024)} KB)`, link: '/backup' });
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
    const { row, data } = await app.ctx.files.get(user.officeId, fileId);
    await audit(req, 'download', 'backup', id);
    return sendStoredFile(reply, { filename: row.filename, mimeType: 'application/zip' }, data);
  });
}
