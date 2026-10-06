/**
 * Aprovação do orçamento pelo cliente:
 * - link público `/orcamento/<token>` (sem login; token aleatório guardado como hash, vale 30 dias);
 * - portal do cliente (token emitido pelo módulo do portal com escopo `portal`).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildInstallmentPlan, splitInstallments } from '@verifco/shared';
import type { AppContext } from '../../context';
import { auditLogs, budgets, customers, offices, paymentMethods } from '../../db/schema';
import { sha256 } from '../../lib/crypto';
import { HttpError, conflict, notFound, unauthorized } from '../../lib/errors';
import { optionalText, parse, uuidParam } from '../../lib/http';
import { notify } from '../../services/notify';
import { sendStoredFile } from '../../services/uploads';
import { approveBudget, linkExpiresAt, rejectBudget, type BudgetRow } from './service';
import { categoryLabel } from './text';

const tokenParam = z.object({ token: z.string().min(20).max(200) });
const gone = (message: string) => new HttpError(410, message);

/** Resumo da proposta mostrado ao cliente (sem observação interna nem dados de outros clientes). */
async function publicSummary(ctx: AppContext, b: BudgetRow) {
  const method = b.paymentMethodId ? await ctx.db.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, b.paymentMethodId) }) : null;
  const plan = b.billingStartDate ? buildInstallmentPlan(b.totalCents, b.installments, b.billingStartDate) : null;
  return {
    id: b.id,
    status: b.status,
    exerciseYear: b.exerciseYear,
    category: b.category,
    categoryLabel: categoryLabel(b.category),
    description: b.description,
    amountCents: b.amountCents,
    discountPercent: Number(b.discountPercent),
    totalCents: b.totalCents,
    installments: b.installments,
    installmentAmounts: splitInstallments(b.totalCents, b.installments),
    plan,
    paymentMethod: method?.name ?? null,
    billingStartDate: b.billingStartDate,
    sentAt: b.sentAt,
    approvedAt: b.approvedAt,
    rejectedAt: b.rejectedAt,
  };
}

async function auditPublic(ctx: AppContext, b: BudgetRow, action: string, data: Record<string, unknown>) {
  await ctx.db.insert(auditLogs).values({ officeId: b.officeId, userId: null, action, entity: 'budget', entityId: b.id, data });
}

async function notifyOffice(ctx: AppContext, b: BudgetRow, approved: boolean, via: string) {
  const c = await ctx.db.query.customers.findFirst({ where: eq(customers.id, b.customerId) });
  await notify(ctx.db, {
    officeId: b.officeId,
    userId: c?.responsibleUserId ?? null,
    customerId: b.customerId,
    title: approved ? 'Orçamento aprovado pelo cliente' : 'Orçamento recusado pelo cliente',
    body: `${c?.name ?? 'Cliente'} ${approved ? 'aprovou' : 'recusou'} a proposta de ${categoryLabel(b.category)} ${b.exerciseYear} (${via}).`,
    link: `/clientes/${b.customerId}/irpf/orcamento`,
  });
}

export async function publicRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  /** Orçamento pelo token do link; 404 se não existe, 410 se expirou, foi cancelado ou o cliente foi excluído. */
  const byToken = async (token: string) => {
    const b = await db.query.budgets.findFirst({ where: eq(budgets.approvalTokenHash, sha256(token)) });
    if (!b || b.status === 'draft') throw notFound('Orçamento');
    if (b.status === 'canceled') throw gone('Esta proposta foi cancelada pelo escritório.');
    // cliente excluído (soft delete): o link deixa de valer e não gera faturamento nem cobrança
    const customer = await db.query.customers.findFirst({ where: eq(customers.id, b.customerId), columns: { deletedAt: true } });
    if (!customer || customer.deletedAt) throw gone('Esta proposta não está mais disponível. Fale com o escritório.');
    const expires = linkExpiresAt(b.sentAt);
    if (b.status === 'sent' && (!expires || expires.getTime() < Date.now())) throw gone('Este link expirou. Peça ao escritório um novo envio da proposta.');
    return b;
  };

  app.get('/public/budgets/:token', async (req) => {
    const { token } = parse(tokenParam, req.params);
    const b = await byToken(token);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, b.officeId) });
    const customer = await db.query.customers.findFirst({ where: eq(customers.id, b.customerId) });
    return {
      office: { name: office?.name ?? '', email: office?.email ?? null, phone: office?.phone ?? null, hasLogo: Boolean(office?.logoFileId) },
      customer: { name: customer?.name ?? '' },
      budget: await publicSummary(ctx, b),
      expiresAt: b.status === 'sent' ? linkExpiresAt(b.sentAt) : null,
    };
  });

  /** Logo do escritório para a página pública. */
  app.get('/public/budgets/:token/logo', async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const b = await byToken(token);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, b.officeId) });
    if (!office?.logoFileId) throw notFound('Logo');
    const { row, data } = await ctx.files.get(office.id, office.logoFileId);
    if (!/^image\//.test(row.mimeType)) throw notFound('Logo');
    return sendStoredFile(reply, row, data, true, 'private, max-age=3600');
  });

  /** Aprovação idempotente: repetir não gera outro faturamento. */
  app.post('/public/budgets/:token/approve', async (req) => {
    const { token } = parse(tokenParam, req.params);
    const b = await byToken(token);
    if (b.status === 'rejected') throw conflict('Esta proposta foi recusada. Fale com o escritório para receber uma nova.');
    if (b.status === 'approved') return { ok: true, budget: await publicSummary(ctx, b) };
    const result = await approveBudget(ctx, b, 'Cliente (link de aprovação)');
    if (result.created) {
      await auditPublic(ctx, b, 'approve_public', { billingId: result.billing.id, ip: req.ip });
      await notifyOffice(ctx, b, true, 'link de aprovação');
    }
    return { ok: true, budget: await publicSummary(ctx, result.budget) };
  });

  app.post('/public/budgets/:token/reject', async (req) => {
    const { token } = parse(tokenParam, req.params);
    const body = parse(z.object({ reason: optionalText }), req.body);
    const b = await byToken(token);
    if (b.status === 'approved') throw conflict('Esta proposta já foi aprovada.');
    if (b.status === 'rejected') return { ok: true, budget: await publicSummary(ctx, b) };
    const row = await rejectBudget(ctx, b);
    await auditPublic(ctx, b, 'reject_public', { reason: body.reason ?? null, ip: req.ip });
    await notifyOffice(ctx, b, false, body.reason ? `motivo: ${body.reason}` : 'link de aprovação');
    return { ok: true, budget: await publicSummary(ctx, row) };
  });

  // ------------------------------------------------------------ portal do cliente
  const portalCustomer = (req: FastifyRequest) => {
    const auth = req.customerAuth;
    if (!auth || auth.scope !== 'portal') throw unauthorized('Entre no portal para continuar.');
    return auth;
  };

  const portalBudget = async (req: FastifyRequest) => {
    const auth = portalCustomer(req);
    const { id } = parse(uuidParam, req.params);
    const b = await db.query.budgets.findFirst({
      where: and(eq(budgets.id, id), eq(budgets.officeId, auth.officeId), eq(budgets.customerId, auth.customerId), inArray(budgets.status, ['sent', 'approved'])),
    });
    if (!b) throw notFound('Orçamento');
    return b;
  };

  /** Propostas enviadas e aprovadas do próprio cliente. */
  app.get('/portal/budgets', async (req) => {
    const auth = portalCustomer(req);
    const rows = await db
      .select()
      .from(budgets)
      .where(and(eq(budgets.officeId, auth.officeId), eq(budgets.customerId, auth.customerId), inArray(budgets.status, ['sent', 'approved'])))
      .orderBy(desc(budgets.exerciseYear), desc(budgets.createdAt));
    return Promise.all(rows.map((b) => publicSummary(ctx, b)));
  });

  app.post('/portal/budgets/:id/approve', async (req) => {
    const b = await portalBudget(req);
    if (b.status === 'approved') return publicSummary(ctx, b);
    const result = await approveBudget(ctx, b, 'Cliente (portal)');
    if (result.created) {
      await auditPublic(ctx, b, 'approve_portal', { billingId: result.billing.id });
      await notifyOffice(ctx, b, true, 'portal do cliente');
    }
    return publicSummary(ctx, result.budget);
  });

  app.post('/portal/budgets/:id/reject', async (req) => {
    const b = await portalBudget(req);
    const body = parse(z.object({ reason: optionalText }), req.body);
    const row = await rejectBudget(ctx, b);
    await auditPublic(ctx, b, 'reject_portal', { reason: body.reason ?? null });
    await notifyOffice(ctx, b, false, body.reason ? `motivo: ${body.reason}` : 'portal do cliente');
    return publicSummary(ctx, row);
  });
}
