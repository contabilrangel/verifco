import { describe, expect, it } from 'vitest';
import { cashAnalysis, declarationTotals, type DeclarationItem } from '../src';

const items: DeclarationItem[] = [
  { kind: 'income_pj', valueCents: 12_000_000, withheldCents: 1_500_000, extra: { officialPensionCents: 1_000_000 } },
  { kind: 'income_exempt', valueCents: 2_000_000 },
  { kind: 'income_exclusive', valueCents: 1_000_000, withheldCents: 150_000 },
  { kind: 'asset', prevValueCents: 30_000_000, valueCents: 36_000_000 },
  { kind: 'debt', prevValueCents: 5_000_000, valueCents: 4_000_000 },
  { kind: 'payment', valueCents: 1_000_000, extra: { reimbursedCents: 200_000 } },
];

describe('análise de caixa', () => {
  it('calcula saldo na completa', () => {
    const r = cashAnalysis({ exerciseYear: 2025, taxation: 'complete', items });
    // recursos: 120k -15k -10k + 20k + 8,5k = 123,5k
    expect(r.totalSourcesCents).toBe(12_350_000);
    // aplicações: +60k bens, 10k dívidas, 8k pagamentos
    expect(r.totalUsesCents).toBe(7_800_000);
    expect(r.balanceCents).toBe(4_550_000);
    expect(r.status).toBe('positive');
    expect(r.netWorthVariationCents).toBe(7_000_000);
  });

  it('usa o desconto simplificado como despesa estimada', () => {
    const r = cashAnalysis({ exerciseYear: 2025, taxation: 'simplified', items });
    const living = r.uses.find((l) => l.key === 'living')!;
    // 20% de 120k = 24k, acima do teto de 16.754,34
    expect(living.cents).toBe(1_675_434);
  });

  it('aponta saldo negativo quando os bens crescem sem origem', () => {
    const r = cashAnalysis({
      exerciseYear: 2025,
      items: [
        { kind: 'income_pj', valueCents: 5_000_000 },
        { kind: 'asset', prevValueCents: 0, valueCents: 20_000_000 },
      ],
    });
    expect(r.status).toBe('negative');
    expect(r.balanceCents).toBe(-15_000_000);
  });

  it('avisa quando o exercício não tem parâmetros ou não foram conferidos', () => {
    expect(cashAnalysis({ exerciseYear: 2031, items: [] }).warnings[0]).toMatch(/Não há parâmetros do exercício 2031; foram usados os de 2026/);
    expect(cashAnalysis({ exerciseYear: 2026, items: [] }).warnings[0]).toMatch(/ainda não foram conferidos/);
    expect(cashAnalysis({ exerciseYear: 2025, items: [] }).warnings).toEqual([]);
  });

  it('soma totais da declaração', () => {
    const t = declarationTotals(items);
    expect(t.assetsTotalCents).toBe(36_000_000);
    expect(t.deductionsCents).toBe(800_000);
    expect(t.totalIncomeCents).toBe(15_000_000);
  });
});
