import { eq } from 'drizzle-orm';
import type { IntegrationProvider } from '@verifco/shared';
import type { AppContext } from '../context';
import { offices } from '../db/schema';
import { testAi } from './ai';
import { testAsaas, type AsaasConfig, type AsaasSecrets } from './asaas';
import { defaultTransportFactory, testSmtp, type SmtpConfig, type SmtpSecrets, type TransportFactory } from './email';
import { IntegrationError } from './http';
import { testOmie, type OmieConfig, type OmieSecrets } from './omie';
import { testSerpro, type MtlsRequest } from './serpro';
import { loadIntegration } from './store';
import { testWhatsApp, type WhatsAppConfig, type WhatsAppSecrets } from './whatsapp';

export interface TestDeps {
  createTransport?: TransportFactory;
  mtls?: MtlsRequest;
}

async function saved<C, S>(ctx: AppContext, officeId: string, provider: IntegrationProvider) {
  const loaded = await loadIntegration<C, S>(ctx, officeId, provider);
  if (!loaded) throw new IntegrationError(provider, 'Salve a configuração antes de testar.');
  return loaded;
}

/**
 * Testa as credenciais salvas falando de verdade com o provedor (mesmo com a integração desativada).
 * Devolve a mensagem de sucesso ou lança `IntegrationError` com o motivo.
 */
export async function testIntegration(
  ctx: AppContext,
  officeId: string,
  provider: IntegrationProvider,
  opts: { sendTo?: string } = {},
  deps: TestDeps = { createTransport: ctx.providers.smtpTransport, mtls: ctx.providers.mtlsRequest },
): Promise<string> {
  switch (provider) {
    case 'ai':
      return testAi(ctx, officeId, ctx.providers.fetch);
    case 'serpro':
      return testSerpro(ctx, officeId, { mtls: deps.mtls });
    case 'asaas':
      return testAsaas(ctx, await saved<AsaasConfig, AsaasSecrets>(ctx, officeId, provider));
    case 'omie':
      return testOmie(ctx, await saved<OmieConfig, OmieSecrets>(ctx, officeId, provider));
    case 'whatsapp':
      return testWhatsApp(ctx.providers.fetch, await saved<WhatsAppConfig, WhatsAppSecrets>(ctx, officeId, provider), opts);
    case 'smtp': {
      const loaded = await saved<SmtpConfig, SmtpSecrets>(ctx, officeId, provider);
      const office = await ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId) });
      return testSmtp(ctx, loaded, { sendTo: opts.sendTo, officeName: office?.name }, deps.createTransport ?? defaultTransportFactory);
    }
    default:
      throw new IntegrationError(provider, 'Integração desconhecida.');
  }
}
