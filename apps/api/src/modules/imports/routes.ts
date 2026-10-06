import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IMPORT_KINDS, IMPORT_KIND_LIST, IMPORT_MAX_ROWS, isImportKind, type ImportKind } from '@verifco/shared';
import type { AuthUser } from '../../context';
import { files, importBatches, users } from '../../db/schema';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { audit, can, paginate, paginationSchema, parse, requirePermission, requireUser, uuidParam } from '../../lib/http';
import { buildWorkbook } from '../../services/xlsx';
import { PROCESSORS } from './processors';
import { COLUMNS, hasColumn, readImportFile, type SheetRow } from './sheet';
import { buildTemplate } from './templates';

const kindParam = z.object({ kind: z.string() });

/** Tipo válido da URL ou 404. */
function kindOf(raw: string): ImportKind {
  if (!isImportKind(raw)) throw notFound('Tipo de importação');
  return raw;
}

/** Colunas que precisam aparecer preenchidas em ao menos uma linha para o arquivo ser deste tipo. */
const SIGNATURE_COLUMNS: Record<ImportKind, { aliases: readonly string[]; label: string }[]> = {
  'novos-clientes': [
    { aliases: COLUMNS.name, label: 'Nome' },
    { aliases: COLUMNS.cpf, label: 'CPF' },
  ],
  'atualizar-clientes': [{ aliases: COLUMNS.cpf, label: 'CPF' }],
  procuracoes: [
    { aliases: COLUMNS.cpf, label: 'CPF' },
    { aliases: COLUMNS.procurator, label: 'CPF/CNPJ do procurador' },
  ],
  inss: [
    { aliases: COLUMNS.cpf, label: 'CPF' },
    { aliases: COLUMNS.inssPassword, label: 'Senha gov.br' },
  ],
  ecac: [
    { aliases: COLUMNS.cpf, label: 'CPF' },
    { aliases: COLUMNS.ecacPassword, label: 'Senha' },
  ],
};

const allowedKinds = (user: AuthUser) => IMPORT_KIND_LIST.filter((k) => can(user, k.permission)).map((k) => k.slug);

export async function importRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  /** Modelo .xlsx; nos tipos de atualização vem com os clientes do escritório. */
  app.get('/imports/:kind/template', async (req, reply) => {
    requireUser(req);
    const kind = kindOf(parse(kindParam, req.params).kind);
    const user = requirePermission(req, IMPORT_KINDS[kind].permission);
    const buf = await buildTemplate(app.ctx, user, kind);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="modelo-${kind}.xlsx"`)
      .send(buf);
  });

  /** Recebe a planilha, processa linha a linha e grava o lote com o resultado de cada linha. */
  app.post('/imports/:kind', async (req, reply) => {
    requireUser(req);
    const kind = kindOf(parse(kindParam, req.params).kind);
    const def = IMPORT_KINDS[kind];
    const user = requirePermission(req, def.permission);

    const file = await req.file();
    if (!file) throw badRequest('Envie a planilha (.xlsx ou .csv).');
    if (!/\.(xlsx|csv)$/i.test(file.filename)) throw badRequest('Formato não aceito. Envie um arquivo .xlsx ou .csv.');
    const data = await file.toBuffer();

    let rows: SheetRow[];
    try {
      rows = await readImportFile(data, file.filename);
    } catch (err) {
      req.log.warn({ err }, 'planilha ilegível');
      throw badRequest('Não foi possível ler o arquivo. Confira se é um .xlsx ou .csv válido.');
    }
    if (!rows.length) throw badRequest('A planilha não tem linhas preenchidas.');
    if (rows.length > IMPORT_MAX_ROWS) {
      throw badRequest(`A planilha tem ${rows.length.toLocaleString('pt-BR')} linhas; o limite é ${IMPORT_MAX_ROWS.toLocaleString('pt-BR')} por arquivo. Divida em mais arquivos.`);
    }
    for (const col of SIGNATURE_COLUMNS[kind]) {
      if (!hasColumn(rows, col.aliases)) {
        throw badRequest(`Nenhuma linha com a coluna “${col.label}” preenchida. Confira se usou o modelo desta importação.`);
      }
    }

    const { results, ignored } = await PROCESSORS[kind](app.ctx, user, rows, (err) => req.log.error({ err }, 'falha ao importar linha'));
    results.sort((a, b) => a.row - b.row);
    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;

    // planilhas com senha não são guardadas: o conteúdo já foi cifrado nos clientes
    const saved = def.hasSecrets
      ? null
      : await app.ctx.files.save({ officeId: user.officeId, data, filename: file.filename, mimeType: file.mimetype, userId: user.userId });

    const [batch] = await db
      .insert(importBatches)
      .values({
        officeId: user.officeId,
        kind,
        fileId: saved?.id ?? null,
        status: failed === 0 ? 'done' : succeeded === 0 ? 'failed' : 'partial',
        total: results.length,
        succeeded,
        failed,
        results,
        createdByUserId: user.userId,
      })
      .returning();
    await audit(req, 'import', 'import_batch', batch.id, { kind, total: batch.total, succeeded, failed, ignored });
    reply.status(201);
    return { ...batch, filename: file.filename, ignored, createdByName: user.name };
  });

  /** Histórico de importações dos tipos que o usuário pode usar. */
  app.get('/imports', async (req) => {
    const user = requireUser(req);
    const q = parse(paginationSchema.extend({ kind: z.string().optional(), pageSize: z.coerce.number().int().min(1).max(100).default(10) }), req.query);
    let kinds = allowedKinds(user);
    if (q.kind) {
      const kind = kindOf(q.kind);
      if (!kinds.includes(kind)) throw forbidden();
      kinds = [kind];
    }
    if (!kinds.length) throw forbidden();
    const where = and(eq(importBatches.officeId, user.officeId), inArray(importBatches.kind, kinds));
    const [{ total }] = await db.select({ total: count() }).from(importBatches).where(where);
    const rows = await db
      .select({
        id: importBatches.id,
        kind: importBatches.kind,
        status: importBatches.status,
        total: importBatches.total,
        succeeded: importBatches.succeeded,
        failed: importBatches.failed,
        fileId: importBatches.fileId,
        filename: files.filename,
        createdAt: importBatches.createdAt,
        createdByName: users.name,
      })
      .from(importBatches)
      .leftJoin(users, eq(users.id, importBatches.createdByUserId))
      .leftJoin(files, eq(files.id, importBatches.fileId))
      .where(where)
      .orderBy(desc(importBatches.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return paginate(rows, total, q.page, q.pageSize);
  });

  /** Carrega um lote do escritório conferindo a permissão do tipo. */
  async function loadBatch(req: Parameters<typeof requireUser>[0]) {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const [row] = await db
      .select({ b: importBatches, filename: files.filename, createdByName: users.name })
      .from(importBatches)
      .leftJoin(users, eq(users.id, importBatches.createdByUserId))
      .leftJoin(files, eq(files.id, importBatches.fileId))
      .where(and(eq(importBatches.id, id), eq(importBatches.officeId, user.officeId)));
    if (!row || !isImportKind(row.b.kind)) throw notFound('Importação');
    requirePermission(req, IMPORT_KINDS[row.b.kind].permission);
    return { ...row.b, filename: row.filename, createdByName: row.createdByName };
  }

  app.get('/imports/:id', async (req) => loadBatch(req));

  /** Resultado linha a linha em Excel, para corrigir a planilha original. */
  app.get('/imports/:id/report', async (req, reply) => {
    const batch = await loadBatch(req);
    const buf = await buildWorkbook([
      {
        name: 'Resultado',
        columns: [
          { header: 'Linha', key: 'row', width: 10, type: 'number' },
          { header: 'Situação', key: 'status', width: 14 },
          { header: 'Mensagem', key: 'message', width: 100 },
        ],
        rows: batch.results.map((r) => ({ row: r.row, status: r.ok ? 'Importada' : 'Com erro', message: r.message })),
      },
    ]);
    const stamp = batch.createdAt.toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="resultado-${batch.kind}-${stamp}.xlsx"`)
      .send(buf);
  });
}
