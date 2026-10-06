import { describe, expect, it } from 'vitest';
import { INTEGRATION_CATALOG, INTEGRATION_PROVIDERS, activeIntegrationFields, getIntegrationDef, integrationDefaults, missingIntegrationFields } from '../src';

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
