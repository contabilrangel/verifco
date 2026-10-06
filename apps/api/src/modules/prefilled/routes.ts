import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatCpfCnpj, onlyDigits } from '@verifco/shared';
import { customers, files, prefilledStatements, procurators } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { customerScope, getCustomerForUser } from '../../services/customers';
import { safeZipName, sendStoredFile } from '../../services/uploads';
import { ZipStream, assertZipSize } from '../../services/zip';
import { readMultipart } from '../sync/multipart';
import { savePrefilled } from './service';

const listQuery = z.object({
  year: yearSchema,
  search: z.string().trim().optional(),
  filter: z.enum(['with_files', 'new', 'without_files', 'without_procurator']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

/** Pré-preenchidas IRPF: arquivos obtidos pelo robô por cliente/exercício e downloads. */
export async function prefilledRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.get('/prefilled', { preHandler: guard('prefilled.download') }, async (req) => {
    const user = requireUser(req);
    const q = parse(listQuery, req.query);
    const conds: SQL[] = [await customerScope(app.ctx, user), eq(customers.status, 'active')];
    if (q.search) {
      const digits = onlyDigits(q.search);
      const or1: SQL[] = [ilike(customers.name, `%${q.search}%`)];
      if (digits.length >= 3) or1.push(ilike(customers.cpfCnpj, `%${digits}%`));
      conds.push(or(...or1)!);
    }
    const rows = await db
      .select({ id: customers.id, name: customers.name, cpfCnpj: customers.cpfCnpj, procurationStatus: customers.procurationStatus, procuratorName: procurators.name })
      .from(customers)
      .leftJoin(procurators, eq(procurators.id, customers.procuratorId))
      .where(and(...conds))
      .orderBy(asc(customers.name));
    const statements = rows.length
      ? await db
          .select({ id: prefilledStatements.id, customerId: prefilledStatements.customerId, fetchedAt: prefilledStatements.fetchedAt, downloadedAt: prefilledStatements.downloadedAt, filename: files.filename, size: files.size })
          .from(prefilledStatements)
          .innerJoin(files, eq(files.id, prefilledStatements.fileId))
          .where(and(eq(prefilledStatements.officeId, user.officeId), eq(prefilledStatements.exerciseYear, q.year), inArray(prefilledStatements.customerId, rows.map((r) => r.id))))
          .orderBy(desc(prefilledStatements.fetchedAt))
      : [];
    const byCustomer = new Map<string, typeof statements>();
    for (const s of statements) byCustomer.set(s.customerId, [...(byCustomer.get(s.customerId) ?? []), s]);
    const all = rows.map((r) => {
      const docs = (byCustomer.get(r.id) ?? []).map(({ customerId, ...d }) => d);
      return {
        customerId: r.id,
        name: r.name,
        cpfCnpj: r.cpfCnpj,
        procuratorName: r.procuratorName,
        procurationStatus: r.procurationStatus,
        documents: docs,
        newCount: docs.filter((d) => !d.downloadedAt).length,
      };
    });
    const summary = {
      customers: all.length,
      withFiles: all.filter((r) => r.documents.length).length,
      newFiles: all.reduce((n, r) => n + r.newCount, 0),
      withoutProcurator: all.filter((r) => !r.procuratorName).length,
    };
    const filtered = all.filter((r) =>
      q.filter === 'with_files' ? r.documents.length > 0 : q.filter === 'new' ? r.newCount > 0 : q.filter === 'without_files' ? !r.documents.length : q.filter === 'without_procurator' ? !r.procuratorName : true,
    );
    const start = (q.page - 1) * q.pageSize;
    return { data: filtered.slice(start, start + q.pageSize), total: filtered.length, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(filtered.length / q.pageSize)), summary };
  });

  /** Download individual: marca o arquivo como baixado. */
  app.get('/prefilled/:id/download', { preHandler: guard('prefilled.download') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const st = await db.query.prefilledStatements.findFirst({ where: and(eq(prefilledStatements.id, id), eq(prefilledStatements.officeId, user.officeId)) });
    if (!st) throw notFound('Arquivo');
    await getCustomerForUser(app.ctx, user, st.customerId);
    const { row, data } = await app.ctx.files.get(user.officeId, st.fileId);
    if (!st.downloadedAt) await db.update(prefilledStatements).set({ downloadedAt: new Date() }).where(eq(prefilledStatements.id, st.id));
    return sendStoredFile(reply, row, data);
  });

  /**
   * "Baixar novos" (`mode: new`, só os ainda não baixados) ou "Baixar todos" (`mode: all`,
   * inclui os anteriores) do exercício, em .zip. Marca `downloadedAt` dos que ainda não tinham.
   */
  app.post('/prefilled/download', { preHandler: guard('prefilled.download') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ year: yearSchema, mode: z.enum(['new', 'all']), customerIds: z.array(z.uuid()).max(2000).optional() }), req.body);
    const conds: SQL[] = [await customerScope(app.ctx, user), eq(prefilledStatements.exerciseYear, body.year), eq(prefilledStatements.officeId, user.officeId)];
    if (body.mode === 'new') conds.push(isNull(prefilledStatements.downloadedAt));
    if (body.customerIds?.length) conds.push(inArray(prefilledStatements.customerId, body.customerIds));
    const rows = await db
      .select({ st: prefilledStatements, name: customers.name, cpf: customers.cpfCnpj, filename: files.filename, size: files.size })
      .from(prefilledStatements)
      .innerJoin(customers, eq(customers.id, prefilledStatements.customerId))
      .innerJoin(files, eq(files.id, prefilledStatements.fileId))
      .where(and(...conds))
      .orderBy(asc(customers.name), desc(prefilledStatements.fetchedAt));
    if (!rows.length) throw notFound(body.mode === 'new' ? 'Arquivo novo' : 'Arquivo');
    assertZipSize(rows.reduce((a, r) => a + r.size, 0), 'Baixe por partes (selecione menos clientes).');
    const pending = rows.filter((r) => !r.st.downloadedAt).map((r) => r.st.id);
    if (pending.length) await db.update(prefilledStatements).set({ downloadedAt: new Date() }).where(inArray(prefilledStatements.id, pending));
    await audit(req, 'prefilled_download', 'prefilled_statement', null, { year: body.year, mode: body.mode, count: rows.length });
    const name = `pre-preenchidas-${body.year}-${body.mode === 'new' ? 'novas' : 'todas'}.zip`;

    // .zip em fluxo: cada arquivo é lido do armazenamento enquanto o navegador baixa
    const output = new ZipStream().produce(
      async (zip) => {
        const used = new Set<string>();
        for (const r of rows) {
          const folder = safeZipName(`${formatCpfCnpj(r.cpf)} - ${r.name}`);
          let path = `${folder}/${safeZipName(r.filename)}`;
          for (let n = 2; used.has(path); n++) path = `${folder}/${safeZipName(r.filename).replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`)}`;
          used.add(path);
          await zip.addFile(app.ctx, user.officeId, r.st.fileId, path);
        }
        zip.end('Estes arquivos não foram encontrados no armazenamento e ficaram de fora do .zip:');
      },
      (err) => req.log.error({ err }, 'falha ao montar o .zip das pré-preenchidas'),
    );
    return sendStoredFile(reply, { filename: name, mimeType: 'application/zip' }, output);
  });

  /** Envio manual do arquivo da pré-preenchida (quando o escritório baixou por fora do robô). */
  app.post('/prefilled/upload', { preHandler: guard('ecac.sync') }, async (req, reply) => {
    const user = requireUser(req);
    const { file, fields } = await readMultipart(req);
    if (!file) throw badRequest('Envie o arquivo no campo "file".');
    const f = parse(z.object({ customerId: z.uuid(), year: yearSchema }), fields);
    const customer = await getCustomerForUser(app.ctx, user, f.customerId);
    const { statement, duplicate } = await savePrefilled(app.ctx, { officeId: user.officeId, customer, year: f.year, file, userId: user.userId });
    await audit(req, 'upload', 'prefilled_statement', statement.id, { customerId: customer.id, year: f.year });
    reply.status(duplicate ? 200 : 201);
    return { id: statement.id, duplicate };
  });
}
