import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarCheck2, CheckCircle2, FileUp, Mail, MessageCircle, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { DARF_MAX_QUOTAS, brazilToday, darfQuotaAmount, lastBusinessDayOfMonth, planDarfQuotas } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, EmptyState, IconButton, Input, Loading, Menu, MenuItem, Modal, MoneyInput, Select, Tag, useToast, type Tone } from '../../ds';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { SEND_STATUS_LABEL, sendTone, useDeclaration } from './data';
import './declarations.css';

interface DarfRow {
  id: string;
  quotaNumber: number;
  valueCents: number;
  dueDate: string;
  status: 'open' | 'paid' | 'overdue';
  paidAt: string | null;
  barcode: string | null;
  source: string;
  /** Quotas geradas a partir da 2ª: valor com juros (null quando a Selic do período não saiu). */
  amount: { principalCents: number; interestPercent: number | null; totalCents: number | null; note: string | null } | null;
  file: { id: string; filename: string; size: number } | null;
  sendStatus: string;
  lastSend: { channel: string; at: string; status: string; error: string | null } | null;
}

interface DarfList {
  autoSendDarfEmail: boolean;
  taxDueCents: number;
  darfs: DarfRow[];
}

const pctLabel = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

/** Valor da quota: o da guia ou, nas geradas a partir da 2ª, o principal com os juros (Selic + 1%). */
function QuotaValue({ d }: { d: Pick<DarfRow, 'valueCents' | 'amount'> }) {
  if (!d.amount) return <>{formatMoney(d.valueCents)}</>;
  const a = d.amount;
  return (
    <span className="vf-cell-stack" style={{ alignItems: 'flex-end' }} title={a.note ?? undefined}>
      <span>{a.totalCents !== null ? formatMoney(a.totalCents) : formatMoney(a.principalCents)}</span>
      <span className="vf-text-xs vf-muted">
        {a.totalCents !== null && a.interestPercent !== null ? `principal ${formatMoney(a.principalCents)} + ${pctLabel(a.interestPercent)}` : 'principal + juros (Selic a publicar)'}
      </span>
    </span>
  );
}

const STATUS: Record<DarfRow['status'], { label: string; tone: Tone }> = {
  open: { label: 'Em aberto', tone: 'primary' },
  paid: { label: 'Pago', tone: 'success' },
  overdue: { label: 'Vencido', tone: 'danger' },
};

/** Etapa DARF: quotas do imposto a pagar, PDF da guia, pagamento e envio ao cliente. */
export function DarfStep() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { declaration, isLoading, error, ensure } = useDeclaration(customer.id, year);
  const q = useApi<DarfList>(['darfs', declaration?.id], declaration?.id ? `/declarations/${declaration.id}/darfs` : null);
  const [generate, setGenerate] = useState(false);
  const [edit, setEdit] = useState<DarfRow | 'new' | null>(null);
  const [pay, setPay] = useState<DarfRow | null>(null);
  const [send, setSend] = useState<{ darf: DarfRow; channel: 'email' | 'whatsapp' } | null>(null);
  const [remove, setRemove] = useState<DarfRow | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<DarfRow | null>(null);
  const canEdit = can('darf.edit');
  const canSend = can('darf.send');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['darfs'] });
    void qc.invalidateQueries({ queryKey: ['customer-dashboard', customer.id] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const unpay = useAction((d: DarfRow) => api.put(`/darfs/${d.id}`, { paidAt: null }), { success: 'Quota reaberta.', onSuccess: refresh });
  const del = useAction((d: DarfRow) => api.del(`/darfs/${d.id}`), { success: 'Quota excluída.', onSuccess: () => (setRemove(null), refresh()) });
  const doSend = useAction((v: { darf: DarfRow; channel: 'email' | 'whatsapp' }) => api.post(`/darfs/${v.darf.id}/send`, { channel: v.channel }), {
    success: (_r) => 'Envio registrado. O cliente recebe em instantes.',
    onSuccess: () => (setSend(null), refresh()),
  });

  const onFile = async (file: File | undefined) => {
    const target = uploadTarget.current;
    if (!file || !target) return;
    setUploading(target.id);
    try {
      const res = await api.upload<DarfRow & { autoSend: 'sent' | 'no_email' | 'off' }>(`/darfs/${target.id}/file`, file);
      if (res.autoSend === 'sent') toast.success('PDF anexado e enviado por e-mail ao cliente.');
      else if (res.autoSend === 'no_email') toast.info('PDF anexado. O cliente não tem e-mail, então o envio automático não foi feito.');
      else toast.success('PDF da guia anexado.');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Não foi possível anexar o PDF.'));
    } finally {
      setUploading(null);
    }
  };

  if (isLoading || (declaration?.id && q.isLoading)) return <Loading />;
  // sem a declaração a etapa não sabe quais quotas buscar: avisa em vez de mostrar a lista vazia
  if (error || q.error) return <Alert tone="danger">Não foi possível carregar as quotas do DARF.</Alert>;
  const data: DarfList = q.data ?? { autoSendDarfEmail: false, taxDueCents: declaration?.taxDueCents ?? 0, darfs: [] };
  const rows = data.darfs;
  const payable = (d: DarfRow) => d.amount?.totalCents ?? d.valueCents;
  const totals = {
    all: rows.reduce((a, d) => a + payable(d), 0),
    paid: rows.filter((d) => d.status === 'paid').reduce((a, d) => a + payable(d), 0),
    overdue: rows.filter((d) => d.status === 'overdue').length,
    pendingInterest: rows.filter((d) => d.amount && d.amount.totalCents === null).length,
  };

  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as CSSProperties}>
      <Card
        flush
        title="Quotas do DARF"
        actions={
          canEdit && (
            <>
              <Button kind="secondary" icon={<Plus />} onClick={() => setEdit('new')}>
                Nova quota
              </Button>
              <Button icon={<Wand2 />} onClick={() => setGenerate(true)}>
                Gerar quotas
              </Button>
            </>
          )
        }
      >
        <div className="vf-inline vf-muted vf-text-sm" style={{ padding: '4px 24px 16px', '--gap': '16px' } as CSSProperties}>
          <span>
            Imposto a pagar na declaração: <strong style={{ color: 'var(--color-text-high)' }}>{formatMoney(data.taxDueCents)}</strong>
          </span>
          <span>·</span>
          <span>Envio automático por e-mail ao anexar o PDF: {data.autoSendDarfEmail ? 'ligado' : 'desligado'} (Administração › Preferências)</span>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={<CalendarCheck2 />}
            title="Nenhuma quota cadastrada"
            description={data.taxDueCents > 0 ? 'Gere as quotas a partir do imposto a pagar ou cadastre uma a uma.' : 'Informe o imposto a pagar no resumo da declaração ou cadastre as quotas manualmente.'}
            action={canEdit && <Button onClick={() => setGenerate(true)}>Gerar quotas</Button>}
          />
        ) : (
          <>
            <div className="vf-table-wrap">
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Quota</th>
                    <th className="num">Valor</th>
                    <th>Vencimento</th>
                    <th>Situação</th>
                    <th>Envio</th>
                    <th>PDF</th>
                    <th className="actions" aria-label="Ações" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <strong>{d.quotaNumber}ª</strong>
                        {rows.length === 1 && <span className="vf-muted"> (única)</span>}
                      </td>
                      <td className="num">
                        <QuotaValue d={d} />
                      </td>
                      <td>{formatDate(d.dueDate)}</td>
                      <td>
                        <span className="vf-cell-stack">
                          <Tag tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Tag>
                          {d.paidAt && <span className="vf-text-xs vf-muted">em {formatDate(d.paidAt)}</span>}
                        </span>
                      </td>
                      <td>
                        <span className="vf-cell-stack">
                          <Tag tone={sendTone(d.sendStatus)}>{SEND_STATUS_LABEL[d.sendStatus] ?? d.sendStatus}</Tag>
                          {d.lastSend && (
                            <span className="vf-text-xs vf-muted" title={d.lastSend.error ?? undefined}>
                              {d.lastSend.channel === 'email' ? 'E-mail' : 'WhatsApp'} · {formatDateTime(d.lastSend.at)}
                            </span>
                          )}
                        </span>
                      </td>
                      <td>
                        <span className="vf-inline" style={{ '--gap': '4px', flexWrap: 'nowrap' } as CSSProperties}>
                        {d.file ? (
                          <button type="button" className="vf-btn vf-btn--tertiary vf-btn--sm" onClick={() => void api.open(`/files/${d.file!.id}?inline=1`)} title={d.file.filename}>
                            Ver PDF
                          </button>
                        ) : (
                          <span className="vf-muted vf-text-xs" style={{ minWidth: 64 }}>Sem PDF</span>
                        )}
                        {canEdit && (
                          <Button
                            kind="tertiary"
                            size="sm"
                            icon={<FileUp />}
                            loading={uploading === d.id}
                            onClick={() => {
                              uploadTarget.current = d;
                              fileInput.current?.click();
                            }}
                          >
                            {d.file ? 'Trocar' : 'Anexar'}
                          </Button>
                        )}
                        </span>
                      </td>
                      <td className="actions">
                        {(canEdit || canSend) && (
                          <Menu
                            trigger={(t) => (
                              <IconButton label={`Opções da quota ${d.quotaNumber}`} onClick={t}>
                                <MoreHorizontal />
                              </IconButton>
                            )}
                          >
                            {(close) => (
                              <>
                                {canSend && (
                                  <>
                                    <MenuItem icon={<Mail />} disabled={!d.file || !customer.email} onClick={() => (close(), setSend({ darf: d, channel: 'email' }))}>
                                      Enviar por e-mail{!customer.email ? ' (sem e-mail)' : !d.file ? ' (anexe o PDF)' : ''}
                                    </MenuItem>
                                    <MenuItem icon={<MessageCircle />} disabled={!d.file || !customer.mobile} onClick={() => (close(), setSend({ darf: d, channel: 'whatsapp' }))}>
                                      Enviar por WhatsApp{!customer.mobile ? ' (sem celular)' : !d.file ? ' (anexe o PDF)' : ''}
                                    </MenuItem>
                                  </>
                                )}
                                {canEdit && (
                                  <>
                                    {canSend && <div className="vf-menu__sep" />}
                                    {d.status === 'paid' ? (
                                      <MenuItem icon={<RotateCcw />} onClick={() => (close(), unpay.mutate(d))}>
                                        Reabrir quota
                                      </MenuItem>
                                    ) : (
                                      <MenuItem icon={<CheckCircle2 />} onClick={() => (close(), setPay(d))}>
                                        Marcar como paga
                                      </MenuItem>
                                    )}
                                    <MenuItem icon={<Pencil />} onClick={() => (close(), setEdit(d))}>
                                      Editar
                                    </MenuItem>
                                    <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setRemove(d))}>
                                      Excluir
                                    </MenuItem>
                                  </>
                                )}
                              </>
                            )}
                          </Menu>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="vf-ficha-total">
              <span>
                {totals.pendingInterest ? 'Total sem os juros pendentes:' : 'Total:'}
                <strong>{formatMoney(totals.all)}</strong>
              </span>
              <span>
                Pago:<strong>{formatMoney(totals.paid)}</strong>
              </span>
              <span>
                Em aberto:<strong>{formatMoney(totals.all - totals.paid)}</strong>
              </span>
              {totals.overdue > 0 && <span className="vf-danger-text">{totals.overdue} quota(s) vencida(s)</span>}
            </div>
          </>
        )}
      </Card>

      <p className="vf-rule">
        <strong>Como as quotas são geradas:</strong> até {DARF_MAX_QUOTAS} quotas mensais; nenhuma menor que R$ 50,00, imposto abaixo de R$ 100,00 em quota única e saldo abaixo de
        R$ 10,00 sem DARF (soma-se ao imposto do próximo exercício). A 1ª quota vence na data informada e as demais no último dia com expediente bancário de cada mês seguinte (sem
        feriados nacionais nem 31/12). <strong>Juros:</strong> da 2ª quota em diante, a guia soma a Selic acumulada desde o mês seguinte ao vencimento da 1ª até o mês anterior ao do
        pagamento, mais 1% (a 2ª tem só 1%). As quotas geradas guardam o principal e mostram o valor com juros quando a Selic do período já foi publicada; sem ela, o envio ao cliente
        avisa que há juros. Ao editar o valor de uma quota, vale o valor digitado (o da guia). Para o robô acompanhar o pagamento no eCAC, a procuração do cliente precisa estar válida.
      </p>

      <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => (void onFile(e.target.files?.[0]), (e.target.value = ''))} />

      {generate && (
        <GenerateModal
          taxDueCents={data.taxDueCents}
          hasQuotas={rows.length > 0}
          hasPaid={rows.some((r) => r.status === 'paid')}
          year={year}
          ensure={ensure}
          onClose={() => setGenerate(false)}
          onDone={() => (setGenerate(false), refresh())}
        />
      )}
      {edit && <DarfModal darf={edit === 'new' ? null : edit} nextNumber={Math.max(0, ...rows.map((r) => r.quotaNumber)) + 1} ensure={ensure} onClose={() => setEdit(null)} onDone={() => (setEdit(null), refresh())} />}
      {pay && <PayModal darf={pay} onClose={() => setPay(null)} onDone={() => (setPay(null), refresh())} />}
      <ConfirmDialog
        open={Boolean(send)}
        title={send?.channel === 'email' ? 'Enviar DARF por e-mail' : 'Enviar DARF por WhatsApp'}
        message={
          send
            ? `A ${send.darf.quotaNumber}ª quota (${send.darf.amount ? (send.darf.amount.totalCents !== null ? `${formatMoney(send.darf.amount.totalCents)} com juros` : `${formatMoney(send.darf.valueCents)} de principal, mais juros`) : formatMoney(send.darf.valueCents)}, vencimento ${formatDate(send.darf.dueDate)}) vai com o PDF anexo para ${
                send.channel === 'email' ? customer.email : 'o celular do cliente'
              }.`
            : ''
        }
        confirmLabel="Enviar"
        loading={doSend.isPending}
        onConfirm={() => send && doSend.mutate(send)}
        onClose={() => setSend(null)}
      />
      <ConfirmDialog
        open={Boolean(remove)}
        danger
        title="Excluir quota"
        message={remove ? `Excluir a ${remove.quotaNumber}ª quota de ${formatMoney(remove.valueCents)}${remove.file ? ' e o PDF anexado' : ''}?` : ''}
        confirmLabel="Excluir"
        loading={del.isPending}
        onConfirm={() => remove && del.mutate(remove)}
        onClose={() => setRemove(null)}
      />
    </div>
  );
}

function GenerateModal({
  taxDueCents,
  hasQuotas,
  hasPaid,
  year,
  ensure,
  onClose,
  onDone,
}: {
  taxDueCents: number;
  hasQuotas: boolean;
  hasPaid: boolean;
  year: number;
  ensure: () => Promise<string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [total, setTotal] = useState(taxDueCents);
  const [quotas, setQuotas] = useState('1');
  const [first, setFirst] = useState(() => lastBusinessDayOfMonth(year, 5));
  const [replace, setReplace] = useState(false);
  const plan = useMemo(() => (total > 0 && /^\d{4}-\d{2}-\d{2}$/.test(first) ? planDarfQuotas(total, Number(quotas), first) : null), [total, quotas, first]);
  const run = useAction(
    async () => {
      const id = await ensure();
      return api.post<{ warning: string | null; count: number }>(`/declarations/${id}/darfs/generate`, { quotas: Number(quotas), firstDueDate: first, totalCents: total, replace: hasQuotas ? replace : undefined });
    },
    {
      success: (r) => `${r.count} quota(s) gerada(s).`,
      onSuccess: (r) => {
        if (r.warning) toast.info(r.warning);
        onDone();
      },
    },
  );
  return (
    <Modal
      open
      width={560}
      title="Gerar quotas do DARF"
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={run.isPending} disabled={!plan?.count || hasPaid || (hasQuotas && !replace)} onClick={() => run.mutate(undefined)}>
            Gerar {plan?.count ?? ''} quota(s)
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <div className="vf-grid" style={{ '--cols': 3 } as CSSProperties}>
          <MoneyInput label="Valor total" value={total} onChange={setTotal} help={taxDueCents ? `Declaração: ${formatMoney(taxDueCents)}` : 'Sem imposto no resumo'} />
          <Select label="Quotas" value={quotas} onChange={(e) => setQuotas(e.target.value)} options={Array.from({ length: DARF_MAX_QUOTAS }, (_, i) => ({ value: String(i + 1), label: i === 0 ? 'Quota única' : `${i + 1} quotas` }))} />
          <Input label="Vencimento da 1ª" type="date" value={first} onChange={(e) => setFirst(e.target.value)} />
        </div>
        {plan?.warning && <Alert tone="warning">{plan.warning}</Alert>}
        {plan && plan.quotas.length > 0 && (
          <div className="vf-preview">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Quota</th>
                  <th>Vencimento</th>
                  <th className="num">Principal</th>
                  <th className="num">Com juros</th>
                </tr>
              </thead>
              <tbody>
                {plan.quotas.map((p) => {
                  const a = darfQuotaAmount({ quotaNumber: p.quotaNumber, principalCents: p.valueCents, dueDate: p.dueDate });
                  return (
                    <tr key={p.quotaNumber}>
                      <td>{p.quotaNumber}ª</td>
                      <td>{formatDate(p.dueDate)}</td>
                      <td className="num">{formatMoney(p.valueCents)}</td>
                      <td className="num" title={a.note ?? undefined}>
                        {a.totalCents !== null ? (
                          <>
                            {formatMoney(a.totalCents)}
                            {a.interestPercent ? <span className="vf-text-xs vf-muted"> (+{pctLabel(a.interestPercent)})</span> : null}
                          </>
                        ) : (
                          <span className="vf-muted">Selic a publicar</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {hasPaid && <Alert tone="warning">Há quotas pagas nesta declaração. Para não perder o histórico, ajuste as quotas uma a uma.</Alert>}
        {hasQuotas && !hasPaid && <Checkbox label="Substituir as quotas atuais (as quotas e os PDFs anexados serão apagados)" checked={replace} onChange={(e) => setReplace(e.target.checked)} />}
        <span className="vf-rule">
          As quotas guardam o principal. Da 2ª em diante, a guia soma juros (Selic acumulada + 1%); a coluna “Com juros” usa a Selic já publicada. Confira com a guia emitida pelo
          programa da Receita.
        </span>
      </div>
    </Modal>
  );
}

function DarfModal({ darf, nextNumber, ensure, onClose, onDone }: { darf: DarfRow | null; nextNumber: number; ensure: () => Promise<string>; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ quotaNumber: String(darf?.quotaNumber ?? nextNumber), valueCents: darf?.valueCents ?? 0, dueDate: darf?.dueDate ?? '', barcode: darf?.barcode ?? '' });
  const save = useAction(
    async () => {
      const body = { quotaNumber: Number(form.quotaNumber), valueCents: form.valueCents, dueDate: form.dueDate, barcode: form.barcode || null };
      if (darf) return api.put(`/darfs/${darf.id}`, body);
      const id = await ensure();
      return api.post(`/declarations/${id}/darfs`, body);
    },
    { success: darf ? 'Quota atualizada.' : 'Quota cadastrada.', onSuccess: onDone },
  );
  const valid = form.valueCents >= 1_000 && /^\d{4}-\d{2}-\d{2}$/.test(form.dueDate) && Number(form.quotaNumber) >= 1;
  return (
    <Modal
      open
      title={darf ? `Editar ${darf.quotaNumber}ª quota` : 'Nova quota'}
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="vf-grid">
        <Input label="Número da quota" type="number" min={1} max={99} value={form.quotaNumber} onChange={(e) => setForm({ ...form, quotaNumber: e.target.value })} />
        <MoneyInput
          label="Valor"
          required
          help={Number(form.quotaNumber) >= 2 ? 'Valor da guia, com os juros (Selic acumulada + 1%). Mínimo de R$ 10,00.' : 'Mínimo de R$ 10,00.'}
          value={form.valueCents}
          onChange={(v) => setForm({ ...form, valueCents: v })}
        />
        <Input label="Vencimento" required type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        <Input label="Código de barras" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} inputMode="numeric" />
      </div>
    </Modal>
  );
}

function PayModal({ darf, onClose, onDone }: { darf: DarfRow; onClose: () => void; onDone: () => void }) {
  const [paidAt, setPaidAt] = useState(brazilToday());
  useEffect(() => setPaidAt(brazilToday()), [darf.id]);
  const save = useAction(() => api.put(`/darfs/${darf.id}`, { paidAt }), { success: 'Pagamento registrado.', onSuccess: onDone });
  return (
    <Modal
      open
      width={420}
      title={`Pagamento da ${darf.quotaNumber}ª quota`}
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} disabled={!paidAt} onClick={() => save.mutate(undefined)}>
            Marcar como paga
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <span className="vf-muted">
          {formatMoney(darf.valueCents)} · vencimento {formatDate(darf.dueDate)}
        </span>
        <Input label="Data do pagamento" type="date" value={paidAt} max={brazilToday()} onChange={(e) => setPaidAt(e.target.value)} />
      </div>
    </Modal>
  );
}
