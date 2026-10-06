import { eq } from 'drizzle-orm';
import { aiProviderDef } from '@verifco/shared';
import type { AppContext } from '../context';
import { platformAiConnections, platformSettings } from '../db/platform-schema';
import { IntegrationError } from './http';

export type AiConnection = typeof platformAiConnections.$inferSelect;
export type ResolvedConnection = AiConnection & { apiKey: string };
export const safeConnection = (row: AiConnection) => {
  const { secretsEnc, ...safe } = row;
  return { ...safe, keyConfigured: Boolean(secretsEnc), pdf: aiProviderDef(row.provider)?.pdf ?? false };
};

export function unlockConnection(ctx: AppContext, row: AiConnection): ResolvedConnection {
  const secrets = row.secretsEnc ? (ctx.secrets.decryptJson<{ apiKey?: string }>(row.secretsEnc) ?? {}) : {};
  if (!secrets.apiKey && row.provider !== 'ollama') throw new IntegrationError('ai', 'A chave desta conexão de IA não está configurada. Contate o suporte do Verifco.');
  return { ...row, apiKey: secrets.apiKey ?? '' };
}

/** Uma escolha global explícita não recorre a outro serviço quando está indisponível. */
export async function resolveGlobalAi(ctx: AppContext): Promise<ResolvedConnection> {
  const settings = await ctx.platformDb.query.platformSettings.findFirst({ where: eq(platformSettings.id, 'global') });
  if (settings?.defaultAiId) {
    const row = await ctx.platformDb.query.platformAiConnections.findFirst({ where: eq(platformAiConnections.id, settings.defaultAiId) });
    if (!row?.enabled) throw new IntegrationError('ai', 'A IA da plataforma está desativada. Contate o suporte do Verifco.');
    return unlockConnection(ctx, row);
  }
  // Compatibilidade com instalações já configuradas pelo proprietário no ambiente do servidor.
  if (ctx.config.ANTHROPIC_API_KEY) return {
    id: 'environment', provider: 'anthropic', name: 'Claude da plataforma', model: ctx.config.AI_MODEL,
    baseUrl: 'https://api.anthropic.com/v1', apiKey: ctx.config.ANTHROPIC_API_KEY, supportsImages: true,
    enabled: true, secretsEnc: null, lastTestAt: null, status: 'configured', updatedAt: new Date(),
  };
  throw new IntegrationError('ai', 'A IA da plataforma não está configurada. Contate o suporte do Verifco.');
}
