import { useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router';
import { CheckCircle2, FileText, HandCoins, Landmark, Scale, Wallet } from 'lucide-react';
import { DEPENDENT_RELATIONSHIPS } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, EmptyState, Loading, Tag } from '../../ds';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDate, formatMoney, procurationLabel, procurationTone, stageLabel, stageTone, substatusLabel } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { BarList, type Datum } from './charts';
import { dateOnly, ecacLabel, ecacTone, type Declaration } from './data';
import './declarations.css';

interface CustomerDashboard {
  year: number;
  declaration: Declaration;
  customer: { procurationStatus: string; procurationExpiresAt: string | null; procuratorName: string | null; cndStatus: string };
  itemCount: number;
  cash: { balanceCents: number; status: string; totalSourcesCents: number; totalUsesCents: number } | null;
  netWorth: { assetsPrevCents: number; assetsCents: number; debtsPrevCents: number; debtsCents: number; variationCents: number } | null;
  health: number;
  education: number;
  dependents: { id: string; name: string; relationship: string | null }[];
  assetsByGroup: { key: string; label: string; cents: number }[];
  backlogs: { open: number; overdue: number };
  darfs: { total: number; paid: number; overdue: number; open: number; openCents: number };
}

/** Aba inicial do perfil: resumo da declaração do cliente no exercício. */
export function CustomerDashboardTab() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const q = useApi<CustomerDashboard>(['customer-dashboard', customer.id, year], `/customers/${customer.id}/dashboard?year=${year}`);
  const finish = useAction(() => api.post(`/declarations/${q.data!.declaration.id}/finish`), {
    success: 'Declaração finalizada.',
    invalidate: [['customer-dashboard', customer.id], ['declaration', customer.id], ['kanban'], ['dashboard']],
    onSuccess: () => setConfirm(false),
  });

  if (q.isLoading) return <Loading />;
  if (q.error instanceof ApiError && q.error.status === 403) {
    return (
      <Card>
        <EmptyState title="Painel indisponível" description="Seu perfil não tem acesso à declaração deste cliente." />
      </Card>
    );
  }
  if (q.error || !q.data) return <Alert tone="danger">Não foi possível carregar o painel do cliente.</Alert>;
  const d = q.data;
  const decl = d.declaration;
  const irpf = (step: string) => `/clientes/${customer.id}/irpf/${step}`;

  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as CSSProperties}>
      <div className="vf-inline vf-between">
        <div>
          <h2 className="vf-text-lg">Exercício {year}</h2>
          <span className="vf-muted">Ano-calendário {year - 1}</span>
        </div>
        {can('declaration.finish') && decl.exists && (
          <Button icon={<CheckCircle2 />} disabled={decl.stage === 'finished'} onClick={() => setConfirm(true)}>
            {decl.stage === 'finished' ? 'Declaração finalizada' : 'Finalizar declaração'}
          </Button>
        )}
      </div>

      <div className="vf-status-row">
        <Card>
          <div className="vf-status">
            <span className="vf-status__label">Declaração</span>
            <span>
              <Tag tone={stageTone(decl.stage)}>{substatusLabel(decl.substatus)}</Tag>
            </span>
            <span className="vf-text-xs vf-muted">
              {stageLabel(decl.stage)}
              {decl.finishedAt ? ` · finalizada em ${formatDate(decl.finishedAt)}` : ''}
            </span>
          </div>
        </Card>
        <Card>
          <div className="vf-status">
            <span className="vf-status__label">Situação no eCAC</span>
            <span>
              <Tag tone={ecacTone(decl.ecacStatus)}>{decl.transmittedAt || decl.receiptNumber ? ecacLabel(decl.ecacStatus) : 'Não transmitida'}</Tag>
            </span>
            <span className="vf-text-xs vf-muted">
              {decl.transmittedAt ? `Transmitida em ${formatDate(dateOnly(decl.transmittedAt))}` : 'Sem data de transmissão'}
              {decl.receiptNumber ? ` · recibo ${decl.receiptNumber}` : ''}
            </span>
          </div>
        </Card>
        <Card>
          <div className="vf-status">
            <span className="vf-status__label">Procuração</span>
            <span>
              <Tag tone={procurationTone(d.customer.procurationStatus)}>{procurationLabel(d.customer.procurationStatus)}</Tag>
            </span>
            <span className="vf-text-xs vf-muted">
              {d.customer.procuratorName ?? 'Sem procurador'}
              {d.customer.procurationExpiresAt ? ` · vence em ${formatDate(d.customer.procurationExpiresAt)}` : ''}
            </span>
          </div>
        </Card>
      </div>

      {!decl.exists ? (
        <Card>
          <EmptyState
            icon={<FileText />}
            title={`Declaração ${year} ainda não iniciada`}
            description="Lance o resumo e as fichas da declaração na aba IRPF para ver caixa, imposto e patrimônio aqui."
            action={<Button onClick={() => navigate(irpf('declaracao'))}>Abrir declaração</Button>}
          />
        </Card>
      ) : (
        <>
          <div className="vf-kpis">
            <div className="vf-kpi">
              <span className="vf-kpi__label">
                <Wallet /> Saldo de caixa
              </span>
              {d.cash ? (
                <span className={`vf-kpi__value${d.cash.balanceCents < 0 ? ' vf-kpi__value--danger' : ''}`}>{formatMoney(d.cash.balanceCents)}</span>
              ) : (
                <span className="vf-kpi__value vf-muted" style={{ fontSize: 20 }}>
                  Sem lançamentos
                </span>
              )}
              <span className="vf-kpi__hint">
                {d.cash && d.cash.balanceCents < 0 ? 'Aplicações maiores que os recursos. ' : ''}
                <Link to={irpf('declaracao')}>Ver análise de caixa</Link>
              </span>
            </div>
            <div className="vf-kpi">
              <span className="vf-kpi__label">
                {decl.refundCents > 0 ? <HandCoins /> : <Landmark />} Imposto
              </span>
              <span className={`vf-kpi__value${decl.taxDueCents > 0 ? ' vf-kpi__value--danger' : decl.refundCents > 0 ? ' vf-kpi__value--success' : ''}`}>
                {formatMoney(decl.taxDueCents > 0 ? decl.taxDueCents : decl.refundCents)}
              </span>
              <span className="vf-kpi__hint">
                {decl.taxDueCents > 0 ? 'a pagar' : decl.refundCents > 0 ? 'a restituir' : 'sem imposto a pagar ou restituir'}
                {d.darfs.total > 0 && (
                  <>
                    {' · '}
                    <Link to={irpf('darf')}>
                      {d.darfs.open} quota(s) em aberto{d.darfs.overdue ? `, ${d.darfs.overdue} vencida(s)` : ''}
                    </Link>
                  </>
                )}
              </span>
            </div>
            <div className="vf-kpi">
              <span className="vf-kpi__label">
                <Scale /> Variação patrimonial
              </span>
              <span className={`vf-kpi__value${(d.netWorth?.variationCents ?? 0) < 0 ? ' vf-kpi__value--danger' : ''}`}>{formatMoney(d.netWorth?.variationCents ?? 0)}</span>
              <span className="vf-kpi__hint">
                Patrimônio líquido de {formatMoney((d.netWorth?.assetsPrevCents ?? 0) - (d.netWorth?.debtsPrevCents ?? 0))} para{' '}
                {formatMoney((d.netWorth?.assetsCents ?? 0) - (d.netWorth?.debtsCents ?? 0))}
              </span>
            </div>
          </div>

          <div className="vf-grid" style={{ alignItems: 'start' }}>
            <Card title="Detalhes">
              <dl className="vf-dl">
                <dt>Despesas com saúde</dt>
                <dd>{formatMoney(d.health)}</dd>
                <dt>Despesas com educação</dt>
                <dd>{formatMoney(d.education)}</dd>
                <dt>Rendimentos tributáveis</dt>
                <dd>{formatMoney(decl.taxableIncomeCents)}</dd>
                <dt>Rendimentos isentos</dt>
                <dd>{formatMoney(decl.exemptIncomeCents)}</dd>
                <dt>Tributação</dt>
                <dd>{decl.taxation === 'complete' ? 'Completa' : decl.taxation === 'simplified' ? 'Simplificada' : 'Não definida'}</dd>
                <hr />
                <dt>Dependentes</dt>
                <dd>{d.dependents.length}</dd>
                {d.dependents.map((dep) => (
                  <dt key={dep.id} className="vf-text-xs vf-muted" style={{ gridColumn: '1 / -1', paddingLeft: 12 }}>
                    {dep.name}
                    {dep.relationship ? ` · ${DEPENDENT_RELATIONSHIPS[dep.relationship as keyof typeof DEPENDENT_RELATIONSHIPS] ?? dep.relationship}` : ''}
                  </dt>
                ))}
                <hr />
                <dt>Documentos faltantes em aberto</dt>
                <dd>
                  <Link to={irpf('pendencias')} className={d.backlogs.overdue ? 'vf-danger-text' : undefined}>
                    {d.backlogs.open}
                    {d.backlogs.overdue ? ` (${d.backlogs.overdue} atrasado(s))` : ''}
                  </Link>
                </dd>
              </dl>
            </Card>
            <Card title="Bens e direitos" actions={<span className="vf-muted vf-text-sm">{formatMoney(decl.assetsTotalCents)}</span>}>
              {d.assetsByGroup.length ? (
                <BarList
                  ariaLabel="Bens e direitos por grupo"
                  data={d.assetsByGroup.map((g): Datum => ({ key: g.key, label: g.label, value: g.cents, display: formatMoney(g.cents) }))}
                />
              ) : (
                <EmptyState title="Nenhum bem lançado" description="Os bens lançados na declaração aparecem aqui agrupados." />
              )}
            </Card>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirm}
        title="Finalizar declaração"
        message={`A declaração ${year} de ${customer.name} vai para a etapa "Finalizado" no Kanban. Você pode reabri-la depois alterando o status.`}
        confirmLabel="Finalizar"
        loading={finish.isPending}
        onConfirm={() => finish.mutate(undefined)}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}
