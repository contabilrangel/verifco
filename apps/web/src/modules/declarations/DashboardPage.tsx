import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarX2,
  CheckCircle2,
  ChevronRight,
  Columns3,
  FileCheck2,
  FileText,
  HandCoins,
  Landmark,
  Rocket,
  ScanSearch,
  Send,
  TrendingUp,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { Alert, Button, Card, Drawer, EmptyState, IconButton, Loading } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { formatMoney } from '../../lib/format';
import { useYear } from '../../lib/year';
import { BarList, ChartCard, Donut, NEUTRAL, SERIES, StackedBar, type Datum } from './charts';
import './declarations.css';

interface Slice {
  key: string;
  label: string;
  count: number;
  cents?: number;
}

interface AlertData {
  key: 'negative_cash' | 'fine_mesh' | 'darf_overdue' | 'irpfm';
  label: string;
  count: number;
  customers: { id: string; name: string; valueCents: number }[];
}

interface DashboardData {
  year: number;
  indicators: {
    activeCustomers: number;
    declarations: number;
    transmitted: number;
    finished: number;
    taxDueCents: number;
    refundCents: number;
    taxDueCount: number;
    refundCount: number;
  };
  alerts: AlertData[];
  charts: {
    procurations: Slice[];
    procuratorLogin: {
      total: number;
      byAuthType: Slice[];
      byAccess: Slice[];
      loginOk: number;
      loginError: number;
      certificatesExpired: number;
      unverified: number;
      serpro: { state: 'ok' | 'error' | null; at: string | null; error: string | null };
    };
    ecac: Slice[];
    stages: Slice[];
    cnd: Slice[];
    taxation: Slice[];
    budgets: Slice[];
    assets: Slice[];
  };
}

const WELCOME_KEY = 'verifco.dashboard.welcomeDismissed';
const compactMoney = (cents: number) =>
  Math.abs(cents) >= 1_000_000 ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100) : formatMoney(cents);
/** Indicador: valor exato até R$ 10 milhões, compacto acima disso. */
const kpiMoney = (cents: number) => (Math.abs(cents) >= 1_000_000_000 ? compactMoney(cents) : formatMoney(cents));
const fmtInt = (n: number) => n.toLocaleString('pt-BR');
const share = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '—');

/** Cor fixa por etapa (a mesma lógica das tags de etapa). */
const STAGE_COLOR: Record<string, string> = { not_started: NEUTRAL, negotiation: SERIES[3], filling: SERIES[2], transmitted: SERIES[0], finished: SERIES[1] };

const counts = (list: Slice[]): Datum[] => list.map((s) => ({ key: s.key, label: s.label, value: s.count }));
const nonZero = (list: Datum[]) => list.filter((d) => d.value > 0);

/** Cores da situação do acesso dos procuradores (verde = em ordem, vermelho = precisa de ação). */
const ACCESS_COLOR: Record<string, string> = {
  serpro_ok: 'var(--color-green-90)',
  valid: 'var(--color-green-70)',
  expiring: 'var(--color-yellow-80)',
  expired: 'var(--color-red-70)',
  missing: 'var(--color-red-60)',
  serpro_error: 'var(--color-red-80)',
  unverified: NEUTRAL,
};

function readDismissed() {
  try {
    return localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    return false;
  }
}

export function DashboardPage() {
  const { me, can } = useAuth();
  const { year } = useYear();
  const navigate = useNavigate();
  const [welcome, setWelcome] = useState(() => !readDismissed());
  const [openAlert, setOpenAlert] = useState<AlertData | null>(null);
  const q = useApi<DashboardData>(['dashboard', year], `/dashboard?year=${year}`);

  const dismiss = () => {
    setWelcome(false);
    try {
      localStorage.setItem(WELCOME_KEY, '1');
    } catch {
      /* navegação privada */
    }
  };

  const header = (
    <PageHeader
      title="Dashboard"
      description={`Olá, ${me?.user.name.split(' ')[0] ?? ''}. Este é o retrato da carteira no exercício ${year} (ano-calendário ${year - 1}).`}
      actions={
        <Button kind="secondary" icon={<Columns3 />} onClick={() => navigate('/kanban')}>
          Abrir Kanban
        </Button>
      }
    />
  );

  if (q.isLoading) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (q.error) {
    const forbidden = q.error instanceof ApiError && q.error.status === 403;
    return (
      <>
        {header}
        {forbidden ? (
          <Card>
            <EmptyState title="Indicadores indisponíveis" description="Seu perfil não tem acesso aos indicadores da carteira. Fale com o administrador do escritório." />
          </Card>
        ) : (
          <Alert tone="danger" title="Não foi possível carregar o dashboard.">
            Tente atualizar a página.
          </Alert>
        )}
      </>
    );
  }
  const d = q.data!;
  const ind = d.indicators;
  const charts = d.charts;
  const stageData: Datum[] = charts.stages.map((s) => ({ key: s.key, label: s.label, value: s.count, color: STAGE_COLOR[s.key] }));
  const taxationData: Datum[] = charts.taxation.map((s, i) => ({ key: s.key, label: s.label, value: s.count, color: s.key === 'none' ? NEUTRAL : SERIES[i] }));
  const login = charts.procuratorLogin;
  const loginData: Datum[] = login.byAccess.map((s) => ({ key: s.key, label: s.label, value: s.count, color: ACCESS_COLOR[s.key] ?? NEUTRAL }));
  const authSummary = login.byAuthType
    .filter((s) => s.count > 0)
    .map((s) => `${fmtInt(s.count)} ${s.label.toLowerCase()}`)
    .join(' · ');
  const budgetData: Datum[] = charts.budgets.map((s) => ({ key: s.key, label: s.label, value: s.count, display: `${fmtInt(s.count)} · ${compactMoney(s.cents ?? 0)}`, detail: formatMoney(s.cents ?? 0) }));
  const assetData: Datum[] = charts.assets.map((s) => ({ key: s.key, label: s.label, value: s.cents ?? 0, display: compactMoney(s.cents ?? 0), detail: `${fmtInt(s.count)} bem(ns)` }));
  const totalAssets = assetData.reduce((a, x) => a + x.value, 0);

  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as CSSProperties}>
      {header}

      {welcome && (
        <Card className="vf-welcome-card">
          <div className="vf-welcome">
            <div className="vf-empty__icon" style={{ width: 48, height: 48 }}>
              <Rocket />
            </div>
            <div className="vf-grow">
              <div className="vf-inline vf-between">
                <strong className="vf-text-md-bold">Primeiros passos</strong>
                <IconButton label="Fechar dicas" onClick={dismiss}>
                  <X />
                </IconButton>
              </div>
              <ol className="vf-text-sm">
                <li>
                  Cadastre ou <Link to="/importacoes/novos-clientes">importe seus clientes</Link> em lote.
                </li>
                <li>
                  Crie grupos e associe procuradores em <Link to="/admin">Administração</Link>.
                </li>
                <li>Abra o cliente e, na aba IRPF, lance o resumo e as fichas da declaração.</li>
                <li>
                  Acompanhe cada declaração pelo <Link to="/kanban">Kanban</Link>, arrastando entre as etapas.
                </li>
              </ol>
              <Button kind="tertiary" size="sm" onClick={dismiss} style={{ marginTop: 8, marginLeft: -12 }}>
                Não mostrar novamente
              </Button>
            </div>
          </div>
        </Card>
      )}

      <section aria-labelledby="dash-ind" className="vf-stack">
        <h2 id="dash-ind" className="vf-section-title">
          Desempenho
        </h2>
        <div className="vf-dec-kpis vf-dec-kpis--6">
          <Kpi icon={<Users />} label="Clientes ativos" value={fmtInt(ind.activeCustomers)} />
          <Kpi icon={<FileText />} label="Declarações" value={fmtInt(ind.declarations)} hint="iniciadas no exercício" />
          <Kpi icon={<Send />} label="Transmitidas" value={fmtInt(ind.transmitted)} hint={`${share(ind.transmitted, ind.declarations)} das declarações`} />
          <Kpi icon={<FileCheck2 />} label="Finalizadas" value={fmtInt(ind.finished)} hint={`${share(ind.finished, ind.declarations)} das declarações`} />
          <Kpi icon={<Landmark />} label="Imposto a pagar" value={kpiMoney(ind.taxDueCents)} title={formatMoney(ind.taxDueCents)} hint={`${fmtInt(ind.taxDueCount)} cliente(s)`} tone={ind.taxDueCents > 0 ? 'danger' : undefined} />
          <Kpi icon={<HandCoins />} label="A restituir" value={kpiMoney(ind.refundCents)} title={formatMoney(ind.refundCents)} hint={`${fmtInt(ind.refundCount)} cliente(s)`} tone={ind.refundCents > 0 ? 'success' : undefined} />
        </div>
      </section>

      <section aria-labelledby="dash-alerts" className="vf-stack">
        <h2 id="dash-alerts" className="vf-section-title">
          Alertas
        </h2>
        <div className="vf-alerts">
          {d.alerts.map((a) => (
            <AlertCard key={a.key} alert={a} onOpen={() => setOpenAlert(a)} />
          ))}
        </div>
      </section>

      <section aria-labelledby="dash-info" className="vf-stack">
        <h2 id="dash-info" className="vf-section-title">
          Informações
        </h2>
        <div className="vf-charts">
          <ChartCard
            title="Declarações (interno)"
            subtitle="Etapa de cada cliente no Kanban"
            data={stageData}
            chart={<StackedBar data={stageData} ariaLabel="Declarações por etapa" />}
            footer={
              <Link to="/kanban" className="vf-inline" style={{ '--gap': '4px' } as CSSProperties}>
                Ver no Kanban <ChevronRight size={14} />
              </Link>
            }
          />
          <ChartCard
            title="Situação eCAC"
            subtitle="Declarações transmitidas"
            data={counts(charts.ecac)}
            empty="Aparece quando houver declarações transmitidas."
            chart={<BarList data={nonZero(counts(charts.ecac))} ariaLabel="Declarações transmitidas por situação no eCAC" />}
          />
          <ChartCard
            title="Situação das procurações"
            subtitle="Clientes ativos"
            data={counts(charts.procurations)}
            chart={<BarList data={nonZero(counts(charts.procurations))} ariaLabel="Clientes ativos por situação da procuração" />}
          />
          <ChartCard
            title="Acesso dos procuradores"
            subtitle="Certificado digital e último uso no SERPRO"
            data={loginData}
            empty="Cadastre procuradores em Administração."
            chart={<Donut data={nonZero(loginData)} ariaLabel="Procuradores por situação do acesso" centerLabel="procuradores" />}
            footer={
              login.total > 0 && (
                <span className="vf-stack" style={{ '--gap': '2px' } as CSSProperties}>
                  <span>
                    {fmtInt(login.loginError)} precisa(m) de atenção · {fmtInt(login.certificatesExpired)} certificado(s) vencido(s)
                    {login.serpro.state === 'error' && login.serpro.error ? ` · SERPRO: ${login.serpro.error}` : ''}
                  </span>
                  <span className="vf-muted">
                    {authSummary}
                    {login.unverified > 0 && ` · ${fmtInt(login.unverified)} sem verificação (login gov.br no navegador ou certificado sem validade informada)`}
                  </span>
                </span>
              )
            }
          />
          <ChartCard title="CND" subtitle="Certidão negativa dos clientes ativos" data={counts(charts.cnd)} chart={<BarList data={nonZero(counts(charts.cnd))} ariaLabel="Clientes ativos por situação da CND" />} />
          <ChartCard
            title="Tributação"
            subtitle="Opção de tributação das declarações"
            data={taxationData}
            empty="Aparece quando as declarações forem iniciadas."
            chart={<Donut data={taxationData} ariaLabel="Declarações por tipo de tributação" centerLabel="declarações" />}
          />
          <ChartCard
            title="Orçamentos"
            subtitle="Quantidade e valor por situação"
            data={budgetData}
            detailHeader="Valor"
            empty="Nenhum orçamento no exercício."
            chart={<BarList data={nonZero(budgetData)} ariaLabel="Orçamentos por situação" />}
          />
          <ChartCard
            title="Bens e direitos"
            subtitle={totalAssets > 0 ? `Soma por grupo · total ${compactMoney(totalAssets)}` : 'Soma por grupo'}
            data={assetData}
            valueHeader="Valor"
            detailHeader="Itens"
            empty="Lance os bens nas declarações para ver a distribuição."
            chart={<BarList data={nonZero(assetData)} ariaLabel="Bens e direitos por grupo" />}
          />
        </div>
      </section>

      <Drawer open={Boolean(openAlert)} title={openAlert?.label ?? ''} onClose={() => setOpenAlert(null)}>
        {openAlert && <AlertCustomers alert={openAlert} canOpen={can('customer.list')} onNavigate={() => setOpenAlert(null)} />}
      </Drawer>
    </div>
  );
}

function Kpi({ icon, label, value, hint, tone, title }: { icon: ReactNode; label: string; value: string; hint?: string; tone?: 'danger' | 'success'; title?: string }) {
  return (
    <div className="vf-dec-kpi">
      <span className="vf-dec-kpi__label">
        {icon}
        {label}
      </span>
      <span className={`vf-dec-kpi__value${tone ? ` vf-dec-kpi__value--${tone}` : ''}`} title={title}>
        {value}
      </span>
      {hint && <span className="vf-dec-kpi__hint">{hint}</span>}
    </div>
  );
}

const ALERT_META: Record<AlertData['key'], { icon: ReactNode; tone: 'danger' | 'warning'; help: string }> = {
  negative_cash: { icon: <Wallet />, tone: 'danger', help: 'A análise de caixa indica mais aplicações do que recursos no ano.' },
  fine_mesh: { icon: <ScanSearch />, tone: 'danger', help: 'Declarações retidas em malha ou com pendências no eCAC.' },
  darf_overdue: { icon: <CalendarX2 />, tone: 'danger', help: 'Quotas do imposto vencidas e sem pagamento registrado.' },
  irpfm: { icon: <TrendingUp />, tone: 'warning', help: 'Rendimentos totais acima do limite da tributação mínima (IRPFM).' },
};

function AlertCard({ alert, onOpen }: { alert: AlertData; onOpen: () => void }) {
  const meta = ALERT_META[alert.key];
  const active = alert.count > 0;
  return (
    <button type="button" className={`vf-alert-card${active ? ` vf-alert-card--${meta.tone}` : ''}`} onClick={onOpen} disabled={!active} title={meta.help}>
      <span className="vf-alert-card__icon">{active ? meta.icon : <CheckCircle2 />}</span>
      <span className="vf-stack vf-grow" style={{ '--gap': '0px' } as CSSProperties}>
        <span className="vf-alert-card__count">{active ? `${fmtInt(alert.count)} cliente(s)` : 'Nenhum'}</span>
        <span className="vf-alert-card__label">{alert.label}</span>
      </span>
      {active && <ChevronRight size={18} color="var(--color-text-low)" />}
    </button>
  );
}

function AlertCustomers({ alert, canOpen, onNavigate }: { alert: AlertData; canOpen: boolean; onNavigate: () => void }) {
  const meta = ALERT_META[alert.key];
  const withValue = alert.key !== 'fine_mesh';
  return (
    <div className="vf-stack">
      <Alert tone={meta.tone === 'danger' ? 'danger' : 'warning'}>{meta.help}</Alert>
      <div className="vf-table-wrap">
        <table className="vf-table">
          <thead>
            <tr>
              <th>Cliente</th>
              {withValue && <th className="num">{alert.key === 'negative_cash' ? 'Saldo' : alert.key === 'darf_overdue' ? 'Em atraso' : 'Rendimentos'}</th>}
            </tr>
          </thead>
          <tbody>
            {alert.customers.map((c) => (
              <tr key={c.id}>
                <td>
                  {canOpen ? (
                    <Link to={`/clientes/${c.id}`} onClick={onNavigate}>
                      {c.name}
                    </Link>
                  ) : (
                    c.name
                  )}
                </td>
                {withValue && <td className={`num${c.valueCents < 0 ? ' vf-danger-text' : ''}`}>{formatMoney(c.valueCents)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {alert.count > alert.customers.length && (
        <span className="vf-muted vf-text-xs">
          Mostrando {alert.customers.length} de {fmtInt(alert.count)} clientes.
        </span>
      )}
      {alert.key === 'fine_mesh' && (
        <span className="vf-inline vf-muted vf-text-xs">
          <AlertTriangle size={14} /> Confira o extrato da declaração no eCAC de cada cliente.
        </span>
      )}
      <span className="vf-inline vf-muted vf-text-xs">
        <BadgeCheck size={14} /> Os dados consideram o exercício selecionado no topo.
      </span>
    </div>
  );
}
