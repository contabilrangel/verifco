/** Orçamentos do cliente (etapa IRPF), faturamento, recibos e autorização. */
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BUDGET_CATEGORIES, computeBudgetAmount, escapeHtml, todayIso, type BudgetCategory } from '@verifco/shared';
import { budgets, declarations, installments, priceTables } from '../../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit, can, centsSchema, dateStr, guard, optionalText, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { getOrCreateDeclaration } from '../../services/declarations';
import { queueDelivery } from '../../services/delivery';
import { getOfficeSettings } from '../../services/settings';
import { billingProvidersReady } from '../integrations/jobs';
import { withExternalSync } from './billing-routes';
import { buildAuthorizationPdf, generateReceipt, receiptValues } from './pdfs';
import {
  applyStatus,
  approveBudget,
  assertContacts,
  getBudgetForUser,
  getInstallmentForUser,
  issueApprovalLink,
  previousYearBudget,
  priceTableLike,
  pricingTotalsOf,
  refreshBillingTotal,
  rejectBudget,
  releaseDeclarationStage,
  resolveBudgetValues,
  sendBudget,
  serializeBudget,
  serializeBudgets,
  userName,
  type Channel,
} from './service';

const categories = Object.keys(BUDGET_CATEGORIES) as [BudgetCategory, ...BudgetCategory[]];
const channelSchema = z.enum(['email', 'whatsapp']);

const pricingInputs = z
  .object({
    hours: z.coerce.number().min(0).max(10_000).optional(),
    items: z.record(z.string(), z.coerce.number().min(0).max(100_000)).optional(),
  })
  .default({});

const budgetFields = {
  type: z.enum(['fixed', 'variable', 'integration']).default('fixed'),
  status: z.enum(['draft', 'sent', 'approved', 'rejected', 'canceled']).default('draft'),
  category: z.enum(categories).default('irpf'),
  description: optionalText,
  priceTableId: z.uuid().nullable().optional(),
  pricingInputs,
  amountCents: centsSchema.nullable().optional(),
  discountPercent: z.coerce.number().min(0, 'Desconto inválido').max(100, 'Desconto inválido').default(0),
  paymentMethodId: z.uuid().nullable().optional(),
  billingStartDate: z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional()),
  installments: z.coerce.number().int().min(1).max(60).default(1),
  internalNote: optionalText,
  sendEmail: z.boolean().optional(),
  sendWhatsApp: z.boolean().optional(),
};

const createSchema = z.object({ customerId: z.uuid(), exerciseYear: yearSchema, ...budgetFields });
const updateSchema = z.object(budgetFields);

const channelsOf = (b: { sendEmail?: boolean; sendWhatsApp?: boolean }): Channel[] => [
  ...(b.sendEmail ? (['email'] as const) : []),
  ...(b.sendWhatsApp ? (['whatsapp'] as const) : []),
];

export async function budgetRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  /** Orçamentos do cliente no exercício, com o faturamento e a referência do ano anterior. */
  app.get('/finance/customers/:customerId/budgets', { preHandler: guard('budget.list') }, async (req) => {
    const user = requireUser(req);
    const { customerId } = parse(z.object({ customerId: z.uuid() }), req.params);
    const { year } = parse(z.object({ year: yearSchema }), req.query);
    const customer = await getCustomerForUser(ctx, user, customerId);
    const rows = await db
      .select()
      .from(budgets)
      .where(and(eq(budgets.officeId, user.officeId), eq(budgets.customerId, customer.id), eq(budgets.exerciseYear, year)))
      .orderBy(desc(budgets.createdAt));
    const decl = await db.query.declarations.findFirst({ where: and(eq(declarations.customerId, customer.id), eq(declarations.exerciseYear, year)) });
    const settings = await getOfficeSettings(db, user.officeId);
    return {
      data: await withExternalSync(ctx, user.officeId, await serializeBudgets(ctx, rows)),
      previous: await previousYearBudget(ctx, user.officeId, customer.id, year),
      declarationTotals: pricingTotalsOf(decl),
      customer: { id: customer.id, name: customer.name, hasEmail: Boolean(customer.email), hasMobile: Boolean(customer.mobile) },
      settings: { allowAuthorizationWithoutBudget: settings.allowAuthorizationWithoutBudget },
      // integrações de cobrança prontas: a tela avisa ao aprovar com Asaas/Omie desligado
      integrations: await billingProvidersReady(ctx, user.officeId),
    };
  });

  /** Calcula o valor pela tabela de cobrança com os dados da declaração do ano. */
  app.post('/finance/budgets/quote', { preHandler: guard('budget.create', 'budget.edit') }, async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ customerId: z.uuid(), exerciseYear: yearSchema, priceTableId: z.uuid(), pricingInputs }), req.body);
    const customer = await getCustomerForUser(ctx, user, body.customerId);
    const table = await db.query.priceTables.findFirst({ where: and(eq(priceTables.id, body.priceTableId), eq(priceTables.officeId, user.officeId)) });
    if (!table) throw notFound('Tabela de cobrança');
    const decl = await getOrCreateDeclaration(db, user.officeId, customer.id, body.exerciseYear);
    const totals = pricingTotalsOf(decl);
    return { ...computeBudgetAmount(priceTableLike(table), body.pricingInputs, totals, todayIso()), declarationTotals: totals };
  });

  app.post('/finance/budgets', { preHandler: guard('budget.create') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(createSchema, req.body);
    const channels = channelsOf(body);
    if (body.status === 'approved' && !can(user, 'budget.approve')) throw forbidden('Você não tem permissão para aprovar orçamentos.');
    if (channels.length && !can(user, 'budget.send')) throw forbidden('Você não tem permissão para enviar orçamentos.');
    if (channels.length && !['draft', 'sent'].includes(body.status)) throw badRequest('Só é possível enviar orçamentos em rascunho ou enviados.');
    const customer = await getCustomerForUser(ctx, user, body.customerId);
    assertContacts(customer, channels);
    const decl = await getOrCreateDeclaration(db, user.officeId, customer.id, body.exerciseYear);
    const values = await resolveBudgetValues(ctx, user.officeId, decl, body);
    let [row] = await db
      .insert(budgets)
      .values({ ...values, officeId: user.officeId, customerId: customer.id, declarationId: decl.id, exerciseYear: body.exerciseYear, status: 'draft', createdByUserId: user.userId })
      .returning();
    let link: string | null = null;
    if (channels.length) {
      const sent = await sendBudget(ctx, row, channels, user.userId);
      row = sent.budget;
      link = sent.link;
    } else if (body.status === 'sent') {
      // marcado como enviado sem envio pelo sistema: devolve o link para o escritório compartilhar
      const issued = await issueApprovalLink(ctx, row);
      row = issued.budget;
      link = issued.link;
    } else if (body.status !== 'draft') {
      row = await applyStatus(ctx, row, body.status, await userName(ctx, user.userId));
    }
    await audit(req, 'create', 'budget', row.id, { customerId: customer.id, year: body.exerciseYear, totalCents: row.totalCents, status: row.status });
    reply.status(201);
    return { ...(await serializeBudget(ctx, row)), link };
  });

  app.put('/finance/budgets/:id', { preHandler: guard('budget.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(updateSchema, req.body);
    const channels = channelsOf(body);
    let row = await getBudgetForUser(ctx, user, id);
    if (row.status === 'approved') {
      // aprovado: o faturamento já existe; só descrição e observação podem mudar
      if (body.status !== 'approved') throw conflict('Orçamento aprovado não pode voltar de status.');
      [row] = await db
        .update(budgets)
        .set({ description: body.description ?? null, internalNote: body.internalNote ?? null, updatedAt: new Date() })
        .where(eq(budgets.id, row.id))
        .returning();
      await audit(req, 'update', 'budget', row.id, { fields: ['description', 'internalNote'] });
      return { ...(await serializeBudget(ctx, row)), link: null };
    }
    if (body.status === 'approved' && !can(user, 'budget.approve')) throw forbidden('Você não tem permissão para aprovar orçamentos.');
    if (channels.length && !can(user, 'budget.send')) throw forbidden('Você não tem permissão para enviar orçamentos.');
    if (channels.length && !['draft', 'sent'].includes(body.status)) throw badRequest('Só é possível enviar orçamentos em rascunho ou enviados.');
    const customer = await getCustomerForUser(ctx, user, row.customerId);
    assertContacts(customer, channels);
    const decl = await getOrCreateDeclaration(db, user.officeId, customer.id, row.exerciseYear);
    const values = await resolveBudgetValues(ctx, user.officeId, decl, body, row);
    [row] = await db.update(budgets).set({ ...values, updatedAt: new Date() }).where(eq(budgets.id, row.id)).returning();
    let link: string | null = null;
    if (channels.length) {
      const sent = await sendBudget(ctx, row, channels, user.userId);
      row = sent.budget;
      link = sent.link;
    } else if (body.status === 'sent' && row.status !== 'sent') {
      const issued = await issueApprovalLink(ctx, row);
      row = issued.budget;
      link = issued.link;
    } else {
      row = await applyStatus(ctx, row, body.status, await userName(ctx, user.userId));
    }
    await audit(req, 'update', 'budget', row.id, { status: row.status, totalCents: row.totalCents });
    return { ...(await serializeBudget(ctx, row)), link };
  });

  app.delete('/finance/budgets/:id', { preHandler: guard('budget.delete') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const row = await getBudgetForUser(ctx, user, id);
    if (row.status === 'approved') throw conflict('Orçamento aprovado não pode ser excluído.');
    await db.delete(budgets).where(eq(budgets.id, row.id));
    await releaseDeclarationStage(ctx, row);
    await audit(req, 'delete', 'budget', row.id, { customerId: row.customerId, year: row.exerciseYear });
    return { ok: true };
  });

  /** Envia a proposta com o link de aprovação. Um novo envio invalida o link anterior. */
  app.post('/finance/budgets/:id/send', { preHandler: guard('budget.send') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ channels: z.array(channelSchema).min(1, 'Escolha ao menos um canal') }), req.body);
    const row = await getBudgetForUser(ctx, user, id);
    const sent = await sendBudget(ctx, row, [...new Set(body.channels)], user.userId);
    await audit(req, 'send', 'budget', row.id, { channels: body.channels });
    return { ...(await serializeBudget(ctx, sent.budget)), link: sent.link };
  });

  /** Gera um novo link de aprovação sem enviar (para o escritório compartilhar). */
  app.post('/finance/budgets/:id/link', { preHandler: guard('budget.send') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const row = await getBudgetForUser(ctx, user, id);
    const issued = await issueApprovalLink(ctx, row);
    await audit(req, 'link', 'budget', row.id);
    return { ...(await serializeBudget(ctx, issued.budget)), link: issued.link };
  });

  app.post('/finance/budgets/:id/approve', { preHandler: guard('budget.approve') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const row = await getBudgetForUser(ctx, user, id);
    const result = await approveBudget(ctx, row, await userName(ctx, user.userId));
    await audit(req, 'approve', 'budget', row.id, { billingId: result.billing.id, created: result.created });
    return serializeBudget(ctx, result.budget);
  });

  app.post('/finance/budgets/:id/reject', { preHandler: guard('budget.approve') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const row = await rejectBudget(ctx, await getBudgetForUser(ctx, user, id));
    await audit(req, 'reject', 'budget', row.id);
    return serializeBudget(ctx, row);
  });

  // ------------------------------------------------------------ parcelas
  app.put('/finance/installments/:id', { preHandler: guard('billing.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ dueDate: dateStr.optional(), amountCents: centsSchema.refine((v) => v > 0, 'Informe o valor').optional() }), req.body);
    const { inst, billing } = await getInstallmentForUser(ctx, user, id);
    if (inst.status === 'paid') throw conflict('Parcela paga não pode ser alterada. Desfaça o recebimento antes.');
    if (inst.status === 'canceled') throw conflict('Parcela cancelada não pode ser alterada.');
    if (inst.externalId && body.amountCents !== undefined && body.amountCents !== inst.amountCents) {
      throw conflict('Esta parcela já tem cobrança emitida no provedor. Altere o valor por lá.');
    }
    const [row] = await db
      .update(installments)
      .set({ ...(body.dueDate ? { dueDate: body.dueDate } : {}), ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}) })
      .where(eq(installments.id, inst.id))
      .returning();
    await refreshBillingTotal(ctx, billing.id);
    await audit(req, 'update', 'installment', row.id, { from: { dueDate: inst.dueDate, amountCents: inst.amountCents }, to: body });
    return { ok: true };
  });

  app.post('/finance/installments/:id/receive', { preHandler: guard('billing.receive') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ paidAt: dateStr.optional(), paidAmountCents: centsSchema.refine((v) => v > 0, 'Informe o valor recebido').optional() }), req.body);
    const { inst } = await getInstallmentForUser(ctx, user, id);
    if (inst.status === 'paid') throw conflict('Esta parcela já está paga.');
    if (inst.status === 'canceled') throw conflict('Parcela cancelada não pode ser recebida.');
    const paidAt = body.paidAt ?? todayIso();
    if (paidAt > todayIso()) throw badRequest('A data do recebimento não pode estar no futuro.');
    await db
      .update(installments)
      .set({ status: 'paid', paidAt, paidAmountCents: body.paidAmountCents ?? inst.amountCents })
      .where(eq(installments.id, inst.id));
    await audit(req, 'receive', 'installment', inst.id, { paidAt, paidAmountCents: body.paidAmountCents ?? inst.amountCents });
    return { ok: true };
  });

  /** Desfaz um recebimento lançado por engano (só antes de emitir o recibo). */
  app.post('/finance/installments/:id/reopen', { preHandler: guard('billing.receive') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { inst } = await getInstallmentForUser(ctx, user, id);
    if (inst.status !== 'paid') throw conflict('A parcela não está paga.');
    if (inst.receiptNumber) throw conflict('Já existe recibo emitido para esta parcela.');
    await db.update(installments).set({ status: 'open', paidAt: null, paidAmountCents: null }).where(eq(installments.id, inst.id));
    await audit(req, 'reopen', 'installment', inst.id);
    return { ok: true };
  });

  app.post('/finance/installments/:id/receipt', { preHandler: guard('billing.receipt_generate') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const data = await getInstallmentForUser(ctx, user, id);
    const r = await generateReceipt(ctx, data, user.userId);
    await audit(req, 'receipt_generate', 'installment', data.inst.id, { receiptNumber: r.receiptNumber });
    return r;
  });

  app.post('/finance/installments/:id/receipt/send', { preHandler: guard('billing.receipt_send') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ channel: channelSchema }), req.body);
    const data = await getInstallmentForUser(ctx, user, id);
    assertContacts(data.customer, [body.channel]);
    let fileId = data.inst.receiptFileId;
    let number = data.inst.receiptNumber;
    let filename = number ? `recibo-${number}.pdf` : 'recibo.pdf';
    if (!fileId) {
      if (!can(user, 'billing.receipt_generate')) throw badRequest('Gere o recibo antes de enviar.');
      const r = await generateReceipt(ctx, data, user.userId);
      fileId = r.fileId;
      number = r.receiptNumber;
      filename = r.filename;
    }
    await queueDelivery(ctx, {
      officeId: user.officeId,
      customerId: data.customer.id,
      channel: body.channel,
      templateKey: 'receipt',
      values: receiptValues(data.customer, data.budget, data.inst),
      exerciseYear: data.budget.exerciseYear,
      attachments: [{ fileId: fileId!, filename }],
      userId: user.userId,
    });
    await db.update(installments).set({ receiptSentAt: new Date() }).where(eq(installments.id, data.inst.id));
    await audit(req, 'receipt_send', 'installment', data.inst.id, { channel: body.channel, receiptNumber: number });
    return { ok: true, receiptNumber: number };
  });

  // ------------------------------------------------------------ autorização
  app.get('/finance/customers/:customerId/authorization', { preHandler: guard('budget.list') }, async (req, reply) => {
    const user = requireUser(req);
    const { customerId } = parse(z.object({ customerId: z.uuid() }), req.params);
    const { year } = parse(z.object({ year: yearSchema }), req.query);
    const customer = await getCustomerForUser(ctx, user, customerId);
    const doc = await buildAuthorizationPdf(ctx, user.officeId, customer, year);
    return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${doc.filename}"`).send(doc.pdf);
  });

  app.post('/finance/customers/:customerId/authorization/send', { preHandler: guard('budget.send') }, async (req) => {
    const user = requireUser(req);
    const { customerId } = parse(z.object({ customerId: z.uuid() }), req.params);
    const body = parse(z.object({ year: yearSchema, channel: channelSchema }), req.body);
    const customer = await getCustomerForUser(ctx, user, customerId);
    assertContacts(customer, [body.channel]);
    const doc = await buildAuthorizationPdf(ctx, user.officeId, customer, body.year);
    const file = await ctx.files.save({ officeId: user.officeId, data: doc.pdf, filename: doc.filename, mimeType: 'application/pdf', userId: user.userId });
    await queueDelivery(ctx, {
      officeId: user.officeId,
      customerId: customer.id,
      channel: body.channel,
      subject: doc.subject,
      body: `<p>Olá, ${escapeHtml(customer.name)}!</p><p>Segue em anexo o documento de autorização para elaborarmos e transmitirmos sua declaração de Imposto de Renda ${body.year}. Por favor, confira, assine e nos devolva.</p>`,
      attachments: [{ fileId: file.id, filename: doc.filename }],
      exerciseYear: body.year,
      userId: user.userId,
    });
    await audit(req, 'authorization_send', 'customer', customer.id, { year: body.year, channel: body.channel });
    return { ok: true };
  });
}
