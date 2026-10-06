import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, FileSpreadsheet, Filter, Play } from 'lucide-react';
import { ECAC_DECLARATION_STATUS, stageOfSubstatus, type DeclarationSubstatus } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, Drawer, EmptyState, Loading, Select, Stat, Tag, useToast } from '../../ds';
import { ApiError, api, qs } from '../../lib/api';
import { formatCpfCnpj, formatDate, formatMoney, stageTone, substatusLabel } from '../../lib/format';
import { YEAR_OPTIONS, useYear } from '../../lib/year';

/**
 * Padrão dos relatórios gerais: filtros num Drawer, estado vazio até gerar,
 * tabela com totais e download em Excel com os mesmos filtros.
 */
function useReport<T>(name: string, path: string) {
  const [applied, setApplied] = useState<Record<string, unknown> | null>(null);
  // cada clique em "Gerar" busca de novo, mesmo com os mesmos filtros
  const [run, setRun] = useState(0);
  const q = useQuery<T, ApiError>({
    queryKey: ['reports', name, applied, run],
    queryFn: () => api.get<T>(`${path}${qs(applied ?? {})}`),
    enabled: applied !== null,
    staleTime: 0,
  });
  return {
    applied,
    generate: (f: Record<string, unknown>) => {
      setApplied({ ...f });
      setRun((n) => n + 1);
    },
    q,
  };
}

function ReportFrame({
  title,
  description,
  filtersOpen,
  setFiltersOpen,
  filters,
  onGenerate,
  onExcel,
  canExcel,
  loading,
  error,
  generated,
  children,
}: {
  title: string;
  description: string;
  filtersOpen: boolean;
  setFiltersOpen: (v: boolean) => void;
  filters: ReactNode;
  onGenerate: () => void;
  onExcel: () => Promise<void>;
  canExcel: boolean;
  loading: boolean;
  error: ApiError | null;
  generated: boolean;
  children: ReactNode;
}) {
  const [downloading, setDownloading] = useState(false);
  const toast = useToast();
  const excel = async () => {
    setDownloading(true);
    try {
      await onExcel();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Falha no download.');
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="vf-inline vf-between" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <h2 className="vf-text-lg">{title}</h2>
          <p className="vf-muted">{description}</p>
        </div>
        <div className="vf-inline">
          <Button kind="secondary" icon={<Filter />} onClick={() => setFiltersOpen(true)}>
            Filtros
          </Button>
          <Button kind="secondary" icon={<FileSpreadsheet />} disabled={!canExcel} loading={downloading} onClick={() => void excel()}>
            Baixar Excel
          </Button>
          <Button icon={<Play />} loading={loading} onClick={onGenerate}>
            Gerar relatório
          </Button>
        </div>
      </div>
      {error && <Alert tone="danger">{error.message}</Alert>}
      {!generated ? (
        <Card>
          <EmptyState icon={<BarChart3 />} title="Nenhum relatório gerado" description="Ajuste os filtros e clique em Gerar relatório." action={<Button kind="secondary" onClick={() => setFiltersOpen(true)}>Abrir filtros</Button>} />
        </Card>
      ) : loading ? (
        <Card>
          <Loading label="Gerando relatório..." />
        </Card>
      ) : (
        children
      )}
      <Drawer
        open={filtersOpen}
        title="Filtros"
        onClose={() => setFiltersOpen(false)}
        footer={
          <Button
            onClick={() => {
              setFiltersOpen(false);
              onGenerate();
            }}
          >
            Gerar relatório
          </Button>
        }
      >
        <div className="vf-stack">{filters}</div>
      </Drawer>
    </div>
  );
}

// ------------------------------------------------------------------ Resultados
interface ResultsData {
  rows: { declarationId: string; customerId: string; name: string; cpfCnpj: string; substatus: string; taxation: string | null; taxDueCents: number; refundCents: number }[];
  totals: { count: number; taxDueCents: number; refundCents: number; payable: number; refundable: number; neutral: number };
}

export function ResultsReport() {
  const { year: globalYear } = useYear();
  const [f, setF] = useState({ year: String(globalYear), payable: false, refundable: false, neutral: false });
  const [open, setOpen] = useState(false);
  const r = useReport<ResultsData>('results', '/reports/results');
  const params = { year: f.year, payable: f.payable || undefined, refundable: f.refundable || undefined, neutral: f.neutral || undefined };
  const d = r.q.data;
  return (
    <ReportFrame
      title="Relatório de resultados"
      description={`Imposto a pagar e a restituir das declarações do exercício ${r.applied?.year ?? f.year}.`}
      filtersOpen={open}
      setFiltersOpen={setOpen}
      onGenerate={() => r.generate(params)}
      onExcel={() => api.download(`/reports/results${qs({ ...(r.applied ?? params), format: 'xlsx' })}`, `resultados-${f.year}.xlsx`)}
      canExcel={Boolean(d)}
      loading={r.q.isFetching}
      error={r.q.error}
      generated={r.applied !== null}
      filters={
        <>
          <Select label="Ano-exercício" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} options={YEAR_OPTIONS} />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="vf-stack">
            <legend className="vf-text-sm-bold" style={{ marginBottom: 8 }}>
              Resultado
            </legend>
            <Checkbox label="A pagar" checked={f.payable} onChange={() => setF({ ...f, payable: !f.payable })} />
            <Checkbox label="A restituir" checked={f.refundable} onChange={() => setF({ ...f, refundable: !f.refundable })} />
            <Checkbox label="Sem pagamento ou restituição" checked={f.neutral} onChange={() => setF({ ...f, neutral: !f.neutral })} />
            <span className="vf-text-xs vf-muted">Sem nenhuma opção marcada, mostra todas. Declarações não iniciadas ficam de fora.</span>
          </fieldset>
        </>
      }
    >
      {d && (
        <>
          <div className="vf-grid" style={{ '--cols': 4 } as React.CSSProperties}>
            <Card>
              <Stat label="Declarações" value={d.totals.count} />
            </Card>
            <Card>
              <Stat label="Imposto a pagar" value={formatMoney(d.totals.taxDueCents)} hint={`${d.totals.payable} declaração(ões)`} tone="danger" />
            </Card>
            <Card>
              <Stat label="Imposto a restituir" value={formatMoney(d.totals.refundCents)} hint={`${d.totals.refundable} declaração(ões)`} tone="success" />
            </Card>
            <Card>
              <Stat label="Sem saldo" value={d.totals.neutral} hint="Sem pagamento nem restituição" />
            </Card>
          </div>
          <Card flush>
            {!d.rows.length ? (
              <EmptyState title="Nenhuma declaração encontrada" description="Revise o ano e as opções dos filtros." />
            ) : (
              <div className="vf-table-wrap">
                <table className="vf-table">
                  <thead>
                    <tr>
                      <th>Cliente</th>
                      <th>CPF/CNPJ</th>
                      <th>Status</th>
                      <th>Tributação</th>
                      <th className="num">A pagar</th>
                      <th className="num">A restituir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((x) => (
                      <tr key={x.declarationId}>
                        <td>
                          <Link to={`/clientes/${x.customerId}/irpf`} className="vf-text-sm-bold">
                            {x.name}
                          </Link>
                        </td>
                        <td className="vf-mono">{formatCpfCnpj(x.cpfCnpj)}</td>
                        <td>
                          <Tag tone={stageTone(stageOfSubstatus(x.substatus as DeclarationSubstatus))}>{substatusLabel(x.substatus)}</Tag>
                        </td>
                        <td className="vf-muted">{x.taxation === 'complete' ? 'Completa' : x.taxation === 'simplified' ? 'Simplificada' : '—'}</td>
                        <td className="num">{x.taxDueCents ? <span className="vf-danger-text">{formatMoney(x.taxDueCents)}</span> : '—'}</td>
                        <td className="num">{x.refundCents ? <span className="vf-success-text">{formatMoney(x.refundCents)}</span> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="vf-text-sm-bold" style={{ padding: '12px 16px' }}>
                        Total ({d.totals.count})
                      </td>
                      <td className="num vf-text-sm-bold" style={{ padding: '12px 16px' }}>
                        {formatMoney(d.totals.taxDueCents)}
                      </td>
                      <td className="num vf-text-sm-bold" style={{ padding: '12px 16px' }}>
                        {formatMoney(d.totals.refundCents)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </ReportFrame>
  );
}

// ------------------------------------------------------------------ Documentos faltantes
interface BacklogsData {
  groups: {
    customerId: string;
    name: string;
    cpfCnpj: string;
    email: string | null;
    mobile: string | null;
    items: { id: string; description: string; dueDate: string | null; createdAt: string; exerciseYear: number; overdueDays: number }[];
  }[];
  totals: { customers: number; items: number; overdue: number };
}

export function BacklogsReport() {
  const { year: globalYear } = useYear();
  const [f, setF] = useState({ year: String(globalYear), overdueOnly: true });
  const [open, setOpen] = useState(false);
  const r = useReport<BacklogsData>('backlogs', '/reports/backlogs');
  const params = { year: f.year || undefined, overdueOnly: f.overdueOnly || undefined };
  const d = r.q.data;
  return (
    <ReportFrame
      title="Documentos faltantes"
      description="Pendências de documentos em aberto, agrupadas por cliente."
      filtersOpen={open}
      setFiltersOpen={setOpen}
      onGenerate={() => r.generate(params)}
      onExcel={() => api.download(`/reports/backlogs${qs({ ...(r.applied ?? params), format: 'xlsx' })}`, 'documentos-faltantes.xlsx')}
      canExcel={Boolean(d)}
      loading={r.q.isFetching}
      error={r.q.error}
      generated={r.applied !== null}
      filters={
        <>
          <Select label="Ano-exercício" placeholder="Todos os exercícios" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} options={YEAR_OPTIONS} />
          <Checkbox label="Exibir somente documentos com data limite vencida" checked={f.overdueOnly} onChange={() => setF({ ...f, overdueOnly: !f.overdueOnly })} />
        </>
      }
    >
      {d && (
        <>
          <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
            <Card>
              <Stat label="Clientes" value={d.totals.customers} />
            </Card>
            <Card>
              <Stat label="Documentos pendentes" value={d.totals.items} />
            </Card>
            <Card>
              <Stat label="Com prazo vencido" value={d.totals.overdue} tone={d.totals.overdue ? 'danger' : undefined} />
            </Card>
          </div>
          <Card flush>
            {!d.groups.length ? (
              <EmptyState title="Nenhuma pendência encontrada" description={r.applied?.overdueOnly ? 'Nenhum documento com data limite vencida.' : 'Todos os documentos foram entregues.'} />
            ) : (
              <div className="vf-table-wrap">
                <table className="vf-table">
                  <thead>
                    <tr>
                      <th>Documento</th>
                      <th>Exercício</th>
                      <th>Criado em</th>
                      <th>Data limite</th>
                      <th>Prazo</th>
                    </tr>
                  </thead>
                  {d.groups.map((g) => (
                    <tbody key={g.customerId}>
                      <tr>
                        <td colSpan={5} style={{ background: 'var(--color-surface-low)' }}>
                          <div className="vf-inline vf-between">
                            <span className="vf-inline">
                              <Link to={`/clientes/${g.customerId}/irpf/pendencias`} className="vf-text-sm-bold">
                                {g.name}
                              </Link>
                              <span className="vf-text-xs vf-muted vf-mono">{formatCpfCnpj(g.cpfCnpj)}</span>
                            </span>
                            <span className="vf-text-xs vf-muted">
                              {g.items.length} documento(s) · {g.email || 'sem e-mail'}
                            </span>
                          </div>
                        </td>
                      </tr>
                      {g.items.map((i) => (
                        <tr key={i.id}>
                          <td style={{ paddingLeft: 32 }}>{i.description}</td>
                          <td>{i.exerciseYear}</td>
                          <td className="vf-muted">{formatDate(i.createdAt)}</td>
                          <td>{i.dueDate ? formatDate(i.dueDate) : '—'}</td>
                          <td>{i.overdueDays > 0 ? <Tag tone="danger">{i.overdueDays} dia(s) de atraso</Tag> : <Tag tone="success">No prazo</Tag>}</td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </ReportFrame>
  );
}

// ------------------------------------------------------------------ Restituição
interface RefundsData {
  rows: { declarationId: string; customerId: string; name: string; cpfCnpj: string; refundCents: number; refundLotDate: string | null; refundPaidAt: string | null; ecacStatus: string; situation: 'paid' | 'released' | 'scheduled' | 'waiting' }[];
  totals: { count: number; refundCents: number; paid: number };
}

const SITUATION = { paid: ['Paga', 'success'], released: ['Lote liberado', 'primary'], scheduled: ['Lote previsto', 'highlight'], waiting: ['Aguardando lote', 'neutral'] } as const;

export function RefundsReport() {
  const { year: globalYear } = useYear();
  const [f, setF] = useState({ year: String(globalYear), futureOnly: false, sort: 'date' as 'date' | 'name' });
  const [open, setOpen] = useState(false);
  const r = useReport<RefundsData>('refunds', '/reports/refunds');
  const params = { year: f.year, futureOnly: f.futureOnly || undefined, sort: f.sort };
  const d = r.q.data;
  return (
    <ReportFrame
      title="Relatório de restituição"
      description="Restituições do exercício com a data do lote. As datas dependem da procuração e dos lotes liberados pela Receita."
      filtersOpen={open}
      setFiltersOpen={setOpen}
      onGenerate={() => r.generate(params)}
      onExcel={() => api.download(`/reports/refunds${qs({ ...(r.applied ?? params), format: 'xlsx' })}`, `restituicoes-${f.year}.xlsx`)}
      canExcel={Boolean(d)}
      loading={r.q.isFetching}
      error={r.q.error}
      generated={r.applied !== null}
      filters={
        <>
          <Select label="Ano-exercício" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} options={YEAR_OPTIONS} />
          <Checkbox label="Apenas restituições futuras (ainda não pagas)" checked={f.futureOnly} onChange={() => setF({ ...f, futureOnly: !f.futureOnly })} />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="vf-stack">
            <legend className="vf-text-sm-bold" style={{ marginBottom: 8 }}>
              Ordenar por
            </legend>
            <label className="vf-check">
              <input type="radio" name="sort" checked={f.sort === 'date'} onChange={() => setF({ ...f, sort: 'date' })} />
              <span>Data do lote</span>
            </label>
            <label className="vf-check">
              <input type="radio" name="sort" checked={f.sort === 'name'} onChange={() => setF({ ...f, sort: 'name' })} />
              <span>Nome do cliente</span>
            </label>
          </fieldset>
        </>
      }
    >
      {d && (
        <>
          <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
            <Card>
              <Stat label="Restituições" value={d.totals.count} />
            </Card>
            <Card>
              <Stat label="Valor total" value={formatMoney(d.totals.refundCents)} tone="success" />
            </Card>
            <Card>
              <Stat label="Já pagas" value={d.totals.paid} />
            </Card>
          </div>
          <Card flush>
            {!d.rows.length ? (
              <EmptyState title="Nenhuma restituição encontrada" description="Revise o ano e as opções dos filtros." />
            ) : (
              <div className="vf-table-wrap">
                <table className="vf-table">
                  <thead>
                    <tr>
                      <th>Cliente</th>
                      <th>CPF/CNPJ</th>
                      <th className="num">Valor</th>
                      <th>Data do lote</th>
                      <th>Situação</th>
                      <th>Status eCAC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((x) => (
                      <tr key={x.declarationId}>
                        <td>
                          <Link to={`/clientes/${x.customerId}/irpf`} className="vf-text-sm-bold">
                            {x.name}
                          </Link>
                        </td>
                        <td className="vf-mono">{formatCpfCnpj(x.cpfCnpj)}</td>
                        <td className="num">{formatMoney(x.refundCents)}</td>
                        <td>{x.refundPaidAt ? formatDate(x.refundPaidAt) : x.refundLotDate ? formatDate(x.refundLotDate) : '—'}</td>
                        <td>
                          <Tag tone={SITUATION[x.situation][1]}>{SITUATION[x.situation][0]}</Tag>
                        </td>
                        <td className="vf-muted">{ECAC_DECLARATION_STATUS[x.ecacStatus as keyof typeof ECAC_DECLARATION_STATUS] ?? x.ecacStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2} className="vf-text-sm-bold" style={{ padding: '12px 16px' }}>
                        Total ({d.totals.count})
                      </td>
                      <td className="num vf-text-sm-bold" style={{ padding: '12px 16px' }}>
                        {formatMoney(d.totals.refundCents)}
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </ReportFrame>
  );
}
