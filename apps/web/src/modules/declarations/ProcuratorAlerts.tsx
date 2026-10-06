import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight, CircleAlert, CircleHelp, KeyRound, TriangleAlert } from 'lucide-react';
import { PROCURATOR_ALERT_SEVERITIES, type ProcuratorAccess, type ProcuratorAlertSeverity } from '@verifco/shared';
import { Alert, Card, Tag, type Tone } from '../../ds';
import { useAuth } from '../../lib/auth';
import { formatDate, formatDateTime } from '../../lib/format';

/** Um procurador com alerta de acesso ao eCAC (GET /dashboard → procuratorAccess). */
export interface ProcuratorAccessItem {
  id: string;
  name: string;
  authType: 'govbr' | 'certificate_local' | 'certificate_cloud';
  access: ProcuratorAccess;
  label: string;
  severity: ProcuratorAlertSeverity;
  certificateExpiresAt: string | null;
  daysLeft: number | null;
  serpro: { status: 'ok' | 'error' | 'expired' | null; at: string | null; usesThisCertificate: boolean };
  customers: number;
  mine: boolean;
}

export interface ProcuratorAccessData {
  warningDays: number;
  total: number;
  count: number;
  counts: Record<ProcuratorAlertSeverity | 'ok', number>;
  items: ProcuratorAccessItem[];
}

const SEVERITY_META: Record<ProcuratorAlertSeverity, { tone: Tone; icon: ReactNode }> = {
  danger: { tone: 'danger', icon: <CircleAlert /> },
  warning: { tone: 'warning', icon: <TriangleAlert /> },
  info: { tone: 'neutral', icon: <CircleHelp /> },
};

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

/** O que aconteceu, em uma linha. */
function describe(p: ProcuratorAccessItem): string {
  const exp = p.certificateExpiresAt ? formatDate(p.certificateExpiresAt) : null;
  switch (p.access) {
    case 'certificate_expired':
      return exp ? `Venceu em ${exp}.` : 'O SERPRO recusou o certificado por estar vencido.';
    case 'certificate_expiring':
      return p.daysLeft === 0 ? `Vence hoje (${exp}).` : `Vence em ${exp} (${plural(p.daysLeft ?? 0, 'dia', 'dias')}).`;
    case 'certificate_missing':
      return 'Forma de acesso com certificado A1 na nuvem, mas o arquivo .pfx e a senha não foram enviados.';
    case 'serpro_error':
      return p.serpro.at ? `O último login no SERPRO com este certificado falhou em ${formatDateTime(p.serpro.at)}.` : 'O último login no SERPRO com este certificado falhou.';
    case 'expiry_unknown':
      return 'Informe a validade do certificado para receber o aviso de vencimento.';
    case 'govbr_unverified':
      return 'O login gov.br acontece no navegador e o Verifco não consegue conferir se está ativo.';
    default:
      return '';
  }
}

/** Texto do link de correção. */
function fixLabel(p: ProcuratorAccessItem): string {
  if (p.access === 'govbr_unverified') return 'Ver procurador';
  if (p.authType === 'certificate_cloud') return p.access === 'serpro_error' ? 'Revisar certificado' : 'Enviar certificado';
  return 'Atualizar validade';
}

/**
 * Alertas de acesso dos procuradores ao eCAC, agrupados por gravidade, com o link para corrigir:
 * Administração › Procuradores para quem administra, ou Minha conta quando o procurador é o próprio
 * usuário.
 */
export function ProcuratorAlerts({ data }: { data: ProcuratorAccessData }) {
  const { can } = useAuth();
  const canAdmin = can('procuration.list', 'procuration.edit', 'procuration.certificate');
  const canIntegrations = can('integrations.manage');
  if (data.total === 0) return null;
  const fixHref = (p: ProcuratorAccessItem) => (canAdmin ? '/admin/procuradores' : p.mine ? '/conta' : null);
  const groups = (Object.keys(PROCURATOR_ALERT_SEVERITIES) as ProcuratorAlertSeverity[])
    .map((severity) => ({ severity, items: data.items.filter((p) => p.severity === severity) }))
    .filter((g) => g.items.length > 0);

  return (
    <Card
      title="Acesso dos procuradores ao eCAC"
      actions={
        canAdmin && (
          <Link to="/admin/procuradores" className="vf-dec-proc__fix">
            Gerenciar procuradores <ChevronRight size={14} />
          </Link>
        )
      }
    >
      {groups.length === 0 ? (
        <Alert tone="success" title="Acesso em ordem">
          {data.total === 1 ? 'O procurador está' : `Os ${data.total.toLocaleString('pt-BR')} procuradores estão`} com o certificado no prazo.
        </Alert>
      ) : (
        <div className="vf-stack" style={{ '--gap': '16px' } as CSSProperties}>
          {groups.map((g) => {
            const meta = SEVERITY_META[g.severity];
            const title = PROCURATOR_ALERT_SEVERITIES[g.severity];
            return (
              <section key={g.severity} aria-label={title} className={`vf-dec-proc vf-dec-proc--${g.severity}`}>
                <h3 className="vf-dec-proc__title">
                  <span className="vf-dec-proc__icon">{meta.icon}</span>
                  {title}
                  <Tag tone={meta.tone}>{g.items.length}</Tag>
                </h3>
                <ul className="vf-dec-proc__list">
                  {g.items.map((p) => {
                    const href = fixHref(p);
                    const lastUse = p.access !== 'serpro_error' && p.serpro.at;
                    return (
                      <li key={p.id} className="vf-dec-proc__item">
                        <span className="vf-dec-proc__main">
                          <span className="vf-dec-proc__name">
                            <KeyRound size={14} aria-hidden />
                            <strong>{p.name}</strong>
                            <Tag tone={meta.tone}>{p.label}</Tag>
                          </span>
                          <span className="vf-dec-proc__text">{describe(p)}</span>
                          <span className="vf-dec-proc__meta">
                            {[
                              p.customers > 0 ? plural(p.customers, 'cliente ativo', 'clientes ativos') : 'Nenhum cliente ativo associado',
                              p.serpro.usesThisCertificate ? 'Certificado usado pelo SERPRO' : null,
                              lastUse ? `Último login no SERPRO em ${formatDateTime(p.serpro.at)}${p.serpro.status === 'ok' ? '' : ' (falhou)'}` : null,
                              p.mine ? 'Você é este procurador' : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                        <span className="vf-dec-proc__actions">
                          {href && (
                            <Link to={href} className="vf-dec-proc__fix" aria-label={`${fixLabel(p)}: ${p.name}`}>
                              {fixLabel(p)} <ChevronRight size={14} />
                            </Link>
                          )}
                          {p.access === 'serpro_error' && canIntegrations && (
                            <Link to="/admin/integracoes" className="vf-dec-proc__fix">
                              Testar o SERPRO <ChevronRight size={14} />
                            </Link>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {data.count > data.items.length && (
            <span className="vf-muted vf-text-xs">
              Mostrando {data.items.length} de {data.count.toLocaleString('pt-BR')} procuradores com alerta.
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
