import { describe, expect, it } from 'vitest';
import { quotaLevel } from '../src';

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
