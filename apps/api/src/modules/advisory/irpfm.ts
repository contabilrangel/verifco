import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IRPFM_EXCLUSIONS, formatCpfCnpj, formatMoney, type IrpfmResult } from '@verifco/shared';
import { audit, guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { PdfBuilder, loadBranding } from '../../services/pdf';
import { irpfmForDeclaration, loadDeclaration, type IrpfmAdjustments } from './common';

const cents = z.coerce.number().int().min(0).max(1e13);
const adjustmentsSchema = z
  .object({
    regularTaxDueCents: cents.nullable().optional(),
    law14754TaxCents: cents.nullable().optional(),
    definitiveTaxPaidCents: cents.nullable().optional(),
    dividendWithholdingCents: cents.nullable().optional(),
    ruralTaxableResultCents: cents.nullable().optional(),
    dividendPayers: z
      .array(
        z.object({
          payerDoc: z.string().max(20).nullable().optional(),
          payerName: z.string().max(200).nullable().optional(),
          pjEffectiveRatePercent: z.coerce.number().min(0).max(100).nullable().optional(),
          nominalKind: z.enum(['general', 'insuranceFinancial', 'banks']).optional(),
        }),
      )
      .max(100)
      .optional(),
  })
  .partial();
const bodySchema = z.object({ year: yearSchema, adjustments: adjustmentsSchema.optional() });

const pct = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const REGULAR_SOURCE = { declaration: 'apurado na declaração', estimated: 'estimado pelas linhas da declaração (deduções legais)', manual: 'informado pelo escritório' } as const;

export async function irpfmRoutes(app: FastifyInstance) {
  async function calculate(req: FastifyRequest, customerId: string, year: number, adjustments: IrpfmAdjustments = {}) {
    const user = requireUser(req);
    const customer = await getCustomerForUser(app.ctx, user, customerId);
    const { declaration, items } = await loadDeclaration(app.ctx, user.officeId, customer.id, year);
    const { result, regularTaxSource } = irpfmForDeclaration(declaration, items, year, adjustments);
    return {
      user,
      customer,
      payload: {
        year,
        calendarYear: year - 1,
        hasDeclaration: Boolean(declaration),
        itemsCount: items.length,
        regularTaxSource,
        regularTaxSourceLabel: REGULAR_SOURCE[regularTaxSource],
        result,
      },
    };
  }

  app.get('/customers/:id/irpfm', { preHandler: guard('irpfm.view') }, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { year } = parse(z.object({ year: yearSchema }), req.query);
    return (await calculate(req, id, year)).payload;
  });

  app.post('/customers/:id/irpfm', { preHandler: guard('irpfm.view') }, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(bodySchema, req.body);
    return (await calculate(req, id, body.year, body.adjustments)).payload;
  });

  app.post('/customers/:id/irpfm/pdf', { preHandler: guard('irpfm.view') }, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(bodySchema, req.body);
    const { user, customer, payload } = await calculate(req, id, body.year, body.adjustments);
    const pdf = await irpfmPdf(app, user.officeId, customer, payload);
    await audit(req, 'pdf', 'irpfm', customer.id, { year: body.year });
    return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="irpfm-${body.year}.pdf"`).send(pdf);
  });
}

async function irpfmPdf(
  app: FastifyInstance,
  officeId: string,
  customer: { name: string; cpfCnpj: string },
  p: { year: number; calendarYear: number; regularTaxSourceLabel: string; result: IrpfmResult },
) {
  const r = p.result;
  const pdf = new PdfBuilder(await loadBranding(app.ctx, officeId), 'Cálculo do IRPFM', `${customer.name} · CPF ${formatCpfCnpj(customer.cpfCnpj)} · exercício ${p.year} (ano-calendário ${p.calendarYear})`);
  const m = formatMoney;

  pdf.heading('Resumo');
  pdf.keyValues([
    ['Situação', r.subject ? 'Sujeito à tributação mínima' : 'Não sujeito'],
    ['Rendimentos totais', m(r.totalIncomeCents)],
    ['Limite', m(r.thresholdCents)],
    ['Base de cálculo', m(r.baseCents)],
    ['Excesso sobre o limite', m(r.excessCents)],
    ['Alíquota', pct(r.ratePercent)],
    ['Imposto mínimo bruto', m(r.grossTaxCents)],
    ['Imposto já pago e redutor', m(r.deductions.totalCents + r.reducer.totalCents)],
    ['IRPFM devido', m(r.dueCents)],
    ['Imposto complementar', m(r.complementaryCents)],
    ['Alíquota efetiva', pct(r.effectiveRatePercent)],
  ]);

  pdf.heading('Composição dos rendimentos');
  const comp = r.composition.filter((c) => c.group !== 'excluded');
  pdf.table(
    [
      { label: 'Descrição', width: 4 },
      { label: 'Valor', width: 1.4, align: 'right' },
    ],
    comp.flatMap((c) => [[c.label.toUpperCase(), m(c.cents)], ...c.lines.map((l) => [`   ${l.label}`, m(l.cents)])]),
    { totals: ['Total incluído na base', m(r.baseCents)] },
  );

  pdf.heading('Exclusões (art. 16-A, § 1º)');
  if (r.exclusions.length) {
    pdf.table(
      [
        { label: 'Descrição', width: 3.4 },
        { label: 'Fundamento', width: 1.6 },
        { label: 'Valor', width: 1.4, align: 'right' },
      ],
      r.exclusions.map((e) => [e.label, e.ref, m(e.cents)]),
      { totals: ['Total excluído', '', m(r.exclusionsCents)] },
    );
  } else pdf.paragraph('Nenhum rendimento excluído da base.', { muted: true });

  pdf.heading('Base de cálculo e alíquota');
  pdf.moneyLines([
    { label: 'Rendimentos totais', cents: r.totalIncomeCents },
    { label: '(−) Exclusões', cents: -r.exclusionsCents },
  ]);
  pdf.paragraph(
    r.baseCents >= r.params.fullRateFromCents
      ? `Base a partir de ${m(r.params.fullRateFromCents)}: alíquota de ${pct(r.params.maxRatePercent)}.`
      : r.baseCents > r.thresholdCents
        ? `Alíquota % = REND / 60.000 − 10 = ${(r.baseCents / 100).toLocaleString('pt-BR')} / 60.000 − 10 = ${pct(r.ratePercent)}.`
        : 'Base até o limite: alíquota zero.',
  );

  pdf.heading('Imposto bruto e deduções (art. 16-A, § 3º)');
  pdf.table(
    [
      { label: 'Descrição', width: 4 },
      { label: 'Valor', width: 1.4, align: 'right' },
    ],
    [
      ['Imposto mínimo bruto (alíquota × base)', m(r.grossTaxCents)],
      [`(−) I — IR devido na declaração de ajuste (${p.regularTaxSourceLabel})`, m(r.deductions.regularTaxDueCents)],
      ['(−) II — IR retido exclusivamente na fonte', m(r.deductions.exclusiveWithheldCents)],
      ['(−) III — IR da Lei 14.754/2023', m(r.deductions.law14754TaxCents)],
      ['(−) IV — IR pago definitivamente', m(r.deductions.definitiveTaxPaidCents)],
      ['(−) V — Redutor (art. 16-B)', m(r.reducer.totalCents)],
    ],
    { totals: ['IRPFM devido (não negativo)', m(r.dueCents)] },
  );

  pdf.heading('Redutor (art. 16-B)');
  if (r.reducer.payers.length) {
    pdf.paragraph(`Alíquota efetiva da tributação mínima da pessoa física sobre os dividendos: ${pct(r.reducer.pfEffectiveRatePercent)}.`);
    pdf.table(
      [
        { label: 'Empresa pagadora', width: 3 },
        { label: 'Dividendos', width: 1.4, align: 'right' },
        { label: 'Efetiva PJ', width: 1, align: 'right' },
        { label: 'Nominal', width: 1, align: 'right' },
        { label: 'Redutor', width: 1.4, align: 'right' },
      ],
      r.reducer.payers.map((x) => [
        x.payerName || (x.payerDoc ? formatCpfCnpj(x.payerDoc) : 'Não identificada'),
        m(x.dividendsCents),
        x.pjEffectiveRatePercent === null ? 'não informada' : pct(x.pjEffectiveRatePercent),
        pct(x.nominalRatePercent),
        m(x.reducerCents),
      ]),
    );
  } else pdf.paragraph('Sem lucros e dividendos na base: não há redutor.', { muted: true });

  pdf.heading('Imposto complementar');
  pdf.table(
    [
      { label: 'Descrição', width: 4 },
      { label: 'Valor', width: 1.4, align: 'right' },
    ],
    [
      ['IRPFM devido', m(r.dueCents)],
      ['(−) IR retido sobre dividendos (art. 6º-A)', m(r.dividendWithholdingCents)],
    ],
    { totals: ['Valor somado ao saldo da declaração', m(r.complementaryCents)] },
  );

  pdf.heading('Conclusão');
  pdf.paragraph(r.conclusion);
  for (const w of r.warnings) pdf.paragraph(`Atenção: ${w}`, { muted: true });
  pdf.rule();
  pdf.paragraph(
    `Simulação — confira com a legislação vigente. Fundamento: Lei 15.270/2025 (arts. 6º-A, 16-A e 16-B da Lei 9.250/1995). Exclusões consideradas: ${Object.values(IRPFM_EXCLUSIONS)
      .map((e) => e.ref)
      .join('; ')}.`,
    { muted: true, size: 8 },
  );
  return pdf.finish();
}
