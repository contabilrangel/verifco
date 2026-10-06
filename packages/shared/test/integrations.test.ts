import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_CATALOG,
  INTEGRATION_PROVIDERS,
  activeIntegrationFields,
  ecacAutoSyncPeriod,
  ecacAutoSyncSetting,
  getIntegrationDef,
  integrationDefaults,
  isEcacAutoSyncDay,
  missingIntegrationFields,
  nextEcacAutoSyncDay,
  weekdayIso,
} from '../src';

describe('catálogo de integrações', () => {
  it('cobre todos os provedores com chaves de campo únicas', () => {
    expect(INTEGRATION_CATALOG.map((d) => d.key).sort()).toEqual(Object.keys(INTEGRATION_PROVIDERS).sort());
    for (const def of INTEGRATION_CATALOG) {
      const keys = def.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(def.steps.length).toBeGreaterThan(0);
      for (const f of def.fields.filter((x) => x.type === 'select')) expect(f.options?.length).toBeGreaterThan(0);
    }
  });

  it('aplica padrões e respeita campos condicionais', () => {
    const wa = getIntegrationDef('whatsapp')!;
    expect(integrationDefaults(wa)).toMatchObject({ mode: 'evolution', apiVersion: 'v25.0' });
    expect(activeIntegrationFields(wa, { mode: 'meta' }).map((f) => f.key)).toEqual(['mode', 'phoneNumberId', 'accessToken', 'apiVersion', 'appSecret', 'webhookVerifyToken', 'templates']);
    expect(missingIntegrationFields(wa, { mode: 'evolution', baseUrl: 'https://x' }, [])).toEqual(['Nome da instância', 'API key']);
    expect(missingIntegrationFields(wa, { mode: 'meta', phoneNumberId: '1' }, ['accessToken'])).toEqual([]);
  });

  it('segredos contam como presentes só quando guardados', () => {
    const asaas = getIntegrationDef('asaas')!;
    const cfg = integrationDefaults(asaas);
    expect(missingIntegrationFields(asaas, cfg, [])).toEqual(['Chave de API']);
    expect(missingIntegrationFields(asaas, cfg, ['apiKey'])).toEqual([]);
  });
});

describe('sincronização automática do eCAC (SERPRO)', () => {
  const serpro = getIntegrationDef('serpro')!;

  it('integração nova começa desligada, com o aviso da cobrança; o dia da semana só aparece na semanal', () => {
    expect(integrationDefaults(serpro)).toMatchObject({ autoSync: 'off', autoSyncWeekday: '1' });
    expect(ecacAutoSyncSetting(integrationDefaults(serpro))).toEqual({ mode: 'off', weekday: 1 });
    const field = serpro.fields.find((f) => f.key === 'autoSync')!;
    expect(field.options!.map((o) => o.value)).toEqual(['off', 'daily', 'weekly']);
    expect(field.help).toMatch(/cobrada pelo SERPRO/);
    expect(field.help).toMatch(/funcionam com qualquer opção/);
    expect(activeIntegrationFields(serpro, { autoSync: 'daily' }).map((f) => f.key)).not.toContain('autoSyncWeekday');
    expect(activeIntegrationFields(serpro, { autoSync: 'weekly' }).map((f) => f.key)).toContain('autoSyncWeekday');
    // não é obrigatória: ativar o SERPRO não exige escolher a frequência
    expect(missingIntegrationFields(serpro, { contractorCnpj: '11222333000181', procuratorId: 'x' }, ['consumerKey', 'consumerSecret'])).toEqual([]);
  });

  it('sem o campo ou com valor desconhecido fica desligada; a diária gravada nas integrações já ativas continua diária', () => {
    expect(ecacAutoSyncSetting({}).mode).toBe('off');
    expect(ecacAutoSyncSetting(null).mode).toBe('off');
    expect(ecacAutoSyncSetting({ autoSync: 'monthly' }).mode).toBe('off');
    // a migração 0009 grava { autoSync: 'daily' } no SERPRO que já estava ativo
    expect(ecacAutoSyncSetting({ contractorCnpj: '11222333000181', autoSync: 'daily' })).toEqual({ mode: 'daily', weekday: 1 });
    expect(ecacAutoSyncSetting({ autoSync: 'weekly', autoSyncWeekday: '0' })).toEqual({ mode: 'weekly', weekday: 0 });
    expect(ecacAutoSyncSetting({ autoSync: 'weekly', autoSyncWeekday: '9' })).toEqual({ mode: 'weekly', weekday: 1 });
  });

  it('decide os dias da rodada: desligada nunca, diária todo dia, semanal no dia escolhido', () => {
    // 06/10/2026 é uma terça-feira
    expect(weekdayIso('2026-10-06')).toBe(2);
    expect(weekdayIso('2026-10-11')).toBe(0);
    const off = { mode: 'off', weekday: 1 } as const;
    const daily = { mode: 'daily', weekday: 1 } as const;
    const friday = { mode: 'weekly', weekday: 5 } as const;
    expect(isEcacAutoSyncDay(off, '2026-10-06')).toBe(false);
    expect(nextEcacAutoSyncDay(off, '2026-10-06')).toBeNull();
    expect(isEcacAutoSyncDay(daily, '2026-10-06')).toBe(true);
    expect(nextEcacAutoSyncDay(daily, '2026-10-06')).toBe('2026-10-06');
    expect(isEcacAutoSyncDay(friday, '2026-10-06')).toBe(false);
    expect(isEcacAutoSyncDay(friday, '2026-10-09')).toBe(true);
    expect(nextEcacAutoSyncDay(friday, '2026-10-06')).toBe('2026-10-09');
    expect(nextEcacAutoSyncDay(friday, '2026-10-10')).toBe('2026-10-16');
    // virada de ano
    expect(nextEcacAutoSyncDay({ mode: 'weekly', weekday: 1 }, '2026-12-29')).toBe('2027-01-04');
  });

  it('período da chave de idempotência: o dia na diária e a segunda-feira na semanal', () => {
    expect(ecacAutoSyncPeriod('daily', '2026-10-09')).toBe('2026-10-09');
    for (const day of ['2026-10-05', '2026-10-06', '2026-10-09', '2026-10-11']) expect(ecacAutoSyncPeriod('weekly', day)).toBe('2026-10-05');
    expect(ecacAutoSyncPeriod('weekly', '2026-10-12')).toBe('2026-10-12');
    expect(ecacAutoSyncPeriod('weekly', '2027-01-01')).toBe('2026-12-28');
  });
});
