/**
 * Recuperação de uma conta do sistema por quem tem acesso ao servidor (linha de comando), para
 * quando não há como entrar no painel: senha esquecida do único proprietário, aparelho da
 * verificação em duas etapas perdido, conta desativada por engano.
 */
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import type { PlatformDb } from '../../db/client';
import { platformAuditLogs, platformUsers } from '../../db/platform-schema';

export interface RecoveryInput {
  email: string;
  password: string;
  /** Desliga a verificação em duas etapas da conta (aparelho perdido). */
  resetTwoFactor?: boolean;
  /** Reativa a conta se estiver desativada. */
  reactivate?: boolean;
}

export async function resetPlatformPassword(db: PlatformDb, input: RecoveryInput) {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 12) throw new Error('A senha precisa ter ao menos 12 caracteres.');
  return db.transaction(async (tx) => {
    // mesmo lock da criação e da desativação de contas
    await tx.execute(sql`select pg_advisory_xact_lock(728103)`);
    const user = await tx.query.platformUsers.findFirst({ where: sql`lower(${platformUsers.email}) = ${email}` });
    if (!user) throw new Error(`Não existe conta do sistema com o e-mail ${email}.`);
    const twoFactorCleared = Boolean(input.resetTwoFactor && user.totpEnabledAt);
    const reactivated = Boolean(input.reactivate && !user.isActive);
    await tx
      .update(platformUsers)
      .set({
        passwordHash: await bcrypt.hash(input.password, 12),
        // as sessões abertas com a senha antiga caem
        tokenVersion: sql`${platformUsers.tokenVersion} + 1`,
        ...(input.resetTwoFactor ? { totpSecretEnc: null, totpEnabledAt: null, totpRecoveryHashes: [] } : {}),
        ...(reactivated ? { isActive: true } : {}),
      })
      .where(eq(platformUsers.id, user.id));
    // tentativas com a senha antiga não podem deixar a conta bloqueada depois da troca
    await tx.execute(sql`delete from rate_limits where key like ${'platform-login%:' + email + '%'} or key = ${'platform-login-email:' + email}`);
    await tx.insert(platformAuditLogs).values({ actorId: user.id, action: 'platform.password.cli', entityId: user.id, details: { twoFactorCleared, reactivated } });
    return { id: user.id, name: user.name, role: user.role, isActive: user.isActive || reactivated, twoFactorCleared, twoFactorStillOn: Boolean(user.totpEnabledAt) && !twoFactorCleared, reactivated };
  });
}
