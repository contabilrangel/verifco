/**
 * SSRF nas integrações com endereço informado pelo escritório (Evolution API e SMTP próprio).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { defaultTransportFactory, smtpOptionsFromConfig, smtpOptionsFromUrl } from '../src/integrations/email';
import { IntegrationError, ensureOk } from '../src/integrations/http';
import { createPublicOnlyFetch, isPrivateAddress, resolvePublicAddress, unsafeBaseUrlReason } from '../src/integrations/ssrf';
import { EvolutionClient } from '../src/integrations/whatsapp';
import { createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

/** DNS falso: cada nome resolve para os IPs indicados. */
const fakeDns =
  (table: Record<string, string[]>) =>
  (hostname: string, _opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => {
    const ips = table[hostname];
    if (!ips) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    cb(
      null,
      ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  };

describe('endereços internos (SEG-6)', () => {
  it('reconhece IPs privados, loopback, link-local, CGNAT e IPv4 embutido em IPv6', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '200.160.2.3', '2001:4860:4860::8888']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('URL da Evolution: só https público, sem usuário, senha, ? ou #', () => {
    expect(unsafeBaseUrlReason('https://evo.exemplo.com.br')).toBeNull();
    for (const url of [
      'http://evo.exemplo.com.br',
      'https://127.0.0.1:8080',
      'https://169.254.169.254/latest',
      'https://localhost',
      'https://evolution',
      'https://painel.internal',
      'https://user:senha@evo.exemplo.com.br',
      'https://evo.exemplo.com.br/?x=',
      'https://evo.exemplo.com.br/#a',
      'https://[::1]/',
    ]) {
      expect(unsafeBaseUrlReason(url), url).not.toBeNull();
    }
    expect(() => new EvolutionClient(fetch, 'https://10.0.0.5', 'inst', 'key')).toThrow(IntegrationError);
  });

  it('configuração recusa URL e SMTP internos ou porta que não é de e-mail', async () => {
    const o = await registerOffice(env);
    for (const baseUrl of ['https://127.0.0.1', 'https://metadata.google.internal', 'https://evo.exemplo.com.br/?x=']) {
      const r = await o.api.put('/api/integrations/whatsapp', { config: { mode: 'evolution', baseUrl, instance: 'x' } });
      expect(r.status, baseUrl).toBe(400);
    }
    expect((await o.api.put('/api/integrations/whatsapp', { config: { mode: 'evolution', baseUrl: 'https://evo.exemplo.com.br', instance: 'x' } })).status).toBe(200);
    expect((await o.api.put('/api/integrations/smtp', { config: { host: 'localhost', port: 587, security: 'starttls', fromEmail: 'a@b.com' } })).status).toBe(400);
    expect((await o.api.put('/api/integrations/smtp', { config: { host: '10.0.0.8', port: 587, security: 'starttls', fromEmail: 'a@b.com' } })).status).toBe(400);
    expect((await o.api.put('/api/integrations/smtp', { config: { host: 'smtp.exemplo.com.br', port: 6379, security: 'none', fromEmail: 'a@b.com' } })).status).toBe(400);
    expect((await o.api.put('/api/integrations/smtp', { config: { host: 'smtp.exemplo.com.br', port: 587, security: 'starttls', fromEmail: 'a@b.com' } })).status).toBe(200);
  });

  it('a cada conexão, bloqueia nome que resolve para a rede interna (DNS rebinding)', async () => {
    const dns = fakeDns({ 'evo.exemplo.com.br': ['10.0.0.7'], 'misto.exemplo.com.br': ['8.8.8.8', '127.0.0.1'] });
    const guarded = createPublicOnlyFetch('evolution', dns);
    await expect(guarded('https://evo.exemplo.com.br/instance/connectionState/x')).rejects.toThrow(/rede interna/);
    await expect(guarded('https://misto.exemplo.com.br/')).rejects.toThrow(/rede interna/);
    await expect(guarded('https://127.0.0.1:1/')).rejects.toThrow(/rede interna/);
    await expect(resolvePublicAddress('smtp', 'smtp.exemplo.com.br', fakeDns({ 'smtp.exemplo.com.br': ['192.168.0.10'] }))).rejects.toThrow(/rede interna/);
    expect(await resolvePublicAddress('smtp', 'smtp.exemplo.com.br', fakeDns({ 'smtp.exemplo.com.br': ['200.160.2.3'] }))).toBe('200.160.2.3');
  });

  it('SMTP do escritório: porta e IP conferidos antes de conectar; SMTP da plataforma não muda', async () => {
    const office = smtpOptionsFromConfig({ host: '127.0.0.1', port: 587, security: 'starttls', fromEmail: 'a@b.com' }, {});
    expect(office.restrictToPublic).toBe(true);
    await expect(defaultTransportFactory(office).verify()).rejects.toThrow(/rede interna/);
    const badPort = smtpOptionsFromConfig({ host: 'smtp.exemplo.com.br', port: 22, security: 'none', fromEmail: 'a@b.com' }, {});
    await expect(defaultTransportFactory(badPort).verify()).rejects.toThrow(/Porta 22/);
    expect(smtpOptionsFromUrl('smtp://relay:25').restrictToPublic).toBeUndefined();
  });

  it('erro de endereço do escritório não devolve o corpo cru da resposta', () => {
    const res = { status: 500, ok: false, data: '<html>painel interno: senha=123</html>', text: '', headers: new Headers() };
    expect(() => ensureOk('evolution', res, () => null, { rawBody: false })).toThrow(/^Evolution API respondeu com erro \(HTTP 500\)\.$/);
  });
});
