/**
 * Envio de e-mail via SMTP (nodemailer, https://nodemailer.com/smtp/).
 * Usa o SMTP configurado pelo escritório; sem ele, o `SMTP_URL` da plataforma.
 */
import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { offices } from '../db/schema';
import { IntegrationError } from './http';
import { resolvePublicAddress } from './ssrf';
import type { EmailSender, OutgoingEmail } from './providers';
import { loadIntegration, type LoadedIntegration } from './store';

export interface SmtpConfig {
  host: string;
  port: number | string;
  security: 'starttls' | 'tls' | 'none';
  username?: string;
  fromEmail: string;
  fromName?: string;
}
export interface SmtpSecrets {
  password?: string;
}

/** Opções de transporte SMTP (subconjunto usado aqui). */
export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  ignoreTLS?: boolean;
  auth?: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  /**
   * SMTP informado pelo escritório: só portas de e-mail e só IPs públicos (proteção contra SSRF).
   * O SMTP da plataforma (`SMTP_URL`) é configuração do servidor e não tem essa trava.
   */
  restrictToPublic?: boolean;
  tls?: { servername?: string };
}

/** Portas de envio de e-mail aceitas no SMTP do escritório. */
export const SMTP_ALLOWED_PORTS = [25, 465, 587, 2525];

export interface MailTransport {
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string }>;
  verify(): Promise<unknown>;
  close?(): void;
}

export type TransportFactory = (opts: SmtpTransportOptions) => MailTransport;

const nodemailerTransport = (opts: SmtpTransportOptions) => {
  const { restrictToPublic: _r, ...rest } = opts;
  return nodemailer.createTransport(rest) as unknown as MailTransport;
};

/**
 * Transporte real (nodemailer). Para o SMTP do escritório, resolve o servidor antes de conectar,
 * recusa IP interno e conecta no IP conferido (mantendo o nome para o TLS), o que impede
 * DNS rebinding; a porta precisa ser de e-mail.
 */
export const defaultTransportFactory: TransportFactory = (opts) => {
  if (!opts.restrictToPublic) return nodemailerTransport(opts);
  let inner: MailTransport | null = null;
  const connect = async () => {
    if (inner) return inner;
    if (!SMTP_ALLOWED_PORTS.includes(opts.port)) {
      throw new IntegrationError('smtp', `Porta ${opts.port} não permitida. Use ${SMTP_ALLOWED_PORTS.join(', ')}.`);
    }
    const address = await resolvePublicAddress('smtp', opts.host);
    inner = nodemailerTransport({ ...opts, host: address, tls: { ...(opts.tls ?? {}), servername: opts.host } });
    return inner;
  };
  return {
    sendMail: async (mail) => (await connect()).sendMail(mail),
    verify: async () => (await connect()).verify(),
    close: () => inner?.close?.(),
  };
};

const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000 };

export const NO_EMAIL_CONFIGURED = 'Configure o envio de e-mail em Administração › Integrações.';

export function smtpOptionsFromConfig(cfg: SmtpConfig, secrets: SmtpSecrets): SmtpTransportOptions {
  const port = Number(cfg.port) || (cfg.security === 'tls' ? 465 : 587);
  return {
    host: cfg.host,
    port,
    secure: cfg.security === 'tls',
    requireTLS: cfg.security === 'starttls',
    ignoreTLS: cfg.security === 'none',
    auth: cfg.username ? { user: cfg.username, pass: secrets.password ?? '' } : undefined,
    ...TIMEOUTS,
    restrictToPublic: true,
  };
}

/** `smtp(s)://usuario:senha@host:porta` → opções do transporte. */
export function smtpOptionsFromUrl(url: string): SmtpTransportOptions {
  const u = new URL(url);
  const secure = u.protocol === 'smtps:';
  return {
    host: u.hostname,
    port: Number(u.port) || (secure ? 465 : 587),
    secure,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
    ...TIMEOUTS,
  };
}

/** "Nome <email>" → partes. */
export function parseAddress(value: string): { name: string | null; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  return m ? { name: m[1].trim() || null, address: m[2].trim() } : { name: null, address: value.trim() };
}

interface ResolvedTransport {
  options: SmtpTransportOptions;
  from: { name: string | null; address: string };
  source: 'office' | 'platform';
}

async function resolveTransport(ctx: AppContext, officeId: string): Promise<ResolvedTransport> {
  const loaded = await loadIntegration<SmtpConfig, SmtpSecrets>(ctx, officeId, 'smtp');
  if (loaded?.row.enabled && loaded.config.host && loaded.config.fromEmail) {
    return {
      options: smtpOptionsFromConfig(loaded.config, loaded.secrets),
      from: { name: loaded.config.fromName || null, address: loaded.config.fromEmail },
      source: 'office',
    };
  }
  if (ctx.config.SMTP_URL) {
    return { options: smtpOptionsFromUrl(ctx.config.SMTP_URL), from: parseAddress(ctx.config.SMTP_FROM), source: 'platform' };
  }
  throw new IntegrationError('smtp', NO_EMAIL_CONFIGURED);
}

function smtpError(err: unknown): IntegrationError {
  if (err instanceof IntegrationError) return err;
  const e = err as { code?: string; responseCode?: number; message?: string };
  const code = e?.code ?? '';
  if (code === 'EAUTH') return new IntegrationError('smtp', 'O servidor de e-mail recusou o usuário ou a senha.');
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET' || code === 'EDNS') {
    return new IntegrationError('smtp', `Não foi possível conectar ao servidor de e-mail (${code}). Confira o servidor, a porta e a segurança.`);
  }
  return new IntegrationError('smtp', `Falha no envio do e-mail: ${e?.message ?? String(err)}`);
}

export function createEmailSender(ctx: AppContext, factory: TransportFactory = defaultTransportFactory): EmailSender {
  return {
    async send(officeId: string, msg: OutgoingEmail) {
      const t = await resolveTransport(ctx, officeId);
      let fromName = msg.fromName ?? t.from.name;
      if (!fromName) {
        const office = await ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId) });
        fromName = office?.name ?? null;
      }
      const transport = factory(t.options);
      try {
        const info = await transport.sendMail({
          from: fromName ? { name: fromName, address: t.from.address } : t.from.address,
          to: msg.toName ? { name: msg.toName, address: msg.to } : msg.to,
          replyTo: msg.replyTo ?? undefined,
          subject: msg.subject,
          html: msg.html,
          attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
          // Imagens enviadas do computador chegam no HTML como `data:image/...`, que o Gmail e o Outlook
          // não exibem; o nodemailer as converte em anexos inline (Content-ID) e troca o src por `cid:`.
          attachDataUrls: true,
        });
        return { messageId: info.messageId ?? `smtp-${Date.now()}` };
      } catch (err) {
        throw smtpError(err);
      } finally {
        transport.close?.();
      }
    },
  };
}

/** Teste: conecta e autentica; com `sendTo`, envia uma mensagem de teste. */
export async function testSmtp(
  ctx: AppContext,
  loaded: LoadedIntegration<SmtpConfig, SmtpSecrets>,
  opts: { sendTo?: string; officeName?: string } = {},
  factory: TransportFactory = defaultTransportFactory,
) {
  if (!loaded.config.host || !loaded.config.fromEmail) throw new IntegrationError('smtp', 'Informe o servidor SMTP e o e-mail do remetente.');
  const transport = factory(smtpOptionsFromConfig(loaded.config, loaded.secrets));
  try {
    await transport.verify();
    if (opts.sendTo) {
      const name = loaded.config.fromName || opts.officeName;
      await transport.sendMail({
        from: name ? { name, address: loaded.config.fromEmail } : loaded.config.fromEmail,
        to: opts.sendTo,
        subject: 'Teste de envio do Verifco',
        html: '<p>Este é um e-mail de teste enviado pela integração de e-mail do Verifco.</p><p>Se você recebeu, a configuração está correta.</p>',
      });
      return `Conexão com o servidor de e-mail funcionando. Mensagem de teste enviada para ${opts.sendTo}.`;
    }
    return 'Conexão com o servidor de e-mail funcionando.';
  } catch (err) {
    throw smtpError(err);
  } finally {
    transport.close?.();
  }
}
