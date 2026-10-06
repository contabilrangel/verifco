/** Cadastros do financeiro: métodos de pagamento e tabelas de cobrança. */
import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PAYMENT_METHOD_TYPES, PRICE_TABLE_TYPES, PRICING_BASES, computeBudgetAmount, isPriceTableValidOn, todayIso, type PaymentMethodType, type PriceTableType, type PricingBase } from '@verifco/shared';
import { budgets, paymentMethods, priceTables, type PriceTableConfig } from '../../db/schema';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { audit, dateStr, guard, parse, requireUser, uuidParam } from '../../lib/http';
import { priceTableLike } from './service';

const keys = <T extends string>(o: Record<T, string>) => Object.keys(o) as [T, ...T[]];

const methodBody = z.object({
  type: z.enum(keys(PAYMENT_METHOD_TYPES) as [PaymentMethodType, ...PaymentMethodType[]]),
  name: z.string().trim().min(2, 'Informe o nome').max(80),
  maxInstallments: z.coerce.number().int().min(1, 'Mínimo de 1 parcela').max(48, 'Máximo de 48 parcelas'),
  active: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

const money = z.coerce.number().int().min(0);

const itemSchema = z.object({
  code: z.string().trim().min(1, 'Informe o código').max(30),
  label: z.string().trim().min(1, 'Informe a descrição').max(120),
  unitPriceCents: money.refine((v) => v > 0, 'Informe o preço'),
});

const tableBody = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome').max(120),
    type: z.enum(keys(PRICE_TABLE_TYPES) as [PriceTableType, ...PriceTableType[]]),
    active: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    validFrom: dateStr,
    validUntil: z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional()),
    config: z
      .object({
        amountCents: money.optional(),
        hourRateCents: money.optional(),
        minHours: z.coerce.number().min(0).max(1000).optional(),
        items: z.array(itemSchema).max(200).optional(),
        percent: z.coerce.number().min(0).max(100).optional(),
        base: z.enum(keys(PRICING_BASES) as [PricingBase, ...PricingBase[]]).optional(),
        minCents: money.nullable().optional(),
        maxCents: money.nullable().optional(),
      })
      .default({}),
  })
  .superRefine((v, ctx) => {
    const c = v.config;
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: path.split('.'), message });
    if (v.validUntil && v.validUntil < v.validFrom) issue('validUntil', 'A data final deve ser depois da inicial');
    if (v.type === 'fixed' && !(c.amountCents && c.amountCents > 0)) issue('config.amountCents', 'Informe o valor');
    if (v.type === 'hourly' && !(c.hourRateCents && c.hourRateCents > 0)) issue('config.hourRateCents', 'Informe o valor da hora');
    if (v.type === 'items') {
      if (!c.items?.length) issue('config.items', 'Cadastre ao menos um item');
      const codes = (c.items ?? []).map((i) => i.code.toUpperCase());
      if (new Set(codes).size !== codes.length) issue('config.items', 'Há códigos de item repetidos');
    }
    if (v.type === 'percentage') {
      if (!(c.percent && c.percent > 0)) issue('config.percent', 'Informe o percentual');
      if (!c.base) issue('config.base', 'Escolha a base do cálculo');
      if (c.minCents && c.maxCents && c.maxCents < c.minCents) issue('config.maxCents', 'O máximo deve ser maior que o mínimo');
    }
  });

/** Guarda só os campos do tipo escolhido. */
function cleanConfig(type: PriceTableType, c: z.infer<typeof tableBody>['config']): PriceTableConfig {
  switch (type) {
    case 'fixed':
      return { amountCents: c.amountCents };
    case 'hourly':
      return { hourRateCents: c.hourRateCents, ...(c.minHours ? { minHours: c.minHours } : {}) };
    case 'items':
      return { items: (c.items ?? []).map((i) => ({ code: i.code.toUpperCase(), label: i.label, unitPriceCents: i.unitPriceCents })) };
    case 'percentage':
      return {
        percent: c.percent,
        base: c.base,
        ...(c.minCents ? { minCents: c.minCents } : {}),
        ...(c.maxCents ? { maxCents: c.maxCents } : {}),
      };
  }
}

export async function catalogRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  // ------------------------------------------------------------ métodos de pagamento
  app.get('/finance/payment-methods', { preHandler: guard('payment_method.list', 'budget.list', 'budget.create', 'budget.edit') }, async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ active: z.enum(['1', 'true']).optional() }), req.query);
    const rows = await db
      .select({ m: paymentMethods, uses: count(budgets.id) })
      .from(paymentMethods)
      .leftJoin(budgets, eq(budgets.paymentMethodId, paymentMethods.id))
      .where(and(eq(paymentMethods.officeId, user.officeId), ...(q.active ? [eq(paymentMethods.active, true)] : [])))
      .groupBy(paymentMethods.id)
      .orderBy(asc(paymentMethods.name));
    return rows.map((r) => ({ ...r.m, typeLabel: PAYMENT_METHOD_TYPES[r.m.type as PaymentMethodType] ?? r.m.type, budgets: r.uses }));
  });

  /** Só um método padrão por escritório; o padrão precisa estar ativo. */
  const saveMethod = async (officeId: string, body: z.infer<typeof methodBody>, id?: string) => {
    if (body.isDefault && !body.active) throw badRequest('Um método inativo não pode ser o padrão.');
    return db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx.update(paymentMethods).set({ isDefault: false }).where(and(eq(paymentMethods.officeId, officeId), ...(id ? [ne(paymentMethods.id, id)] : [])));
      }
      if (id) {
        const [row] = await tx.update(paymentMethods).set(body).where(and(eq(paymentMethods.id, id), eq(paymentMethods.officeId, officeId))).returning();
        if (!row) throw notFound('Método de pagamento');
        return row;
      }
      const [row] = await tx.insert(paymentMethods).values({ ...body, officeId }).returning();
      return row;
    });
  };

  app.post('/finance/payment-methods', { preHandler: guard('payment_method.create') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(methodBody, req.body);
    const row = await saveMethod(user.officeId, body);
    await audit(req, 'create', 'payment_method', row.id, { name: row.name });
    reply.status(201);
    return row;
  });

  app.put('/finance/payment-methods/:id', { preHandler: guard('payment_method.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(methodBody, req.body);
    const row = await saveMethod(user.officeId, body, id);
    await audit(req, 'update', 'payment_method', row.id);
    return row;
  });

  app.delete('/finance/payment-methods/:id', { preHandler: guard('payment_method.delete') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const m = await db.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.id, id), eq(paymentMethods.officeId, user.officeId)) });
    if (!m) throw notFound('Método de pagamento');
    const [{ n }] = await db.select({ n: count() }).from(budgets).where(eq(budgets.paymentMethodId, id));
    if (n > 0) throw conflict('Este método já foi usado em orçamentos. Inative-o em vez de excluir.');
    await db.delete(paymentMethods).where(eq(paymentMethods.id, id));
    await audit(req, 'delete', 'payment_method', id, { name: m.name });
    return { ok: true };
  });

  // ------------------------------------------------------------ tabelas de cobrança
  app.get('/finance/price-tables', { preHandler: guard('price_table.list', 'budget.list', 'budget.create', 'budget.edit') }, async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ valid: z.enum(['1', 'true']).optional() }), req.query);
    const rows = await db
      .select({ t: priceTables, uses: count(budgets.id) })
      .from(priceTables)
      .leftJoin(budgets, eq(budgets.priceTableId, priceTables.id))
      .where(eq(priceTables.officeId, user.officeId))
      .groupBy(priceTables.id)
      .orderBy(asc(priceTables.name));
    const today = todayIso();
    return rows
      .map((r) => ({
        ...r.t,
        typeLabel: PRICE_TABLE_TYPES[r.t.type as PriceTableType] ?? r.t.type,
        validNow: isPriceTableValidOn(r.t, today),
        budgets: r.uses,
      }))
      .filter((t) => !q.valid || t.validNow);
  });

  const saveTable = async (officeId: string, body: z.infer<typeof tableBody>, id?: string) => {
    if (body.isDefault && !body.active) throw badRequest('Uma tabela inativa não pode ser a padrão.');
    const values = { ...body, validUntil: body.validUntil ?? null, config: cleanConfig(body.type, body.config) };
    return db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx.update(priceTables).set({ isDefault: false }).where(and(eq(priceTables.officeId, officeId), ...(id ? [ne(priceTables.id, id)] : [])));
      }
      if (id) {
        const [row] = await tx.update(priceTables).set(values).where(and(eq(priceTables.id, id), eq(priceTables.officeId, officeId))).returning();
        if (!row) throw notFound('Tabela de cobrança');
        return row;
      }
      const [row] = await tx.insert(priceTables).values({ ...values, officeId }).returning();
      return row;
    });
  };

  app.post('/finance/price-tables', { preHandler: guard('price_table.create') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(tableBody, req.body);
    const row = await saveTable(user.officeId, body);
    await audit(req, 'create', 'price_table', row.id, { name: row.name });
    reply.status(201);
    return row;
  });

  app.put('/finance/price-tables/:id', { preHandler: guard('price_table.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(tableBody, req.body);
    const row = await saveTable(user.officeId, body, id);
    await audit(req, 'update', 'price_table', row.id);
    return row;
  });

  app.delete('/finance/price-tables/:id', { preHandler: guard('price_table.delete') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const t = await db.query.priceTables.findFirst({ where: and(eq(priceTables.id, id), eq(priceTables.officeId, user.officeId)) });
    if (!t) throw notFound('Tabela de cobrança');
    const [{ n }] = await db.select({ n: count() }).from(budgets).where(eq(budgets.priceTableId, id));
    if (n > 0) throw conflict('Esta tabela já foi usada em orçamentos. Inative-a em vez de excluir.');
    await db.delete(priceTables).where(eq(priceTables.id, id));
    await audit(req, 'delete', 'price_table', id, { name: t.name });
    return { ok: true };
  });

  /** Simulação do cálculo de uma tabela (tela de cadastro), sem dados de cliente. */
  app.post('/finance/price-tables/:id/simulate', { preHandler: guard('price_table.list', 'budget.create', 'budget.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        inputs: z.object({ hours: z.coerce.number().min(0).optional(), items: z.record(z.string(), z.coerce.number().min(0)).optional() }).default({}),
        totals: z
          .object({ refundCents: money.optional(), taxDueCents: money.optional(), assetsTotalCents: money.optional(), totalIncomeCents: money.optional() })
          .default({}),
        date: dateStr.optional(),
      }),
      req.body,
    );
    const t = await db.query.priceTables.findFirst({ where: and(eq(priceTables.id, id), eq(priceTables.officeId, user.officeId)) });
    if (!t) throw notFound('Tabela de cobrança');
    return computeBudgetAmount(priceTableLike(t), body.inputs, body.totals, body.date ?? todayIso());
  });
}
