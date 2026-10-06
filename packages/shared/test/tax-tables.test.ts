import { describe, expect, it } from 'vitest';
import {
  ANNUAL_IRPF_TABLES,
  DARF_BELOW_MINIMUM_MESSAGE,
  annualIrpfTable,
  cashAnalysis,
  compareTaxation,
  computeIrpfm,
  darfQuotaAmount,
  darfValueText,
  declarationTotals,
  fineMeshCheck,
  irpfmFromItems,
  legalDeductions,
  parseBrDate,
  parseBrMoney,
  planDarfQuotas,
  ruralResult,
  simulateHolding,
  type DeclarationItem,
  type IrpfmIncomeLine,
} from '../src';

const R = (reais: number) => Math.round(reais * 100);

/**
 * Valores oficiais da Receita Federal (tabelas de incidência anual):
 * - exercícios 2017 a 2023: https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas/2016
 * - exercício 2024: …/tabelas/2023 · exercício 2025: …/tabelas/copy_of_2024
 * - exercício 2026: …/tabelas/2025 · exercício 2027: …/tabelas/2026 (consulta em 06/10/2026)
 */
const OFFICIAL: Record<number, { limits: number[]; deductions: number[]; simplified: number }> = {
  2023: { limits: [2_284_776, 3_391_980, 4_501_260, 5_597_616], deductions: [171_358, 425_757, 763_351, 1_043_232], simplified: 1_675_434 },
  2024: { limits: [2_451_192, 3_391_980, 4_501_260, 5_597_616], deductions: [183_839, 438_238, 775_832, 1_055_713], simplified: 1_675_434 },
  2025: { limits: [2_696_320, 3_391_980, 4_501_260, 5_597_616], deductions: [202_224, 456_623, 794_217, 1_074_098], simplified: 1_675_434 },
  2026: { limits: [2_846_720, 3_391_980, 4_501_260, 5_597_616], deductions: [213_504, 467_903, 805_497, 1_085_378], simplified: 1_675_434 },
  2027: { limits: [2_914_560, 3_391_980, 4_501_260, 5_597_616], deductions: [218_592, 472_991, 810_585, 1_090_466], simplified: 1_764_000 },
};

describe('tabela única do IR (irpf-annual)', () => {
  it('confere limites, parcelas e desconto simplificado com as tabelas oficiais', () => {
    for (const [ex, o] of Object.entries(OFFICIAL)) {
      const t = annualIrpfTable(Number(ex));
      expect(t.fallback).toBe(false);
      expect(t.confirmed).toBe(true);
      expect(t.brackets.slice(0, 4).map((b) => b.upToCents)).toEqual(o.limits);
      expect(t.brackets.slice(1).map((b) => b.deductionCents)).toEqual(o.deductions);
      expect(t.brackets.map((b) => b.ratePercent)).toEqual([0, 7.5, 15, 22.5, 27.5]);
      expect(t.simplifiedDiscountCapCents).toBe(o.simplified);
      expect(t.dependentDeductionCents).toBe(227_508);
      expect(t.educationCapCents).toBe(356_150);
      expect(t.annualReduction).toBe(Number(ex) >= 2027);
    }
    // exercícios 2017 a 2022 usam a mesma tabela de 2023, sem fallback
    expect(ANNUAL_IRPF_TABLES[2017].brackets).toEqual(ANNUAL_IRPF_TABLES[2023].brackets);
    expect(annualIrpfTable(2016).fallback).toBe(true);
    expect(annualIrpfTable(2030)).toMatchObject({ fallback: true, exercise: 2027, annualReduction: true });
  });
});

describe('comparativo completa × simplificada pela tabela única', () => {
  const pj = (reais: number): DeclarationItem => ({ kind: 'income_pj', valueCents: R(reais), counterpartyDoc: '11222333000181' });

  it('exercício 2027: R$ 60 mil zera o imposto (art. 11-A) e não avisa fallback', () => {
    const r = compareTaxation({ exerciseYear: 2027, items: [pj(60_000)] });
    expect(r.warnings).toEqual([]);
    expect(r.annualReduction).toBe(true);
    expect(r.simplified).toMatchObject({ deductionsCents: R(12_000), baseCents: R(48_000), grossTaxCents: R(2_694.15), reductionCents: R(2_694.15), taxCents: 0 });
    expect(r.best).toBe('simplified');
    expect(r.suggestions.some((s) => /Lei 15\.270/.test(s))).toBe(true);
  });

  it('exercício 2027: R$ 80 mil tem redução parcial e R$ 200 mil usa o desconto de R$ 17.640', () => {
    // base 64.000 → 27,5% − 10.904,66 = 6.695,34; redução 8.429,73 − 0,095575 × 80.000 = 783,73
    expect(compareTaxation({ exerciseYear: 2027, items: [pj(80_000)] }).simplified.taxCents).toBe(R(5_911.61));
    const big = compareTaxation({ exerciseYear: 2027, items: [pj(200_000)] });
    expect(big.simplified.deductionsCents).toBe(R(17_640));
    // (200.000 − 17.640) × 27,5% − 10.904,66 = 39.244,34, sem redução
    expect(big.simplified.taxCents).toBe(R(39_244.34));
    expect(big.simplified.reductionCents).toBe(0);
  });

  it('exercício 2026: tabela conferida, sem aviso de "não conferida"', () => {
    const r = compareTaxation({ exerciseYear: 2026, items: [pj(60_000)] });
    expect(r.warnings).toEqual([]);
    expect(r.simplified.taxCents).toBe(R(2_745.03));
  });

  it('deduções legais: aluguel e "outros" não deduzem; INSS, dependente e instrução limitada sim', () => {
    const items: DeclarationItem[] = [
      { kind: 'income_pj', valueCents: R(300_000), extra: { officialPensionCents: R(10_000) } },
      { kind: 'payment', valueCents: R(120_000), extra: { nature: 'other' } },
      { kind: 'payment', valueCents: R(20_000), extra: { nature: 'education' } },
      { kind: 'dependent', counterpartyDoc: '39053344705' },
    ];
    const d = legalDeductions(items, 2027, R(300_000));
    // 10.000 + 2.275,08 + 3.561,50
    expect(d.totalCents).toBe(R(15_836.58));
  });
});

describe('atividade rural', () => {
  it('resultado tributável: informado, resultado menos a parcela isenta ou receita − despesa', () => {
    const items: DeclarationItem[] = [
      { kind: 'rural_income', valueCents: R(2_000_000) },
      { kind: 'rural_expense', valueCents: R(1_000_000) },
    ];
    expect(ruralResult(items)).toMatchObject({ grossResultCents: R(1_000_000), option20Cents: R(400_000), taxableCents: R(1_000_000), source: 'gross' });
    const withExempt = [...items, { kind: 'income_exempt' as const, valueCents: R(600_000), extra: { nature: 'rural' } }];
    expect(ruralResult(withExempt)).toMatchObject({ exemptPortionCents: R(600_000), taxableCents: R(400_000), source: 'exempt_portion' });
    expect(ruralResult(items, R(350_000))).toMatchObject({ taxableCents: R(350_000), source: 'informed' });
  });
});

describe('IRPFM — atividade rural, indenizações, doações e dividendos até 2025', () => {
  const rural: DeclarationItem[] = [
    { kind: 'income_pj', valueCents: R(100_000) },
    { kind: 'rural_income', valueCents: R(2_000_000) },
    { kind: 'rural_expense', valueCents: R(1_000_000) },
  ];

  it('parcela isenta rural sai da base (VIII) e não é contada duas vezes', () => {
    const items = [...rural, { kind: 'income_exempt' as const, valueCents: R(600_000), extra: { nature: 'rural' } }];
    const p = irpfmFromItems(items);
    const r = computeIrpfm({ calendarYear: 2026, incomes: p.incomes, regularTaxDueCents: R(100_000), exclusiveWithheldCents: 0 });
    expect(r.exclusions).toEqual([expect.objectContaining({ exclusion: 'rural_exempt', cents: R(600_000) })]);
    // base: 100k + resultado tributável 400k (antes: 1,7 milhão e alíquota de 10%)
    expect(r.baseCents).toBe(R(500_000));
    expect(r.totalIncomeCents).toBe(R(1_100_000));
    expect(r.ratePercent).toBe(0);
    expect(r.dueCents).toBe(0);
  });

  it('com o resultado tributável informado (opção de 20%), produtor não tem IRPFM', () => {
    const p = irpfmFromItems(rural, { ruralTaxableResultCents: R(400_000) });
    const r = computeIrpfm({ calendarYear: 2026, incomes: p.incomes, regularTaxDueCents: R(100_000), exclusiveWithheldCents: 0, notes: p.warnings });
    expect(r.baseCents).toBe(R(500_000));
    expect(r.exclusionsCents).toBe(R(600_000));
    expect(r.dueCents).toBe(0);
    expect(r.warnings.join(' ')).not.toMatch(/entrou inteiro na base/);
  });

  it('sem a parcela isenta nem o valor informado, avisa que o resultado entrou inteiro', () => {
    const p = irpfmFromItems(rural);
    expect(p.warnings.join(' ')).toMatch(/entrou inteiro na base.*20% da receita bruta/);
    const r = computeIrpfm({ calendarYear: 2026, incomes: p.incomes, regularTaxDueCents: 0, exclusiveWithheldCents: 0, notes: p.warnings });
    expect(r.warnings.join(' ')).toMatch(/20% da receita bruta/);
  });

  it('rescisão/FGTS e doações comuns ficam na base; acidente, danos e adiantamento da legítima saem', () => {
    const p = irpfmFromItems([
      { kind: 'income_exempt', valueCents: R(300_000), extra: { nature: 'indemnity' } },
      { kind: 'income_exempt', valueCents: R(50_000), extra: { nature: 'indemnity_damages' } },
      { kind: 'income_exempt', valueCents: R(40_000), extra: { nature: 'donation' } },
      { kind: 'income_exempt', valueCents: R(70_000), extra: { nature: 'inheritance_donation' } },
    ]);
    const excl = Object.fromEntries(p.incomes.filter((l) => l.exclusion).map((l) => [l.exclusion, l.cents]));
    expect(excl).toEqual({ indemnity: R(50_000), inheritance_donation: R(70_000) });
    expect(p.incomes.filter((l) => !l.exclusion).reduce((a, l) => a + l.cents, 0)).toBe(R(340_000));
    expect(p.warnings.join(' ')).toMatch(/rescisão, PDV, aviso prévio ou FGTS entraram na base/);
  });

  it('dividendos de lucros até 2025 só saem da base se pagos de 2026 a 2028 (XII, c)', () => {
    const incomes: IrpfmIncomeLine[] = [
      { key: 'sal', label: 'salário', group: 'taxable', cents: R(100_000) },
      { key: 'div', label: 'dividendos', group: 'exempt', cents: R(700_000), isDividend: true, exclusion: 'legacy_dividends' },
    ];
    const in2028 = computeIrpfm({ calendarYear: 2028, incomes, regularTaxDueCents: 0, exclusiveWithheldCents: 0 });
    expect(in2028.baseCents).toBe(R(100_000));
    const in2029 = computeIrpfm({ calendarYear: 2029, incomes, regularTaxDueCents: 0, exclusiveWithheldCents: 0 });
    expect(in2029.baseCents).toBe(R(800_000));
    expect(in2029.exclusionsCents).toBe(0);
    expect(in2029.warnings.join(' ')).toMatch(/2026 a 2028/);
  });
});

describe('holding: IR do aluguel na PF com a redução do art. 11-A', () => {
  const property = (monthlyRentCents: number) => ({ id: 'a', description: 'Sala', declaredValueCents: R(300_000), marketValueCents: R(300_000), monthlyRentCents });

  it('AC 2026: renda baixa tem o imposto reduzido', () => {
    // 54.000: 22,5% − 8.105,85 = 4.044,15 − 2.694,15 = 1.350,00; 30.000: 64,08 − 64,08 = 0
    const r = simulateHolding({ calendarYear: 2026, properties: [property(R(2_000))], otherTaxableIncomeCents: R(30_000) });
    expect(r.pfRentTaxCents).toBe(R(1_350));
    // a redução dos demais rendimentos some com o aluguel: 10.311,61 − 450,00
    const r2 = simulateHolding({ calendarYear: 2026, properties: [property(R(2_500))], otherTaxableIncomeCents: R(50_000) });
    expect(r2.pfRentTaxCents).toBe(R(9_861.61));
  });

  it('projeção usa a tabela de cada exercício', () => {
    const r = simulateHolding({ calendarYear: 2025, properties: [property(R(2_000))], otherTaxableIncomeCents: R(30_000), params: { years: 2 } });
    // ano 1 (exercício 2026, sem redução): 4.095,03 − 114,96; ano 2 (exercício 2027): 1.350,00
    expect(r.yearly.map((y) => y.pfTaxCents)).toEqual([R(3_980.07), R(1_350)]);
  });
});

describe('análise de caixa e malha fina', () => {
  it('prejuízo rural é saída de caixa e pode tornar o saldo negativo', () => {
    const r = cashAnalysis({
      exerciseYear: 2026,
      taxation: 'complete',
      items: [
        { kind: 'income_pj', valueCents: R(100_000), withheldCents: R(15_000) },
        { kind: 'rural_income', valueCents: R(50_000) },
        { kind: 'rural_expense', valueCents: R(150_000) },
      ],
    });
    expect(r.uses.find((l) => l.key === 'rural_loss')!.cents).toBe(R(100_000));
    expect(r.balanceCents).toBe(R(-15_000));
    expect(r.status).toBe('negative');
  });

  it('parcela isenta rural não é contada duas vezes e o DARF da renda variável sai do caixa', () => {
    const items: DeclarationItem[] = [
      { kind: 'rural_income', valueCents: R(2_000_000) },
      { kind: 'rural_expense', valueCents: R(1_000_000) },
      { kind: 'income_exempt', valueCents: R(600_000), extra: { nature: 'rural' } },
      { kind: 'variable_income', valueCents: R(10_000), extra: { taxPaidCents: R(1_500) } },
    ];
    const r = cashAnalysis({ exerciseYear: 2026, taxation: 'complete', items });
    expect(r.sources.find((l) => l.key === 'taxable_net')!.cents).toBe(R(400_000));
    expect(r.sources.find((l) => l.key === 'exempt')!.cents).toBe(R(600_000));
    expect(r.sources.find((l) => l.key === 'gains')!.cents).toBe(R(8_500));
    expect(r.uses.some((l) => l.key === 'rural_loss')).toBe(false);
    // totais gravados: resultado rural, não a receita bruta
    expect(declarationTotals(items).totalIncomeCents).toBe(R(1_010_000));
  });

  it('investimento rural marcado não é contado de novo no aumento de bens', () => {
    const r = cashAnalysis({
      exerciseYear: 2026,
      taxation: 'complete',
      items: [
        { kind: 'rural_income', valueCents: R(300_000) },
        { kind: 'rural_expense', valueCents: R(100_000), extra: { investment: true } },
        { kind: 'rural_asset', prevValueCents: 0, valueCents: R(100_000) },
      ],
    });
    expect(r.uses.find((l) => l.key === 'assets_increase')!.cents).toBe(0);
    expect(r.balanceCents).toBe(R(200_000));
  });

  it('malha fina compara a variação patrimonial com o resultado rural, não com a receita bruta', () => {
    const points = fineMeshCheck({
      exerciseYear: 2026,
      taxation: 'complete',
      items: [
        { kind: 'rural_income', valueCents: R(2_000_000) },
        { kind: 'rural_expense', valueCents: R(1_900_000) },
        { kind: 'asset', groupCode: '01', prevValueCents: 0, valueCents: R(500_000) },
      ],
    });
    // resultado de R$ 100 mil × patrimônio +R$ 500 mil (antes a receita de R$ 2 milhões escondia o alerta)
    expect(points.find((p) => p.key === 'patrimony_incompatible')?.detail).toMatch(/renda líquida declarada \(R\$\s100\.000,00\)/);
  });

  it('carnê-leão: gravidade alta só quando algum mês certamente teve imposto', () => {
    const point = (exerciseYear: number, reais: number) =>
      fineMeshCheck({ exerciseYear, taxation: 'complete', items: [{ kind: 'income_pf', valueCents: R(reais) }] }).find((p) => p.key === 'pf_income_without_carne_leao')!;
    // exercício 2027: redução mensal zera o imposto até R$ 5.000/mês → limiar de R$ 60.000
    expect(point(2027, 40_000).severity).toBe('medium');
    expect(point(2027, 60_001).severity).toBe('high');
    // exercício 2026: 12 × (2.428,80 + 607,20) = 36.432,00
    expect(point(2026, 36_000).severity).toBe('medium');
    expect(point(2026, 36_433).severity).toBe('high');
  });
});

describe('DARF: valor mínimo e juros das quotas', () => {
  it('saldo abaixo de R$ 10,00 não gera DARF', () => {
    expect(planDarfQuotas(999, 1, '2026-05-29')).toEqual({ quotas: [], count: 0, warning: DARF_BELOW_MINIMUM_MESSAGE });
    expect(planDarfQuotas(1_000, 1, '2026-05-29').quotas).toEqual([{ quotaNumber: 1, valueCents: 1_000, dueDate: '2026-05-29' }]);
  });

  it('2ª quota +1%; da 3ª em diante Selic acumulada desde junho + 1% (P&R 064)', () => {
    expect(darfQuotaAmount({ quotaNumber: 1, principalCents: 100_000, dueDate: '2026-05-29' })).toMatchObject({ interestPercent: 0, totalCents: 100_000, note: null });
    expect(darfQuotaAmount({ quotaNumber: 2, principalCents: 100_000, dueDate: '2026-06-30' })).toMatchObject({ selicMonths: [], interestPercent: 1, totalCents: 101_000 });
    // Selic de junho/2026 = 1,12%
    expect(darfQuotaAmount({ quotaNumber: 3, principalCents: 100_000, dueDate: '2026-07-31' })).toMatchObject({ selicMonths: ['2026-06'], interestPercent: 2.12, totalCents: 102_120 });
    // junho a agosto: 1,12 + 1,22 + 1,09 + 1 = 4,43%
    expect(darfQuotaAmount({ quotaNumber: 5, principalCents: 100_000, dueDate: '2026-09-30' })).toMatchObject({ interestPercent: 4.43, totalCents: 104_430 });
  });

  it('sem a Selic de algum mês, mostra o principal com o aviso dos juros', () => {
    const a = darfQuotaAmount({ quotaNumber: 7, principalCents: 100_000, dueDate: '2026-11-30' });
    expect(a).toMatchObject({ missingSelicMonths: ['2026-10'], interestPercent: null, totalCents: null });
    expect(a.note).toBe('Valor principal. A guia soma juros: Selic acumulada de jun/2026, jul/2026, ago/2026, set/2026 e out/2026 + 1%; a taxa de out/2026 ainda não foi publicada. Vale o valor da guia.');
    expect(darfQuotaAmount({ quotaNumber: 8, principalCents: 100_000, dueDate: '2026-12-30' }).note).toMatch(/as taxas de out\/2026 e nov\/2026 ainda não foram publicadas/);
    const withSelic = darfQuotaAmount({ quotaNumber: 7, principalCents: 100_000, dueDate: '2026-11-30', selic: { '2026-06': 1.12, '2026-07': 1.22, '2026-08': 1.09, '2026-09': 1.08, '2026-10': 0.9 } });
    expect(withSelic).toMatchObject({ interestPercent: 6.41, totalCents: 106_410 });
  });

  it('texto do valor para o cliente deixa claros os juros', () => {
    expect(darfValueText({ source: 'generated', quotaNumber: 2, valueCents: 100_000, dueDate: '2026-06-30' })).toMatch(/^R\$\s1\.010,00 \(principal de R\$\s1\.000,00 \+ juros de 1,00%: Selic acumulada \+ 1%\)$/);
    expect(darfValueText({ source: 'generated', quotaNumber: 7, valueCents: 100_000, dueDate: '2026-11-30' })).toMatch(/^R\$\s1\.000,00 mais juros \(Selic acumulada \+ 1%; o valor total está na guia\)$/);
    // 1ª quota, quota editada, manual ou do eCAC: o valor já é o da guia
    expect(darfValueText({ source: 'generated', quotaNumber: 1, valueCents: 100_000, dueDate: '2026-05-29' })).toMatch(/^R\$\s1\.000,00$/);
    expect(darfValueText({ source: 'edited', quotaNumber: 3, valueCents: 102_120, dueDate: '2026-07-31' })).toMatch(/^R\$\s1\.021,20$/);
  });
});

describe('leitura de valores em reais (parser único)', () => {
  it('casos pedidos: milhar brasileiro, vírgula decimal e ponto decimal', () => {
    expect(parseBrMoney('R$ 1.500')).toBe(150_000);
    expect(parseBrMoney('1.500')).toBe(150_000);
    expect(parseBrMoney('1.500,50')).toBe(150_050);
    expect(parseBrMoney('1500.5')).toBe(150_050);
    expect(parseBrMoney('1,5')).toBe(150);
  });

  it('bordas', () => {
    expect(parseBrMoney('1500')).toBe(150_000);
    expect(parseBrMoney('1500,00')).toBe(150_000);
    expect(parseBrMoney('12.345.678')).toBe(1_234_567_800);
    expect(parseBrMoney('1.234.567,89')).toBe(123_456_789);
    expect(parseBrMoney('R$ 1.234,56')).toBe(123_456);
    expect(parseBrMoney(' R$ 0,99 ')).toBe(99);
    expect(parseBrMoney('1.50')).toBe(150);
    expect(parseBrMoney('0.5')).toBe(50);
    expect(parseBrMoney('-1.500,00')).toBe(-150_000);
    expect(parseBrMoney('1,500.50')).toBe(150_050); // formato americano completo
    expect(parseBrMoney('1,234,567')).toBe(123_456_700);
    // ambíguos ou malformados
    expect(parseBrMoney('1,500')).toBeNull();
    expect(parseBrMoney('1.500.5')).toBeNull();
    expect(parseBrMoney('1.500,00,0')).toBeNull();
    expect(parseBrMoney('1,500,50')).toBeNull();
    expect(parseBrMoney('12,34.56')).toBeNull();
    expect(parseBrMoney('R$')).toBeNull();
    expect(parseBrMoney('')).toBeNull();
    expect(parseBrMoney('abc')).toBeNull();
    expect(parseBrMoney('1e3')).toBeNull();
  });

  it('datas que não existem são recusadas', () => {
    expect(parseBrDate('31/02/2026')).toBeNull();
    expect(parseBrDate('29/02/2028')).toBe('2028-02-29');
    expect(parseBrDate('10/11/2026')).toBe('2026-11-10');
    expect(parseBrDate('2026-02-31')).toBeNull();
  });
});
