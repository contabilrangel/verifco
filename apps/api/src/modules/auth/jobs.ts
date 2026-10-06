import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { jobs, users } from '../../db/schema';

/** E-mail com o link de redefinição de senha (o token vai cifrado no job e é apagado após o envio). */
export const PASSWORD_RESET_JOB = 'auth.password_reset';
/** Aviso ao dono da conta de que o login foi bloqueado por excesso de tentativas. */
export const LOCKOUT_NOTICE_JOB = 'auth.lockout_notice';

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function registerJobs(ctx: AppContext) {
  ctx.jobs.register(PASSWORD_RESET_JOB, async (job) => {
    const user = await ctx.db.query.users.findFirst({ where: eq(users.id, String(job.payload.userId)) });
    const sealed = job.payload.token;
    if (!user?.isActive || typeof sealed !== 'string') return { skipped: true };
    const token = ctx.secrets.decrypt(sealed);
    const link = `${ctx.config.WEB_URL}/redefinir-senha?token=${token}`;
    await ctx.providers.email.send(user.officeId, {
      to: user.email,
      toName: user.name,
      subject: 'Redefinição de senha — Verifco',
      html: `<p>Olá, ${escapeHtml(user.name)}.</p><p>Para criar uma nova senha, acesse: <a href="${link}">${link}</a></p><p>O link vale por 1 hora. Se não foi você, ignore este e-mail.</p>`,
    });
    // enviado: o token não fica guardado nem cifrado
    await ctx.db.update(jobs).set({ payload: { userId: user.id } }).where(eq(jobs.id, job.id));
    return { sent: true };
  });

  ctx.jobs.register(LOCKOUT_NOTICE_JOB, async (job) => {
    const user = await ctx.db.query.users.findFirst({ where: eq(users.id, String(job.payload.userId)) });
    if (!user?.isActive) return { skipped: true };
    await ctx.providers.email.send(user.officeId, {
      to: user.email,
      toName: user.name,
      subject: 'Tentativas de acesso bloqueadas — Verifco',
      html: `<p>Olá, ${escapeHtml(user.name)}.</p><p>Registramos várias tentativas de entrar na sua conta do Verifco com a senha errada. Por segurança, o login com este e-mail ficou bloqueado por 15 minutos.</p><p>Se não foi você, recomendamos trocar a senha em “Esqueci minha senha” ou em Minha conta.</p>`,
    });
    return { sent: true };
  });
}
