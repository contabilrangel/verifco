import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_HOLDING_PARAMS,
  formatCpfCnpj,
  formatMoney,
  simulateHolding,
  type DeclarationItem,
  type HoldingProperty,
  type HoldingSimulationParams,
} from '@verifco/shared';
import { holdingSimulations } from '../../db/schema';
import { badRequest } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { PdfBuilder, loadBranding } from '../../services/pdf';
import { loadDeclaration } from './common';

type StoredParams = Record<string, number>;

/** Parâmetros da tela ↔ jsonb numérico de `holding_simulations.params`. */
function toSimParams(p: StoredParams): HoldingSimulationParams {
  const d = DEFAULT_HOLDING_PARAMS;
  const n = (k: keyof HoldingSimulationParams, fallback: number) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] : fallback);
  return {
    itbiPercent: n('itbiPercent', d.itbiPercent),
    itbiImmune: p.itbiImmune === 1,
    registryPercent: n('registryPercent', d.registryPercent),
    itcmdPercent: n('itcmdPercent', d.itcmdPercent),
    inventoryFeesPercent: n('inventoryFeesPercent', d.inventoryFeesPercent),
    holdingItcmdBase: p.holdingItcmdBaseDeclared === 1 ? 'declared' : 'market',
    holdingSetupCents: n('holdingSetupCents', d.holdingSetupCents),
    holdingAnnualCostCents: n('holdingAnnualCostCents', d.holdingAnnualCostCents),
    rentGrowthPercent: n('rentGrowthPercent', d.rentGrowthPercent),
    years: n('years', d.years),
  };
}

/** Imóveis da declaração: bens do grupo 01. */
const realEstate = (items: DeclarationItem[]) => items.filter((i) => i.kind === 'asset' && i.groupCode === '01' && i.id);

/** Demais rendimentos tributáveis (sem aluguéis, que entram pela simulação). */
const otherTaxable = (items: DeclarationItem[]) =>
  items
    .filter((i) => (i.kind === 'income_pj' || i.kind === 'income_pf') && i.extra?.nature !== 'rent')
    .reduce((a, i) => a + (i.valueCents ?? 0), 0) +
  Math.max(
    0,
    items.reduce((a, i) => a + (i.kind === 'rural_income' ? (i.valueCents ?? 0) : i.kind === 'rural_expense' ? -(i.valueCents ?? 0) : 0), 0),
  );

const pct = z.coerce.number().min(0).max(100);
const saveSchema = z.object({
  year: yearSchema,
  selectedItemIds: z.array(z.uuid()).max(500),
  params: z
    .object({
      itbiPercent: pct,
      itbiImmune: z.boolean(),
      registryPercent: pct,
      itcmdPercent: pct,
      inventoryFeesPercent: pct,
      holdingItcmdBase: z.enum(['market', 'declared']),
      holdingSetupCents: z.coerce.number().int().min(0).max(1e12),
      holdingAnnualCostCents: z.coerce.number().int().min(0).max(1e12),
      rentGrowthPercent: z.coerce.number().min(-50).max(100),
      years: z.coerce.number().int().min(1).max(30),
    })
    .partial()
    .default({}),
  properties: z
    .record(z.uuid(), z.object({ monthlyRentCents: z.coerce.number().int().min(0).max(1e12).optional(), marketValueCents: z.coerce.number().int().min(0).max(1e14).optional() }))
    .default({}),
});

export async function holdingRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  async function load(req: FastifyRequest, customerId: string, year: number) {
    const user = requireUser(req);
    const customer = await getCustomerForUser(app.ctx, user, customerId);
    const { declaration, items } = await loadDeclaration(app.ctx, user.officeId, customer.id, year);
    const sim = await db.query.holdingSimulations.findFirst({
      where: and(eq(holdingSimulations.officeId, user.officeId), eq(holdingSimulations.customerId, customer.id), eq(holdingSimulations.exerciseYear, year)),
    });
    const stored: StoredParams = sim?.params ?? {};
    const assets = realEstate(items);
    const selected = new Set(sim ? sim.selectedItemIds : assets.map((a) => a.id!));
    const properties = assets.map((a) => ({
      id: a.id!,
      description: a.description || 'Imóvel sem descrição',
      code: a.code ?? null,
      prevValueCents: a.prevValueCents ?? 0,
      declaredValueCents: a.valueCents ?? 0,
      marketValueCents: stored[`market:${a.id}`] ?? a.valueCents ?? 0,
      monthlyRentCents: stored[`rent:${a.id}`] ?? 0,
      selected: selected.has(a.id!),
    }));
    const params = toSimParams(stored);
    const used: HoldingProperty[] = properties.filter((p) => p.selected);
    const result = simulateHolding({ calendarYear: year - 1, properties: used, otherTaxableIncomeCents: otherTaxable(items), params });
    return {
      user,
      customer,
      payload: {
        year,
        hasDeclaration: Boolean(declaration),
        saved: Boolean(sim),
        updatedAt: sim?.updatedAt ?? null,
        properties,
        params,
        otherTaxableIncomeCents: otherTaxable(items),
        declaredTotalCents: properties.reduce((a, p) => a + p.declaredValueCents, 0),
        result,
      },
    };
  }

  app.get('/customers/:id/holding', { preHandler: guard('holding.view') }, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(z.object({ year: yearSchema }), req.query);
    return (await load(req, id, year)).payload;
  });

  app.put('/customers/:id/holding', { preHandler: guard('holding.view') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(saveSchema, req.body);
    const customer = await getCustomerForUser(app.ctx, user, id);
    const { items } = await loadDeclaration(app.ctx, user.officeId, customer.id, body.year);
    const valid = new Set(realEstate(items).map((a) => a.id!));
    if (body.selectedItemIds.some((x) => !valid.has(x))) throw badRequest('Imóvel não encontrado na declaração do exercício.');
    const current = await db.query.holdingSimulations.findFirst({
      where: and(eq(holdingSimulations.officeId, user.officeId), eq(holdingSimulations.customerId, customer.id), eq(holdingSimulations.exerciseYear, body.year)),
    });
    const merged = { ...toSimParams(current?.params ?? {}), ...body.params };
    const stored: StoredParams = {
      ...Object.fromEntries(Object.entries(current?.params ?? {}).filter(([k]) => k.includes(':'))),
      itbiPercent: merged.itbiPercent,
      itbiImmune: merged.itbiImmune ? 1 : 0,
      registryPercent: merged.registryPercent,
      itcmdPercent: merged.itcmdPercent,
      inventoryFeesPercent: merged.inventoryFeesPercent,
      holdingItcmdBaseDeclared: merged.holdingItcmdBase === 'declared' ? 1 : 0,
      holdingSetupCents: merged.holdingSetupCents,
      holdingAnnualCostCents: merged.holdingAnnualCostCents,
      rentGrowthPercent: merged.rentGrowthPercent,
      years: merged.years,
    };
    for (const [itemId, v] of Object.entries(body.properties)) {
      if (!valid.has(itemId)) throw badRequest('Imóvel não encontrado na declaração do exercício.');
      if (v.monthlyRentCents !== undefined) stored[`rent:${itemId}`] = v.monthlyRentCents;
      if (v.marketValueCents !== undefined) stored[`market:${itemId}`] = v.marketValueCents;
    }
    await db
      .insert(holdingSimulations)
      .values({ officeId: user.officeId, customerId: customer.id, exerciseYear: body.year, params: stored, selectedItemIds: body.selectedItemIds })
      .onConflictDoUpdate({
        target: [holdingSimulations.customerId, holdingSimulations.exerciseYear],
        set: { params: stored, selectedItemIds: body.selectedItemIds, updatedAt: new Date() },
      });
    await audit(req, 'save', 'holding_simulation', customer.id, { year: body.year, properties: body.selectedItemIds.length });
    return (await load(req, id, body.year)).payload;
  });

  app.post('/customers/:id/holding/pdf', { preHandler: guard('holding.view') }, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(z.object({ year: yearSchema }), req.body);
    const { user, customer, payload } = await load(req, id, year);
    const r = payload.result;
    const m = formatMoney;
    const pdf = new PdfBuilder(await loadBranding(app.ctx, user.officeId), 'Simulação de holding patrimonial', `${customer.name} · CPF ${formatCpfCnpj(customer.cpfCnpj)} · exercício ${year}`);
    pdf.heading('Imóveis da simulação');
    const used = payload.properties.filter((p) => p.selected);
    pdf.table(
      [
        { label: 'Imóvel', width: 3.2 },
        { label: 'Declarado', width: 1.3, align: 'right' },
        { label: 'Mercado', width: 1.3, align: 'right' },
        { label: 'Aluguel/mês', width: 1.2, align: 'right' },
      ],
      used.map((p) => [p.description, m(p.declaredValueCents), m(p.marketValueCents), m(p.monthlyRentCents)]),
      { totals: [`${used.length} imóvel(is)`, m(r.totals.declaredValueCents), m(r.totals.marketValueCents), m(r.totals.monthlyRentCents)] },
    );
    pdf.heading('Parâmetros');
    pdf.keyValues([
      ['ITBI', r.params.itbiImmune ? 'imunidade na integralização' : `${r.params.itbiPercent}%`],
      ['Cartório e registro', `${r.params.registryPercent}%`],
      ['ITCMD', `${r.params.itcmdPercent}% (holding: ${r.params.holdingItcmdBase === 'declared' ? 'valor declarado' : 'valor de mercado'})`],
      ['Honorários e custas do inventário', `${r.params.inventoryFeesPercent}%`],
      ['Constituição da holding', m(r.params.holdingSetupCents)],
      ['Manutenção anual da holding', m(r.params.holdingAnnualCostCents)],
      ['Reajuste anual dos aluguéis', `${r.params.rentGrowthPercent}%`],
      ['Demais rendimentos tributáveis da PF', m(payload.otherTaxableIncomeCents)],
    ]);
    pdf.heading('Comparação: pessoa física × holding');
    pdf.table(
      [
        { label: 'Item', width: 2 },
        { label: 'PF', width: 1.3, align: 'right' },
        { label: 'Holding', width: 1.3, align: 'right' },
        { label: 'Economia', width: 1.3, align: 'right' },
      ],
      r.rows.map((x) => [x.label, m(x.pfCents), m(x.holdingCents), m(x.savingCents)]),
      { totals: [`Total (${r.params.years} anos + sucessão)`, m(r.pfTotalCents), m(r.holdingTotalCents), m(r.totalSavingCents)] },
    );
    pdf.paragraph(
      `IR anual na holding: IRPJ ${m(r.holdingRentTax.irpjCents)}, adicional ${m(r.holdingRentTax.surchargeCents)}, CSLL ${m(r.holdingRentTax.csllCents)}, PIS/COFINS ${m(r.holdingRentTax.pisCofinsCents)} sobre lucro presumido de ${m(r.holdingRentTax.presumedProfitCents)}.`,
      { size: 9 },
    );
    pdf.heading('Projeção anual');
    pdf.table(
      [
        { label: 'Ano', width: 0.6 },
        { label: 'Aluguéis', width: 1.3, align: 'right' },
        { label: 'IR na PF', width: 1.3, align: 'right' },
        { label: 'Tributos holding', width: 1.3, align: 'right' },
        { label: 'Manutenção', width: 1.2, align: 'right' },
      ],
      r.yearly.map((y) => [String(y.year), m(y.annualRentCents), m(y.pfTaxCents), m(y.holdingTaxCents), m(y.holdingCostCents)]),
    );
    pdf.heading('Observações importantes');
    for (const o of [...r.observations, ...r.warnings]) pdf.paragraph(`• ${o}`, { size: 9 });
    pdf.paragraph(`Fontes: ${r.taxParams.sources.join(' · ')}`, { muted: true, size: 7 });
    const buf = await pdf.finish();
    await audit(req, 'pdf', 'holding_simulation', customer.id, { year });
    return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="holding-${year}.pdf"`).send(buf);
  });
}
