import { ExternalLink, FileText } from 'lucide-react';
import { Alert, Card, EmptyState, Loading, Progress, Tag, type Tone } from '../../ds';
import { useApi } from '../../lib/hooks';
import { formatDate } from '../../lib/format';

interface ContractRow {
  id: string;
  name: string;
  plan: string;
  declarationLimit: number | null;
  year: number;
  startsAt: string;
  expiresAt: string;
  hasBackup: boolean;
  status: string;
  termsUrl: string | null;
}

const PLANS: Record<string, string> = { trial: 'Avaliação', basic: 'Básico', pro: 'Profissional', enterprise: 'Empresarial' };

function situation(c: ContractRow): { tone: Tone; label: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (c.status === 'canceled') return { tone: 'neutral', label: 'Cancelado' };
  if (c.status === 'suspended') return { tone: 'warning', label: 'Suspenso' };
  if (c.expiresAt < today) return { tone: 'danger', label: 'Expirado' };
  if (c.startsAt > today) return { tone: 'primary', label: 'A iniciar' };
  return { tone: 'success', label: 'Ativo' };
}

interface ContractStatus {
  hasContracts: boolean;
  blocked: boolean;
  lastExpiresAt: string | null;
  nextStartsAt: string | null;
  activeExpiresAt: string | null;
  quotas: { year: number; limit: number | null; used: number; remaining: number | null }[];
}

const daysUntil = (iso: string) => Math.round((new Date(`${iso}T12:00:00`).getTime() - Date.now()) / 86_400_000);

/** Validade do contrato e uso do limite de declarações (o servidor bloqueia a criação acima do limite). */
function ContractUsage() {
  const q = useApi<ContractStatus>(['contracts', 'status'], '/office/contracts/status');
  const s = q.data;
  if (!s || !s.hasContracts) return null;
  const expiring = s.activeExpiresAt !== null && daysUntil(s.activeExpiresAt) <= 15;
  return (
    <Card title="Uso do contrato">
      <div className="vf-stack">
        {s.blocked ? (
          <Alert tone="danger" title={s.nextStartsAt ? `O pacote começa em ${formatDate(s.nextStartsAt)}` : `Contrato vencido${s.lastExpiresAt ? ` em ${formatDate(s.lastExpiresAt)}` : ''}`}>
            Não é possível criar novas declarações até haver um pacote vigente. As declarações já criadas continuam disponíveis. Para renovar, fale com o suporte do Verifco.
          </Alert>
        ) : (
          expiring &&
          s.activeExpiresAt && (
            <Alert tone="warning" title={`O pacote vence em ${formatDate(s.activeExpiresAt)}`}>
              Depois do vencimento, novas declarações ficam bloqueadas até a renovação. Fale com o suporte do Verifco para renovar.
            </Alert>
          )
        )}
        {s.quotas.map((u) => {
          const pct = u.limit ? Math.round((u.used / u.limit) * 100) : 0;
          const full = u.limit !== null && u.used >= u.limit;
          return (
            <div key={u.year} className="vf-stack" style={{ '--gap': '6px' } as React.CSSProperties}>
              <div className="vf-inline">
                <span className="vf-text-sm-bold vf-grow">Declarações do exercício {u.year}</span>
                <span className="vf-text-sm">{u.limit === null ? `${u.used.toLocaleString('pt-BR')} (ilimitado)` : `${u.used.toLocaleString('pt-BR')} de ${u.limit.toLocaleString('pt-BR')}`}</span>
              </div>
              {u.limit !== null && <Progress value={pct} />}
              {full ? (
                <Alert tone="danger">Limite atingido: o sistema não cria novas declarações do exercício {u.year}. Para ampliar o pacote, fale com o suporte do Verifco.</Alert>
              ) : (
                u.limit !== null && pct >= 90 && <Alert tone="warning">Restam {u.remaining} declaração(ões) no pacote do exercício {u.year}.</Alert>
              )}
            </div>
          );
        })}
        <span className="vf-text-xs vf-muted">
          Contam as declarações do exercício do pacote (de clientes não excluídos). Declarações de outros exercícios, como retificar o ano anterior, não consomem o limite, mas também precisam de
          um pacote vigente.
        </span>
      </div>
    </Card>
  );
}

/** Aba Contratos: pacotes e licenças contratados pelo escritório (somente consulta). */
export function ContractsTab() {
  const list = useApi<ContractRow[]>(['contracts'], '/office/contracts');
  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <ContractUsage />
      <Card flush title="Pacotes e licenças">
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div style={{ padding: 16 }}>
            <Alert tone="danger" title="Não foi possível carregar os contratos." />
          </div>
        ) : !list.data?.length ? (
          <EmptyState icon={<FileText />} title="Nenhum pacote contratado" description="Fale com o suporte do Verifco para contratar um pacote de declarações." />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Pacote</th>
                  <th>Início</th>
                  <th>Expiração</th>
                  <th>Exercício</th>
                  <th className="num">Declarações</th>
                  <th>Backup</th>
                  <th>Situação</th>
                  <th className="actions">Termo</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((c) => {
                  const s = situation(c);
                  return (
                    <tr key={c.id}>
                      <td>
                        <div className="adm-person__text">
                          <span className="vf-text-sm-bold">{c.name}</span>
                          <span className="vf-text-xs vf-muted">Plano {PLANS[c.plan] ?? c.plan}</span>
                        </div>
                      </td>
                      <td>{formatDate(c.startsAt)}</td>
                      <td>{formatDate(c.expiresAt)}</td>
                      <td>{c.year}</td>
                      <td className="num">{c.declarationLimit === null ? 'Ilimitado' : c.declarationLimit.toLocaleString('pt-BR')}</td>
                      <td>{c.hasBackup ? <Tag tone="success">Incluído</Tag> : <span className="vf-muted">Não</span>}</td>
                      <td>
                        <Tag tone={s.tone}>{s.label}</Tag>
                      </td>
                      <td className="actions">
                        {c.termsUrl && /^https?:\/\//i.test(c.termsUrl) ? (
                          <a href={c.termsUrl} target="_blank" rel="noreferrer noopener" className="vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
                            Ver termo <ExternalLink size={14} />
                          </a>
                        ) : (
                          <span className="vf-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <span className="vf-text-xs vf-muted">Os pacotes são contratados com a equipe Verifco. Para renovar ou ampliar o limite de declarações, fale com o suporte.</span>
    </div>
  );
}
