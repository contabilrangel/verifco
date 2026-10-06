import { and, eq } from 'drizzle-orm';
import { INTEGRATION_PROVIDERS, integrationDefaults, getIntegrationDef, type IntegrationProvider } from '@verifco/shared';
import type { AppContext } from '../context';
import { integrations } from '../db/schema';
import { IntegrationError } from './http';

export type IntegrationRow = typeof integrations.$inferSelect;

export interface LoadedIntegration<C = Record<string, unknown>, S = Record<string, string>> {
  row: IntegrationRow;
  /** Configuração pública com os padrões do catálogo aplicados. */
  config: C;
  /** Segredos decifrados — use só no servidor, nunca devolva ao navegador. */
  secrets: S;
}

export async function getIntegrationRow(ctx: AppContext, officeId: string, provider: IntegrationProvider): Promise<IntegrationRow | null> {
  const row = await ctx.db.query.integrations.findFirst({
    where: and(eq(integrations.officeId, officeId), eq(integrations.provider, provider)),
  });
  return row ?? null;
}

export function decryptSecrets(ctx: AppContext, row: Pick<IntegrationRow, 'secretsEnc'>): Record<string, string> {
  return ctx.secrets.decryptJson<Record<string, string>>(row.secretsEnc) ?? {};
}

/** Carrega a integração do escritório (habilitada ou não), com segredos decifrados. */
export async function loadIntegration<C = Record<string, unknown>, S = Record<string, string>>(
  ctx: AppContext,
  officeId: string,
  provider: IntegrationProvider,
): Promise<LoadedIntegration<C, S> | null> {
  const row = await getIntegrationRow(ctx, officeId, provider);
  if (!row) return null;
  const def = getIntegrationDef(provider);
  const config = { ...(def ? integrationDefaults(def) : {}), ...row.publicConfig } as C;
  return { row, config, secrets: decryptSecrets(ctx, row) as S };
}

/**
 * Integração habilitada ou erro claro dizendo onde configurar.
 * Usada pelos jobs de cobrança e pelo SERPRO.
 */
export async function requireIntegration<C = Record<string, unknown>, S = Record<string, string>>(
  ctx: AppContext,
  officeId: string,
  provider: IntegrationProvider,
): Promise<LoadedIntegration<C, S>> {
  const loaded = await loadIntegration<C, S>(ctx, officeId, provider);
  const label = INTEGRATION_PROVIDERS[provider];
  if (!loaded) throw new IntegrationError(provider, `A integração ${label} não está configurada. Configure em Administração › Integrações.`);
  if (!loaded.row.enabled) throw new IntegrationError(provider, `A integração ${label} está desativada. Ative em Administração › Integrações.`);
  return loaded;
}

/** Mostra só os 4 últimos caracteres de um segredo (nada, se for curto demais). */
export function maskSecret(value: string | undefined): { configured: boolean; last4: string | null } {
  if (!value) return { configured: false, last4: null };
  return { configured: true, last4: value.length >= 8 ? value.slice(-4) : null };
}
