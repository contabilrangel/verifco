import { describe, expect, it } from 'vitest';
import {
  addMonthsIso,
  amountInWords,
  applyDiscount,
  buildInstallmentPlan,
  computeBudgetAmount,
  effectiveInstallmentStatus,
  installmentDueDates,
  integerInWords,
  isPriceTableValidOn,
  multiplyCents,
  percentOf,
  splitInstallments,
  todayIso,
  type PriceTableLike,
} from '../src';

const table = (type: string, config: PriceTableLike['config'], extra: Partial<PriceTableLike> = {}): PriceTableLike => ({
  type,
  active: true,
  validFrom: '2026-01-01',
  validUntil: null,
  config,
  ...extra,
});

describe('computeBudgetAmount', () => {
  const totals = { refundCents: 250_000, taxDueCents: 1_234_567, assetsTotalCents: 80_000_000, totalIncomeCents: 15_000_000 };

  it('tabela fixa devolve o valor configurado', () => {
    const r = computeBudgetAmount(table('fixed', { amountCents: 30_000 }), {}, totals, '2026-03-10');
    expect(r).toMatchObject({ ok: true, amountCents: 30_000, adjustment: null });
  });

  it('por hora aplica o mínimo de horas e arredonda em centavos', () => {
    const t = table('hourly', { hourRateCents: 12_345, minHours: 2 });
    expect(computeBudgetAmount(t, { hours: 1 }, totals, '2026-03-10')).toMatchObject({ ok: true, amountCents: 24_690, adjustment: 'min' });
    // 1,5 h × R$ 123,45 = R$ 185,175 → R$ 185,18
    const t2 = table('hourly', { hourRateCents: 12_345 });
    expect(computeBudgetAmount(t2, { hours: 1.5 }, totals, '2026-03-10')).toMatchObject({ ok: true, amountCents: 18_518, adjustment: null });
    expect(computeBudgetAmount(t2, {}, totals, '2026-03-10')).toMatchObject({ ok: false });
  });

  it('por itens soma preço × quantidade só dos itens informados', () => {
    const t = table('items', {
      items: [
        { code: 'DEP', label: 'Dependente', unitPriceCents: 5_000 },
        { code: 'IMOVEL', label: 'Imóvel', unitPriceCents: 3_333 },
        { code: 'GCAP', label: 'Ganho de capital', unitPriceCents: 20_000 },
      ],
    });
    const r = computeBudgetAmount(t, { items: { DEP: 2, IMOVEL: 3, GCAP: 0 } }, totals, '2026-03-10');
    expect(r.ok && r.amountCents).toBe(10_000 + 9_999);
    expect(r.ok && r.lines.map((l) => l.label)).toEqual(['Dependente', 'Imóvel']);
    expect(computeBudgetAmount(t, { items: {} }, totals, '2026-03-10').ok).toBe(false);
    expect(computeBudgetAmount(t, { items: { DEP: -1 } }, totals, '2026-03-10').ok).toBe(false);
  });

  it('percentual usa a base da declaração e respeita mínimo e máximo', () => {
    // 1,5% de R$ 12.345,67 = R$ 185,18505 → R$ 185,19
    const t = table('percentage', { percent: 1.5, base: 'tax_due' });
    expect(computeBudgetAmount(t, {}, totals, '2026-03-10')).toMatchObject({ ok: true, amountCents: 18_519, baseCents: 1_234_567, adjustment: null });

    const withMin = table('percentage', { percent: 10, base: 'refund', minCents: 40_000, maxCents: 100_000 });
    expect(computeBudgetAmount(withMin, {}, totals, '2026-03-10')).toMatchObject({ ok: true, amountCents: 40_000, adjustment: 'min' });

    const withMax = table('percentage', { percent: 1, base: 'assets_total', minCents: 10_000, maxCents: 500_000 });
    const r = computeBudgetAmount(withMax, {}, totals, '2026-03-10');
    expect(r).toMatchObject({ ok: true, amountCents: 500_000, adjustment: 'max' });
    expect(r.ok && r.lines.at(-1)?.totalCents).toBe(500_000 - 800_000);

    // sem dados na declaração, vale o mínimo
    expect(computeBudgetAmount(withMin, {}, null, '2026-03-10')).toMatchObject({ ok: true, amountCents: 40_000 });
  });

  it('meio centavo arredonda para cima', () => {
    // 5% de 1.010 centavos = 50,5 → 51
    const t = table('percentage', { percent: 5, base: 'total_income' });
    expect(computeBudgetAmount(t, {}, { totalIncomeCents: 1_010 }, '2026-03-10')).toMatchObject({ ok: true, amountCents: 51 });
    expect(percentOf(1_005, 1.5)).toBe(15); // 15,075 → 15
    expect(multiplyCents(999, 0.5, 2)).toBe(500); // 499,5 → 500
  });

  it('só aceita tabela ativa e vigente na data', () => {
    const t = table('fixed', { amountCents: 100 }, { validFrom: '2026-02-01', validUntil: '2026-04-30' });
    expect(computeBudgetAmount(t, {}, null, '2026-01-31')).toMatchObject({ ok: false });
    expect(computeBudgetAmount(t, {}, null, '2026-02-01')).toMatchObject({ ok: true });
    expect(computeBudgetAmount(t, {}, null, '2026-04-30')).toMatchObject({ ok: true });
    const expired = computeBudgetAmount(t, {}, null, '2026-05-01');
    expect(expired.ok).toBe(false);
    expect(!expired.ok && expired.error).toContain('30/04/2026');
    expect(computeBudgetAmount({ ...t, active: false }, {}, null, '2026-03-01')).toMatchObject({ ok: false });
    expect(isPriceTableValidOn({ active: true, validFrom: '2026-01-01', validUntil: null }, '2030-12-31')).toBe(true);
  });

  it('recusa configuração incompleta', () => {
    expect(computeBudgetAmount(table('fixed', {}), {}, null, '2026-03-10').ok).toBe(false);
    expect(computeBudgetAmount(table('percentage', { percent: 5 }), {}, null, '2026-03-10').ok).toBe(false);
    expect(computeBudgetAmount(table('items', { items: [] }), {}, null, '2026-03-10').ok).toBe(false);
    expect(computeBudgetAmount(table('outro', {}), {}, null, '2026-03-10').ok).toBe(false);
  });
});

describe('desconto e parcelas', () => {
  it('aplica desconto percentual em centavos', () => {
    expect(applyDiscount(30_000, 10)).toBe(27_000);
    expect(applyDiscount(33_333, 12.5)).toBe(29_166); // desconto de 4.166,625 → 4.167
    expect(applyDiscount(10_000, 0)).toBe(10_000);
    expect(applyDiscount(10_000, 150)).toBe(0);
  });

  it('divide o total sem perder centavos', () => {
    expect(splitInstallments(10_000, 3)).toEqual([3_334, 3_333, 3_333]);
    expect(splitInstallments(10_001, 2)).toEqual([5_001, 5_000]);
    expect(splitInstallments(500, 1)).toEqual([500]);
    const parts = splitInstallments(99_999, 7);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(99_999);
  });

  it('vencimentos mensais respeitam o fim do mês', () => {
    expect(installmentDueDates('2026-01-31', 4)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(addMonthsIso('2027-12-15', 2)).toBe('2028-02-15');
    expect(addMonthsIso('2028-01-30', 1)).toBe('2028-02-29');
    expect(buildInstallmentPlan(1_000, 3, '2026-05-10')).toEqual([
      { number: 1, dueDate: '2026-05-10', amountCents: 334 },
      { number: 2, dueDate: '2026-06-10', amountCents: 333 },
      { number: 3, dueDate: '2026-07-10', amountCents: 333 },
    ]);
  });

  it('parcela em aberto com vencimento passado é vencida', () => {
    expect(effectiveInstallmentStatus('open', '2026-03-01', '2026-03-02')).toBe('overdue');
    expect(effectiveInstallmentStatus('open', '2026-03-02', '2026-03-02')).toBe('open');
    expect(effectiveInstallmentStatus('paid', '2026-01-01', '2026-03-02')).toBe('paid');
  });

  it('data de hoje no fuso de Brasília', () => {
    expect(todayIso(new Date('2026-03-02T02:00:00Z'))).toBe('2026-03-01');
    expect(todayIso(new Date('2026-03-02T12:00:00Z'))).toBe('2026-03-02');
  });
});

describe('valor por extenso', () => {
  it('escreve inteiros', () => {
    expect(integerInWords(0)).toBe('zero');
    expect(integerInWords(100)).toBe('cem');
    expect(integerInWords(101)).toBe('cento e um');
    expect(integerInWords(1_000)).toBe('mil');
    expect(integerInWords(1_100)).toBe('mil e cem');
    expect(integerInWords(1_020)).toBe('mil e vinte');
    expect(integerInWords(1_234)).toBe('mil duzentos e trinta e quatro');
    expect(integerInWords(21_000)).toBe('vinte e um mil');
    expect(integerInWords(1_200_000)).toBe('um milhão e duzentos mil');
    expect(integerInWords(2_000_015)).toBe('dois milhões e quinze');
  });

  it('escreve valores em reais', () => {
    expect(amountInWords(123_456)).toBe('mil duzentos e trinta e quatro reais e cinquenta e seis centavos');
    expect(amountInWords(100)).toBe('um real');
    expect(amountInWords(1)).toBe('um centavo');
    expect(amountInWords(30_000)).toBe('trezentos reais');
    expect(amountInWords(100_000_000)).toBe('um milhão de reais');
    expect(amountInWords(0)).toBe('zero real');
  });
});
