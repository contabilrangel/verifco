import { describe, expect, it } from 'vitest';
import { capitalGainTax, holdingRentTax, holdingSaleTax, holdingTaxParams, simulateHolding } from '../src';

const R = (reais: number) => Math.round(reais * 100);

describe('holding — componentes', () => {
  it('ganho de capital progressivo por parcela (Lei 13.259/2016)', () => {
    expect(capitalGainTax(R(1_000_000))).toBe(R(150_000));
    expect(capitalGainTax(R(5_000_000))).toBe(R(750_000));
    // 5M × 15% + 5M × 17,5% + 2M × 20% = 2.025.000
    expect(capitalGainTax(R(12_000_000))).toBe(R(2_025_000));
    // + 30M+: 5M×15% + 5M×17,5% + 20M×20% + 10M×22,5%
    expect(capitalGainTax(R(40_000_000))).toBe(R(750_000 + 875_000 + 4_000_000 + 2_250_000));
    expect(capitalGainTax(-100)).toBe(0);
  });

  it('aluguel na holding (lucro presumido 32%)', () => {
    const tp = holdingTaxParams(2025);
    // 96.000/ano: presumido 30.720; IRPJ 4.608; CSLL 2.764,80; PIS/COFINS 3.504
    const t = holdingRentTax(R(96_000), tp);
    expect(t.presumedProfitCents).toBe(R(30_720));
    expect(t.irpjCents).toBe(R(4_608));
    expect(t.surchargeCents).toBe(0);
    expect(t.csllCents).toBe(R(2_764.8));
    expect(t.pisCofinsCents).toBe(R(3_504));
    expect(t.totalCents).toBe(R(10_876.8));
  });

  it('adicional de 10% acima de R$ 240 mil de lucro presumido no ano', () => {
    const t = holdingRentTax(R(1_200_000), holdingTaxParams(2025));
    // presumido 384.000; adicional 10% × 144.000
    expect(t.surchargeCents).toBe(R(14_400));
    expect(t.totalCents).toBe(R(57_600 + 14_400 + 34_560 + 43_800));
  });

  it('LC 224/2025: presunção 10% maior sobre a receita acima de R$ 5 milhões a partir de 2026', () => {
    const t2025 = holdingRentTax(R(6_000_000), holdingTaxParams(2025));
    const t2026 = holdingRentTax(R(6_000_000), holdingTaxParams(2026));
    expect(t2025.presumedProfitCents).toBe(R(1_920_000));
    // 32% × 5M + 35,2% × 1M
    expect(t2026.presumedProfitCents).toBe(R(1_952_000));
    expect(holdingTaxParams(2026).confirmed).toBe(false);
  });

  it('venda de imóvel do estoque num trimestre', () => {
    // 2M: IRPJ 15% × 160k = 24k; adicional 10% × 100k = 10k; CSLL 9% × 240k = 21,6k; PIS/COFINS 73k
    expect(holdingSaleTax(R(2_000_000), holdingTaxParams(2025))).toBe(R(128_600));
  });
});

describe('holding — simulação completa', () => {
  const property = { id: 'a', description: 'Apartamento', declaredValueCents: R(1_000_000), marketValueCents: R(2_000_000), monthlyRentCents: R(8_000) };

  it('compara PF × holding linha a linha', () => {
    const r = simulateHolding({ calendarYear: 2025, properties: [property], otherTaxableIncomeCents: R(300_000) });
    const row = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(r.totals.annualRentCents).toBe(R(96_000));
    expect(row.itbi.holdingCents).toBe(R(60_000));
    expect(row.registry.holdingCents).toBe(R(20_000));
    expect(row.setup.holdingCents).toBe(R(5_000));
    // demais rendimentos já na faixa de 27,5%: 27,5% × 96.000
    expect(row.annual_tax.pfCents).toBe(R(26_400));
    expect(row.annual_tax.holdingCents).toBe(R(10_876.8));
    expect(row.capital_gain.pfCents).toBe(R(150_000));
    expect(row.capital_gain.holdingCents).toBe(R(128_600));
    expect(row.capital_gain.savingCents).toBe(R(21_400));
    // 10 anos: PF 264.000; holding 85.000 + 10 × (10.876,80 + 6.000)
    expect(row.ten_years.pfCents).toBe(R(264_000));
    expect(row.ten_years.holdingCents).toBe(R(253_768));
    // inventário: PF (4% + 6%) × 2M; holding 4% × 2M (valor de mercado)
    expect(row.inventory.pfCents).toBe(R(200_000));
    expect(row.inventory.holdingCents).toBe(R(80_000));
    expect(r.totalSavingCents).toBe(R(464_000 - 333_768));
    expect(r.observations[0]).toMatch(/Simulação/);
  });

  it('respeita imunidade de ITBI, base declarada do ITCMD e renda baixa na PF', () => {
    const r = simulateHolding({
      calendarYear: 2025,
      properties: [{ ...property, monthlyRentCents: R(3_000) }],
      otherTaxableIncomeCents: 0,
      params: { itbiImmune: true, holdingItcmdBase: 'declared', years: 5, rentGrowthPercent: 10 },
    });
    const row = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(row.itbi.holdingCents).toBe(0);
    expect(row.inventory.holdingCents).toBe(R(40_000));
    // 36.000/ano sozinho: 15% × 36.000 − 4.679,03 = 720,97
    expect(row.annual_tax.pfCents).toBe(R(720.97));
    expect(r.yearly).toHaveLength(5);
    expect(r.yearly[1].annualRentCents).toBe(R(39_600));
  });
});
