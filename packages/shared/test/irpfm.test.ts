import { describe, expect, it } from 'vitest';
import {
  ANNUAL_IRPF_TABLES,
  annualIrpfDue,
  annualProgressiveTax,
  annualTaxReduction,
  computeIrpfm,
  irpfmFromItems,
  irpfmRatePercent,
  regularTaxFromDeclaration,
  type DeclarationItem,
  type IrpfmIncomeLine,
} from '../src';

const R = (reais: number) => Math.round(reais * 100);
const line = (key: string, group: IrpfmIncomeLine['group'], reais: number, extra: Partial<IrpfmIncomeLine> = {}): IrpfmIncomeLine => ({
  key,
  label: key,
  group,
  cents: R(reais),
  ...extra,
});

describe('tabela progressiva anual', () => {
  it('exercício 2026 (AC 2025)', () => {
    expect(annualProgressiveTax(R(28_467.2), 2026)).toBe(0);
    // 7,5% × 30.000 − 2.135,04 = 114,96
    expect(annualProgressiveTax(R(30_000), 2026)).toBe(R(114.96));
    // 27,5% × 60.000 − 10.853,78 = 5.646,22
    expect(annualProgressiveTax(R(60_000), 2026)).toBe(R(5_646.22));
  });

  it('continuidade entre faixas (parcelas a deduzir oficiais)', () => {
    // com as parcelas oficiais, o imposto varia no máximo 1 centavo na troca de faixa (arredondamento
    // das parcelas publicadas); antes, as parcelas de 2027 (mensal × 12) davam até 10 centavos de salto
    for (const ex of [2017, 2023, 2024, 2025, 2026, 2027]) {
      const limits = ANNUAL_IRPF_TABLES[ex].brackets.map((b) => b.upToCents).filter((x): x is number => x !== null);
      for (const limit of limits) {
        expect(Math.abs(annualProgressiveTax(limit + 1, ex) - annualProgressiveTax(limit, ex))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('redução anual da Lei 15.270/2025 a partir do exercício 2027', () => {
    expect(annualTaxReduction(R(60_000), R(5_000), 2026)).toBe(0);
    expect(annualTaxReduction(R(60_000), R(5_000), 2027)).toBe(R(2_694.15));
    // 8.429,73 − 0,095575 × 80.000 = 783,73
    expect(annualTaxReduction(R(80_000), R(6_695.24), 2027)).toBe(R(783.73));
    expect(annualTaxReduction(R(88_200.01), R(10_000), 2027)).toBe(0);
    // limitada ao imposto
    expect(annualTaxReduction(R(50_000), R(100), 2027)).toBe(R(100));
  });

  it('IR devido: R$ 60 mil zera no exercício 2027 e R$ 80 mil tem redução parcial', () => {
    // simplificada: base 48.000 → 22,5% × 48.000 − 8.105,85 = 2.694,15, reduzido a zero
    expect(annualIrpfDue({ exercise: 2027, taxableIncomeCents: R(60_000) }).taxDueCents).toBe(0);
    // simplificada: base 64.000 → 27,5% × 64.000 − 10.904,66 = 6.695,34 − 783,73 = 5.911,61
    const r = annualIrpfDue({ exercise: 2027, taxableIncomeCents: R(80_000), model: 'simplified' });
    expect(r.grossTaxCents).toBe(R(6_695.34));
    expect(r.taxDueCents).toBe(R(5_911.61));
    expect(r.confirmed).toBe(true);
  });
});

describe('IRPFM — alíquota (art. 16-A, § 2º)', () => {
  it('limites de R$ 600 mil, R$ 900 mil e R$ 1,2 milhão', () => {
    expect(irpfmRatePercent(R(600_000))).toBe(0);
    expect(irpfmRatePercent(R(750_000))).toBeCloseTo(2.5, 10);
    expect(irpfmRatePercent(R(900_000))).toBeCloseTo(5, 10);
    expect(irpfmRatePercent(R(1_200_000))).toBe(10);
    expect(irpfmRatePercent(R(5_000_000))).toBe(10);
    // REND/60.000 − 10
    expect(irpfmRatePercent(R(1_000_000))).toBeCloseTo(1_000_000 / 60_000 - 10, 10);
  });
});

describe('IRPFM — cálculo', () => {
  it('exatamente R$ 600 mil não sujeita', () => {
    const r = computeIrpfm({ calendarYear: 2026, incomes: [line('salário', 'taxable', 600_000)], regularTaxDueCents: R(150_000), exclusiveWithheldCents: 0 });
    expect(r.subject).toBe(false);
    expect(r.ratePercent).toBe(0);
    expect(r.dueCents).toBe(0);
    expect(r.inForce).toBe(true);
  });

  it('R$ 900 mil com dividendos: 5% sobre a base menos o IR já pago', () => {
    const r = computeIrpfm({
      calendarYear: 2026,
      incomes: [line('pró-labore', 'taxable', 100_000), line('dividendos', 'exempt', 800_000, { isDividend: true, payerDoc: '11222333000181' })],
      regularTaxDueCents: R(15_000),
      exclusiveWithheldCents: 0,
    });
    expect(r.subject).toBe(true);
    expect(r.baseCents).toBe(R(900_000));
    expect(r.excessCents).toBe(R(300_000));
    expect(r.ratePercent).toBeCloseTo(5, 10);
    expect(r.grossTaxCents).toBe(R(45_000));
    expect(r.dueCents).toBe(R(30_000));
    expect(r.complementaryCents).toBe(R(30_000));
    // (15.000 + 30.000) / 900.000 = 5%
    expect(r.effectiveRatePercent).toBeCloseTo(5, 10);
    // sem a alíquota da PJ não há redutor, e o sistema avisa
    expect(r.reducer.totalCents).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/alíquota efetiva/);
  });

  it('redutor do art. 16-B: PJ a 34% zera o IRPFM; PJ a 32% reduz em 1,75 p.p.', () => {
    const incomes = [line('pró-labore', 'taxable', 100_000), line('dividendos', 'exempt', 800_000, { isDividend: true, payerDoc: '11222333000181' })];
    const full = computeIrpfm({
      calendarYear: 2026,
      incomes,
      regularTaxDueCents: R(15_000),
      exclusiveWithheldCents: 0,
      dividendPayers: [{ payerDoc: '11222333000181', pjEffectiveRatePercent: 34 }],
    });
    // efetiva PF = 30.000 / 800.000 = 3,75%; 34 + 3,75 − 34 = 3,75% × 800.000 = 30.000
    expect(full.reducer.pfEffectiveRatePercent).toBeCloseTo(3.75, 10);
    expect(full.reducer.totalCents).toBe(R(30_000));
    expect(full.dueCents).toBe(0);

    const partial = computeIrpfm({
      calendarYear: 2026,
      incomes,
      regularTaxDueCents: R(15_000),
      exclusiveWithheldCents: 0,
      dividendPayers: [{ payerDoc: '11222333000181', pjEffectiveRatePercent: 32 }],
    });
    // 32 + 3,75 − 34 = 1,75% × 800.000 = 14.000 → 45.000 − 15.000 − 14.000 = 16.000
    expect(partial.reducer.totalCents).toBe(R(14_000));
    expect(partial.dueCents).toBe(R(16_000));

    const bank = computeIrpfm({
      calendarYear: 2026,
      incomes,
      regularTaxDueCents: R(15_000),
      exclusiveWithheldCents: 0,
      dividendPayers: [{ payerDoc: '11222333000181', pjEffectiveRatePercent: 40, nominalKind: 'banks' }],
    });
    // 40 + 3,75 < 45: sem redutor
    expect(bank.reducer.totalCents).toBe(0);
    expect(bank.reducer.payers[0].nominalRatePercent).toBe(45);
  });

  it('R$ 1,2 milhão de salário: 10%, mas o IR da tabela já supera o mínimo', () => {
    const regular = annualIrpfDue({ exercise: 2027, taxableIncomeCents: R(1_200_000) }).taxDueCents;
    // simplificada: (1.200.000 − 17.640) × 27,5% − 10.904,66 = 314.244,34
    expect(regular).toBe(R(314_244.34));
    const r = computeIrpfm({ calendarYear: 2026, incomes: [line('salário', 'taxable', 1_200_000)], regularTaxDueCents: regular, exclusiveWithheldCents: 0 });
    expect(r.ratePercent).toBe(10);
    expect(r.grossTaxCents).toBe(R(120_000));
    expect(r.dueCents).toBe(0);
    expect(r.conclusion).toMatch(/não há IRPFM a pagar/);
  });

  it('exclusões, retenção exclusiva e antecipação sobre dividendos', () => {
    const r = computeIrpfm({
      calendarYear: 2026,
      incomes: [
        line('salário', 'taxable', 100_000),
        line('dividendos', 'exempt', 1_100_000, { isDividend: true }),
        line('LCI', 'exempt', 300_000, { exclusion: 'exempt_investments' }),
        line('CDB', 'exclusive', 50_000),
      ],
      regularTaxDueCents: R(15_000),
      exclusiveWithheldCents: R(7_500),
      dividendWithholdingCents: R(60_000),
    });
    expect(r.totalIncomeCents).toBe(R(1_550_000));
    expect(r.exclusionsCents).toBe(R(300_000));
    expect(r.baseCents).toBe(R(1_250_000));
    expect(r.grossTaxCents).toBe(R(125_000));
    expect(r.deductions.totalCents).toBe(R(22_500));
    expect(r.dueCents).toBe(R(102_500));
    expect(r.complementaryCents).toBe(R(42_500));
    expect(r.exclusions).toEqual([expect.objectContaining({ exclusion: 'exempt_investments', cents: R(300_000) })]);
    expect(r.composition.map((c) => c.group)).toEqual(['taxable', 'exclusive', 'exempt', 'excluded']);
  });

  it('rendimentos acima de R$ 600 mil com base abaixo do limite: alíquota zero', () => {
    const r = computeIrpfm({
      calendarYear: 2026,
      incomes: [line('salário', 'taxable', 400_000), line('LCA', 'exempt', 300_000, { exclusion: 'exempt_investments' })],
      regularTaxDueCents: R(100_000),
      exclusiveWithheldCents: 0,
    });
    expect(r.subject).toBe(true);
    expect(r.baseCents).toBe(R(400_000));
    expect(r.ratePercent).toBe(0);
    expect(r.dueCents).toBe(0);
  });

  it('retenção de dividendos sem sujeição volta como crédito', () => {
    const r = computeIrpfm({
      calendarYear: 2026,
      incomes: [line('dividendos', 'exempt', 400_000, { isDividend: true })],
      regularTaxDueCents: 0,
      exclusiveWithheldCents: 0,
      dividendWithholdingCents: R(10_000),
    });
    expect(r.subject).toBe(false);
    expect(r.complementaryCents).toBe(R(-10_000));
  });

  it('antes de 2026 é simulação', () => {
    const r = computeIrpfm({ calendarYear: 2025, incomes: [line('x', 'taxable', 900_000)], regularTaxDueCents: 0, exclusiveWithheldCents: 0 });
    expect(r.inForce).toBe(false);
    expect(r.warnings[0]).toMatch(/simulação/);
    expect(r.dueCents).toBe(R(45_000));
  });
});

describe('IRPFM — linhas da declaração', () => {
  const items: DeclarationItem[] = [
    { kind: 'income_pj', valueCents: R(100_000), withheldCents: R(20_000), extra: { nature: 'salary' } },
    { kind: 'income_pf', valueCents: R(60_000), withheldCents: R(5_000), extra: { nature: 'rent' } },
    { kind: 'income_exempt', valueCents: R(500_000), withheldCents: R(30_000), counterpartyDoc: '11222333000181', extra: { nature: 'dividends' } },
    { kind: 'income_exempt', valueCents: R(200_000), extra: { nature: 'dividends', legacyDividends: true } },
    { kind: 'income_exempt', valueCents: R(80_000), extra: { nature: 'financial_exempt' } },
    { kind: 'income_exempt', valueCents: R(50_000), extra: { nature: 'retirement_illness' } },
    { kind: 'income_exempt', valueCents: R(40_000), extra: { nature: 'inheritance_donation' } },
    // rescisão/FGTS fica na base; acidente de trabalho e danos saem (inciso IX)
    { kind: 'income_exempt', valueCents: R(10_000), extra: { nature: 'indemnity' } },
    { kind: 'income_exempt', valueCents: R(8_000), extra: { nature: 'indemnity_damages' } },
    { kind: 'income_exclusive', valueCents: R(30_000), withheldCents: R(4_500), extra: { nature: 'financial_taxed' } },
    { kind: 'income_exclusive', valueCents: R(15_000), withheldCents: R(1_000), extra: { nature: 'thirteenth' } },
    { kind: 'income_accumulated', valueCents: R(25_000), withheldCents: R(2_000) },
    { kind: 'capital_gain', valueCents: R(300_000), withheldCents: R(45_000) },
    { kind: 'variable_income', valueCents: R(20_000), withheldCents: R(3_000) },
    { kind: 'rural_income', valueCents: R(50_000) },
    { kind: 'rural_expense', valueCents: R(20_000) },
    { kind: 'tax_paid', valueCents: R(7_000), extra: { law14754: true } },
    { kind: 'asset', valueCents: R(999_999) },
  ];

  it('classifica inclusões e exclusões', () => {
    const r = irpfmFromItems(items);
    const included = r.incomes.filter((l) => !l.exclusion).reduce((a, l) => a + l.cents, 0);
    // 100k + 60k + 500k + 10k (FGTS/rescisão) + 30k + 15k + 20k + (50k − 20k) = 765k
    expect(included).toBe(R(765_000));
    const excl = Object.fromEntries(r.incomes.filter((l) => l.exclusion).map((l) => [l.exclusion, l.cents]));
    expect(excl).toEqual({
      legacy_dividends: R(200_000),
      exempt_investments: R(80_000),
      serious_illness: R(50_000),
      inheritance_donation: R(40_000),
      indemnity: R(8_000),
      rra_exclusive: R(25_000),
      capital_gain: R(300_000),
    });
    expect(r.exclusiveWithheldCents).toBe(R(5_500));
    expect(r.definitiveTaxPaidCents).toBe(R(3_000));
    expect(r.law14754TaxCents).toBe(R(7_000));
    expect(r.dividendWithholdingCents).toBe(R(30_000));
  });

  it('rendimentos totais consideram o resultado rural, não a receita bruta', () => {
    const r = irpfmFromItems([
      { kind: 'rural_income', valueCents: R(1_350_000) },
      { kind: 'rural_expense', valueCents: R(820_000) },
    ]);
    const res = computeIrpfm({ calendarYear: 2026, incomes: r.incomes, regularTaxDueCents: 0, exclusiveWithheldCents: 0 });
    expect(res.totalIncomeCents).toBe(R(530_000));
    expect(res.subject).toBe(false);
  });

  it('resultado rural negativo não reduz a base', () => {
    const r = irpfmFromItems([
      { kind: 'rural_income', valueCents: R(10_000) },
      { kind: 'rural_expense', valueCents: R(30_000) },
    ]);
    expect(r.incomes.reduce((a, l) => a + l.cents, 0)).toBe(0);
  });

  it('IR devido na declaração a partir do saldo e das retenções', () => {
    expect(regularTaxFromDeclaration({ taxDueCents: 0, refundCents: 0, items })).toBeNull();
    // saldo a pagar 10.000 + IRRF 20.000 + carnê-leão 5.000 = 35.000
    expect(regularTaxFromDeclaration({ taxDueCents: R(10_000), refundCents: 0, items })).toBe(R(35_000));
    // restituição 3.000: 25.000 − 3.000 = 22.000
    expect(regularTaxFromDeclaration({ taxDueCents: 0, refundCents: R(3_000), items })).toBe(R(22_000));
  });
});
