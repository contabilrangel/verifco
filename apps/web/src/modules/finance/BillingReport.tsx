import { useState } from 'react';
import { Link } from 'react-router';
import { BarChart3, FileSpreadsheet, Filter, Play } from 'lucide-react';
import { BUDGET_CATEGORIES, BUDGET_TYPES } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, Drawer, EmptyState, Loading, Select, Stat, Tag, useToast } from '../../ds';
import { api, qs } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { formatCpfCnpj, formatDateTime, formatMoney } from '../../lib/format';
import { YEAR_OPTIONS, useYear } from '../../lib/year';
import type { BillingReport as Report, PaymentStatus } from './types';
import { BudgetStatusTag, PAYMENT_STATUS, paymentStatusTone } from './ui';

type Filters = {
  year: string;
  category: string;
  responsible: string;
  type: string;
  paymentStatus: string;
  approvedOnly: boolean;
  overdueOnly: boolean;
};

const opts = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ value, label }));

/** Relatórios › Faturamento. */
export function BillingReportPage() {
  const { year } = useYear();
  const toast = useToast();
  const initial: Filters = { year: String(year), category: '', responsible: '', type: '', paymentStatus: '', approvedOnly: false, overdueOnly: false };
  const [draft, setDraft] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters | null>(null);
  const [run, setRun] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState(false);
  const employees = useApi<{ id: string; name: string }[]>(['employees'], '/employees');

  const query = applied ? qs({ ...applied, approvedOnly: applied.approvedOnly || undefined, overdueOnly: applied.overdueOnly || undefined }) : '';
  const report = useApi<Report>(['finance', 'billing-report', query, run], applied ? `/finance/reports/billing${query}` : null);

  const generate = (f: Filters = draft) => {
    setApplied({ ...f });
    setRun((n) => n + 1);
    setShowFilters(false);
  };
  const active = [draft.category, draft.responsible, draft.type, draft.paymentStatus, draft.approvedOnly, draft.overdueOnly].filter(Boolean).length;
  const d = report.data;

  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <Card>
        <div className="vf-inline vf-between">
          <div>
            <h2 className="vf-text-lg">Relatório de faturamento</h2>
            <p className="vf-muted vf-text-sm">
              Orçado, faturado, recebido e em aberto por cliente no exercício {applied?.year ?? draft.year}
              {active ? ` · ${active} filtro(s)` : ''}.
            </p>
          </div>
          <div className="vf-inline">
            <Button kind="secondary" icon={<Filter />} onClick={() => setShowFilters(true)}>
              Filtros{active ? ` (${active})` : ''}
            </Button>
            <Button
              kind="secondary"
              icon={<FileSpreadsheet />}
              disabled={!d || d.data.length === 0}
              loading={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  await api.download(`/finance/reports/billing.xlsx${query}`, `faturamento-${applied?.year}.xlsx`);
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Falha ao exportar.');
                } finally {
                  setExporting(false);
                }
              }}
            >
              Exportar Excel
            </Button>
            <Button icon={<Play />} loading={report.isFetching} onClick={() => generate()}>
              Gerar relatório
            </Button>
          </div>
        </div>
      </Card>

      {!applied ? (
        <Card>
          <EmptyState icon={<BarChart3 />} title="Clique em gerar relatório" description="Ajuste os filtros se quiser e gere o relatório do exercício selecionado." />
        </Card>
      ) : report.isLoading ? (
        <Card>
          <Loading label="Gerando relatório..." />
        </Card>
      ) : report.isError || !d ? (
        <Alert tone="danger" title="Não foi possível gerar o relatório.">
          Tente novamente em instantes.
        </Alert>
      ) : d.data.length === 0 ? (
        <Card>
          <EmptyState title="Nenhum orçamento encontrado" description="Não há orçamentos com esses filtros no exercício. Revise os filtros e gere de novo." />
        </Card>
      ) : (
        <>
          <div className="vf-fin-stats vf-fin-stats--cards">
            <Card>
              <Stat label="Orçado" value={formatMoney(d.totals.budgetedCents)} hint={`${d.data.length} orçamento(s) · ${d.customers} cliente(s)`} />
            </Card>
            <Card>
              <Stat label="Faturado" value={formatMoney(d.totals.billedCents)} />
            </Card>
            <Card>
              <Stat label="Recebido" value={formatMoney(d.totals.receivedCents)} tone="success" />
            </Card>
            <Card>
              <Stat label="Em aberto" value={formatMoney(d.totals.openCents)} />
            </Card>
            <Card>
              <Stat label="Vencido" value={formatMoney(d.totals.overdueCents)} tone={d.totals.overdueCents > 0 ? 'danger' : undefined} />
            </Card>
          </div>
          <Card flush>
            <div className="vf-table-wrap">
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Serviço</th>
                    <th>Orçamento</th>
                    <th>Pagamento</th>
                    <th className="num">Orçado</th>
                    <th className="num">Faturado</th>
                    <th className="num">Recebido</th>
                    <th className="num">Em aberto</th>
                    <th className="num">Vencido</th>
                  </tr>
                </thead>
                <tbody>
                  {d.data.map((r) => (
                    <tr key={r.budgetId}>
                      <td>
                        <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                          <Link to={`/clientes/${r.customerId}/irpf/orcamento`} className="vf-text-sm-bold">
                            {r.customerName}
                          </Link>
                          <span className="vf-text-xs vf-muted">
                            {formatCpfCnpj(r.cpfCnpj)}
                            {r.responsibleName ? ` · ${r.responsibleName}` : ''}
                          </span>
                        </div>
                      </td>
                      <td className="vf-text-sm">
                        {r.categoryLabel}
                        <div className="vf-text-xs vf-muted">
                          {r.paymentMethodName ?? 'Sem forma de pagamento'}
                          {r.installmentsCount > 1 ? ` · ${r.installmentsCount}x` : ''}
                        </div>
                      </td>
                      <td>
                        <BudgetStatusTag status={r.status} />
                      </td>
                      <td>
                        <Tag tone={paymentStatusTone(r.paymentStatus)}>{PAYMENT_STATUS[r.paymentStatus]}</Tag>
                      </td>
                      <td className="num">{formatMoney(r.budgetedCents)}</td>
                      <td className="num">{formatMoney(r.billedCents)}</td>
                      <td className="num vf-success-text">{r.receivedCents ? formatMoney(r.receivedCents) : '—'}</td>
                      <td className="num">{r.openCents ? formatMoney(r.openCents) : '—'}</td>
                      <td className="num vf-danger-text">{r.overdueCents ? formatMoney(r.overdueCents) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="vf-fin-total-row">
                    <td colSpan={4}>Total</td>
                    <td className="num">{formatMoney(d.totals.budgetedCents)}</td>
                    <td className="num">{formatMoney(d.totals.billedCents)}</td>
                    <td className="num">{formatMoney(d.totals.receivedCents)}</td>
                    <td className="num">{formatMoney(d.totals.openCents)}</td>
                    <td className="num">{formatMoney(d.totals.overdueCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="vf-pagination">
              <span className="vf-text-xs vf-muted">Gerado em {formatDateTime(d.generatedAt)}</span>
            </div>
          </Card>
        </>
      )}

      <Drawer
        open={showFilters}
        title="Filtros do relatório"
        onClose={() => setShowFilters(false)}
        footer={
          <>
            <Button kind="secondary" onClick={() => setDraft({ ...initial, year: draft.year })}>
              Limpar
            </Button>
            <Button icon={<Play />} onClick={() => generate()}>
              Gerar relatório
            </Button>
          </>
        }
      >
        <div className="vf-stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          <Select label="Ano-exercício" value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} options={YEAR_OPTIONS} />
          <Select label="Categoria" placeholder="Todas" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} options={opts(BUDGET_CATEGORIES)} />
          <Select
            label="Responsável"
            placeholder="Todos"
            value={draft.responsible}
            onChange={(e) => setDraft({ ...draft, responsible: e.target.value })}
            options={(employees.data ?? []).map((u) => ({ value: u.id, label: u.name }))}
          />
          <Select label="Tipo de faturamento" placeholder="Todos" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} options={opts(BUDGET_TYPES)} />
          <Select
            label="Status do pagamento"
            placeholder="Todos"
            value={draft.paymentStatus}
            onChange={(e) => setDraft({ ...draft, paymentStatus: e.target.value })}
            options={(Object.keys(PAYMENT_STATUS) as PaymentStatus[]).map((k) => ({ value: k, label: PAYMENT_STATUS[k] }))}
          />
          <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
            <Checkbox label="Somente orçamentos aprovados" checked={draft.approvedOnly} onChange={(e) => setDraft({ ...draft, approvedOnly: e.target.checked })} />
            <Checkbox label="Somente clientes com parcelas vencidas" checked={draft.overdueOnly} onChange={(e) => setDraft({ ...draft, overdueOnly: e.target.checked })} />
          </div>
        </div>
      </Drawer>
    </div>
  );
}
