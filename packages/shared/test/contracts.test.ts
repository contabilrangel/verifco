import { describe, expect, it } from 'vitest';
import { CONTRACT_STATUS, contractSituation, quotaLevel } from '../src';

describe('uso do limite do contrato', () => {
  it('classifica sem limite, normal, perto do limite (80%) e no limite', () => {
    expect(quotaLevel({ limit: null, used: 500 })).toBe('unlimited');
    expect(quotaLevel({ limit: 30, used: 23 })).toBe('ok');
    expect(quotaLevel({ limit: 30, used: 24 })).toBe('near');
    expect(quotaLevel({ limit: 30, used: 29 })).toBe('near');
    expect(quotaLevel({ limit: 30, used: 30 })).toBe('full');
    expect(quotaLevel({ limit: 30, used: 31 })).toBe('full');
    expect(quotaLevel({ limit: 0, used: 0 })).toBe('full');
  });
});

describe('contractSituation', () => {
  const base = { startsAt: '2026-01-01', expiresAt: '2026-12-31' };
  it('usa a mesma grafia gravada pelo painel do sistema', () => {
    expect(Object.keys(CONTRACT_STATUS)).toEqual(['active', 'expired', 'cancelled']);
    expect(contractSituation({ ...base, status: 'cancelled' }, '2026-06-01')).toBe('cancelled');
    expect(contractSituation({ ...base, status: 'expired' }, '2026-06-01')).toBe('expired');
  });
  it('dentro das datas é ativo; fora delas, expirado ou a iniciar', () => {
    expect(contractSituation({ ...base, status: 'active' }, '2026-06-01')).toBe('active');
    expect(contractSituation({ ...base, status: 'active' }, '2027-01-01')).toBe('expired');
    expect(contractSituation({ ...base, status: 'active' }, '2025-12-31')).toBe('upcoming');
  });
});
