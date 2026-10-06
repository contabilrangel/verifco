import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileCheck2, Pencil, Plus, ReceiptText, Save, Trash2 } from 'lucide-react';
import { DECLARATION_SUBSTATUS, ECAC_DECLARATION_STATUS, ITEM_KINDS, stageOfSubstatus, type ItemKind } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, IconButton, Input, Loading, Modal, MoneyInput, Select, Tag, Textarea } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fieldErrors, useAction, useApi } from '../../lib/hooks';
import { formatDate, formatMoney, stageLabel, stageTone } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { dateOnly, declarationKey, useDeclaration, type Declaration, type ItemRow } from './data';
import { FICHAS, type FieldDef, type Ficha } from './fichas';
import './declarations.css';

interface CashAnalysis {
  sources: { key: string; label: string; cents: number }[];
  uses: { key: string; label: string; cents: number }[];
  totalSourcesCents: number;
  totalUsesCents: number;
  balanceCents: number;
  netWorthVariationCents: number;
  status: 'positive' | 'negative' | 'zero';
  warnings: string[];
  itemCount: number;
}

/** Etapa "Declaração" da aba IRPF: resumo, fichas da DIRPF e análise de caixa. */
export function DeclarationStep() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const { can } = useAuth();
  const { declaration, isLoading, error, ensure } = useDeclaration(customer.id, year);
  const qc = useQueryClient();
  const canEdit = can('declaration.edit');

  /** Atualiza o cache depois de qualquer mudança (painel, Kanban e dashboard dependem dela). */
  const afterChange = (d?: Declaration) => {
    // as respostas de gravação não trazem o recibo (.REC) do sincronizador: mantém o que já veio no GET
    if (d) qc.setQueryData<Declaration>(declarationKey(customer.id, year), (old) => ({ ...old, ...d, receiptFile: d.receiptFile ?? old?.receiptFile ?? null }));
    void qc.invalidateQueries({ queryKey: ['declaration-items'] });
    void qc.invalidateQueries({ queryKey: ['cash'] });
    void qc.invalidateQueries({ queryKey: ['customer-dashboard', customer.id] });
    void qc.invalidateQueries({ queryKey: ['kanban'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  if (isLoading) return <Loading />;
  if (error || !declaration) return <Alert tone="danger">Não foi possível carregar a declaração.</Alert>;

  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as CSSProperties}>
      <SummaryCard declaration={declaration} canEdit={canEdit} ensure={ensure} onSaved={afterChange} />
      <FichasCard declaration={declaration} canEdit={canEdit} ensure={ensure} onChanged={afterChange} />
      {declaration.id && <CashCard declaration={declaration} canEdit={canEdit} onSaved={afterChange} />}
    </div>
  );
}

// ---------------------------------------------------------------- resumo
type SummaryForm = {
  taxation: string;
  isRectification: boolean;
  receiptNumber: string;
  transmittedAt: string;
  taxDueCents: number;
  refundCents: number;
  refundLotDate: string;
  ecacStatus: string;
};

const toSummary = (d: Declaration): SummaryForm => ({
  taxation: d.taxation ?? '',
  isRectification: d.isRectification,
  receiptNumber: d.receiptNumber ?? '',
  transmittedAt: dateOnly(d.transmittedAt),
  taxDueCents: d.taxDueCents,
  refundCents: d.refundCents,
  refundLotDate: d.refundLotDate ?? '',
  ecacStatus: d.ecacStatus,
});

function SummaryCard({ declaration, canEdit, ensure, onSaved }: { declaration: Declaration; canEdit: boolean; ensure: () => Promise<string>; onSaved: (d: Declaration) => void }) {
  const { customer } = useCustomer();
  const { year } = useYear();
  const { can } = useAuth();
  const [form, setForm] = useState(() => toSummary(declaration));
  useEffect(() => setForm(toSummary(declaration)), [declaration]);
  const dirty = JSON.stringify(form) !== JSON.stringify(toSummary(declaration));
  const both = form.taxDueCents > 0 && form.refundCents > 0;

  const save = useAction(
    () =>
      api.put<Declaration>(`/customers/${customer.id}/declarations/${year}`, {
        ...form,
        taxation: form.taxation || null,
        receiptNumber: form.receiptNumber || null,
        transmittedAt: form.transmittedAt || null,
        refundLotDate: form.refundLotDate || null,
      }),
    { success: 'Resumo da declaração salvo.', onSuccess: onSaved },
  );
  const status = useAction(
    async (substatus: string) => {
      const id = await ensure();
      return api.patch<Declaration>(`/declarations/${id}/substatus`, { substatus });
    },
    { success: 'Status atualizado.', onSuccess: onSaved },
  );
  const set = <K extends keyof SummaryForm>(k: K, v: SummaryForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const substatusOptions = Object.entries(DECLARATION_SUBSTATUS)
    .filter(([k]) => k === declaration.substatus || k !== 'finished' || can('declaration.finish'))
    .map(([value, label]) => ({ value, label: `${stageLabel(stageOfSubstatus(value as keyof typeof DECLARATION_SUBSTATUS))} · ${label}` }));

  return (
    <Card
      title={
        <span className="vf-inline">
          Resumo da declaração
          <Tag tone={stageTone(declaration.stage)}>{stageLabel(declaration.stage)}</Tag>
          {!declaration.exists && <span className="vf-text-xs vf-muted">ainda não iniciada</span>}
        </span>
      }
      actions={
        canEdit && (
          <Button icon={<Save />} disabled={!dirty || both} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar resumo
          </Button>
        )
      }
    >
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="vf-grid" style={{ '--cols': 4 } as CSSProperties}>
          <div className="vf-span-2">
            <Select
              label="Status interno"
              value={declaration.substatus}
              onChange={(e) => status.mutate(e.target.value)}
              disabled={!canEdit || status.isPending}
              options={substatusOptions}
              help="Muda na hora, como no Kanban."
            />
          </div>
          <Select
            label="Tributação"
            value={form.taxation}
            onChange={(e) => set('taxation', e.target.value)}
            options={[
              { value: '', label: 'Não definida' },
              { value: 'complete', label: 'Completa (deduções legais)' },
              { value: 'simplified', label: 'Simplificada (desconto padrão)' },
            ]}
          />
          <Select
            label="Situação no eCAC"
            value={form.ecacStatus}
            onChange={(e) => set('ecacStatus', e.target.value)}
            options={Object.entries(ECAC_DECLARATION_STATUS).map(([value, label]) => ({ value, label }))}
          />
          <Input label="Número do recibo" value={form.receiptNumber} onChange={(e) => set('receiptNumber', e.target.value)} placeholder="00.00.00.00.00-00" />
          <Input label="Data da transmissão" type="date" value={form.transmittedAt} onChange={(e) => set('transmittedAt', e.target.value)} />
          <MoneyInput label="Imposto a pagar" value={form.taxDueCents} onChange={(v) => set('taxDueCents', v)} error={both ? 'Informe só um: a pagar ou a restituir' : undefined} />
          <MoneyInput label="Imposto a restituir" value={form.refundCents} onChange={(v) => set('refundCents', v)} />
          <Input label="Lote da restituição" type="date" value={form.refundLotDate} onChange={(e) => set('refundLotDate', e.target.value)} />
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 10 }}>
            <Checkbox label="Declaração retificadora" checked={form.isRectification} onChange={(e) => set('isRectification', e.target.checked)} />
          </div>
        </div>
      </fieldset>
      <p className="vf-rule" style={{ marginTop: 12 }}>
        Ao informar a data de transmissão ou o recibo, a declaração passa para “Transmitida” no Kanban, com o status da situação no eCAC. O mesmo vale para o
        recibo (.REC) recebido do sincronizador e para a situação vinda do eCAC.
      </p>
      {declaration.receiptFile && (
        <div className="vf-dec-receipt">
          <FileCheck2 aria-hidden />
          <span>
            Recibo de entrega (.REC) recebido do sincronizador em {formatDate(declaration.receiptFile.receivedAt)}.{' '}
            <button type="button" className="vf-dec-receipt__link" onClick={() => void api.download(`/files/${declaration.receiptFile!.fileId}`, declaration.receiptFile!.filename)}>
              Baixar {declaration.receiptFile.filename}
            </button>
            <span className="vf-muted"> · o conteúdo do arquivo não é lido (leiaute não público): o número do recibo é informado acima.</span>
          </span>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- fichas
function FichasCard({ declaration, canEdit, ensure, onChanged }: { declaration: Declaration; canEdit: boolean; ensure: () => Promise<string>; onChanged: (d?: Declaration) => void }) {
  const { year } = useYear();
  const [tab, setTab] = useState(FICHAS[0].id);
  const [editing, setEditing] = useState<{ ficha: Ficha; item: ItemRow | null } | null>(null);
  const [removing, setRemoving] = useState<ItemRow | null>(null);
  const items = useApi<ItemRow[]>(['declaration-items', declaration.id], declaration.id ? `/declarations/${declaration.id}/items` : null);
  const all = items.data ?? [];
  const byFicha = useMemo(() => Object.fromEntries(FICHAS.map((f) => [f.id, all.filter((i) => f.kinds.includes(i.kind))])), [all]);
  const ficha = FICHAS.find((f) => f.id === tab)!;
  const rows = byFicha[ficha.id] ?? [];
  const remove = useAction((item: ItemRow) => api.del<{ declaration: Declaration }>(`/declarations/${declaration.id}/items/${item.id}`), {
    success: 'Lançamento excluído.',
    onSuccess: (r) => {
      setRemoving(null);
      onChanged(r.declaration);
    },
  });

  return (
    <Card flush title="Fichas da declaração" actions={canEdit && <Button icon={<Plus />} onClick={() => setEditing({ ficha, item: null })}>Adicionar em {ficha.title}</Button>}>
      <div className="vf-dec-chips" role="tablist" aria-label="Fichas da declaração">
        {FICHAS.map((f) => {
          const n = byFicha[f.id]?.length ?? 0;
          return (
            <button key={f.id} type="button" role="tab" aria-selected={f.id === tab} className={`vf-dec-chip${n ? '' : ' vf-dec-chip--empty'}`} onClick={() => setTab(f.id)}>
              {f.title}
              {n > 0 && <span className="vf-dec-chip__n">{n}</span>}
            </button>
          );
        })}
      </div>
      {items.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="vf-inline vf-muted" style={{ padding: '24px', justifyContent: 'center' }}>
          <ReceiptText size={18} />
          Nenhum lançamento em {ficha.title.toLowerCase()}.
          {canEdit && (
            <Button kind="tertiary" size="sm" onClick={() => setEditing({ ficha, item: null })}>
              Adicionar
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  {ficha.columns(year).map((c) => (
                    <th key={c.header} className={c.num ? 'num' : undefined}>
                      {c.header}
                    </th>
                  ))}
                  {canEdit && <th className="actions" aria-label="Ações" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id}>
                    {ficha.columns(year).map((c) => (
                      <td key={c.header} className={c.num ? 'num' : undefined}>
                        {c.render(item)}
                      </td>
                    ))}
                    {canEdit && (
                      <td className="actions">
                        <IconButton label="Editar" onClick={() => setEditing({ ficha, item })}>
                          <Pencil />
                        </IconButton>
                        <IconButton label="Excluir" onClick={() => setRemoving(item)}>
                          <Trash2 />
                        </IconButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="vf-ficha-total">
            <span>
              {rows.length} lançamento(s)
            </span>
            {ficha.totals(rows).map((t) => (
              <span key={t.label}>
                {t.label}:<strong className={t.cents < 0 ? 'vf-danger-text' : undefined}>{formatMoney(t.cents)}</strong>
              </span>
            ))}
          </div>
        </>
      )}

      {editing && (
        <ItemModal
          ficha={editing.ficha}
          item={editing.item}
          year={year}
          ensure={ensure}
          onClose={() => setEditing(null)}
          onSaved={(d) => {
            setEditing(null);
            onChanged(d);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        danger
        title="Excluir lançamento"
        message="O lançamento sai da declaração e os totais são recalculados."
        confirmLabel="Excluir"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}

type FormValues = Record<string, string | number | boolean>;

const readPath = (item: ItemRow | null, name: string): unknown => {
  if (!item) return undefined;
  if (name.startsWith('extra.')) return (item.extra as Record<string, unknown> | undefined)?.[name.slice(6)];
  return (item as unknown as Record<string, unknown>)[name];
};

function ItemModal({
  ficha,
  item,
  year,
  ensure,
  onClose,
  onSaved,
}: {
  ficha: Ficha;
  item: ItemRow | null;
  year: number;
  ensure: () => Promise<string>;
  onClose: () => void;
  onSaved: (d: Declaration) => void;
}) {
  const fields = ficha.fields(year);
  const [kind, setKind] = useState<ItemKind>(item?.kind ?? ficha.kinds[0]);
  const [values, setValues] = useState<FormValues>(() =>
    Object.fromEntries(
      fields.map((f) => {
        const v = readPath(item, f.name);
        return [f.name, f.kind === 'checkbox' ? v === true : f.kind === 'money' ? (typeof v === 'number' ? v : 0) : typeof v === 'string' ? v : ''];
      }),
    ),
  );
  const save = useAction(
    async () => {
      const id = await ensure();
      const payload: Record<string, unknown> = { kind, extra: { ...((item?.extra as Record<string, unknown>) ?? {}) } };
      for (const f of fields) {
        const v = values[f.name];
        const applies = !f.onlyKinds || f.onlyKinds.includes(kind);
        // caixa de seleção: grava `true` ou remove a marca (também quando não vale para o tipo)
        const value = f.kind === 'checkbox' ? (applies && v === true ? true : null) : f.kind === 'money' ? Number(v) || 0 : typeof v === 'string' && v.trim() ? v.trim() : null;
        if (f.name.startsWith('extra.')) {
          const key = f.name.slice(6);
          if (value === null) delete (payload.extra as Record<string, unknown>)[key];
          else (payload.extra as Record<string, unknown>)[key] = value;
        } else payload[f.name] = value;
      }
      return item
        ? api.put<{ declaration: Declaration }>(`/declarations/${id}/items/${item.id}`, payload)
        : api.post<{ declaration: Declaration }>(`/declarations/${id}/items`, payload);
    },
    { success: item ? 'Lançamento atualizado.' : 'Lançamento incluído.', onSuccess: (r) => onSaved(r.declaration) },
  );
  const errors = fieldErrors(save.error);
  const missing = fields.some((f) => f.required && (f.kind === 'money' ? false : !String(values[f.name] ?? '').trim()));
  const set = (name: string, v: string | number | boolean) => setValues((s) => ({ ...s, [name]: v }));

  const render = (f: FieldDef) => {
    if (f.onlyKinds && !f.onlyKinds.includes(kind)) return null;
    const common = { label: f.label, required: f.required, help: f.help, error: errors[f.name] };
    const style = f.wide ? ({ gridColumn: '1 / -1' } as CSSProperties) : undefined;
    const value = values[f.name];
    switch (f.kind) {
      case 'checkbox':
        return (
          <div key={f.name} className="vf-span-full vf-stack" style={{ '--gap': '2px' } as CSSProperties}>
            <Checkbox label={f.label} checked={value === true} onChange={(e) => set(f.name, e.target.checked)} />
            {f.help && <span className="vf-text-xs vf-muted">{f.help}</span>}
          </div>
        );
      case 'money':
        return <MoneyInput key={f.name} {...common} style={style} value={Number(value) || 0} onChange={(c) => set(f.name, c)} />;
      case 'select':
        return <Select key={f.name} {...common} style={style} placeholder="Selecione" value={String(value)} onChange={(e) => set(f.name, e.target.value)} options={f.options ?? []} />;
      case 'textarea':
        return <Textarea key={f.name} {...common} style={style} rows={3} value={String(value)} onChange={(e) => set(f.name, e.target.value)} />;
      case 'date':
        return <Input key={f.name} {...common} style={style} type="date" value={String(value)} onChange={(e) => set(f.name, e.target.value)} />;
      default:
        return (
          <Input
            key={f.name}
            {...common}
            style={style}
            inputMode={f.kind === 'cpf' || f.kind === 'doc' ? 'numeric' : undefined}
            placeholder={f.kind === 'cpf' ? '000.000.000-00' : f.kind === 'doc' ? 'CPF ou CNPJ' : undefined}
            value={String(value)}
            onChange={(e) => set(f.name, e.target.value)}
          />
        );
    }
  };

  return (
    <Modal
      open
      width={640}
      title={`${item ? 'Editar' : 'Novo'} lançamento · ${ficha.title}`}
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} disabled={missing} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="vf-grid">
        {ficha.kinds.length > 1 && (
          <Select
            label="Tipo"
            required
            style={{ gridColumn: '1 / -1' }}
            value={kind}
            onChange={(e) => setKind(e.target.value as ItemKind)}
            options={ficha.kinds.map((k) => ({ value: k, label: ficha.id === 'outros' ? ITEM_KINDS[k].ficha : ITEM_KINDS[k].label }))}
          />
        )}
        {fields.map(render)}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- análise de caixa
function CashCard({ declaration, canEdit, onSaved }: { declaration: Declaration; canEdit: boolean; onSaved: (d: Declaration) => void }) {
  const [editOther, setEditOther] = useState(false);
  const q = useApi<CashAnalysis>(['cash', declaration.id], `/declarations/${declaration.id}/cash-analysis`);
  if (q.isLoading) return <Card title="Análise de caixa"><Loading /></Card>;
  if (!q.data) return <Alert tone="danger">Não foi possível calcular a análise de caixa.</Alert>;
  const c = q.data;
  const negative = c.balanceCents < 0;
  return (
    <Card
      title="Análise de caixa"
      actions={
        canEdit && (
          <Button kind="secondary" size="sm" onClick={() => setEditOther(true)}>
            Outros gastos
          </Button>
        )
      }
    >
      {c.itemCount === 0 ? (
        <p className="vf-muted">Lance rendimentos, pagamentos, bens e dívidas nas fichas para calcular o fluxo de caixa do ano.</p>
      ) : (
        <>
          <div className="vf-cash">
            <CashColumn title="Recursos (origens)" lines={c.sources} total={c.totalSourcesCents} />
            <CashColumn title="Aplicações (usos)" lines={c.uses} total={c.totalUsesCents} />
          </div>
          <div className={`vf-balance${negative ? ' vf-balance--negative' : ''}`} role={negative ? 'alert' : undefined}>
            <span>
              <strong>Saldo de caixa: {formatMoney(c.balanceCents)}</strong>
              <br />
              <span className="vf-text-xs">
                {negative
                  ? 'As aplicações superam os recursos: há variação patrimonial sem origem comprovada, risco de malha fina.'
                  : 'Os recursos do ano cobrem as aplicações declaradas.'}
              </span>
            </span>
            <span className="vf-text-sm">Variação patrimonial líquida: {formatMoney(c.netWorthVariationCents)}</span>
          </div>
          {c.warnings.map((w) => (
            <div key={w} style={{ marginTop: 12 }}>
              <Alert tone="warning">{w}</Alert>
            </div>
          ))}
        </>
      )}
      {editOther && <OtherExpensesModal declaration={declaration} onClose={() => setEditOther(false)} onSaved={(d) => (setEditOther(false), onSaved(d))} />}
    </Card>
  );
}

function CashColumn({ title, lines, total }: { title: string; lines: { key: string; label: string; cents: number }[]; total: number }) {
  return (
    <div>
      <h3>{title}</h3>
      <dl className="vf-dl">
        {lines.map((l) => (
          <span key={l.key} style={{ display: 'contents' }}>
            <dt className={l.cents === 0 ? 'vf-muted' : undefined}>{l.label}</dt>
            <dd className={l.cents === 0 ? 'vf-muted' : undefined} style={l.cents === 0 ? { fontWeight: 500 } : undefined}>
              {formatMoney(l.cents)}
            </dd>
          </span>
        ))}
        <hr />
        <dt>
          <strong>Total</strong>
        </dt>
        <dd>{formatMoney(total)}</dd>
      </dl>
    </div>
  );
}

const OTHER_FIELDS = [
  { key: 'annualPaymentCents', label: 'Pagamentos de imposto do ano anterior (quotas)' },
  { key: 'interestCents', label: 'Juros pagos' },
  { key: 'creditCardCents', label: 'Despesas com cartão de crédito' },
  { key: 'capitalLossCents', label: 'Perdas de capital' },
] as const;

function OtherExpensesModal({ declaration, onClose, onSaved }: { declaration: Declaration; onClose: () => void; onSaved: (d: Declaration) => void }) {
  const { customer } = useCustomer();
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(OTHER_FIELDS.map((f) => [f.key, declaration.otherExpenses?.[f.key] ?? 0])));
  const save = useAction(() => api.put<Declaration>(`/customers/${customer.id}/declarations/${declaration.exerciseYear}`, { otherExpenses: values }), {
    success: 'Outros gastos salvos.',
    onSuccess: onSaved,
  });
  return (
    <Modal
      open
      title="Outros gastos do ano"
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <p className="vf-muted">Gastos que não aparecem nas fichas, mas consomem recursos do contribuinte. Entram como aplicações na análise de caixa.</p>
        {OTHER_FIELDS.map((f) => (
          <MoneyInput key={f.key} label={f.label} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
        ))}
      </div>
    </Modal>
  );
}
