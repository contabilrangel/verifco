import { describe, expect, it } from 'vitest';
import { brazilToday, darfStatus, easterSunday, isBusinessDay, lastBusinessDayOfMonth, maxDarfQuotas, nationalHolidays, planDarfQuotas } from '../src';

describe('calendário de dias úteis', () => {
  it('calcula a Páscoa', () => {
    expect(easterSunday(2024)).toBe('2024-03-31');
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2029)).toBe('2029-04-01');
  });

  it('considera fins de semana e feriados nacionais', () => {
    expect(isBusinessDay('2026-06-06')).toBe(false); // sábado
    expect(isBusinessDay('2026-04-03')).toBe(false); // Sexta-feira Santa
    expect(isBusinessDay('2026-04-21')).toBe(false); // Tiradentes
    expect(nationalHolidays(2024).has('2024-11-20')).toBe(true);
    expect(nationalHolidays(2023).has('2023-11-20')).toBe(false);
    expect(isBusinessDay('2026-06-30')).toBe(true);
  });

  it('acha o último dia útil do mês', () => {
    expect(lastBusinessDayOfMonth(2026, 5)).toBe('2026-05-29'); // 30 e 31 caem no fim de semana
    expect(lastBusinessDayOfMonth(2026, 6)).toBe('2026-06-30');
    expect(lastBusinessDayOfMonth(2026, 10)).toBe('2026-10-30'); // 31 é sábado
    // 31/12 não tem expediente bancário: a 8ª quota de 2026 vence em 30/12 (P&R IRPF 2026, pergunta 064)
    expect(lastBusinessDayOfMonth(2026, 12)).toBe('2026-12-30');
    expect(lastBusinessDayOfMonth(2025, 12)).toBe('2025-12-30');
    expect(isBusinessDay('2027-12-31')).toBe(false); // sexta-feira, sem expediente bancário
    expect(lastBusinessDayOfMonth(2027, 12)).toBe('2027-12-30');
    expect(lastBusinessDayOfMonth(2029, 3)).toBe('2029-03-29'); // 30 é Sexta-feira Santa, 31 é sábado
  });
});

describe('quotas do DARF', () => {
  it('divide igualmente e joga os centavos na 1ª quota', () => {
    const plan = planDarfQuotas(100_001, 3, '2026-05-29');
    expect(plan.count).toBe(3);
    expect(plan.warning).toBeNull();
    expect(plan.quotas.map((q) => q.valueCents)).toEqual([33_335, 33_333, 33_333]);
    expect(plan.quotas.reduce((a, q) => a + q.valueCents, 0)).toBe(100_001);
    expect(plan.quotas.map((q) => q.dueDate)).toEqual(['2026-05-29', '2026-06-30', '2026-07-31']);
  });

  it('limita a 8 quotas e respeita o mínimo de R$ 50 por quota', () => {
    expect(planDarfQuotas(1_000_000, 12, '2026-05-29').count).toBe(8);
    const p = planDarfQuotas(20_000, 8, '2026-05-29');
    expect(p.count).toBe(4);
    expect(p.warning).toContain('até 4');
    expect(p.quotas.every((q) => q.valueCents >= 5_000)).toBe(true);
    expect(maxDarfQuotas(14_999)).toBe(2);
  });

  it('imposto abaixo de R$ 100 vai em quota única', () => {
    const p = planDarfQuotas(9_999, 3, '2026-05-29');
    expect(p.count).toBe(1);
    expect(p.quotas[0]).toEqual({ quotaNumber: 1, valueCents: 9_999, dueDate: '2026-05-29' });
    expect(p.warning).toContain('quota única');
  });

  it('vira o ano nos vencimentos', () => {
    const p = planDarfQuotas(800_000, 8, '2026-09-30');
    expect(p.quotas.at(-1)!.dueDate).toBe('2027-04-30');
    expect(p.quotas[3].dueDate).toBe('2026-12-30');
  });

  it('não gera quotas sem imposto', () => {
    expect(planDarfQuotas(0, 3, '2026-05-29').quotas).toEqual([]);
  });

  it('calcula a situação da quota', () => {
    expect(darfStatus({ dueDate: '2026-05-29' }, '2026-06-01')).toBe('overdue');
    expect(darfStatus({ dueDate: '2026-05-29' }, '2026-05-29')).toBe('open');
    expect(darfStatus({ dueDate: '2026-05-29', status: 'paid' }, '2026-06-01')).toBe('paid');
    expect(brazilToday(new Date('2026-06-01T02:00:00Z'))).toBe('2026-05-31');
  });
});
