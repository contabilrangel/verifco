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

  it('avisa quando o exercício não tem tabela própria (só pesa na simplificada)', () => {
    expect(cashAnalysis({ exerciseYear: 2031, taxation: 'simplified', items: [] }).warnings[0]).toMatch(/O exercício 2031 não tem tabela do IR própria; foram usados os valores do exercício 2027/);
    expect(cashAnalysis({ exerciseYear: 2031, taxation: 'complete', items: [] }).warnings).toEqual([]);
    // tabelas oficiais conferidas: sem aviso de "não conferida"
    for (const ex of [2024, 2025, 2026, 2027]) expect(cashAnalysis({ exerciseYear: ex, taxation: 'simplified', items: [] }).warnings).toEqual([]);
  });

  it('soma totais da declaração', () => {
    const t = declarationTotals(items);
    expect(t.assetsTotalCents).toBe(36_000_000);
    expect(t.deductionsCents).toBe(800_000);
    expect(t.totalIncomeCents).toBe(15_000_000);
  });

  it('conta só os juros dos financiamentos, sem duplicar o principal', () => {
    const base = { exerciseYear: 2025, items: [{ kind: 'income_pj' as const, valueCents: 10_000_000 }] };
    const other = (o: Record<string, number>) => cashAnalysis({ ...base, otherExpenses: o }).uses.find((l) => l.key === 'other')!.cents;
    expect(other({ annualPaymentCents: 1_200_000, principalCents: 900_000, interestCents: 300_000 })).toBe(300_000);
    expect(other({ annualPaymentCents: 1_200_000, principalCents: 900_000 })).toBe(300_000);
    expect(other({ annualPaymentCents: 1_200_000, interestCents: 300_000, creditCardCents: 50_000 })).toBe(350_000);
    expect(cashAnalysis({ ...base, otherExpenses: { annualPaymentCents: 1_200_000 } }).uses.find((l) => l.key === 'tax_paid')!.cents).toBe(0);
  });
});
