import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ecacRecords } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { readMultipart } from '../sync/multipart';
import { buildEcacPanel, recordInputSchema, saveEcacRecord } from './records';
import { jobView, pendingJob } from './util';

/** Aba eCAC do cliente: painéis, sincronização e lançamento manual de registros. */
export async function ecacRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.get('/customers/:id/ecac', { preHandler: guard('ecac.view') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const c = await getCustomerForUser(app.ctx, user, id);
    return buildEcacPanel(app.ctx, c);
  });

  /** Enfileira a sincronização do cliente (não duplica se já houver uma pendente). */
  app.post('/customers/:id/ecac/sync', { preHandler: guard('ecac.sync') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const c = await getCustomerForUser(app.ctx, user, id);
    const pending = await pendingJob(db, user.officeId, 'ecac.sync', { customerId: c.id });
    if (pending) return { job: jobView(pending), alreadyQueued: true };
    const job = await app.ctx.jobs.enqueue('ecac.sync', { customerId: c.id }, { officeId: user.officeId, userId: user.userId, maxAttempts: 1 });
    await audit(req, 'ecac_sync', 'customer', c.id);
    reply.status(202);
    return { job: jobView(job), alreadyQueued: false };
  });

  /**
   * Lançamento manual de um registro do eCAC (ex.: extrato baixado à mão), com arquivo opcional.
   * Aceita multipart (campos `kind`, `year`, `externalId`, `data` em JSON e `file`) ou JSON.
   */
  app.post('/customers/:id/ecac/records', { preHandler: guard('ecac.sync') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const c = await getCustomerForUser(app.ctx, user, id);
    let raw: Record<string, unknown>;
    let file = null;
    if (req.isMultipart()) {
      const mp = await readMultipart(req);
      file = mp.file;
      let data: unknown = {};
      if (mp.fields.data) {
        try {
          data = JSON.parse(mp.fields.data);
        } catch {
          throw badRequest('O campo "data" deve ser um JSON.');
        }
      }
      raw = { kind: mp.fields.kind, year: mp.fields.year || null, externalId: mp.fields.externalId || undefined, data };
    } else {
      raw = (req.body ?? {}) as Record<string, unknown>;
    }
    const input = parse(recordInputSchema, raw);
    const result = await saveEcacRecord(app.ctx, { ...input, officeId: user.officeId, customer: c, source: 'manual', file, userId: user.userId });
    await audit(req, 'create', 'ecac_record', result.record.id, { kind: input.kind, year: input.year ?? null });
    reply.status(201);
    return { ...result.record, effects: result.effects };
  });

  /** Remove um registro lançado manualmente (os vindos do robô ficam). */
  app.delete('/customers/:id/ecac/records/:recordId', { preHandler: guard('ecac.sync') }, async (req) => {
    const user = requireUser(req);
    const params = parse(z.object({ id: z.uuid(), recordId: z.uuid() }), req.params);
    const c = await getCustomerForUser(app.ctx, user, params.id);
    const rec = await db.query.ecacRecords.findFirst({
      where: and(eq(ecacRecords.id, params.recordId), eq(ecacRecords.customerId, c.id), eq(ecacRecords.officeId, user.officeId)),
    });
    if (!rec) throw notFound('Registro');
    if (rec.source !== 'manual') throw badRequest('Só registros lançados manualmente podem ser removidos.');
    await db.delete(ecacRecords).where(eq(ecacRecords.id, rec.id));
    if (rec.fileId) await app.ctx.files.remove(user.officeId, rec.fileId);
    await audit(req, 'delete', 'ecac_record', rec.id, { kind: rec.kind });
    return { ok: true };
  });
}
