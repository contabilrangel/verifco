import { ExternalLink, FileText } from 'lucide-react';
import { Alert, Card, EmptyState, Loading, Tag, type Tone } from '../../ds';
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

/** Aba Contratos: pacotes e licenças contratados pelo escritório (somente consulta). */
export function ContractsTab() {
  const list = useApi<ContractRow[]>(['contracts'], '/office/contracts');
  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
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
