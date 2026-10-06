import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  brazilToday,
  copilotLimit,
  currentExerciseYear,
  currentMonthInBrazil,
  currentYearInBrazil,
  formatDate,
  formatDateTimeBr,
  isoDateInBrazil,
  todayIso,
} from '../src';

describe('datas no fuso de Brasília (fonte única de "hoje")', () => {
  // 22h30 de 05/10 em Brasília = 01h30 de 06/10 em UTC: o dia em UTC já virou
  const lateNight = new Date('2026-10-06T01:30:00Z');

  it('hoje é o dia de Brasília, não o de UTC', () => {
    expect(lateNight.toISOString().slice(0, 10)).toBe('2026-10-06');
    expect(todayIso(lateNight)).toBe('2026-10-05');
    expect(brazilToday(lateNight)).toBe('2026-10-05');
    expect(isoDateInBrazil('2026-10-06T01:30:00Z')).toBe('2026-10-05');
    expect(todayIso(new Date('2026-10-06T12:00:00Z'))).toBe('2026-10-06');
  });

  it('brazilToday e todayIso são a mesma função de data', () => {
    for (const iso of ['2026-01-01T02:59:00Z', '2026-01-01T03:00:00Z', '2026-12-31T23:59:00Z']) {
      expect(brazilToday(new Date(iso))).toBe(todayIso(new Date(iso)));
    }
  });

  it('ano e mês correntes também seguem Brasília (virada do ano)', () => {
    const newYearUtc = new Date('2027-01-01T01:00:00Z'); // 22h de 31/12/2026 em Brasília
    expect(currentYearInBrazil(newYearUtc)).toBe(2026);
    expect(currentMonthInBrazil(newYearUtc)).toBe(12);
    expect(currentExerciseYear(newYearUtc)).toBe(2026);
  });

  it('soma dias sem depender de fuso nem de horário de verão', () => {
    expect(addDaysIso('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysIso('2026-10-05', 30)).toBe('2026-11-04');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('formata data sem hora sem passar por fuso e data com hora no horário de Brasília', () => {
    expect(formatDate('2026-10-05')).toBe('05/10/2026');
    expect(formatDate(lateNight)).toBe('05/10/2026');
    expect(formatDate('2026-10-06T01:30:00Z')).toBe('05/10/2026');
    expect(formatDate('')).toBe('');
    expect(formatDateTimeBr(lateNight)).toBe('05/10/2026, 22:30');
  });

  it('o contrato do Copiloto vale até o fim do dia em Brasília', () => {
    const contracts = [{ plan: 'pro', status: 'active', startsAt: '2026-01-01', expiresAt: '2026-10-05' }];
    expect(copilotLimit(contracts, todayIso(lateNight))).toBe(25);
    expect(copilotLimit(contracts, todayIso(new Date('2026-10-06T12:00:00Z')))).toBe(5);
  });
});
