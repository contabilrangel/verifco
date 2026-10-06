/**
 * Situação do acesso dos procuradores ao eCAC (alertas do dashboard).
 *
 * Só usa o que o Verifco sabe: forma de acesso, certificado enviado (arquivo e senha), validade
 * informada e o último login no SERPRO feito com o certificado (`login_status` e
 * `last_validated_at`, gravados a cada autenticação do Integra Contador). O login gov.br acontece
 * no navegador, fora do Verifco, e por isso fica "sem verificação".
 */
import { addDaysIso, daysBetweenIso } from './dates';

/** Antecedência (dias corridos) do aviso de vencimento do certificado digital. */
export const CERTIFICATE_EXPIRY_WARNING_DAYS = 30;

export const PROCURATOR_ACCESS = {
  certificate_expired: 'Certificado vencido',
  certificate_missing: 'Certificado não enviado',
  serpro_error: 'Falha no login do SERPRO',
  certificate_expiring: `Certificado vence em até ${CERTIFICATE_EXPIRY_WARNING_DAYS} dias`,
  expiry_unknown: 'Validade do certificado não informada',
  govbr_unverified: 'Login gov.br sem verificação',
  serpro_ok: 'Autenticado no SERPRO',
  valid: 'Certificado no prazo',
} as const;
export type ProcuratorAccess = keyof typeof PROCURATOR_ACCESS;

/** Gravidade do alerta: `ok` não vira alerta, só entra na contagem. */
export type ProcuratorAccessSeverity = 'danger' | 'warning' | 'info' | 'ok';

export const PROCURATOR_ACCESS_SEVERITY: Record<ProcuratorAccess, ProcuratorAccessSeverity> = {
  certificate_expired: 'danger',
  certificate_missing: 'danger',
  serpro_error: 'danger',
  certificate_expiring: 'warning',
  expiry_unknown: 'info',
  govbr_unverified: 'info',
  serpro_ok: 'ok',
  valid: 'ok',
};

/** Títulos dos grupos de alertas, do mais grave ao informativo. */
export const PROCURATOR_ALERT_SEVERITIES = {
  danger: 'Ação necessária',
  warning: 'Atenção',
  info: 'Sem verificação',
} as const;
export type ProcuratorAlertSeverity = keyof typeof PROCURATOR_ALERT_SEVERITIES;

export interface ProcuratorAccessInput {
  authType: string;
  /** Arquivo .pfx e senha guardados no Verifco. */
  hasCertificate: boolean;
  certificateExpiresAt: string | null;
  /** Último login no SERPRO com o certificado: ok, error, expired ou unknown (nunca usado). */
  loginStatus: string;
}

/**
 * Classifica o acesso de um procurador, do problema mais grave ao normal. `today` é o dia de
 * Brasília (`todayIso()`); o certificado vale até o dia da validade, inclusive.
 */
export function classifyProcuratorAccess(p: ProcuratorAccessInput, today: string): ProcuratorAccess {
  if (p.authType === 'govbr') return 'govbr_unverified';
  const exp = p.certificateExpiresAt;
  if ((exp && exp < today) || p.loginStatus === 'expired') return 'certificate_expired';
  if (p.authType === 'certificate_cloud' && !p.hasCertificate) return 'certificate_missing';
  if (p.loginStatus === 'error') return 'serpro_error';
  if (exp && exp <= addDaysIso(today, CERTIFICATE_EXPIRY_WARNING_DAYS)) return 'certificate_expiring';
  if (!exp) return 'expiry_unknown';
  return p.loginStatus === 'ok' ? 'serpro_ok' : 'valid';
}

/** Dias até o vencimento (0 = vence hoje; negativo = já venceu); null sem validade informada. */
export function certificateDaysLeft(certificateExpiresAt: string | null, today: string): number | null {
  return certificateExpiresAt ? daysBetweenIso(today, certificateExpiresAt) : null;
}
