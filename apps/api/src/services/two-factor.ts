/**
 * Verificação em duas etapas, igual para as contas dos escritórios (`users`) e as do sistema
 * (`platform_users`): as duas tabelas têm as mesmas três colunas. Este módulo trabalha sobre os
 * valores; quem grava é a rota de cada painel.
 */
import type { Secrets } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from '../lib/totp';

export interface TwoFactorState {
  totpSecretEnc: string | null;
  totpEnabledAt: Date | null;
  totpRecoveryHashes: string[];
}

export const TWO_FACTOR_REQUIRED = 'two_factor_required';
export const TWO_FACTOR_MESSAGE = 'Informe o código do aplicativo autenticador.';
export const TWO_FACTOR_INVALID = 'Código inválido. Confira o aplicativo autenticador ou use um código de recuperação.';

/** Começa a ativação: segredo novo (cifrado, ainda sem valer) e o endereço para o aplicativo. */
export function beginSetup(secrets: Secrets, account: string, issuer: string) {
  const secret = newTotpSecret();
  return { set: { totpSecretEnc: secrets.encrypt(secret), totpEnabledAt: null, totpRecoveryHashes: [] as string[] }, secret, otpauthUrl: otpauthUrl({ secret, account, issuer }) };
}

/** Conclui a ativação: o código do aplicativo confere com o segredo pendente. Devolve os códigos de recuperação (mostrados uma vez). */
export function finishSetup(secrets: Secrets, state: TwoFactorState, code: string) {
  if (state.totpEnabledAt) throw badRequest('A verificação em duas etapas já está ativa.');
  if (!state.totpSecretEnc) throw badRequest('Comece a ativação de novo: não há uma chave pendente.');
  if (!verifyTotp(secrets.decrypt(state.totpSecretEnc), code)) throw badRequest('Código inválido. Confira se a hora do celular está certa e digite o código atual do aplicativo.');
  const recoveryCodes = newRecoveryCodes();
  return { set: { totpEnabledAt: new Date(), totpRecoveryHashes: recoveryCodes.map(hashRecoveryCode) }, recoveryCodes };
}

export const DISABLED = { totpSecretEnc: null, totpEnabledAt: null, totpRecoveryHashes: [] as string[] };

/**
 * Confere o segundo fator no login ou numa ação sensível: código do aplicativo ou um código de
 * recuperação (que é gasto: `remaining` traz a lista sem ele para gravar).
 */
export function checkSecondFactor(secrets: Secrets, state: TwoFactorState, code: string | undefined): { ok: boolean; remaining?: string[] } {
  if (!state.totpEnabledAt || !state.totpSecretEnc) return { ok: true };
  if (!code) return { ok: false };
  if (/^[\d\s-]{6,9}$/.test(code) && verifyTotp(secrets.decrypt(state.totpSecretEnc), code)) return { ok: true };
  if (normalizeRecoveryCode(code).length === 12) {
    const hash = hashRecoveryCode(code);
    if (state.totpRecoveryHashes.includes(hash)) return { ok: true, remaining: state.totpRecoveryHashes.filter((h) => h !== hash) };
  }
  return { ok: false };
}
