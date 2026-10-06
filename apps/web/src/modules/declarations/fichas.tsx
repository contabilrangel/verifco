import type { ReactNode } from 'react';
import { ASSET_GROUPS, DEPENDENT_RELATIONSHIPS, INCOME_NATURES, ITEM_KINDS, PAYMENT_NATURES, type ItemKind } from '@verifco/shared';
import { formatCpfCnpj, formatDate, formatMoney } from '../../lib/format';
import type { ItemRow } from './data';

/** Campo do formulário de uma linha; `name` é o caminho no item (ex.: `extra.nature`). */
export interface FieldDef {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'money' | 'select' | 'date' | 'cpf' | 'doc' | 'checkbox';
  options?: { value: string; label: string }[];
  required?: boolean;
  wide?: boolean;
  help?: string;
  /** Só aparece (e só é gravado) para estes tipos de linha da ficha. */
  kinds?: ItemKind[];
}

export interface ColumnDef {
  header: string;
  num?: boolean;
  render: (i: ItemRow) => ReactNode;
}

export interface Ficha {
  id: string;
  title: string;
  /** Tipos de linha da ficha; com mais de um, o formulário pede o tipo. */
  kinds: ItemKind[];
  fields: (year: number) => FieldDef[];
  columns: (year: number) => ColumnDef[];
  totals: (items: ItemRow[]) => { label: string; cents: number }[];
}

const opts = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ value, label }));
const extra = (i: ItemRow, k: string) => (i.extra as Record<string, unknown> | undefined)?.[k];
const extraNum = (i: ItemRow, k: string) => {
  const v = extra(i, k);
  return typeof v === 'number' ? v : 0;
};
const sum = (items: ItemRow[], f: (i: ItemRow) => number) => items.reduce((a, i) => a + f(i), 0);
const money = (v: number | undefined) => formatMoney(v ?? 0);
const label = (map: Record<string, string>, v: unknown) => (typeof v === 'string' && v ? (map[v] ?? v) : '—');
const party = (i: ItemRow) => (
  <span className="vf-stack" style={{ gap: 0 } as React.CSSProperties}>
    <span>{i.counterpartyName || i.description || '—'}</span>
    {i.counterpartyDoc && <span className="vf-text-xs vf-muted vf-mono">{formatCpfCnpj(i.counterpartyDoc)}</span>}
  </span>
);
const owner = (i: ItemRow) => (i.ownerName ? <span className="vf-text-xs vf-muted">{i.ownerName}</span> : null);
const dec31 = (y: number) => `31/12/${y}`;

const counterparty = (who = 'Fonte pagadora'): FieldDef[] => [
  { name: 'counterpartyName', label: who, kind: 'text', wide: true },
  { name: 'counterpartyDoc', label: 'CPF/CNPJ', kind: 'doc' },
];
const ownerField: FieldDef = { name: 'ownerName', label: 'Beneficiário (titular ou dependente)', kind: 'text', help: 'Deixe em branco quando for o titular.' };

export const FICHAS: Ficha[] = [
  {
    id: 'dependentes',
    title: 'Dependentes',
    kinds: ['dependent'],
    fields: () => [
      { name: 'ownerName', label: 'Nome', kind: 'text', required: true, wide: true },
      { name: 'ownerCpf', label: 'CPF', kind: 'cpf' },
      { name: 'extra.relationship', label: 'Relação de dependência', kind: 'select', options: opts(DEPENDENT_RELATIONSHIPS), wide: true },
      { name: 'extra.birthDate', label: 'Data de nascimento', kind: 'date' },
    ],
    columns: () => [
      { header: 'Nome', render: (i) => i.ownerName },
      { header: 'CPF', render: (i) => <span className="vf-mono">{formatCpfCnpj(i.ownerCpf) || '—'}</span> },
      { header: 'Relação', render: (i) => label(DEPENDENT_RELATIONSHIPS, extra(i, 'relationship')) },
      { header: 'Nascimento', render: (i) => formatDate(extra(i, 'birthDate') as string) || '—' },
    ],
    totals: () => [],
  },
  {
    id: 'rendimentos-pj',
    title: 'Rendimentos de PJ',
    kinds: ['income_pj'],
    fields: () => [
      ...counterparty(),
      ownerField,
      { name: 'valueCents', label: 'Rendimentos recebidos', kind: 'money', required: true },
      { name: 'extra.officialPensionCents', label: 'Contribuição previdenciária oficial', kind: 'money' },
      { name: 'withheldCents', label: 'Imposto retido na fonte', kind: 'money' },
    ],
    columns: () => [
      { header: 'Fonte pagadora', render: (i) => <>{party(i)}{owner(i)}</> },
      { header: 'Rendimentos', num: true, render: (i) => money(i.valueCents) },
      { header: 'Previdência oficial', num: true, render: (i) => money(extraNum(i, 'officialPensionCents')) },
      { header: 'IR retido', num: true, render: (i) => money(i.withheldCents) },
    ],
    totals: (items) => [
      { label: 'Rendimentos', cents: sum(items, (i) => i.valueCents ?? 0) },
      { label: 'IR retido', cents: sum(items, (i) => i.withheldCents ?? 0) },
    ],
  },
  {
    id: 'rendimentos-pf',
    title: 'Rendimentos de PF/exterior',
    kinds: ['income_pf'],
    fields: () => [
      { name: 'description', label: 'Descrição', kind: 'text', wide: true, help: 'Ex.: aluguel recebido de pessoa física, trabalho sem vínculo, exterior.' },
      ...counterparty('Pagador'),
      ownerField,
      { name: 'valueCents', label: 'Valor recebido no ano', kind: 'money', required: true },
      { name: 'withheldCents', label: 'Carnê-leão pago', kind: 'money' },
    ],
    columns: () => [
      { header: 'Descrição', render: (i) => <>{i.description || '—'}{owner(i)}</> },
      { header: 'Pagador', render: (i) => party({ ...i, description: null }) },
      { header: 'Valor', num: true, render: (i) => money(i.valueCents) },
      { header: 'Carnê-leão', num: true, render: (i) => money(i.withheldCents) },
    ],
    totals: (items) => [
      { label: 'Recebido', cents: sum(items, (i) => i.valueCents ?? 0) },
      { label: 'Carnê-leão', cents: sum(items, (i) => i.withheldCents ?? 0) },
    ],
  },
  {
    id: 'isentos',
    title: 'Isentos',
    kinds: ['income_exempt'],
    fields: () => [
      { name: 'extra.nature', label: 'Natureza', kind: 'select', options: opts(INCOME_NATURES), required: true, wide: true },
      ...counterparty(),
      { name: 'description', label: 'Descrição', kind: 'text', wide: true },
      { name: 'valueCents', label: 'Valor', kind: 'money', required: true },
    ],
    columns: () => [
      { header: 'Natureza', render: (i) => label(INCOME_NATURES, extra(i, 'nature')) },
      { header: 'Fonte', render: party },
      { header: 'Valor', num: true, render: (i) => money(i.valueCents) },
    ],
    totals: (items) => [{ label: 'Isentos', cents: sum(items, (i) => i.valueCents ?? 0) }],
  },
  {
    id: 'exclusivos',
    title: 'Tributação exclusiva',
    kinds: ['income_exclusive'],
    fields: () => [
      { name: 'extra.nature', label: 'Natureza', kind: 'select', options: opts(INCOME_NATURES), required: true, wide: true },
      ...counterparty(),
      { name: 'description', label: 'Descrição', kind: 'text', wide: true },
      { name: 'valueCents', label: 'Valor', kind: 'money', required: true },
      { name: 'withheldCents', label: 'Imposto retido', kind: 'money' },
    ],
    columns: () => [
      { header: 'Natureza', render: (i) => label(INCOME_NATURES, extra(i, 'nature')) },
      { header: 'Fonte', render: party },
      { header: 'Valor', num: true, render: (i) => money(i.valueCents) },
      { header: 'IR retido', num: true, render: (i) => money(i.withheldCents) },
    ],
    totals: (items) => [
      { label: 'Rendimentos', cents: sum(items, (i) => i.valueCents ?? 0) },
      { label: 'IR retido', cents: sum(items, (i) => i.withheldCents ?? 0) },
    ],
  },
  {
    id: 'pagamentos',
    title: 'Pagamentos',
    kinds: ['payment'],
    fields: () => [
      { name: 'extra.nature', label: 'Natureza', kind: 'select', options: opts(PAYMENT_NATURES), required: true, wide: true },
      { name: 'code', label: 'Código', kind: 'text' },
      ...counterparty('Beneficiário do pagamento'),
      { name: 'ownerName', label: 'Paciente, aluno ou alimentando', kind: 'text', help: 'Deixe em branco quando for o titular.' },
      { name: 'valueCents', label: 'Valor pago', kind: 'money', required: true },
      { name: 'extra.reimbursedCents', label: 'Parcela não dedutível / reembolsada', kind: 'money' },
    ],
    columns: () => [
      { header: 'Natureza', render: (i) => <>{label(PAYMENT_NATURES, extra(i, 'nature'))}{owner(i)}</> },
      { header: 'Beneficiário', render: party },
      { header: 'Pago', num: true, render: (i) => money(i.valueCents) },
      { header: 'Reembolso', num: true, render: (i) => money(extraNum(i, 'reimbursedCents')) },
    ],
    totals: (items) => [
      { label: 'Pago', cents: sum(items, (i) => i.valueCents ?? 0) },
      { label: 'Saúde', cents: sum(items.filter((i) => extra(i, 'nature') === 'health'), (i) => (i.valueCents ?? 0) - extraNum(i, 'reimbursedCents')) },
      { label: 'Educação', cents: sum(items.filter((i) => extra(i, 'nature') === 'education'), (i) => (i.valueCents ?? 0) - extraNum(i, 'reimbursedCents')) },
    ],
  },
  {
    id: 'doacoes',
    title: 'Doações',
    kinds: ['donation'],
    fields: () => [{ name: 'code', label: 'Código', kind: 'text' }, ...counterparty('Beneficiário'), { name: 'description', label: 'Descrição', kind: 'text', wide: true }, { name: 'valueCents', label: 'Valor doado', kind: 'money', required: true }],
    columns: () => [
      { header: 'Beneficiário', render: party },
      { header: 'Código', render: (i) => i.code || '—' },
      { header: 'Valor', num: true, render: (i) => money(i.valueCents) },
    ],
    totals: (items) => [{ label: 'Doado', cents: sum(items, (i) => i.valueCents ?? 0) }],
  },
  {
    id: 'bens',
    title: 'Bens e direitos',
    kinds: ['asset'],
    fields: (year) => [
      { name: 'groupCode', label: 'Grupo', kind: 'select', options: Object.entries(ASSET_GROUPS).map(([value, l]) => ({ value, label: `${value} · ${l}` })), required: true, wide: true },
      { name: 'code', label: 'Código', kind: 'text' },
      { name: 'description', label: 'Discriminação', kind: 'textarea', wide: true },
      { name: 'prevValueCents', label: `Situação em ${dec31(year - 2)}`, kind: 'money' },
      { name: 'valueCents', label: `Situação em ${dec31(year - 1)}`, kind: 'money' },
    ],
    columns: (year) => [
      { header: 'Grupo / código', render: (i) => <span className="vf-stack" style={{ gap: 0 } as React.CSSProperties}><span>{label(ASSET_GROUPS, i.groupCode)}</span><span className="vf-text-xs vf-muted">{[i.groupCode, i.code].filter(Boolean).join(' · ')}</span></span> },
      { header: 'Discriminação', render: (i) => <span style={{ display: 'block', maxWidth: 360, whiteSpace: 'normal' }}>{i.description || '—'}</span> },
      { header: dec31(year - 2), num: true, render: (i) => money(i.prevValueCents) },
      { header: dec31(year - 1), num: true, render: (i) => money(i.valueCents) },
    ],
    totals: (items) => [
      { label: 'Ano anterior', cents: sum(items, (i) => i.prevValueCents ?? 0) },
      { label: 'Ano atual', cents: sum(items, (i) => i.valueCents ?? 0) },
    ],
  },
  {
    id: 'dividas',
    title: 'Dívidas',
    kinds: ['debt'],
    fields: (year) => [
      { name: 'code', label: 'Código', kind: 'text' },
      ...counterparty('Credor'),
      { name: 'description', label: 'Discriminação', kind: 'textarea', wide: true },
      { name: 'prevValueCents', label: `Situação em ${dec31(year - 2)}`, kind: 'money' },
      { name: 'valueCents', label: `Situação em ${dec31(year - 1)}`, kind: 'money' },
    ],
    columns: (year) => [
      { header: 'Credor', render: party },
      { header: 'Discriminação', render: (i) => <span style={{ display: 'block', maxWidth: 320, whiteSpace: 'normal' }}>{i.description || '—'}</span> },
      { header: dec31(year - 2), num: true, render: (i) => money(i.prevValueCents) },
      { header: dec31(year - 1), num: true, render: (i) => money(i.valueCents) },
    ],
    totals: (items) => [
      { label: 'Ano anterior', cents: sum(items, (i) => i.prevValueCents ?? 0) },
      { label: 'Ano atual', cents: sum(items, (i) => i.valueCents ?? 0) },
    ],
  },
  {
    id: 'rural',
    title: 'Atividade rural',
    kinds: ['rural_income', 'rural_expense', 'rural_asset', 'rural_debt'],
    fields: (year) => [
      { name: 'description', label: 'Descrição', kind: 'text', wide: true },
      { name: 'prevValueCents', label: `Situação em ${dec31(year - 2)}`, kind: 'money', help: 'Só para bens e dívidas da atividade.' },
      { name: 'valueCents', label: 'Valor no ano', kind: 'money', required: true },
      {
        name: 'extra.investment',
        label: 'Despesa de investimento (bem da atividade)',
        kind: 'checkbox',
        wide: true,
        kinds: ['rural_expense'],
        help: 'Marque quando a despesa comprou um bem da atividade rural lançado também nos bens: a análise de caixa não conta o valor duas vezes.',
      },
    ],
    columns: () => [
      {
        header: 'Tipo',
        render: (i) => (
          <>
            {ITEM_KINDS[i.kind].label}
            {extra(i, 'investment') === true && <span className="vf-text-xs vf-muted"> · investimento</span>}
          </>
        ),
      },
      { header: 'Descrição', render: (i) => i.description || '—' },
      { header: 'Anterior', num: true, render: (i) => (i.kind === 'rural_asset' || i.kind === 'rural_debt' ? money(i.prevValueCents) : '—') },
      { header: 'Valor', num: true, render: (i) => money(i.valueCents) },
    ],
    totals: (items) => {
      const income = sum(items.filter((i) => i.kind === 'rural_income'), (i) => i.valueCents ?? 0);
      const expense = sum(items.filter((i) => i.kind === 'rural_expense'), (i) => i.valueCents ?? 0);
      return [
        { label: 'Receitas', cents: income },
        { label: 'Despesas', cents: expense },
        { label: 'Resultado', cents: income - expense },
      ];
    },
  },
  {
    id: 'outros',
    title: 'Outras fichas',
    kinds: ['income_suspended', 'income_accumulated', 'capital_gain', 'variable_income', 'tax_paid'],
    fields: () => [
      { name: 'description', label: 'Descrição', kind: 'text', wide: true },
      ...counterparty(),
      { name: 'valueCents', label: 'Valor', kind: 'money', required: true },
      { name: 'withheldCents', label: 'Imposto retido/pago', kind: 'money' },
    ],
    columns: () => [
      { header: 'Ficha', render: (i) => ITEM_KINDS[i.kind].ficha },
      { header: 'Descrição', render: (i) => <>{i.description || '—'}{i.counterpartyName ? <span className="vf-text-xs vf-muted"> · {i.counterpartyName}</span> : null}</> },
      { header: 'Valor', num: true, render: (i) => money(i.valueCents) },
      { header: 'IR', num: true, render: (i) => money(i.withheldCents) },
    ],
    totals: (items) => [{ label: 'Valor', cents: sum(items, (i) => i.valueCents ?? 0) }],
  },
];
