/**
 * Redefine a senha de uma conta do sistema pela linha de comando (deploy/reset-platform-password.sh).
 * Variáveis: PLATFORM_USER_EMAIL, PLATFORM_USER_PASSWORD (mínimo 12 caracteres) e, opcionais,
 * PLATFORM_USER_RESET_2FA=true (desliga a verificação em duas etapas) e
 * PLATFORM_USER_REACTIVATE=true (reativa a conta desativada).
 */
import { z } from 'zod';
import { loadConfig } from '../config';
import { resetPlatformPassword } from '../modules/platform/recovery';
import { openPlatformDatabase } from './client';

const yes = z.enum(['true', 'false', '1', '0', '']).optional().transform((v) => v === 'true' || v === '1');
const input = z
  .object({
    PLATFORM_USER_EMAIL: z.email().max(320),
    PLATFORM_USER_PASSWORD: z.string().min(12).max(200),
    PLATFORM_USER_RESET_2FA: yes,
    PLATFORM_USER_REACTIVATE: yes,
  })
  .safeParse(process.env);
if (!input.success) throw new Error('Defina PLATFORM_USER_EMAIL e PLATFORM_USER_PASSWORD (mínimo 12 caracteres).');

const handle = await openPlatformDatabase(loadConfig().PLATFORM_DATABASE_URL);
try {
  const result = await resetPlatformPassword(handle.db, {
    email: input.data.PLATFORM_USER_EMAIL,
    password: input.data.PLATFORM_USER_PASSWORD,
    resetTwoFactor: input.data.PLATFORM_USER_RESET_2FA,
    reactivate: input.data.PLATFORM_USER_REACTIVATE,
  });
  console.log(`Senha de ${result.name} redefinida. As sessões abertas foram encerradas. Entre em /sistema.`);
  if (result.twoFactorCleared) console.log('A verificação em duas etapas foi desligada: ative de novo depois de entrar.');
  if (result.twoFactorStillOn) console.log('A verificação em duas etapas continua ligada. Se o aparelho foi perdido, rode de novo com PLATFORM_USER_RESET_2FA=true.');
  if (result.reactivated) console.log('A conta estava desativada e foi reativada.');
  else if (!result.isActive) console.log('Atenção: a conta está DESATIVADA e não entra. Rode de novo com PLATFORM_USER_REACTIVATE=true para reativar.');
} finally {
  await handle.close();
}
