import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DARF_MAX_QUOTAS, DARF_MIN_PAYABLE_CENTS, brazilToday, darfPayable, darfStatus, darfValueText, formatDate, planDarfQuotas } from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { darfs, declarations, deliveries, files } from '../../db/schema';
import { HttpError, badRequest, conflict, notFound } from '../../lib/errors';
import { audit, dateStr, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { queueDelivery } from '../../services/delivery';
import { getOfficeSettings } from '../../services/settings';
import { PDF_TYPES, readUploads } from '../../services/uploads';
import { getDeclarationForUser } from './access';

type DarfRow = typeof darfs.$inferSelect;

const money = z.coerce.number().int().min(1).max(10_000_000_000_000);
/** O DARF não pode ter valor abaixo de R$ 10,00 (P&R IRPF 2026, pergunta 063). */
const darfValue = z.coerce
  .number()
  .int()
  .min(DARF_MIN_PAYABLE_CENTS, 'DARF abaixo de R$ 10,00 não pode ser pago: some o valor ao imposto do próximo exercício.')
  .max(10_000_000_000_000);
const darfBody = z.object({
  quotaNumber: z.coerce.number().int().min(1).max(99).optional(),
  valueCents: darfValue,
  dueDate: dateStr,
  barcode: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(80).nullable().optional()),
});
const darfUpdate = darfBody.partial().extend({
  paidAt: z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional()),
});

async function getDarfForUser(ctx: AppContext, user: AuthUser, id: string) {
  const darf = await ctx.db.query.darfs.findFirst({ where: and(eq(darfs.id, id), eq(darfs.officeId, user.officeId)) });
  if (!darf) throw notFound('DARF');
  const customer = await getCustomerForUser(ctx, user, darf.customerId).catch((err) => {
    throw err instanceof HttpError && err.statusCode === 404 ? notFound('DARF') : err;
  });
  return { darf, customer };
}

/**
 * Quotas do DARF do IRPF. A regra de geração está documentada em
 * `packages/shared/src/darf.ts` (até 8 quotas, mínimo de R$ 50, 1ª no vencimento
 * informado e as demais no último dia útil de cada mês).
 */
export async function darfRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  /** Monta a resposta com a situação calculada, o arquivo e o último envio. */
  const present = async (rows: DarfRow[], customerId: string) => {
    const today = brazilToday();
    const fileIds = rows.map((r) => r.fileId).filter((x): x is string => Boolean(x));
    const fileRows = fileIds.length ? await db.select({ id: files.id, filename: files.filename, size: files.size }).from(files).where(inArray(files.id, fileIds)) : [];
    const sends = rows.length
      ? await db
          .select({ key: deliveries.idempotencyKey, status: deliveries.status, channel: deliveries.channel, createdAt: deliveries.createdAt, error: deliveries.error })
          .from(deliveries)
          .where(and(eq(deliveries.customerId, customerId), like(deliveries.idempotencyKey, 'darf:%')))
          .orderBy(desc(deliveries.createdAt))
      : [];
    return rows.map((r) => {
      const last = sends.find((s) => s.key?.startsWith(`darf:${r.id}:`));
      const file = fileRows.find((f) => f.id === r.fileId);
      return {
        ...r,
        amount: darfPayable(r),
        status: darfStatus({ status: r.status, paidAt: r.paidAt, dueDate: r.dueDate }, today),
        file: file ? { id: file.id, filename: file.filename, size: file.size } : null,
        sendStatus: last ? (last.status === 'delivered' ? 'sent' : last.status) : r.sendStatus,
        lastSend: last ? { channel: last.channel, at: last.createdAt, status: last.status, error: last.error } : null,
      };
    });
  };

  const listFor = (declarationId: string) => db.select().from(darfs).where(eq(darfs.declarationId, declarationId)).orderBy(asc(darfs.quotaNumber), asc(darfs.dueDate));

  app.get('/declarations/:id/darfs', { preHandler: guard('darf.view') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const settings = await getOfficeSettings(db, user.officeId);
    return { autoSendDarfEmail: settings.autoSendDarfEmail, taxDueCents: declaration.taxDueCents, darfs: await present(await listFor(declaration.id), declaration.customerId) };
  });

  app.post('/declarations/:id/darfs', { preHandler: guard('darf.edit') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(darfBody, req.body);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const existing = await listFor(declaration.id);
    const quotaNumber = body.quotaNumber ?? Math.max(0, ...existing.map((d) => d.quotaNumber)) + 1;
    const [row] = await db
      .insert(darfs)
      .values({ officeId: user.officeId, customerId: declaration.customerId, declarationId: declaration.id, quotaNumber, valueCents: body.valueCents, dueDate: body.dueDate, barcode: body.barcode ?? null, source: 'manual' })
      .returning();
    await audit(req, 'create', 'darf', row.id, { quotaNumber, valueCents: row.valueCents });
    reply.status(201);
    return (await present([row], declaration.customerId))[0];
  });

  /** Gera as quotas a partir do imposto a pagar (ou de um total informado). */
  app.post('/declarations/:id/darfs/generate', { preHandler: guard('darf.edit') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        quotas: z.coerce.number().int().min(1).max(DARF_MAX_QUOTAS),
        firstDueDate: dateStr,
        totalCents: money.optional(),
        replace: z.boolean().optional(),
      }),
      req.body,
    );
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const total = body.totalCents ?? declaration.taxDueCents;
    if (!total || total <= 0) throw badRequest('Informe o imposto a pagar no resumo da declaração ou o valor total a parcelar.');
    const existing = await listFor(declaration.id);
    if (existing.length && !body.replace) throw conflict('Já existem quotas cadastradas. Confirme a substituição para gerar de novo.');
    if (existing.some((d) => d.status === 'paid' || d.paidAt)) throw conflict('Há quotas pagas; ajuste as quotas manualmente.');
    const plan = planDarfQuotas(total, body.quotas, body.firstDueDate);
    if (!plan.quotas.length) throw badRequest(plan.warning ?? 'Não foi possível gerar as quotas.');
    for (const d of existing) if (d.fileId) await app.ctx.files.remove(user.officeId, d.fileId);
    if (existing.length) await db.delete(darfs).where(inArray(darfs.id, existing.map((d) => d.id)));
    const rows = await db
      .insert(darfs)
      .values(plan.quotas.map((q) => ({ officeId: user.officeId, customerId: declaration.customerId, declarationId: declaration.id, ...q, source: 'generated' })))
      .returning();
    await audit(req, 'generate', 'darf', declaration.id, { totalCents: total, quotas: plan.count });
    reply.status(201);
    return { warning: plan.warning, count: plan.count, totalCents: total, darfs: await present(rows, declaration.customerId) };
  });

  app.put('/darfs/:id', { preHandler: guard('darf.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(darfUpdate, req.body);
    const { darf } = await getDarfForUser(app.ctx, user, id);
    const { paidAt, ...fields } = body;
    // valor editado à mão é o da guia: deixa de ser só o principal gerado
    const edited = fields.valueCents !== undefined && darf.source === 'generated' && fields.valueCents !== darf.valueCents ? { source: 'edited' } : {};
    const [row] = await db
      .update(darfs)
      .set({ ...fields, ...edited, ...(paidAt !== undefined ? { paidAt, status: paidAt ? 'paid' : 'open' } : {}) })
      .where(eq(darfs.id, darf.id))
      .returning();
    await audit(req, paidAt !== undefined ? (paidAt ? 'pay' : 'unpay') : 'update', 'darf', darf.id);
    return (await present([row], darf.customerId))[0];
  });

  app.delete('/darfs/:id', { preHandler: guard('darf.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { darf } = await getDarfForUser(app.ctx, user, id);
    await db.delete(darfs).where(eq(darfs.id, darf.id));
    if (darf.fileId) await app.ctx.files.remove(user.officeId, darf.fileId);
    await audit(req, 'delete', 'darf', darf.id, { quotaNumber: darf.quotaNumber });
    return { ok: true };
  });

  /** Envia a guia ao cliente (template `darf`, PDF anexo). */
  const sendDarf = async (user: AuthUser, darf: DarfRow, filename: string, channel: 'email' | 'whatsapp', idempotencyKey: string) => {
    const decl = darf.declarationId ? await db.query.declarations.findFirst({ where: eq(declarations.id, darf.declarationId) }) : null;
    const delivery = await queueDelivery(app.ctx, {
      exerciseYear: decl?.exerciseYear,
      officeId: user.officeId,
      customerId: darf.customerId,
      channel,
      templateKey: 'darf',
      values: { VALOR: darfValueText(darf), VENCIMENTO: formatDate(darf.dueDate), LINK: `${app.ctx.config.WEB_URL}/portal` },
      attachments: [{ fileId: darf.fileId!, filename }],
      idempotencyKey,
      userId: user.userId,
    });
    await db.update(darfs).set({ sendStatus: 'sent' }).where(eq(darfs.id, darf.id));
    return delivery;
  };

  /** PDF da guia. Com o envio automático ligado nas preferências, já manda por e-mail. */
  app.post('/darfs/:id/file', { preHandler: guard('darf.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { darf, customer } = await getDarfForUser(app.ctx, user, id);
    const {
      files: [file],
    } = await readUploads(req, { types: PDF_TYPES, maxFiles: 1, accepted: 'a guia em PDF' });
    if (!file) throw badRequest('Envie o PDF da guia.');
    const saved = await app.ctx.files.save({ officeId: user.officeId, data: file.data, filename: file.filename, mimeType: file.mimeType, userId: user.userId });
    const [row] = await db.update(darfs).set({ fileId: saved.id, sendStatus: 'not_sent' }).where(eq(darfs.id, darf.id)).returning();
    if (darf.fileId) await app.ctx.files.remove(user.officeId, darf.fileId);
    await audit(req, 'upload', 'darf', darf.id);
    const settings = await getOfficeSettings(db, user.officeId);
    let autoSend: 'sent' | 'no_email' | 'off' = 'off';
    if (settings.autoSendDarfEmail) {
      if (customer.email) {
        await sendDarf(user, row, saved.filename, 'email', `darf:${darf.id}:auto:${saved.id}`);
        autoSend = 'sent';
      } else autoSend = 'no_email';
    }
    const fresh = await db.query.darfs.findFirst({ where: eq(darfs.id, darf.id) });
    return { ...(await present([fresh!], darf.customerId))[0], autoSend };
  });

  app.post('/darfs/:id/send', { preHandler: guard('darf.send') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { channel } = parse(z.object({ channel: z.enum(['email', 'whatsapp']) }), req.body);
    const { darf } = await getDarfForUser(app.ctx, user, id);
    if (!darf.fileId) throw badRequest('Anexe o PDF da guia antes de enviar.');
    const file = await db.query.files.findFirst({ where: eq(files.id, darf.fileId) });
    const delivery = await sendDarf(user, darf, file?.filename ?? `darf-quota-${darf.quotaNumber}.pdf`, channel, `darf:${darf.id}:${channel}:${randomUUID()}`);
    await audit(req, 'send', 'darf', darf.id, { channel });
    return { ok: true, deliveryId: delivery.id };
  });
}
