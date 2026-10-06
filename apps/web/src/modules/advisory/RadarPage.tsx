import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Bitcoin, Briefcase, Building2, Gem, Landmark, Megaphone, Radar, Receipt, RefreshCw, Tractor, TrendingUp, Users } from 'lucide-react';
import { OPPORTUNITY_STATUS, type OpportunityCategory } from '@verifco/shared';
import { Alert, Button, Card, Drawer, EmptyState, Loading, Progress, Select, Tabs, Tag, useToast, type Tone } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { formatCpfCnpj, formatDateTime } from '../../lib/format';
import { useYear } from '../../lib/year';
import { errorMessage } from './ui';

interface RadarCategory {
  category: OpportunityCategory;
  label: string;
  title: string;
  description: string;
  rule: string;
  total: number;
  active: number;
  byStatus: Record<string, number>;
}
interface RadarSummary {
  year: number;
  categories: RadarCategory[];
  lastJob: { id: string; status: string; progress: number; finishedAt: string | null; createdAt: string; error: string | null; result: { declarations?: number } | null } | null;
}
interface Opportunity {
  id: string;
  customerId: string;
  customerName: string;
  cpfCnpj: string;
  category: OpportunityCategory;
  status: keyof typeof OPPORTUNITY_STATUS;
  score: number;
  evidence: { summary?: string };
}

const ICONS: Record<OpportunityCategory, typeof Gem> = {
  high_net_worth: Gem,
  crypto: Bitcoin,
  variable_income: TrendingUp,
  rural: Tractor,
  carne_leao: Receipt,
  company_opening: Briefcase,
  irpfm: Landmark,
  holding: Building2,
};
const STATUS_TONE: Record<string, Tone> = { open: 'primary', in_progress: 'warning', done: 'success', dismissed: 'neutral' };

export function RadarPage() {
  const { can } = useAuth();
  const { year } = useYear();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const allowed = can('radar.view');
  const [polling, setPolling] = useState(false);
  const summary = useApi<RadarSummary>(['radar', year], allowed ? `/radar?year=${year}` : null, { refetchInterval: polling ? 1500 : undefined });
  const [open, setOpen] = useState<RadarCategory | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const job = summary.data?.lastJob;
  const jobRunning = job?.status === 'queued' || job?.status === 'running';

  useEffect(() => {
    setPolling(jobRunning);
    if (!jobRunning && polling) void qc.invalidateQueries({ queryKey: ['radar-opps'] });
  }, [jobRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.post('/radar/refresh', { year });
      setPolling(true);
      await qc.invalidateQueries({ queryKey: ['radar', year] });
      toast.info('Atualizando o Radar com as declarações do exercício...');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };

  const campaign = async (c: RadarCategory) => {
    try {
      const list = await api.get<Opportunity[]>(`/radar/opportunities?year=${year}&category=${c.category}`);
      const ids = [...new Set(list.filter((o) => o.status === 'open' || o.status === 'in_progress').map((o) => o.customerId))];
      if (!ids.length) return toast.info('Nenhum cliente aberto ou em andamento nesta oportunidade.');
      navigate(`/comunicacao/mala-direta?clientes=${ids.join(',')}&template=marketing`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (!allowed) return <EmptyState title="Sem acesso" description="Seu perfil não tem acesso ao Radar de oportunidades." />;

  return (
    <>
      <PageHeader
        title="Radar de oportunidades"
        description={`Clientes com sinais de serviços adicionais nas declarações do exercício ${year} (ano-calendário ${year - 1}).`}
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Radar de oportunidades' }]}
        actions={
          <Button icon={<RefreshCw />} loading={refreshing || jobRunning} onClick={() => void refresh()}>
            Atualizar dados
          </Button>
        }
      />
      <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
        {jobRunning && (
          <Card>
            <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
              <span>Analisando as declarações do exercício {year}...</span>
              <Progress value={job?.progress ?? 0} />
            </div>
          </Card>
        )}
        {job?.status === 'failed' && <Alert tone="danger">A última atualização falhou: {job.error}</Alert>}
        {!job && !summary.isLoading && (
          <Alert tone="primary" title="Radar ainda não calculado neste exercício">
            Clique em “Atualizar dados” para analisar as declarações dos clientes.
          </Alert>
        )}
        {job?.status === 'done' && (
          <span className="vf-muted vf-text-xs">
            Atualizado em {formatDateTime(job.finishedAt)} · {job.result?.declarations ?? 0} declaração(ões) analisada(s)
          </span>
        )}
        {summary.isLoading ? (
          <Loading />
        ) : (
          <div className="vf-grid" style={{ '--cols': 4 } as React.CSSProperties}>
            {(summary.data?.categories ?? []).map((c) => {
              const Icon = ICONS[c.category] ?? Radar;
              return (
                <Card key={c.category} elevated>
                  <div className="vf-radar-card">
                    <div className="vf-inline vf-between">
                      <span className="vf-radar-card__icon">
                        <Icon />
                      </span>
                      <span className="vf-radar-card__count" aria-label={`${c.active} clientes ativos`}>
                        {c.active}
                      </span>
                    </div>
                    <div className="vf-stack" style={{ '--gap': '4px' } as React.CSSProperties}>
                      <strong className="vf-text-md-bold">{c.title}</strong>
                      <span className="vf-text-sm vf-muted">{c.description}</span>
                      <span className="vf-text-xs vf-muted">Regra: {c.rule}</span>
                    </div>
                    <div className="vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
                      {(['open', 'in_progress', 'done', 'dismissed'] as const).map((s) =>
                        c.byStatus[s] ? (
                          <Tag key={s} tone={STATUS_TONE[s]}>
                            {OPPORTUNITY_STATUS[s]}: {c.byStatus[s]}
                          </Tag>
                        ) : null,
                      )}
                    </div>
                    <div className="vf-radar-card__foot">
                      <Button kind="secondary" size="sm" icon={<Users />} disabled={!c.total} onClick={() => setOpen(c)}>
                        Ver clientes
                      </Button>
                      <Button kind="tertiary" size="sm" icon={<Megaphone />} disabled={!c.active} onClick={() => void campaign(c)}>
                        Campanha
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      {open && <OpportunitiesDrawer category={open} year={year} onClose={() => setOpen(null)} onCampaign={() => void campaign(open)} />}
    </>
  );
}

function OpportunitiesDrawer({ category, year, onClose, onCampaign }: { category: RadarCategory; year: number; onClose: () => void; onCampaign: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | keyof typeof OPPORTUNITY_STATUS>('all');
  const key = ['radar-opps', year, category.category];
  const list = useApi<Opportunity[]>(key, `/radar/opportunities?year=${year}&category=${category.category}`);
  const rows = (list.data ?? []).filter((o) => status === 'all' || o.status === status);

  const change = async (o: Opportunity, s: string) => {
    try {
      await api.put(`/radar/opportunities/${o.id}`, { status: s });
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ['radar', year] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Drawer
      open
      title={category.title}
      onClose={onClose}
      width={760}
      footer={
        <Button icon={<Megaphone />} onClick={onCampaign} disabled={!category.active}>
          Campanha para os ativos
        </Button>
      }
    >
      <div className="vf-stack">
        <p className="vf-muted">{category.rule}</p>
        <Tabs
          value={status}
          onChange={setStatus}
          items={[{ value: 'all' as const, label: `Todos (${list.data?.length ?? 0})` }, ...(Object.keys(OPPORTUNITY_STATUS) as (keyof typeof OPPORTUNITY_STATUS)[]).map((s) => ({ value: s, label: OPPORTUNITY_STATUS[s] }))]}
        />
        {list.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState title="Nenhum cliente neste filtro" />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Evidências</th>
                  <th className="num">Pontos</th>
                  <th style={{ width: 170 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/clientes/${o.customerId}`} className="vf-text-sm-bold">
                        {o.customerName}
                      </Link>
                      <div className="vf-text-xs vf-muted vf-mono">{formatCpfCnpj(o.cpfCnpj)}</div>
                    </td>
                    <td className="vf-text-sm">{o.evidence.summary ?? '—'}</td>
                    <td className="num">{o.score}</td>
                    <td>
                      <Select
                        aria-label={`Status de ${o.customerName}`}
                        value={o.status}
                        onChange={(e) => void change(o, e.target.value)}
                        options={Object.entries(OPPORTUNITY_STATUS).map(([value, label]) => ({ value, label }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Drawer>
  );
}
