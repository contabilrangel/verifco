import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MACHINE_TOKEN_SCOPES, isValidCpfCnpj, onlyDigits, type MachineTokenScope } from '@verifco/shared';
import { apiTokens, customers, documents, ecacRecords, files, offices, prefilledStatements, procurators, users } from '../../db/schema';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { recordInputSchema, saveEcacRecord } from '../ecac/records';
import { loadSerproModule, requireSerpro } from '../ecac/serpro';
import { jobView, latestJob, pendingJob } from '../ecac/util';
import { savePrefilled } from '../prefilled/service';
import { customerByDoc, ingestSyncFile, machineAudit, resolveFileTarget } from './ingest';
import { readMultipart } from './multipart';
import { PACKAGES, buildPackageZip, type PackageName } from './packages';
import { generateMachineToken, publicToken, requireMachine } from './tokens';
import { customerScope } from '../../services/customers';

const SCOPES = Object.keys(MACHINE_TOKEN_SCOPES) as [MachineTokenScope, ...MachineTokenScope[]];

const machineRecordSchema = recordInputSchema.extend({
  cpf: z.string().refine((v) => isValidCpfCnpj(v), 'CPF/CNPJ inválido'),
  file: z
    .object({
      filename: z.string().trim().min(1).max(200),
      mimeType: z.string().max(100).optional(),
      base64: z.string().min(1).max(14_000_000),
    })
    .optional(),
});

/**
 * Robô: tokens de máquina (Administração › Robô) e a API usada pela extensão do navegador e
 * pelo sincronizador local (`/api/sync/*`, autenticada por `Authorization: Bearer vfk_...`).
 */
export async function syncRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  // ------------------------------------------------------------------ tokens
  app.get('/robot/tokens', { preHandler: guard('ecac.robot') }, async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select({ t: apiTokens, createdByName: users.name })
      .from(apiTokens)
      .leftJoin(users, eq(users.id, apiTokens.createdByUserId))
      .where(eq(apiTokens.officeId, user.officeId))
      .orderBy(asc(apiTokens.revokedAt), desc(apiTokens.createdAt));
    return rows.map((r) => ({ ...publicToken(r.t), createdByName: r.createdByName }));
  });

  /** Cria um token; o valor aparece só nesta resposta. */
  app.post('/robot/tokens', { preHandler: guard('ecac.robot') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ name: z.string().trim().min(2).max(80), scope: z.enum(SCOPES) }), req.body);
    const { token, hash, prefix } = generateMachineToken();
    const [row] = await db.insert(apiTokens).values({ officeId: user.officeId, name: body.name, scope: body.scope, tokenHash: hash, prefix, createdByUserId: user.userId }).returning();
    await audit(req, 'create', 'api_token', row.id, { name: row.name, scope: row.scope });
    reply.status(201);
    return { ...publicToken(row), token };
  });

  app.delete('/robot/tokens/:id', { preHandler: guard('ecac.robot') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const [row] = await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.officeId, user.officeId), isNull(apiTokens.revokedAt)))
      .returning();
    if (!row) throw notFound('Token ativo');
    await audit(req, 'revoke', 'api_token', row.id, { name: row.name });
    return publicToken(row);
  });

  // ------------------------------------------------------------------ painel do robô
  app.get('/robot/overview', { preHandler: guard('ecac.robot', 'ecac.sync') }, async (req) => {
    const user = requireUser(req);
    const officeId = user.officeId;
    const [{ n: withProcurator }] = await db
      .select({ n: count() })
      .from(customers)
      .where(and(eq(customers.officeId, officeId), isNull(customers.deletedAt), isNotNull(customers.procuratorId)));
    const [{ n: activeTokens }] = await db.select({ n: count() }).from(apiTokens).where(and(eq(apiTokens.officeId, officeId), isNull(apiTokens.revokedAt)));
    // a atividade cita clientes: respeita a restrição "contadores veem só seus clientes"
    const scope = await customerScope(ctx, user);
    const recentFiles = await db
      .select({ at: documents.createdAt, name: customers.name, customerId: customers.id, filename: files.filename, category: documents.category })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .innerJoin(customers, eq(customers.id, documents.customerId))
      .where(and(eq(documents.officeId, officeId), eq(documents.uploadedBy, 'sync'), scope))
      .orderBy(desc(documents.createdAt))
      .limit(15);
    const recentRecords = await db
      .select({ at: ecacRecords.fetchedAt, name: customers.name, customerId: customers.id, kind: ecacRecords.kind, source: ecacRecords.source })
      .from(ecacRecords)
      .innerJoin(customers, eq(customers.id, ecacRecords.customerId))
      .where(and(eq(ecacRecords.officeId, officeId), inArray(ecacRecords.source, ['extension', 'sync', 'serpro']), scope))
      .orderBy(desc(ecacRecords.fetchedAt))
      .limit(15);
    const recentPrefilled = await db
      .select({ at: prefilledStatements.fetchedAt, name: customers.name, customerId: customers.id, filename: files.filename, year: prefilledStatements.exerciseYear })
      .from(prefilledStatements)
      .innerJoin(files, eq(files.id, prefilledStatements.fileId))
      .innerJoin(customers, eq(customers.id, prefilledStatements.customerId))
      .where(and(eq(prefilledStatements.officeId, officeId), scope))
      .orderBy(desc(prefilledStatements.fetchedAt))
      .limit(15);
    const activity = [
      ...recentFiles.map((r) => ({ at: r.at, type: 'file' as const, customerId: r.customerId, customerName: r.name, detail: r.filename, category: r.category })),
      ...recentRecords.map((r) => ({ at: r.at, type: 'record' as const, customerId: r.customerId, customerName: r.name, detail: r.kind, category: r.source })),
      ...recentPrefilled.map((r) => ({ at: r.at, type: 'prefilled' as const, customerId: r.customerId, customerName: r.name, detail: r.filename, category: String(r.year) })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 20);
    return {
      customersWithProcurator: withProcurator,
      activeTokens,
      // ready = integração ativa no escritório; not_configured = existe mas falta configurar; missing = ausente
      serpro: (await loadSerproModule())
        ? await requireSerpro(ctx, officeId).then(
            () => 'ready' as const,
            () => 'not_configured' as const,
          )
        : ('missing' as const),
      lastOfficeSync: jobView(await latestJob(db, officeId, ['ecac.sync_office'])),
      activity,
    };
  });

  /** Sincroniza pelo SERPRO todos os clientes com procurador. */
  app.post('/robot/sync-office', { preHandler: guard('ecac.sync') }, async (req, reply) => {
    const user = requireUser(req);
    const pending = await pendingJob(db, user.officeId, 'ecac.sync_office', {});
    if (pending) return { job: jobView(pending), alreadyQueued: true };
    const job = await ctx.jobs.enqueue('ecac.sync_office', {}, { officeId: user.officeId, userId: user.userId, maxAttempts: 1 });
    await audit(req, 'ecac_sync_office', 'office', user.officeId);
    reply.status(202);
    return { job: jobView(job), alreadyQueued: false };
  });

  /** Pacotes da Central de downloads (sincronizador e extensão), para qualquer usuário logado. */
  app.get('/robot/downloads/:pkg', async (req, reply) => {
    requireUser(req);
    const { pkg } = parse(z.object({ pkg: z.enum(Object.keys(PACKAGES) as [PackageName, ...PackageName[]]) }), req.params);
    const zip = await buildPackageZip(pkg);
    if (!zip) throw notFound('Pacote neste servidor');
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${PACKAGES[pkg].filename}"`).send(zip);
  });

  // ------------------------------------------------------------------ API de máquina
  /** Confere o token (usado pelo "Testar conexão" da extensão e do sincronizador). */
  app.get('/sync/whoami', async (req) => {
    const auth = await requireMachine(ctx, req, ['extension', 'sync']);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, auth.officeId) });
    return { office: { id: auth.officeId, name: office?.name ?? '' }, token: { name: auth.name, scope: auth.scope } };
  });

  /** CPFs e nomes dos clientes com procurador associado (a lista que o robô percorre). */
  app.get('/sync/customers', async (req) => {
    const auth = await requireMachine(ctx, req, ['extension', 'sync']);
    const rows = await db
      .select({ cpf: customers.cpfCnpj, name: customers.name, procurationStatus: customers.procurationStatus, procuratorName: procurators.name, procuratorDoc: procurators.cpfCnpj })
      .from(customers)
      .innerJoin(procurators, eq(procurators.id, customers.procuratorId))
      .where(and(eq(customers.officeId, auth.officeId), isNull(customers.deletedAt), eq(customers.status, 'active')))
      .orderBy(asc(customers.name));
    return rows.map((r) => ({ cpf: r.cpf, name: r.name, procurationStatus: r.procurationStatus, procurator: { name: r.procuratorName, cpfCnpj: r.procuratorDoc } }));
  });

  /**
   * Arquivo do programa IRPF (multipart): `file` + `cpf` (opcional) + `ano` (opcional) +
   * `tipo` (dec|rec|dbk|xml|pdf|other, opcional) + `caminho` (caminho original, opcional).
   */
  app.post('/sync/files', async (req, reply) => {
    const auth = await requireMachine(ctx, req, ['sync']);
    const { file, fields } = await readMultipart(req);
    if (!file || !file.buffer.length) throw badRequest('Envie o arquivo no campo "file".');
    const result = await ingestSyncFile(ctx, auth, file, fields);
    reply.status(result.duplicate ? 200 : 201);
    return result;
  });

  /**
   * Registros do eCAC já interpretados pela extensão: `{ records: [{ kind, cpf, year, data,
   * externalId?, file?: { filename, mimeType, base64 } }] }` (ou um registro só).
   * Cada item tem resultado próprio; um CPF desconhecido não derruba o lote.
   */
  // os PDFs vêm em base64 no JSON: esta rota aceita corpo maior que o limite geral da API
  app.post('/sync/ecac-records', { bodyLimit: 25 * 1024 * 1024 }, async (req) => {
    const auth = await requireMachine(ctx, req, ['extension']);
    const raw = req.body as { records?: unknown } | undefined;
    const list = parse(z.array(z.unknown()).min(1).max(100), Array.isArray(raw?.records) ? raw.records : raw ? [raw] : []);
    const results = [];
    for (const [index, item] of list.entries()) {
      try {
        const input = parse(machineRecordSchema, item);
        const customer = await customerByDoc(ctx, auth.officeId, onlyDigits(input.cpf));
        const file = input.file
          ? { buffer: Buffer.from(input.file.base64, 'base64'), filename: input.file.filename, mimeType: input.file.mimeType ?? 'application/octet-stream' }
          : null;
        const { record, effects, duplicate } = await saveEcacRecord(ctx, { ...input, officeId: auth.officeId, customer, source: 'extension', file });
        await machineAudit(ctx, auth, 'sync_ecac_record', 'ecac_record', record.id, { kind: input.kind, customerId: customer.id });
        results.push({ index, ok: true, recordId: record.id, duplicate, effects });
      } catch (err) {
        results.push({ index, ok: false, error: err instanceof Error ? err.message : String(err), status: err instanceof HttpError ? err.statusCode : 500 });
      }
    }
    return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  });

  /** Arquivo da pré-preenchida (multipart): `file` + `cpf` + `ano` (ou identificados pelo nome). */
  app.post('/sync/prefilled', async (req, reply) => {
    const auth = await requireMachine(ctx, req, ['extension', 'sync']);
    const { file, fields } = await readMultipart(req);
    if (!file || !file.buffer.length) throw badRequest('Envie o arquivo no campo "file".');
    const { cpf, year } = resolveFileTarget(file, fields);
    const customer = await customerByDoc(ctx, auth.officeId, cpf);
    const { statement, duplicate } = await savePrefilled(ctx, { officeId: auth.officeId, customer, year, file });
    if (!duplicate) await machineAudit(ctx, auth, 'sync_prefilled', 'prefilled_statement', statement.id, { customerId: customer.id, year });
    reply.status(duplicate ? 200 : 201);
    return { id: statement.id, customer: { id: customer.id, name: customer.name }, year, duplicate };
  });
}
