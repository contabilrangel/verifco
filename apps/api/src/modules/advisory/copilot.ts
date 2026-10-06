import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  COPILOT_ENTRY_KINDS,
  COPILOT_EXPENSE_CATEGORIES,
  COPILOT_INCOME_CATEGORIES,
  copilotBudget,
  copilotLimit,
  copilotOverview,
  formatMoney,
  projectCopilotIrpfm,
  type CopilotEntryKind,
} from '@verifco/shared';
import type { AppContext } from '../../context';
import { contracts, copilotEnrollments, copilotEntries, customers, documents, files } from '../../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit, dateStr, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { customerScope, getCustomerForUser } from '../../services/customers';
import { DOCUMENT_TYPES, readUploads } from '../../services/uploads';

/** O cliente precisa estar habilitado (e ativo) no plano do Copiloto. */
export async function requireActiveEnrollment(ctx: AppContext, officeId: string, customerId: string) {
  const e = await ctx.db.query.copilotEnrollments.findFirst({
    where: and(eq(copilotEnrollments.officeId, officeId), eq(copilotEnrollments.customerId, customerId)),
  });
  if (!e || e.status !== 'active') throw forbidden('O Copiloto Financeiro não está habilitado para este cliente.');
  return e;
}

async function officeLimit(ctx: AppContext, officeId: string) {
  const rows = await ctx.db.select().from(contracts).where(eq(contracts.officeId, officeId));
  return copilotLimit(rows.map((c) => ({ plan: c.plan, status: c.status, startsAt: String(c.startsAt), expiresAt: String(c.expiresAt) })));
}

async function activeCount(ctx: AppContext, officeId: string) {
  const [{ n }] = await ctx.db
    .select({ n: count() })
    .from(copilotEnrollments)
    .where(and(eq(copilotEnrollments.officeId, officeId), eq(copilotEnrollments.status, 'active')));
  return n;
}

const entryKinds = Object.keys(COPILOT_ENTRY_KINDS) as [CopilotEntryKind, ...CopilotEntryKind[]];
const entryBody = z.object({
  kind: z.enum(entryKinds),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().min(1, 'Informe a descrição').max(300),
  amountCents: z.coerce.number().int().min(0).max(1e13),
  dueDate: z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional()),
  data: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
});

function checkCategory(body: z.infer<typeof entryBody>) {
  if (body.kind === 'income' && body.category && !(body.category in COPILOT_INCOME_CATEGORIES)) throw badRequest('Categoria de receita inválida.');
  if ((body.kind === 'expense' || body.kind === 'budget') && body.category && !(body.category in COPILOT_EXPENSE_CATEGORIES)) throw badRequest('Categoria de despesa inválida.');
  if ((body.kind === 'income' || body.kind === 'expense') && !body.month) throw badRequest('Informe o mês do lançamento.');
}

/** Resumo do copiloto para o prompt do chat. */
export async function copilotContextText(ctx: AppContext, officeId: string, customerId: string, year: number) {
  const rows = await ctx.db
    .select()
    .from(copilotEntries)
    .where(and(eq(copilotEntries.officeId, officeId), eq(copilotEntries.customerId, customerId), eq(copilotEntries.year, year)));
  const ov = copilotOverview(rows);
  const proj = projectCopilotIrpfm(rows, year);
  const lines = [`Copiloto financeiro ${year}: receitas ${formatMoney(ov.totals.incomeCents)}, despesas ${formatMoney(ov.totals.expenseCents)}, saldo ${formatMoney(ov.totals.balanceCents)}.`];
  for (const m of ov.months.filter((x) => x.incomeCents || x.expenseCents)) {
    lines.push(`- mês ${m.month}: receitas ${formatMoney(m.incomeCents)}, despesas ${formatMoney(m.expenseCents)}`);
  }
  const pending = rows.filter((r) => r.kind === 'bill' && !r.data?.paid);
  if (pending.length) lines.push(`Vencimentos em aberto: ${pending.map((b) => `${b.description} ${formatMoney(b.amountCents)} em ${b.dueDate ?? 's/d'}`).join('; ')}.`);
  const ins = rows.filter((r) => r.kind === 'insurance');
  if (ins.length) lines.push(`Seguros: ${ins.map((b) => `${b.description} (${formatMoney(b.amountCents)})`).join('; ')}.`);
  const ext = rows.filter((r) => r.kind === 'foreign');
  if (ext.length) lines.push(`Bens/contas no exterior: ${ext.map((b) => `${b.description} (${formatMoney(b.amountCents)})`).join('; ')}.`);
  lines.push(
    `Projeção do IRPFM (declaração de ${proj.declarationYear}): rendimentos ${formatMoney(proj.result.totalIncomeCents)}, base ${formatMoney(proj.result.baseCents)}, alíquota ${proj.result.ratePercent.toFixed(2)}%, devido ${formatMoney(proj.result.dueCents)}.`,
  );
  return lines.join('\n');
}

export async function copilotRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  // ------------------------------------------------------------------ administração do plano
  app.get('/copilot/enrollments', { preHandler: guard('copilot.manage') }, async (req) => {
    const user = requireUser(req);
    const scope = await customerScope(app.ctx, user);
    const rows = await db
      .select({ e: copilotEnrollments, name: customers.name, cpfCnpj: customers.cpfCnpj, email: customers.email })
      .from(copilotEnrollments)
      .innerJoin(customers, eq(customers.id, copilotEnrollments.customerId))
      .where(and(eq(copilotEnrollments.officeId, user.officeId), scope))
      .orderBy(asc(customers.name));
    return {
      limit: await officeLimit(app.ctx, user.officeId),
      used: await activeCount(app.ctx, user.officeId),
      enrollments: rows.map((r) => ({ ...r.e, name: r.name, cpfCnpj: r.cpfCnpj, email: r.email })),
    };
  });

  app.post('/copilot/enrollments', { preHandler: guard('copilot.manage') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ customerId: z.uuid() }), req.body);
    const customer = await getCustomerForUser(app.ctx, user, body.customerId);
    const existing = await db.query.copilotEnrollments.findFirst({ where: eq(copilotEnrollments.customerId, customer.id) });
    if (existing?.status === 'active') throw conflict('O cliente já está habilitado no Copiloto.');
    const limit = await officeLimit(app.ctx, user.officeId);
    if ((await activeCount(app.ctx, user.officeId)) >= limit) throw conflict(`Limite do plano atingido (${limit} clientes). Desabilite um cliente ou amplie o plano.`);
    const [row] = existing
      ? await db.update(copilotEnrollments).set({ status: 'active' }).where(eq(copilotEnrollments.id, existing.id)).returning()
      : await db.insert(copilotEnrollments).values({ officeId: user.officeId, customerId: customer.id, status: 'active' }).returning();
    await audit(req, 'enable', 'copilot_enrollment', row.id, { customerId: customer.id });
    reply.status(201);
    return row;
  });

  app.put('/copilot/enrollments/:id', { preHandler: guard('copilot.manage') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['active', 'inactive']) }), req.body);
    const row = await db.query.copilotEnrollments.findFirst({ where: and(eq(copilotEnrollments.id, id), eq(copilotEnrollments.officeId, user.officeId)) });
    if (!row) throw notFound('Habilitação');
    await getCustomerForUser(app.ctx, user, row.customerId);
    if (status === 'active' && row.status !== 'active') {
      const limit = await officeLimit(app.ctx, user.officeId);
      if ((await activeCount(app.ctx, user.officeId)) >= limit) throw conflict(`Limite do plano atingido (${limit} clientes).`);
    }
    const [updated] = await db.update(copilotEnrollments).set({ status }).where(eq(copilotEnrollments.id, id)).returning();
    await audit(req, status === 'active' ? 'enable' : 'disable', 'copilot_enrollment', id);
    return updated;
  });

  app.delete('/copilot/enrollments/:id', { preHandler: guard('copilot.manage') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const row = await db.query.copilotEnrollments.findFirst({ where: and(eq(copilotEnrollments.id, id), eq(copilotEnrollments.officeId, user.officeId)) });
    if (!row) throw notFound('Habilitação');
    await getCustomerForUser(app.ctx, user, row.customerId);
    await db.delete(copilotEnrollments).where(eq(copilotEnrollments.id, id));
    await audit(req, 'delete', 'copilot_enrollment', id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ cliente
  app.get('/customers/:id/copilot', { preHandler: guard('copilot.use') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const q = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), month: z.coerce.number().int().min(1).max(12).optional() }), req.query);
    const customer = await getCustomerForUser(app.ctx, user, id);
    const enrollment = await db.query.copilotEnrollments.findFirst({ where: and(eq(copilotEnrollments.officeId, user.officeId), eq(copilotEnrollments.customerId, customer.id)) });
    if (!enrollment || enrollment.status !== 'active') {
      return { enrolled: false, enrollment: enrollment ?? null, limit: await officeLimit(app.ctx, user.officeId), used: await activeCount(app.ctx, user.officeId) };
    }
    const year = q.year ?? new Date().getFullYear();
    const month = q.month ?? (year === new Date().getFullYear() ? new Date().getMonth() + 1 : 12);
    const rows = await db
      .select()
      .from(copilotEntries)
      .where(and(eq(copilotEntries.officeId, user.officeId), eq(copilotEntries.customerId, customer.id), eq(copilotEntries.year, year)))
      .orderBy(asc(copilotEntries.dueDate), desc(copilotEntries.createdAt));
    const docs = await db
      .select({ id: documents.id, fileId: documents.fileId, filename: files.filename, size: files.size, createdAt: documents.createdAt })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .where(and(eq(documents.officeId, user.officeId), eq(documents.customerId, customer.id), eq(documents.category, 'copilot')))
      .orderBy(desc(documents.createdAt));
    const todayStr = new Date().toISOString().slice(0, 10);
    const bills = rows.filter((r) => r.kind === 'bill');
    return {
      enrolled: true,
      enrollment,
      year,
      month,
      overview: copilotOverview(rows),
      budget: copilotBudget(rows, month),
      bills: bills.map((b) => ({ ...b, overdue: !b.data?.paid && Boolean(b.dueDate && b.dueDate < todayStr) })),
      pendingBills: bills.filter((b) => !b.data?.paid).length,
      insurances: rows.filter((r) => r.kind === 'insurance'),
      foreign: rows.filter((r) => r.kind === 'foreign'),
      documents: docs,
      projection: projectCopilotIrpfm(rows, year),
    };
  });

  app.get('/customers/:id/copilot/entries', { preHandler: guard('copilot.use') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const q = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100), kind: z.enum(entryKinds).optional(), month: z.coerce.number().int().min(1).max(12).optional() }), req.query);
    const customer = await getCustomerForUser(app.ctx, user, id);
    await requireActiveEnrollment(app.ctx, user.officeId, customer.id);
    const conds = [eq(copilotEntries.officeId, user.officeId), eq(copilotEntries.customerId, customer.id), eq(copilotEntries.year, q.year)];
    if (q.kind) conds.push(eq(copilotEntries.kind, q.kind));
    if (q.month) conds.push(eq(copilotEntries.month, q.month));
    return db.select().from(copilotEntries).where(and(...conds)).orderBy(asc(copilotEntries.month), desc(copilotEntries.createdAt));
  });

  app.post('/customers/:id/copilot/entries', { preHandler: guard('copilot.use') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(entryBody, req.body);
    checkCategory(body);
    const customer = await getCustomerForUser(app.ctx, user, id);
    await requireActiveEnrollment(app.ctx, user.officeId, customer.id);
    const [row] = await db
      .insert(copilotEntries)
      .values({ ...body, month: body.month ?? null, category: body.category ?? null, dueDate: body.dueDate ?? null, data: body.data ?? {}, officeId: user.officeId, customerId: customer.id })
      .returning();
    reply.status(201);
    return row;
  });

  async function loadEntry(officeId: string, entryId: string) {
    const row = await db.query.copilotEntries.findFirst({ where: and(eq(copilotEntries.id, entryId), eq(copilotEntries.officeId, officeId)) });
    if (!row) throw notFound('Lançamento');
    return row;
  }

  app.put('/copilot/entries/:id', { preHandler: guard('copilot.use') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(entryBody, req.body);
    checkCategory(body);
    const row = await loadEntry(user.officeId, id);
    await getCustomerForUser(app.ctx, user, row.customerId);
    await requireActiveEnrollment(app.ctx, user.officeId, row.customerId);
    const [updated] = await db
      .update(copilotEntries)
      .set({ ...body, month: body.month ?? null, category: body.category ?? null, dueDate: body.dueDate ?? null, data: body.data ?? {} })
      .where(eq(copilotEntries.id, id))
      .returning();
    return updated;
  });

  app.delete('/copilot/entries/:id', { preHandler: guard('copilot.use') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const row = await loadEntry(user.officeId, id);
    await getCustomerForUser(app.ctx, user, row.customerId);
    await requireActiveEnrollment(app.ctx, user.officeId, row.customerId);
    await db.delete(copilotEntries).where(eq(copilotEntries.id, id));
    return { ok: true };
  });

  /** Documentos do copiloto (ficam nos documentos do cliente, categoria "copilot"). */
  app.post('/customers/:id/copilot/documents', { preHandler: guard('copilot.use') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const customer = await getCustomerForUser(app.ctx, user, id);
    await requireActiveEnrollment(app.ctx, user.officeId, customer.id);
    const created: string[] = [];
    // tipo pela extensão conferida com o conteúdo; desconhecidos viram binário (só download)
    const { files: received } = await readUploads(req, { types: DOCUMENT_TYPES, unknown: 'octet-stream' });
    for (const u of received) {
      const f = await app.ctx.files.save({ officeId: user.officeId, data: u.data, filename: u.filename, mimeType: u.mimeType, userId: user.userId });
      const [doc] = await db.insert(documents).values({ officeId: user.officeId, customerId: customer.id, fileId: f.id, category: 'copilot', uploadedBy: 'office' }).returning();
      created.push(doc.id);
    }
    if (!created.length) throw badRequest('Selecione ao menos um arquivo.');
    reply.status(201);
    return { ids: created };
  });

  app.delete('/customers/:id/copilot/documents/:docId', { preHandler: guard('copilot.use') }, async (req) => {
    const user = requireUser(req);
    const { id, docId } = parse(z.object({ id: z.uuid(), docId: z.uuid() }), req.params);
    const customer = await getCustomerForUser(app.ctx, user, id);
    await requireActiveEnrollment(app.ctx, user.officeId, customer.id);
    const rows = await db
      .delete(documents)
      .where(and(eq(documents.id, docId), eq(documents.officeId, user.officeId), eq(documents.customerId, customer.id), inArray(documents.category, ['copilot'])))
      .returning();
    if (!rows.length) throw notFound('Documento');
    await app.ctx.files.remove(user.officeId, rows[0].fileId);
    return { ok: true };
  });
}
