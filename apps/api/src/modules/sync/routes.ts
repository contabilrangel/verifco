import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, like, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DOCUMENT_CATEGORY_LIST, MACHINE_TOKEN_SCOPES, currentExerciseYear, isValidCpfCnpj, onlyDigits, type DocumentCategory, type MachineTokenScope } from '@verifco/shared';
import { apiTokens, customers, documents, ecacRecords, files, offices, prefilledStatements, syncInbox, users } from '../../db/schema';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { sha256 } from '../../lib/crypto';
import { getOrCreateDeclaration } from '../../services/declarations';
import { isExtractable, refreshElaborationStatus } from '../elaboration/service';
import { listInbox, receiveInboxFile } from './inbox';
import { createEcacChangeBatch, flushEcacChanges, recordInputSchema, saveEcacRecord } from '../ecac/records';
import { ECAC_SYNC_OFFICE, latestOfficeSync, nextScheduledOfficeSync } from '../ecac/jobs';
import { loadSerproModule, requireSerpro } from '../ecac/serpro';
import { fanoutJobView } from '../ecac/util';
import { savePrefilled } from '../prefilled/service';
import { customerByDoc, ingestSyncFile, machineAudit, resolveFileTarget } from './ingest';
import { readMultipart } from './multipart';
import { sendStoredFile, uploadedFromBase64 } from '../../services/uploads';
import { PACKAGES, buildPackageZip, clientVersionInfo, distributedVersions, type PackageName } from './packages';
import { generateMachineToken, publicToken, requireMachine } from './tokens';
import { customerScope, getCustomerForUser } from '../../services/customers';

/** Título digitado pelo usuário com a extensão do arquivo original (o tipo gravado vem dela). */
const withExtension = (title: string, original: string) => {
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(original)?.[0] ?? '';
  return ext && !title.toLowerCase().endsWith(ext.toLowerCase()) ? `${title}${ext}` : title;
};

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
    const [{ n: inboxPending }] = await db.select({ n: count() }).from(syncInbox).where(and(eq(syncInbox.officeId, officeId), eq(syncInbox.status, 'pending')));
    return {
      customersWithProcurator: withProcurator,
      activeTokens,
      // arquivos do sincronizador esperando alguém atribuir a um cliente
      inboxPending,
      // versões que este servidor distribui (os tokens mostram a que cada programa usa)
      clientVersions: await distributedVersions(),
      // ready = integração ativa no escritório; not_configured = existe mas falta configurar; missing = ausente
      serpro: (await loadSerproModule())
        ? await requireSerpro(ctx, officeId).then(
            () => 'ready' as const,
            () => 'not_configured' as const,
          )
        : ('missing' as const),
      // andamento somado dos clientes; a rodada automática agendada para depois aparece à parte
      lastOfficeSync: await fanoutJobView(db, await latestOfficeSync(db, officeId)),
      nextAutoSync: await nextScheduledOfficeSync(db, officeId),
      activity,
    };
  });

  // ------------------------------------------------------------------ caixa de entrada
  /** Arquivos do sincronizador sem cliente identificado, aguardando alguém do escritório. */
  app.get('/robot/inbox', { preHandler: guard('ecac.robot') }, async (req) => {
    const user = requireUser(req);
    return listInbox(ctx, user.officeId);
  });

  const inboxItem = async (officeId: string, id: string) => {
    const item = await db.query.syncInbox.findFirst({ where: and(eq(syncInbox.id, id), eq(syncInbox.officeId, officeId), eq(syncInbox.status, 'pending')) });
    if (!item) throw notFound('Arquivo pendente');
    return item;
  };

  app.get('/robot/inbox/:id/download', { preHandler: guard('ecac.robot') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const item = await inboxItem(user.officeId, id);
    const { row, stream } = await ctx.files.open(user.officeId, item.fileId);
    return sendStoredFile(reply, row, stream);
  });

  /** Atribui o arquivo a um cliente e exercício: entra como qualquer arquivo do sincronizador. */
  app.post('/robot/inbox/:id/file', { preHandler: guard('ecac.robot') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ customerId: z.uuid(), year: yearSchema }), req.body);
    const item = await inboxItem(user.officeId, id);
    const customer = await getCustomerForUser(ctx, user, body.customerId);
    const { row, data } = await ctx.files.get(user.officeId, item.fileId);
    const result = await ingestSyncFile(
      ctx,
      { tokenId: '', officeId: user.officeId, scope: 'sync', name: item.tokenName ?? 'caixa de entrada', clientVersion: null },
      { filename: row.filename, mimeType: row.mimeType, data },
      { cpf: customer.cpfCnpj, ano: String(body.year), ...(item.originalPath ? { caminho: item.originalPath } : {}) },
    );
    // o documento do cliente guarda a própria cópia: o arquivo da caixa de entrada sai (a linha vai junto)
    await ctx.files.remove(user.officeId, item.fileId);
    await audit(req, 'inbox_file', 'sync_inbox', item.id, { customerId: customer.id, year: body.year, filename: item.filename, documentId: result.documentId });
    return { ok: true, documentId: result.documentId, duplicate: result.duplicate, customer: { id: customer.id, name: customer.name }, year: body.year };
  });

  /** Descarta o arquivo: o conteúdo é apagado (o sincronizador não o envia de novo). */
  app.delete('/robot/inbox/:id', { preHandler: guard('ecac.robot') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const item = await inboxItem(user.officeId, id);
    // a linha sai junto com o arquivo (FK em cascata)
    await ctx.files.remove(user.officeId, item.fileId);
    await audit(req, 'inbox_discard', 'sync_inbox', item.id, { filename: item.filename, reason: item.reason });
    return { ok: true };
  });

  /** Sincroniza pelo SERPRO todos os clientes com procurador (um job por cliente). */
  app.post('/robot/sync-office', { preHandler: guard('ecac.sync') }, async (req, reply) => {
    const user = requireUser(req);
    // não duplica uma sincronização na vez ou com clientes ainda em andamento
    const current = await fanoutJobView(db, await latestOfficeSync(db, user.officeId));
    if (current && (current.status === 'queued' || current.status === 'running')) return { job: current, alreadyQueued: true };
    const job = await ctx.jobs.enqueue(ECAC_SYNC_OFFICE, {}, { officeId: user.officeId, userId: user.userId, maxAttempts: 1 });
    await audit(req, 'ecac_sync_office', 'office', user.officeId);
    reply.status(202);
    return { job: await fanoutJobView(db, job), alreadyQueued: false };
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
    return {
      office: { id: auth.officeId, name: office?.name ?? '' },
      token: { name: auth.name, scope: auth.scope },
      // versão em uso × versão distribuída por este servidor (aviso de atualização no programa)
      client: await clientVersionInfo(auth.scope, auth.clientVersion),
    };
  });

  /**
   * Clientes ativos do escritório para o seletor da extensão e a conferência do sincronizador:
   * `q` busca por nome ou pelos dígitos do CPF/CNPJ; sem `q`, os primeiros por nome.
   */
  app.get('/sync/customers', async (req) => {
    const auth = await requireMachine(ctx, req, ['extension', 'sync']);
    const { q, limit } = parse(z.object({ q: z.string().trim().max(100).default(''), limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
    const digits = onlyDigits(q);
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const match = q ? or(ilike(customers.name, `%${escaped}%`), digits.length >= 3 ? like(customers.cpfCnpj, `${digits}%`) : undefined) : undefined;
    const rows = await db
      .select({ cpf: customers.cpfCnpj, name: customers.name, procurationStatus: customers.procurationStatus, procuratorId: customers.procuratorId })
      .from(customers)
      .where(and(eq(customers.officeId, auth.officeId), isNull(customers.deletedAt), eq(customers.status, 'active'), match))
      .orderBy(asc(customers.name))
      .limit(limit);
    return rows.map((r) => ({ cpf: r.cpf, name: r.name, procurationStatus: r.procurationStatus, hasProcurator: Boolean(r.procuratorId) }));
  });

  /**
   * Documento avulso para a pasta do cliente (multipart): `file` + `cpf` + `ano` (exercício,
   * opcional: vale o corrente) + `categoria` (opcional) + `origem` (endereço da página ou texto
   * livre) + `titulo`. É o "Enviar arquivo ao cliente" da extensão; o sincronizador também pode usar.
   */
  app.post('/sync/documents', async (req, reply) => {
    const auth = await requireMachine(ctx, req, ['extension', 'sync']);
    const { file, fields } = await readMultipart(req);
    if (!file) throw badRequest('Envie o arquivo no campo "file".');
    const cpf = onlyDigits(fields.cpf);
    if (!cpf || !isValidCpfCnpj(cpf)) throw badRequest('Informe o CPF/CNPJ do cliente no campo "cpf".');
    const year = fields.ano ? Number(fields.ano) : currentExerciseYear();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('Ano inválido: informe o ano-exercício com 4 dígitos.');
    const category = fields.categoria || 'other';
    if (!DOCUMENT_CATEGORY_LIST.includes(category as DocumentCategory)) throw badRequest(`Categoria inválida: use ${DOCUMENT_CATEGORY_LIST.join(', ')}.`);
    const customer = await customerByDoc(ctx, auth.officeId, cpf);
    const declaration = await getOrCreateDeclaration(db, auth.officeId, customer.id, year);
    const hash = sha256(file.data);
    const [dup] = await db
      .select({ id: documents.id })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .where(and(eq(documents.customerId, customer.id), eq(documents.declarationId, declaration.id), eq(files.sha256, hash)))
      .limit(1);
    const base = { customer: { id: customer.id, name: customer.name }, year };
    if (dup) return { id: dup.id, ...base, duplicate: true };
    const saved = await ctx.files.save({ officeId: auth.officeId, data: file.data, filename: (fields.titulo?.trim() ? withExtension(fields.titulo.trim().slice(0, 200), file.filename) : file.filename), mimeType: file.mimeType });
    const [doc] = await db
      .insert(documents)
      .values({
        officeId: auth.officeId,
        customerId: customer.id,
        declarationId: declaration.id,
        fileId: saved.id,
        category,
        // enviado por alguém do escritório pela extensão: vale como arquivo do escritório
        uploadedBy: auth.scope === 'extension' ? 'office' : 'sync',
        processingStatus: isExtractable(file.mimeType) ? 'not_processed' : 'not_applicable',
        extracted: { sync: { type: 'document', origin: fields.origem ? fields.origem.slice(0, 500) : null, tokenName: auth.name, client: auth.scope } },
      })
      .returning();
    await refreshElaborationStatus(db, declaration.id);
    await machineAudit(ctx, auth, 'sync_document', 'document', doc.id, { customerId: customer.id, year, category, filename: saved.filename });
    reply.status(201);
    return { id: doc.id, ...base, duplicate: false };
  });

  /**
   * Arquivo que o sincronizador não conseguiu ligar a um cliente (multipart): `file` + `motivo`
   * (`sem_cpf` | `cliente_nao_cadastrado`) + `caminho`, `cpf` e `ano` quando conhecidos. Fica na
   * caixa de entrada do robô até o escritório atribuir a um cliente ou descartar.
   */
  app.post('/sync/inbox', async (req, reply) => {
    const auth = await requireMachine(ctx, req, ['sync']);
    const { file, fields } = await readMultipart(req);
    if (!file) throw badRequest('Envie o arquivo no campo "file".');
    const result = await receiveInboxFile(ctx, auth, file, fields);
    reply.status(result.duplicate ? 200 : 201);
    return result;
  });

  /**
   * Arquivo do programa IRPF (multipart): `file` + `cpf` (opcional) + `ano` (opcional) +
   * `tipo` (dec|rec|dbk|xml|pdf|other, opcional) + `caminho` (caminho original, opcional) +
   * `modificadoEm` (data e hora do arquivo em ISO 8601 com fuso, opcional: no .REC vira o dia da
   * transmissão; sincronizadores anteriores à 0.2.0 não enviam e vale o dia do recebimento).
   */
  app.post('/sync/files', async (req, reply) => {
    const auth = await requireMachine(ctx, req, ['sync']);
    const { file, fields } = await readMultipart(req);
    if (!file) throw badRequest('Envie o arquivo no campo "file".');
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
    // um aviso por cliente para o lote inteiro (não um por mensagem da caixa postal)
    const batch = createEcacChangeBatch();
    for (const [index, item] of list.entries()) {
      try {
        const input = parse(machineRecordSchema, item);
        const customer = await customerByDoc(ctx, auth.officeId, onlyDigits(input.cpf));
        const file = input.file
          ? uploadedFromBase64(input.file.filename, input.file.base64)
          : null;
        const { record, effects, duplicate } = await saveEcacRecord(ctx, { ...input, officeId: auth.officeId, customer, source: 'extension', file, batch });
        await machineAudit(ctx, auth, 'sync_ecac_record', 'ecac_record', record.id, { kind: input.kind, customerId: customer.id });
        results.push({ index, ok: true, recordId: record.id, duplicate, effects });
      } catch (err) {
        results.push({ index, ok: false, error: err instanceof Error ? err.message : String(err), status: err instanceof HttpError ? err.statusCode : 500 });
      }
    }
    await flushEcacChanges(ctx, batch);
    return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  });

  /** Arquivo da pré-preenchida (multipart): `file` + `cpf` + `ano` (ou identificados pelo nome). */
  app.post('/sync/prefilled', async (req, reply) => {
    const auth = await requireMachine(ctx, req, ['extension', 'sync']);
    const { file, fields } = await readMultipart(req);
    if (!file) throw badRequest('Envie o arquivo no campo "file".');
    const { cpf, year } = resolveFileTarget(file, fields);
    const customer = await customerByDoc(ctx, auth.officeId, cpf);
    const { statement, duplicate } = await savePrefilled(ctx, { officeId: auth.officeId, customer, year, file });
    if (!duplicate) await machineAudit(ctx, auth, 'sync_prefilled', 'prefilled_statement', statement.id, { customerId: customer.id, year });
    reply.status(duplicate ? 200 : 201);
    return { id: statement.id, customer: { id: customer.id, name: customer.name }, year, duplicate };
  });
}
