/**
 * Configurações globais do sistema (painel /sistema › Configurações), guardadas no banco da
 * plataforma. Cada campo vazio vale o padrão: a variável de ambiente correspondente ou o do código.
 */
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { platformSettings } from '../db/platform-schema';

export const DEFAULT_TRIAL_DAYS = 30;
export const DEFAULT_TRIAL_DECLARATION_LIMIT = 30;

export interface EffectiveSettings {
  /** Cadastro de novos escritórios aberto (a variável SIGNUP_ENABLED=false fecha de vez). */
  signupEnabled: boolean;
  trialDays: number;
  trialDeclarationLimit: number;
  supportEmail: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
}

type Ctx = Pick<AppContext, 'config' | 'platformDb'>;

export async function effectiveSettings(ctx: Ctx): Promise<EffectiveSettings> {
  const row = await ctx.platformDb.query.platformSettings.findFirst({ where: eq(platformSettings.id, 'global') });
  return {
    // a variável de ambiente é a trava do operador do servidor: o painel só fecha, nunca reabre
    signupEnabled: ctx.config.SIGNUP_ENABLED && (row?.signupEnabled ?? true),
    trialDays: row?.trialDays ?? DEFAULT_TRIAL_DAYS,
    trialDeclarationLimit: row?.trialDeclarationLimit ?? DEFAULT_TRIAL_DECLARATION_LIMIT,
    supportEmail: row?.supportEmail || ctx.config.SUPPORT_EMAIL || null,
    termsUrl: row?.termsUrl || null,
    privacyUrl: row?.privacyUrl || null,
  };
}

/** Versão dos termos aceita no cadastro: o próprio endereço publicado (muda o endereço, muda a versão). */
export const termsVersionOf = (s: Pick<EffectiveSettings, 'termsUrl'>) => (s.termsUrl ? s.termsUrl.slice(0, 500) : null);
