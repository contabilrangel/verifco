import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Compass, Download, FileText, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  COPILOT_ENTRY_KINDS,
  COPILOT_EXPENSE_CATEGORIES,
  COPILOT_INCOME_CATEGORIES,
  type CopilotEntryKind,
  type CopilotIrpfmProjection,
  type CopilotMonth,
} from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, DropFile, EmptyState, IconButton, Input, Loading, Modal, MoneyInput, Progress, Select, Switch, Tabs, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { formatDate, formatMoney } from '../../lib/format';
import { useCustomer } from '../customers/customerContext';
import { AiBadge, ChatPanel, Kpi, SimulationNotice, errorMessage, pct } from './ui';

interface Entry {
  id: string;
  kind: CopilotEntryKind;
  year: number;
  month: number | null;
  category: string | null;
  description: string;
  amountCents: number;
  dueDate: string | null;
  data: Record<string, string | number | boolean | null>;
  overdue?: boolean;
}
interface CopilotData {
  enrolled: boolean;
  limit?: number;
  used?: number;
  year: number;
  month: number;
  overview: { months: CopilotMonth[]; totals: { incomeCents: number; expenseCents: number; balanceCents: number; savingsRatePercent: number | null } };
  budget: { category: string; label: string; limitCents: number; spentCents: number; usedPercent: number | null }[];
  bills: Entry[];
  pendingBills: number;
  insurances: Entry[];
  foreign: Entry[];
  documents: { id: string; fileId: string; filename: string; size: number; createdAt: string }[];
  projection: CopilotIrpfmProjection;
}

const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
type View = 'overview' | 'budget' | 'bills' | 'insurance' | 'irpfm' | 'foreign' | 'documents' | 'chat';

const catLabel = (kind: string, c: string | null) =>
  !c ? '—' : kind === 'income' ? (COPILOT_INCOME_CATEGORIES[c as keyof typeof COPILOT_INCOME_CATEGORIES] ?? c) : (COPILOT_EXPENSE_CATEGORIES[c as keyof typeof COPILOT_EXPENSE_CATEGORIES] ?? c);

export function CopilotTab() {
  const { customer } = useCustomer();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [view, setView] = useState<View>('overview');
  const [editing, setEditing] = useState<Partial<Entry> | null>(null);
  const [removing, setRemoving] = useState<Entry | null>(null);
  const key = ['copilot', customer.id, year, month];
  const q = useApi<CopilotData>(key, `/customers/${customer.id}/copilot?year=${year}&month=${month}`);
  const entries = useApi<Entry[]>(['copilot-entries', customer.id, year, month], q.data?.enrolled ? `/customers/${customer.id}/copilot/entries?year=${year}&month=${month}` : null);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['copilot', customer.id] });
    await qc.invalidateQueries({ queryKey: ['copilot-entries', customer.id] });
  };
  const enable = async () => {
    try {
      await api.post('/copilot/enrollments', { customerId: customer.id });
      toast.success('Copiloto habilitado para o cliente.');
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async () => {
    if (!removing) return;
    try {
      await api.del(`/copilot/entries/${removing.id}`);
      setRemoving(null);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const togglePaid = async (b: Entry) => {
    try {
      await api.put(`/copilot/entries/${b.id}`, { ...pickEntry(b), data: { ...b.data, paid: !b.data.paid } });
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (q.isLoading) return <Loading />;
  if (q.error) return <Alert tone="danger">{errorMessage(q.error)}</Alert>;
  const d = q.data!;

  if (!d.enrolled) {
    return (
      <Card>
        <div className="vf-lock">
          <span className="vf-lock__icon">
            <Lock />
          </span>
          <h2 className="vf-text-lg">Copiloto Financeiro não habilitado para este cliente</h2>
          <p className="vf-muted" style={{ maxWidth: 560 }}>
            O Copiloto organiza receitas, despesas, orçamento, vencimentos, seguros e bens no exterior do cliente, projeta o IRPFM do ano e traz um assistente de IA para
            conversar sobre as finanças. Ele é contratado por cliente, dentro do limite do plano do escritório.
          </p>
          <Tag tone="highlight">
            {d.used ?? 0} de {d.limit ?? 0} clientes habilitados no plano
          </Tag>
          {can('copilot.manage') ? (
            <Button kind="ai" icon={<Compass />} disabled={(d.used ?? 0) >= (d.limit ?? 0)} onClick={() => void enable()}>
              Habilitar para este cliente
            </Button>
          ) : (
            <span className="vf-text-sm vf-muted">Peça a um administrador do escritório para habilitar o cliente em Administração › Copiloto Financeiro.</span>
          )}
        </div>
      </Card>
    );
  }

  const m = d.overview.months[month - 1];
  const maxBar = Math.max(1, ...d.overview.months.map((x) => Math.max(x.incomeCents, x.expenseCents)));
  const p = d.projection;
  const monthEntries = (entries.data ?? []).filter((e) => e.kind === 'income' || e.kind === 'expense');

  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="vf-inline vf-between">
        <div className="vf-inline">
          <Compass size={20} />
          <strong className="vf-text-md-bold">Copiloto Financeiro</strong>
          <Tag tone="highlight">Novo</Tag>
        </div>
        <div className="vf-inline">
          <Select aria-label="Ano" value={String(year)} onChange={(e) => setYear(Number(e.target.value))} options={[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => ({ value: String(y), label: String(y) }))} />
          <Button kind="secondary" onClick={() => navigate(`/clientes/${customer.id}/ia/assessor-financeiro`)}>
            Assessor Financeiro
          </Button>
          <Button icon={<Plus />} onClick={() => setEditing({ kind: view === 'bills' ? 'bill' : view === 'insurance' ? 'insurance' : view === 'foreign' ? 'foreign' : view === 'budget' ? 'budget' : 'income', year, month })}>
            Adicionar lançamento
          </Button>
        </div>
      </div>
      <Tabs
        value={view}
        onChange={setView}
        items={[
          { value: 'overview', label: 'Visão geral' },
          { value: 'budget', label: 'Orçamento' },
          { value: 'bills', label: `Vencimentos${d.pendingBills ? ` (${d.pendingBills})` : ''}` },
          { value: 'insurance', label: 'Seguros' },
          { value: 'irpfm', label: 'IRPFM' },
          { value: 'foreign', label: 'Exterior' },
          { value: 'documents', label: 'Documentos' },
          { value: 'chat', label: <span className="vf-inline" style={{ '--gap': '6px' } as React.CSSProperties}>Copiloto <AiBadge /></span> },
        ]}
      />

      {view === 'overview' && (
        <>
          <Card
            title={`Receitas e despesas de ${year}`}
            actions={
              <span className="vf-inline">
                <span className="vf-adv-legend">
                  <i style={{ background: 'var(--chart-2)' }} /> Receitas
                </span>
                <span className="vf-adv-legend">
                  <i style={{ background: 'var(--chart-5)' }} /> Despesas
                </span>
              </span>
            }
          >
            <div className="vf-bars" role="group" aria-label="Meses">
              {d.overview.months.map((x) => (
                <button key={x.month} type="button" className="vf-bars__col" aria-pressed={x.month === month} onClick={() => setMonth(x.month)} title={`${MONTHS[x.month - 1]}: receitas ${formatMoney(x.incomeCents)}, despesas ${formatMoney(x.expenseCents)}`}>
                  <span className="vf-bars__pair">
                    <span className="vf-bars__bar vf-bars__bar--in" style={{ height: `${(x.incomeCents / maxBar) * 100}%` }} />
                    <span className="vf-bars__bar vf-bars__bar--out" style={{ height: `${(x.expenseCents / maxBar) * 100}%` }} />
                  </span>
                  <span className="vf-bars__label">{MONTHS[x.month - 1]}</span>
                </button>
              ))}
            </div>
          </Card>
          <div className="vf-adv-kpis">
            <Kpi label={`Receitas · ${MONTHS[month - 1]}`} value={formatMoney(m.incomeCents)} hint={`Ano: ${formatMoney(d.overview.totals.incomeCents)}`} />
            <Kpi label={`Despesas · ${MONTHS[month - 1]}`} value={formatMoney(m.expenseCents)} hint={`Ano: ${formatMoney(d.overview.totals.expenseCents)}`} />
            <Kpi label="Saldo do mês" value={<span className={m.balanceCents >= 0 ? 'vf-saving' : 'vf-loss'}>{formatMoney(m.balanceCents)}</span>} hint={`Ano: ${formatMoney(d.overview.totals.balanceCents)}`} />
            <Kpi label="Taxa de poupança" value={pct(m.savingsRatePercent, 1)} hint={`Ano: ${pct(d.overview.totals.savingsRatePercent, 1)}`} strong />
          </div>
          <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
            <Card title="Pendências">
              <div className="vf-stack">
                <span className="vf-text-xl">{d.pendingBills}</span>
                <span className="vf-muted vf-text-sm">vencimento(s) em aberto</span>
                <Button kind="secondary" size="sm" onClick={() => setView('bills')}>
                  Ver vencimentos
                </Button>
              </div>
            </Card>
            <Card title="Seguros e documentos">
              <div className="vf-stack">
                <span className="vf-text-sm">
                  {d.insurances.length} seguro(s) · {d.documents.length} documento(s)
                </span>
                <div className="vf-inline">
                  <Button kind="secondary" size="sm" onClick={() => setView('insurance')}>
                    Ver seguros
                  </Button>
                  <Button kind="secondary" size="sm" onClick={() => setView('documents')}>
                    Ver documentos
                  </Button>
                  <Button kind="tertiary" size="sm" onClick={() => setView('budget')}>
                    Ir para Orçamento
                  </Button>
                </div>
              </div>
            </Card>
            <Card title={`Projeção do IRPFM devido (DAA ${p.declarationYear})`}>
              <div className="vf-stack">
                <span className="vf-text-xl">{formatMoney(p.result.dueCents)}</span>
                <span className="vf-muted vf-text-sm">
                  Base {formatMoney(p.result.baseCents)} · alíquota {pct(p.result.ratePercent)}
                </span>
                <Button kind="secondary" size="sm" onClick={() => setView('irpfm')}>
                  Ver acompanhamento IRPFM
                </Button>
              </div>
            </Card>
          </div>
          <Card flush title={`Lançamentos de ${MONTHS[month - 1]}/${year}`}>
            {entries.isLoading ? (
              <Loading />
            ) : !monthEntries.length ? (
              <EmptyState title="Sem receitas ou despesas neste mês" action={<Button size="sm" icon={<Plus />} onClick={() => setEditing({ kind: 'income', year, month })}>Adicionar lançamento</Button>} />
            ) : (
              <EntryTable rows={monthEntries} onEdit={setEditing} onRemove={setRemoving} />
            )}
          </Card>
        </>
      )}

      {view === 'budget' && (
        <Card flush title={`Orçamento por categoria · ${MONTHS[month - 1]}/${year}`} actions={<Button size="sm" icon={<Plus />} onClick={() => setEditing({ kind: 'budget', year })}>Definir limite</Button>}>
          {!d.budget.length ? (
            <EmptyState title="Sem orçamento definido" description="Defina limites mensais por categoria de despesa." />
          ) : (
            <div className="vf-table-wrap" style={{ marginTop: 16 }}>
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Categoria</th>
                    <th className="num">Limite mensal</th>
                    <th className="num">Gasto no mês</th>
                    <th style={{ width: 220 }}>Uso</th>
                  </tr>
                </thead>
                <tbody>
                  {d.budget.map((b) => (
                    <tr key={b.category}>
                      <td className="vf-text-sm-bold">{b.label}</td>
                      <td className="num">{b.limitCents ? formatMoney(b.limitCents) : '—'}</td>
                      <td className="num">{formatMoney(b.spentCents)}</td>
                      <td>
                        {b.usedPercent === null ? (
                          <span className="vf-muted vf-text-xs">sem limite</span>
                        ) : (
                          <div className="vf-inline" style={{ flexWrap: 'nowrap' }}>
                            <div className="vf-grow">
                              <Progress value={b.usedPercent} />
                            </div>
                            <Tag tone={b.usedPercent > 100 ? 'danger' : b.usedPercent > 80 ? 'warning' : 'success'}>{pct(b.usedPercent, 0)}</Tag>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {view === 'bills' && (
        <Card flush title="Vencimentos">
          {!d.bills.length ? (
            <EmptyState title="Nenhum vencimento cadastrado" description="IPVA, IPTU, faturas, parcelas e outros compromissos com data." />
          ) : (
            <div className="vf-table-wrap" style={{ marginTop: 16 }}>
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Vencimento</th>
                    <th>Descrição</th>
                    <th className="num">Valor</th>
                    <th>Situação</th>
                    <th className="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {d.bills.map((b) => (
                    <tr key={b.id}>
                      <td>{b.dueDate ? formatDate(b.dueDate) : '—'}</td>
                      <td>{b.description}</td>
                      <td className="num">{formatMoney(b.amountCents)}</td>
                      <td>{b.data.paid ? <Tag tone="success">Pago</Tag> : b.overdue ? <Tag tone="danger">Vencido</Tag> : <Tag tone="warning">Em aberto</Tag>}</td>
                      <td className="actions">
                        <Button kind="tertiary" size="sm" onClick={() => void togglePaid(b)}>
                          {b.data.paid ? 'Reabrir' : 'Marcar como pago'}
                        </Button>
                        <IconButton label="Editar" onClick={() => setEditing(b)}>
                          <Pencil />
                        </IconButton>
                        <IconButton label="Excluir" onClick={() => setRemoving(b)}>
                          <Trash2 />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {view === 'insurance' && (
        <SimpleList
          title="Seguros"
          empty="Nenhum seguro cadastrado"
          rows={d.insurances}
          columns={[
            { label: 'Seguro', render: (e) => e.description },
            { label: 'Seguradora', render: (e) => String(e.data.insurer ?? '—') },
            { label: 'Cobertura', render: (e) => (e.data.coverageCents ? formatMoney(Number(e.data.coverageCents)) : '—') },
            { label: 'Renovação', render: (e) => (e.dueDate ? formatDate(e.dueDate) : '—') },
            { label: 'Prêmio anual', render: (e) => formatMoney(e.amountCents), num: true },
          ]}
          onEdit={setEditing}
          onRemove={setRemoving}
        />
      )}

      {view === 'foreign' && (
        <SimpleList
          title="Bens e contas no exterior"
          empty="Nenhum bem no exterior"
          rows={d.foreign}
          columns={[
            { label: 'Descrição', render: (e) => e.description },
            { label: 'País', render: (e) => String(e.data.country ?? '—') },
            { label: 'Moeda', render: (e) => String(e.data.currency ?? '—') },
            { label: 'Valor em reais', render: (e) => formatMoney(e.amountCents), num: true },
          ]}
          onEdit={setEditing}
          onRemove={setRemoving}
          footer="Aplicações financeiras e entidades controladas no exterior seguem a Lei 14.754/2023 (tributação anual de 15%), dedutível do IRPFM."
        />
      )}

      {view === 'irpfm' && (
        <Card title={`Projeção do IRPFM devido (DAA ${p.declarationYear})`}>
          <div className="vf-stack">
            <div className="vf-adv-kpis">
              <Kpi label="Rendimentos projetados" value={formatMoney(p.result.totalIncomeCents)} hint={`${p.monthsWithData} mês(es) com lançamentos`} />
              <Kpi label="Base de cálculo" value={formatMoney(p.result.baseCents)} hint={`Alíquota ${pct(p.result.ratePercent)}`} />
              <Kpi label="IR já devido (estimado)" value={formatMoney(p.regularTaxDueCents + p.exclusiveWithheldCents)} />
              <Kpi label="IRPFM devido" value={formatMoney(p.result.dueCents)} hint={p.dividendWithholdingCents ? `Retenção sobre dividendos ${formatMoney(p.dividendWithholdingCents)}` : undefined} strong />
            </div>
            <div className="vf-table-wrap">
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Categoria</th>
                    <th className="num">Projeção anual</th>
                  </tr>
                </thead>
                <tbody>
                  {p.projectedByCategory.map((c) => (
                    <tr key={c.category}>
                      <td>{c.label}</td>
                      <td className="num">{formatMoney(c.cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Alert tone={p.result.dueCents > 0 ? 'warning' : 'success'}>{p.result.conclusion}</Alert>
            <ul style={{ margin: 0, paddingLeft: 20 }} className="vf-text-sm vf-muted">
              {p.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            <SimulationNotice />
          </div>
        </Card>
      )}

      {view === 'documents' && <CopilotDocuments customerId={customer.id} docs={d.documents} onChange={() => void refresh()} />}

      {view === 'chat' && (
        <Card className="vf-ai-card" title={<span className="vf-inline">Copiloto Financeiro <AiBadge /></span>}>
          <ChatPanel
            customerId={customer.id}
            assistant="copilot"
            year={year + 1}
            shortcuts={['Como está o orçamento deste mês?', 'Quais vencimentos estão próximos?', 'Vou pagar IRPFM no ano que vem?']}
            intro="Converse sobre as finanças do cliente. O copiloto recebe os lançamentos do ano e a projeção do IRPFM."
          />
        </Card>
      )}

      {editing && <EntryModal customerId={customer.id} entry={editing} onClose={() => setEditing(null)} onSaved={() => void refresh()} />}
      <ConfirmDialog open={Boolean(removing)} title="Excluir lançamento" message={`Excluir "${removing?.description}"?`} confirmLabel="Excluir" danger onConfirm={() => void remove()} onClose={() => setRemoving(null)} />
    </div>
  );
}

const pickEntry = (e: Partial<Entry>) => ({
  kind: e.kind,
  year: e.year,
  month: e.month ?? null,
  category: e.category ?? null,
  description: e.description,
  amountCents: e.amountCents ?? 0,
  dueDate: e.dueDate ?? null,
  data: e.data ?? {},
});

function EntryTable({ rows, onEdit, onRemove }: { rows: Entry[]; onEdit: (e: Entry) => void; onRemove: (e: Entry) => void }) {
  return (
    <div className="vf-table-wrap" style={{ marginTop: 16 }}>
      <table className="vf-table">
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Categoria</th>
            <th>Descrição</th>
            <th className="num">Valor</th>
            <th className="actions"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>
                <Tag tone={e.kind === 'income' ? 'success' : 'danger'}>{COPILOT_ENTRY_KINDS[e.kind]}</Tag>
              </td>
              <td className="vf-text-sm">{catLabel(e.kind, e.category)}</td>
              <td>{e.description}</td>
              <td className="num">{formatMoney(e.amountCents)}</td>
              <td className="actions">
                <IconButton label="Editar" onClick={() => onEdit(e)}>
                  <Pencil />
                </IconButton>
                <IconButton label="Excluir" onClick={() => onRemove(e)}>
                  <Trash2 />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SimpleList({
  title,
  empty,
  rows,
  columns,
  onEdit,
  onRemove,
  footer,
}: {
  title: string;
  empty: string;
  rows: Entry[];
  columns: { label: string; render: (e: Entry) => React.ReactNode; num?: boolean }[];
  onEdit: (e: Entry) => void;
  onRemove: (e: Entry) => void;
  footer?: string;
}) {
  return (
    <Card flush title={title}>
      {!rows.length ? (
        <EmptyState title={empty} />
      ) : (
        <div className="vf-table-wrap" style={{ marginTop: 16 }}>
          <table className="vf-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.label} className={c.num ? 'num' : undefined}>
                    {c.label}
                  </th>
                ))}
                <th className="actions"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  {columns.map((c) => (
                    <td key={c.label} className={c.num ? 'num' : undefined}>
                      {c.render(e)}
                    </td>
                  ))}
                  <td className="actions">
                    <IconButton label="Editar" onClick={() => onEdit(e)}>
                      <Pencil />
                    </IconButton>
                    <IconButton label="Excluir" onClick={() => onRemove(e)}>
                      <Trash2 />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {footer && <p className="vf-text-xs vf-muted" style={{ padding: '12px 24px 20px' }}>{footer}</p>}
    </Card>
  );
}

function EntryModal({ customerId, entry, onClose, onSaved }: { customerId: string; entry: Partial<Entry>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [e, setE] = useState<Partial<Entry>>({ month: null, data: {}, amountCents: 0, description: '', ...entry });
  const [busy, setBusy] = useState(false);
  const kind = (e.kind ?? 'income') as CopilotEntryKind;
  const set = (patch: Partial<Entry>) => setE((x) => ({ ...x, ...patch }));
  const setData = (k: string, v: string | number | boolean | null) => setE((x) => ({ ...x, data: { ...(x.data ?? {}), [k]: v } }));
  const cats = kind === 'income' ? COPILOT_INCOME_CATEGORIES : kind === 'expense' || kind === 'budget' ? COPILOT_EXPENSE_CATEGORIES : null;
  const save = async () => {
    setBusy(true);
    try {
      const body = pickEntry({ ...e, kind });
      if (entry.id) await api.put(`/copilot/entries/${entry.id}`, body);
      else await api.post(`/customers/${customerId}/copilot/entries`, body);
      toast.success('Lançamento salvo.');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={entry.id ? 'Editar lançamento' : 'Novo lançamento'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="vf-grid">
        <Select
          label="Tipo"
          value={kind}
          disabled={Boolean(entry.id)}
          onChange={(ev) => set({ kind: ev.target.value as CopilotEntryKind, category: null })}
          options={Object.entries(COPILOT_ENTRY_KINDS).map(([value, label]) => ({ value, label }))}
        />
        {(kind === 'income' || kind === 'expense') && (
          <Select label="Mês" required value={String(e.month ?? '')} placeholder="Selecione" onChange={(ev) => set({ month: ev.target.value ? Number(ev.target.value) : null })} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
        )}
        {cats && <Select label="Categoria" value={e.category ?? ''} placeholder="Selecione" onChange={(ev) => set({ category: ev.target.value || null })} options={Object.entries(cats).map(([value, label]) => ({ value, label }))} span={2} />}
        <Input label="Descrição" required value={e.description ?? ''} onChange={(ev) => set({ description: ev.target.value })} span={2} />
        <MoneyInput
          label={kind === 'budget' ? 'Limite mensal' : kind === 'insurance' ? 'Prêmio anual' : kind === 'foreign' ? 'Valor em reais' : 'Valor'}
          value={e.amountCents ?? 0}
          onChange={(v) => set({ amountCents: v })}
        />
        {(kind === 'bill' || kind === 'insurance') && (
          <Input label={kind === 'bill' ? 'Vencimento' : 'Renovação'} type="date" value={e.dueDate ?? ''} onChange={(ev) => set({ dueDate: ev.target.value || null })} />
        )}
        {kind === 'bill' && (
          <div className="vf-field" style={{ justifyContent: 'flex-end' }}>
            <Switch label="Pago" checked={Boolean(e.data?.paid)} onChange={(v) => setData('paid', v)} />
          </div>
        )}
        {kind === 'insurance' && (
          <>
            <Input label="Seguradora" value={String(e.data?.insurer ?? '')} onChange={(ev) => setData('insurer', ev.target.value)} />
            <MoneyInput label="Cobertura" value={Number(e.data?.coverageCents ?? 0)} onChange={(v) => setData('coverageCents', v)} />
          </>
        )}
        {kind === 'foreign' && (
          <>
            <Input label="País" value={String(e.data?.country ?? '')} onChange={(ev) => setData('country', ev.target.value)} />
            <Input label="Moeda" value={String(e.data?.currency ?? '')} onChange={(ev) => setData('currency', ev.target.value.toUpperCase())} maxLength={3} />
          </>
        )}
      </div>
    </Modal>
  );
}

function CopilotDocuments({ customerId, docs, onChange }: { customerId: string; docs: CopilotData['documents']; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const send = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      await api.upload(`/customers/${customerId}/copilot/documents`, files);
      toast.success('Documento(s) adicionado(s).');
      onChange();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await api.del(`/customers/${customerId}/copilot/documents/${id}`);
      onChange();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card title="Documentos do copiloto">
      <div className="vf-stack">
        <DropFile multiple disabled={busy} onFiles={(f) => void send(f)} title={busy ? 'Enviando...' : 'Adicionar documento (apólices, contratos, extratos)'} />
        {docs.length > 0 && (
          <div className="vf-doc-list">
            {docs.map((d) => (
              <div key={d.id} className="vf-doc-row">
                <FileText size={18} color="var(--color-text-low)" />
                <span className="vf-grow">
                  <span className="vf-text-sm-bold">{d.filename}</span>
                  <span className="vf-text-xs vf-muted"> · {formatDate(d.createdAt)}</span>
                </span>
                <IconButton label="Baixar" onClick={() => void api.download(`/files/${d.fileId}`, d.filename)}>
                  <Download />
                </IconButton>
                <IconButton label="Excluir" onClick={() => void remove(d.id)}>
                  <Trash2 />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
