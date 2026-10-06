import type { AppContext } from '../context';
import { createAiProvider } from './ai';
import { createEmailSender, defaultTransportFactory, type TransportFactory } from './email';
import type { Providers } from './providers';
import type { MtlsRequest } from './serpro';
import { createPublicOnlyFetch } from './ssrf';
import { createWhatsAppSender } from './whatsapp';

export interface ProviderDeps {
  /** `fetch` usado por todos os clientes HTTP (injetável nos testes). */
  fetch?: typeof fetch;
  /** Fábrica do transporte SMTP (injetável nos testes). */
  createTransport?: TransportFactory;
  /** Requisição mTLS da autenticação do SERPRO (injetável nos testes). */
  mtlsRequest?: MtlsRequest;
}

/**
 * Monta os provedores reais. Cada envio lê a configuração do escritório na hora
 * (Administração › Integrações), então mudanças valem sem reiniciar a API:
 * - e-mail: SMTP do escritório ou `SMTP_URL` da plataforma;
 * - WhatsApp: Evolution API ou WhatsApp Cloud API (Meta), conforme o modo;
 * - IA: Anthropic com a chave do escritório ou `ANTHROPIC_API_KEY`.
 */
export function createProviders(ctx: AppContext, deps: ProviderDeps = {}): Providers {
  const providers: Providers = {
    fetch: deps.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    // com fetch injetado (testes) usa o mesmo; em produção, o que bloqueia a rede interna
    userUrlFetch: deps.fetch ?? createPublicOnlyFetch('evolution'),
    email: createEmailSender(ctx, deps.createTransport ?? defaultTransportFactory),
    whatsapp: createWhatsAppSender(ctx, () => providers.fetch, () => providers.userUrlFetch ?? providers.fetch),
    ai: createAiProvider(ctx, () => providers.fetch),
    smtpTransport: deps.createTransport,
    mtlsRequest: deps.mtlsRequest,
  };
  return providers;
}
