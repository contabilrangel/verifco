import { useEffect, useMemo, useState } from 'react';
import { Calculator, History, Lock } from 'lucide-react';
import { BUDGET_CATEGORIES, BUDGET_STATUS, BUDGET_TYPES, applyDiscount, todayIso } from '@verifco/shared';
import { Alert, Button, Checkbox, Input, Modal, MoneyInput, Select, Spinner, Textarea } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fieldErrors, useAction, useApi, useDebounced } from '../../lib/hooks';
import { formatDate, formatMoney } from '../../lib/format';
import { describeTable } from './PriceTablesPage';
import type { Budget, PaymentMethod, PriceTable, Quote } from './types';
import { BudgetStatusTag, formatNumber, parseNumber } from './ui';

const CATEGORY_OPTIONS = Object.entries(BUDGET_CATEGORIES).map(([value, label]) => ({ value, label }));
// rótulos curtos para caber no seletor
const TYPE_OPTIONS = (Object.keys(BUDGET_TYPES) as (keyof typeof BUDGET_TYPES)[]).map((value) => ({
  value,
  label: value === 'fixed' ? 'Fixo' : value === 'variable' ? 'Variável (tabela)' : 'Integrado (Asaas/Omie)',
}));

type Form = {
  type: Budget['type'];
  status: Budget['status'];
  category: string;
  description: string;
  priceTableId: string;
  hours: string;
  items: Record<string, string>;
  amountCents: number;
  discount: string;
  paymentMethodId: string;
  billingStartDate: string;
  installments: number;
  internalNote: string;
  sendEmail: boolean;
  sendWhatsApp: boolean;
};

function initialForm(b: Budget | null, methods: PaymentMethod[], tables: PriceTable[]): Form {
  if (b) {
    return {
      type: b.type,
      status: b.status,
      category: b.category,
      description: b.description ?? '',
      priceTableId: b.priceTableId ?? '',
      hours: b.pricingInputs.hours ? formatNumber(b.pricingInputs.hours) : '',
      items: Object.fromEntries(Object.entries(b.pricingInputs.items ?? {}).map(([k, v]) => [k, String(v)])),
      amountCents: b.amountCents,
      discount: b.discountPercent ? formatNumber(b.discountPercent) : '',
      paymentMethodId: b.paymentMethodId ?? '',
      billingStartDate: b.billingStartDate ?? '',
      installments: b.installments,
      internalNote: b.internalNote ?? '',
      sendEmail: false,
      sendWhatsApp: false,
    };
  }
  const defMethod = methods.find((m) => m.isDefault && m.active);
  const defTable = tables.find((t) => t.isDefault && t.validNow);
  return {
    type: 'fixed',
    status: 'draft',
    category: 'irpf',
    description: '',
    priceTableId: defTable?.id ?? '',
    hours: '',
    items: {},
    amountCents: defTable?.type === 'fixed' ? (defTable.config.amountCents ?? 0) : 0,
    discount: '',
    paymentMethodId: defMethod?.id ?? '',
    billingStartDate: todayIso(),
    installments: 1,
    internalNote: '',
    sendEmail: false,
    sendWhatsApp: false,
  };
}

export function BudgetFormModal({
  open,
  budget,
  customerId,
  year,
  hasEmail,
  hasMobile,
  previous,
  onClose,
  onSaved,
}: {
  open: boolean;
  budget: Budget | null;
  customerId: string;
  year: number;
  hasEmail: boolean;
  hasMobile: boolean;
  previous: Budget | null;
  onClose: () => void;
  onSaved: (b: Budget & { link: string | null }) => void;
}) {
  const { can } = useAuth();
  const methodsQ = useApi<PaymentMethod[]>(['finance', 'payment-methods'], open ? '/finance/payment-methods' : null);
  const tablesQ = useApi<PriceTable[]>(['finance', 'price-tables'], open ? '/finance/price-tables' : null);
  const methods = useMemo(() => (methodsQ.data ?? []).filter((m) => m.active || m.id === budget?.paymentMethodId), [methodsQ.data, budget]);
  const tables = useMemo(() => (tablesQ.data ?? []).filter((t) => t.validNow || t.id === budget?.priceTableId), [tablesQ.data, budget]);
  const ready = Boolean(methodsQ.data && tablesQ.data);
  const [f, setF] = useState<Form | null>(null);

  useEffect(() => {
    if (!open) setF(null);
    else if (ready && !f) setF(initialForm(budget, methods, tables));
  }, [open, ready, budget, methods, tables, f]);

  const approved = budget?.status === 'approved';
  const table = tables.find((t) => t.id === f?.priceTableId) ?? null;
  const method = methods.find((m) => m.id === f?.paymentMethodId) ?? null;
  const maxInstallments = method?.maxInstallments ?? 1;

  // cálculo pela tabela com os dados da declaração do ano
  const inputs = useMemo(() => {
    if (!f || !table) return null;
    if (table.type === 'hourly') return { hours: parseNumber(f.hours) ?? 0 };
    if (table.type === 'items') return { items: Object.fromEntries(Object.entries(f.items).map(([k, v]) => [k, parseNumber(v) ?? 0]).filter(([, v]) => (v as number) > 0)) };
    return {};
  }, [f, table]);
  const quoteKey = useDebounced(JSON.stringify({ t: table?.id, inputs }), 350);
  const [q, setQ] = useState<{ loading: boolean; data: Quote | null }>({ loading: false, data: null });
  useEffect(() => {
    const key = JSON.parse(quoteKey) as { t?: string; inputs: Record<string, unknown> | null };
    if (!open || !key.t || approved) {
      setQ({ loading: false, data: null });
      return;
    }
    let alive = true;
    setQ((s) => ({ ...s, loading: true }));
    api
      .post<Quote>('/finance/budgets/quote', { customerId, exerciseYear: year, priceTableId: key.t, pricingInputs: key.inputs ?? {} })
      .then((data) => alive && setQ({ loading: false, data }))
      .catch(() => alive && setQ({ loading: false, data: null }));
    return () => {
      alive = false;
    };
  }, [quoteKey, open, approved, customerId, year]);

  // orçamento variável acompanha o valor calculado
  useEffect(() => {
    if (f && f.type === 'variable' && q.data?.ok && q.data.amountCents !== f.amountCents) setF({ ...f, amountCents: q.data.amountCents });
  }, [q.data, f]);

  const save = useAction(
    () => {
      const form = f!;
      const body = {
        type: form.type,
        status: form.status,
        category: form.category,
        description: form.description,
        priceTableId: form.priceTableId || null,
        pricingInputs: inputs ?? {},
        amountCents: form.amountCents,
        discountPercent: parseNumber(form.discount) ?? 0,
        paymentMethodId: form.paymentMethodId || null,
        billingStartDate: form.billingStartDate || null,
        installments: form.installments,
        internalNote: form.internalNote,
        sendEmail: form.sendEmail,
        sendWhatsApp: form.sendWhatsApp,
      };
      return budget
        ? api.put<Budget & { link: string | null }>(`/finance/budgets/${budget.id}`, body)
        : api.post<Budget & { link: string | null }>('/finance/budgets', { ...body, customerId, exerciseYear: year });
    },
    {
      success: (r) => (r.status === 'approved' && !approved ? 'Orçamento aprovado e faturamento gerado.' : f?.sendEmail || f?.sendWhatsApp ? 'Orçamento salvo e enviado ao cliente.' : 'Orçamento salvo.'),
      invalidate: [['finance', 'budgets', customerId]],
      onSuccess: (r) => onSaved(r),
    },
  );
  const errors = fieldErrors(save.error);

  if (!open) return null;
  if (!f) {
    return (
      <Modal open title={budget ? 'Editar orçamento' : 'Novo orçamento'} onClose={onClose} width={760}>
        <div className="vf-inline" style={{ justifyContent: 'center', padding: 32 }}>
          <Spinner />
        </div>
      </Modal>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const discount = parseNumber(f.discount) ?? 0;
  const discountOk = discount >= 0 && discount <= 100;
  const total = applyDiscount(f.amountCents, discountOk ? discount : 0);
  const canSend = can('budget.send') && ['draft', 'sent'].includes(f.status);
  const statusOptions = (Object.keys(BUDGET_STATUS) as Budget['status'][])
    .filter((s) => s !== 'approved' || can('budget.approve') || approved)
    .filter((s) => !approved || s === 'approved')
    .map((value) => ({ value, label: BUDGET_STATUS[value] }));
  const valid = approved || (f.amountCents > 0 && discountOk && f.installments <= maxInstallments && (f.type !== 'variable' || Boolean(table && q.data?.ok)));

  return (
    <Modal
      open
      title={budget ? 'Editar orçamento' : 'Novo orçamento'}
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="vf-grow vf-text-xs vf-muted">O faturamento é criado quando o orçamento é aprovado.</span>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {f.sendEmail || f.sendWhatsApp ? 'Salvar e enviar' : 'Salvar orçamento'}
          </Button>
        </>
      }
    >
      <div className="vf-stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {previous && !budget && (
          <div className="vf-fin-reference">
            <History size={16} />
            <span>
              Referência {previous.exerciseYear}: <strong>{previous.categoryLabel}</strong> · {formatMoney(previous.totalCents)}
              {previous.installments > 1 ? ` em ${previous.installments}x` : ''}
              {previous.paymentMethodName ? ` · ${previous.paymentMethodName}` : ''}
            </span>
            <BudgetStatusTag status={previous.status} />
          </div>
        )}
        {approved && (
          <Alert tone="success" title="Orçamento aprovado">
            Os valores já estão no faturamento. Aqui você ainda pode ajustar a descrição e a observação interna; parcelas são ajustadas no faturamento.
          </Alert>
        )}

        <fieldset disabled={approved} className="vf-stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0, '--gap': '20px' } as React.CSSProperties}>
          <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
            <Select
              label="Tipo de orçamento"
              value={f.type}
              onChange={(e) => {
                const type = e.target.value as Form['type'];
                setF({ ...f, type, priceTableId: type === 'variable' && !f.priceTableId ? (tables[0]?.id ?? '') : f.priceTableId });
              }}
              options={TYPE_OPTIONS}
            />
            <Select
              label="Status"
              value={f.status}
              onChange={(e) => {
                const status = e.target.value as Form['status'];
                setF({ ...f, status, sendEmail: ['draft', 'sent'].includes(status) && f.sendEmail, sendWhatsApp: ['draft', 'sent'].includes(status) && f.sendWhatsApp });
              }}
              options={statusOptions}
              help={f.status === 'approved' && !approved ? 'Ao salvar, o faturamento é gerado.' : undefined}
            />
            <Select label="Categoria" value={f.category} onChange={(e) => set('category', e.target.value)} options={CATEGORY_OPTIONS} />
          </div>

          <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
            <Select
              label={f.type === 'variable' ? 'Tabela de cobrança' : 'Tabela de cobrança (opcional)'}
              required={f.type === 'variable'}
              placeholder={f.type === 'variable' ? 'Selecione' : 'Sem tabela'}
              value={f.priceTableId}
              onChange={(e) => setF({ ...f, priceTableId: e.target.value, hours: '', items: {} })}
              options={tables.map((t) => ({ value: t.id, label: `${t.name} — ${describeTable(t)}` }))}
              help={tables.length === 0 ? 'Nenhuma tabela vigente. Cadastre em Financeiro › Tabelas de cobrança.' : undefined}
              style={table?.type === 'hourly' ? undefined : { gridColumn: '1 / -1' }}
            />
            {table?.type === 'hourly' && (
              <Input label="Horas de trabalho" inputMode="decimal" value={f.hours} onChange={(e) => set('hours', e.target.value)} placeholder="Ex.: 3,5" />
            )}
          </div>

          {table?.type === 'items' && (
            <div className="vf-fin-panel">
              <span className="vf-text-sm-bold">Quantidade por item</span>
              <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
                {(table.config.items ?? []).map((it) => (
                  <Input
                    key={it.code}
                    label={`${it.label} (${formatMoney(it.unitPriceCents)})`}
                    inputMode="numeric"
                    value={f.items[it.code] ?? ''}
                    placeholder="0"
                    onChange={(e) => setF({ ...f, items: { ...f.items, [it.code]: e.target.value } })}
                  />
                ))}
              </div>
            </div>
          )}

          {table && (
            <div className="vf-fin-quote" aria-live="polite">
              <Calculator size={18} />
              {q.loading ? (
                <span className="vf-muted">Calculando…</span>
              ) : q.data?.ok ? (
                <>
                  <div className="vf-grow">
                    <div>
                      Calculado pela tabela: <strong>{formatMoney(q.data.amountCents)}</strong>
                      {q.data.adjustment === 'min' && <span className="vf-muted"> · valor mínimo aplicado</span>}
                      {q.data.adjustment === 'max' && <span className="vf-muted"> · valor máximo aplicado</span>}
                    </div>
                    {q.data.baseCents !== undefined && (
                      <div className="vf-text-xs vf-muted">Base da declaração {year}: {formatMoney(q.data.baseCents)}</div>
                    )}
                  </div>
                  {f.type !== 'variable' && f.amountCents !== q.data.amountCents && (
                    <Button kind="secondary" size="sm" onClick={() => q.data?.ok && set('amountCents', q.data.amountCents)}>
                      Usar este valor
                    </Button>
                  )}
                </>
              ) : (
                <span className="vf-danger-text">{q.data && !q.data.ok ? q.data.error : 'Não foi possível calcular pela tabela.'}</span>
              )}
            </div>
          )}

          <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
            <MoneyInput
              label="Valor do orçamento"
              required
              value={f.amountCents}
              onChange={(v) => set('amountCents', v)}
              disabled={f.type === 'variable'}
              help={f.type === 'variable' ? 'Definido pela tabela de cobrança.' : undefined}
              error={errors.amountCents}
            />
            <Input label="Desconto" inputMode="decimal" suffix="%" className="vf-fin-plain" value={f.discount} onChange={(e) => set('discount', e.target.value)} placeholder="0" error={!discountOk ? 'De 0 a 100' : errors.discountPercent} />
            <div className="vf-field">
              <span className="vf-field__label">Total</span>
              <div className="vf-fin-total">{formatMoney(total)}</div>
            </div>
          </div>

          <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
            <Select
              label="Forma de pagamento"
              placeholder="Não definida"
              value={f.paymentMethodId}
              onChange={(e) => {
                const m = methods.find((x) => x.id === e.target.value);
                setF({ ...f, paymentMethodId: e.target.value, installments: Math.min(f.installments, m?.maxInstallments ?? 1), type: f.type === 'integration' && !['asaas', 'omie'].includes(m?.type ?? '') ? 'fixed' : f.type });
              }}
              options={methods.map((m) => ({ value: m.id, label: m.name }))}
              error={f.type === 'integration' && !['asaas', 'omie'].includes(method?.type ?? '') ? 'Escolha uma cobrança Asaas ou Omie' : undefined}
            />
            <Input label="Data inicial da cobrança" type="date" value={f.billingStartDate} onChange={(e) => set('billingStartDate', e.target.value)} help="Vencimento da 1ª parcela." />
            <Select
              label="Parcelas"
              value={String(f.installments)}
              onChange={(e) => set('installments', Number(e.target.value))}
              options={Array.from({ length: maxInstallments }, (_, i) => ({
                value: String(i + 1),
                label: i === 0 ? `À vista · ${formatMoney(total)}` : `${i + 1}x de ${formatMoney(Math.ceil(total / (i + 1)))}`,
              }))}
              help={!method ? 'Escolha a forma de pagamento para parcelar.' : `Até ${maxInstallments}x em ${method.name}.`}
            />
          </div>
        </fieldset>

        <Textarea label="Descrição" value={f.description} onChange={(e) => set('description', e.target.value)} rows={2} placeholder="O que está incluído na proposta" />
        <Textarea
          label={
            <span className="vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
              <Lock size={12} /> Observação (uso interno)
            </span>
          }
          value={f.internalNote}
          onChange={(e) => set('internalNote', e.target.value)}
          rows={2}
          placeholder="Não é enviada ao cliente"
        />

        {!approved && canSend && (
          <div className="vf-inline" style={{ '--gap': '24px' } as React.CSSProperties}>
            <Checkbox label={hasEmail ? 'Enviar este orçamento por e-mail' : 'Enviar por e-mail (cliente sem e-mail)'} checked={f.sendEmail} disabled={!hasEmail} onChange={(e) => set('sendEmail', e.target.checked)} />
            <Checkbox label={hasMobile ? 'Enviar também por WhatsApp' : 'WhatsApp (cliente sem celular)'} checked={f.sendWhatsApp} disabled={!hasMobile} onChange={(e) => set('sendWhatsApp', e.target.checked)} />
          </div>
        )}
        {(f.sendEmail || f.sendWhatsApp) && (
          <Alert tone="primary">O cliente recebe a proposta com um link para aprovar ou recusar, válido por 30 dias{f.billingStartDate ? `; a 1ª parcela vence em ${formatDate(f.billingStartDate)}` : ''}.</Alert>
        )}
      </div>
    </Modal>
  );
}
