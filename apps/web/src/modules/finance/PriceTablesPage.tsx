import { useEffect, useState } from 'react';
import { MoreHorizontal, Pencil, Plus, Star, Table2, Trash2, X } from 'lucide-react';
import { PRICE_TABLE_TYPE_OPTIONS, PRICING_BASES, currentExerciseYear, type PriceTableConfigShape, type PricingBase } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, EmptyState, IconButton, Input, Loading, Menu, MenuItem, Modal, MoneyInput, Select, Switch, Tag } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fieldErrors, useAction, useApi } from '../../lib/hooks';
import { formatDate, formatMoney } from '../../lib/format';
import type { PriceTable } from './types';
import { formatNumber, parseNumber } from './ui';

const KEY = ['finance', 'price-tables'];
const BASE_OPTIONS = Object.entries(PRICING_BASES).map(([value, label]) => ({ value, label }));

type Item = { code: string; label: string; unitPriceCents: number };
type Form = {
  name: string;
  type: PriceTable['type'];
  active: boolean;
  isDefault: boolean;
  validFrom: string;
  validUntil: string;
  amountCents: number;
  hourRateCents: number;
  minHours: string;
  items: Item[];
  percent: string;
  base: string;
  minCents: number;
  maxCents: number;
};

const firstOfYear = () => `${currentExerciseYear()}-01-01`;
const emptyForm = (): Form => ({
  name: '',
  type: 'fixed',
  active: true,
  isDefault: false,
  validFrom: firstOfYear(),
  validUntil: '',
  amountCents: 0,
  hourRateCents: 0,
  minHours: '',
  items: [{ code: '', label: '', unitPriceCents: 0 }],
  percent: '',
  base: 'tax_due',
  minCents: 0,
  maxCents: 0,
});

/** Resumo da regra de cobrança para a listagem. */
export function describeTable(t: Pick<PriceTable, 'type' | 'config'>): string {
  const c = t.config ?? {};
  switch (t.type) {
    case 'fixed':
      return formatMoney(c.amountCents ?? 0);
    case 'hourly':
      return `${formatMoney(c.hourRateCents ?? 0)}/hora${c.minHours ? ` · mínimo de ${formatNumber(c.minHours)}h` : ''}`;
    case 'items':
      return `${c.items?.length ?? 0} item(ns) · a partir de ${formatMoney(Math.min(...(c.items ?? []).map((i) => i.unitPriceCents), Infinity) || 0)}`;
    case 'percentage': {
      const base = PRICING_BASES[c.base as PricingBase]?.toLowerCase() ?? 'base';
      const lim = [c.minCents ? `mín. ${formatMoney(c.minCents)}` : '', c.maxCents ? `máx. ${formatMoney(c.maxCents)}` : ''].filter(Boolean).join(' · ');
      return `${formatNumber(c.percent ?? 0)}% sobre ${base}${lim ? ` · ${lim}` : ''}`;
    }
  }
}

export function PriceTablesPage() {
  const { can } = useAuth();
  const list = useApi<PriceTable[]>(KEY, can('price_table.list') ? '/finance/price-tables' : null);
  const [editing, setEditing] = useState<PriceTable | 'new' | null>(null);
  const [removing, setRemoving] = useState<PriceTable | null>(null);
  const remove = useAction((id: string) => api.del(`/finance/price-tables/${id}`), {
    success: 'Tabela excluída.',
    invalidate: [KEY],
    onSuccess: () => setRemoving(null),
  });
  const setDefault = useAction((t: PriceTable) => api.put(`/finance/price-tables/${t.id}`, { ...toBody(toForm(t)), isDefault: true }), {
    success: 'Tabela padrão atualizada.',
    invalidate: [KEY],
  });
  const rows = list.data ?? [];
  if (!can('price_table.list')) return <EmptyState title="Sem acesso" description="Seu perfil não tem permissão para ver as tabelas de cobrança." />;

  return (
    <>
      <PageHeader
        title="Tabelas de cobrança"
        description="Regras de preço usadas para calcular o valor dos orçamentos: valor fixo, por hora, por itens ou percentual sobre a declaração."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Financeiro' }, { label: 'Tabelas de cobrança' }]}
        actions={
          can('price_table.create') && (
            <Button icon={<Plus />} onClick={() => setEditing('new')}>
              Nova tabela
            </Button>
          )
        }
      />
      <Card flush>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div style={{ padding: 24 }}>
            <Alert tone="danger" title="Não foi possível carregar as tabelas.">
              Atualize a página ou tente novamente em instantes.
            </Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Table2 />}
            title="Nenhuma tabela cadastrada"
            description="Crie uma tabela para calcular os orçamentos automaticamente."
            action={can('price_table.create') && <Button onClick={() => setEditing('new')}>Nova tabela</Button>}
          />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Tipo</th>
                  <th>Regra</th>
                  <th>Validade</th>
                  <th>Situação</th>
                  <th className="actions" aria-label="Opções" />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="vf-inline">
                        <span className="vf-text-sm-bold">{t.name}</span>
                        {t.isDefault && (
                          <Tag tone="primary" icon={<Star size={12} />}>
                            Padrão
                          </Tag>
                        )}
                      </div>
                    </td>
                    <td>{t.typeLabel}</td>
                    <td className="vf-text-sm">{describeTable(t)}</td>
                    <td className="vf-text-sm" style={{ whiteSpace: 'nowrap' }}>
                      {formatDate(t.validFrom)} {t.validUntil ? `a ${formatDate(t.validUntil)}` : 'em diante'}
                    </td>
                    <td>{!t.active ? <Tag>Inativa</Tag> : t.validNow ? <Tag tone="success">Vigente</Tag> : <Tag tone="warning">Fora da validade</Tag>}</td>
                    <td className="actions">
                      {(can('price_table.edit') || can('price_table.delete')) && (
                        <Menu
                          trigger={(tg) => (
                            <IconButton label={`Opções de ${t.name}`} onClick={tg}>
                              <MoreHorizontal />
                            </IconButton>
                          )}
                        >
                          {(close) => (
                            <>
                              {can('price_table.edit') && (
                                <MenuItem icon={<Pencil />} onClick={() => (close(), setEditing(t))}>
                                  Editar
                                </MenuItem>
                              )}
                              {can('price_table.edit') && !t.isDefault && t.active && (
                                <MenuItem icon={<Star />} onClick={() => (close(), setDefault.mutate(t))}>
                                  Definir como padrão
                                </MenuItem>
                              )}
                              {can('price_table.delete') && (
                                <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setRemoving(t))}>
                                  Excluir
                                </MenuItem>
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
        )}
      </Card>

      <TableModal table={editing} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={Boolean(removing)}
        danger
        title="Excluir tabela de cobrança"
        message={
          removing && removing.budgets > 0
            ? `"${removing.name}" já foi usada em ${removing.budgets} orçamento(s) e não pode ser excluída. Inative-a para que não apareça em novos orçamentos.`
            : `A tabela "${removing?.name}" será excluída. Esta ação não pode ser desfeita.`
        }
        confirmLabel="Excluir"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}

function toForm(t: PriceTable): Form {
  const c = t.config ?? {};
  return {
    ...emptyForm(),
    name: t.name,
    type: t.type,
    active: t.active,
    isDefault: t.isDefault,
    validFrom: t.validFrom,
    validUntil: t.validUntil ?? '',
    amountCents: c.amountCents ?? 0,
    hourRateCents: c.hourRateCents ?? 0,
    minHours: c.minHours ? formatNumber(c.minHours) : '',
    items: c.items?.length ? c.items : emptyForm().items,
    percent: c.percent ? formatNumber(c.percent) : '',
    base: c.base ?? 'tax_due',
    minCents: c.minCents ?? 0,
    maxCents: c.maxCents ?? 0,
  };
}

function toBody(f: Form) {
  const config: PriceTableConfigShape =
    f.type === 'fixed'
      ? { amountCents: f.amountCents }
      : f.type === 'hourly'
        ? { hourRateCents: f.hourRateCents, minHours: parseNumber(f.minHours) ?? 0 }
        : f.type === 'items'
          ? { items: f.items.filter((i) => i.code.trim() || i.label.trim() || i.unitPriceCents) }
          : { percent: parseNumber(f.percent) ?? 0, base: f.base as PricingBase, minCents: f.minCents || undefined, maxCents: f.maxCents || undefined };
  return { name: f.name, type: f.type, active: f.active, isDefault: f.isDefault, validFrom: f.validFrom, validUntil: f.validUntil || null, config };
}

function TableModal({ table, onClose }: { table: PriceTable | 'new' | null; onClose: () => void }) {
  const [f, setF] = useState<Form>(emptyForm);
  useEffect(() => {
    if (table === 'new') setF(emptyForm());
    else if (table) setF(toForm(table));
  }, [table]);
  const isNew = table === 'new';
  const save = useAction(() => (isNew ? api.post('/finance/price-tables', toBody(f)) : api.put(`/finance/price-tables/${(table as PriceTable).id}`, toBody(f))), {
    success: isNew ? 'Tabela cadastrada.' : 'Tabela atualizada.',
    invalidate: [KEY],
    onSuccess: onClose,
  });
  const errors = fieldErrors(save.error);
  const setItem = (i: number, patch: Partial<Item>) => setF((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const pct = parseNumber(f.percent);
  const valid =
    f.name.trim().length >= 2 &&
    Boolean(f.validFrom) &&
    (!f.validUntil || f.validUntil >= f.validFrom) &&
    (f.type !== 'fixed' || f.amountCents > 0) &&
    (f.type !== 'hourly' || f.hourRateCents > 0) &&
    (f.type !== 'items' || f.items.some((i) => i.code.trim() && i.label.trim() && i.unitPriceCents > 0)) &&
    (f.type !== 'percentage' || (pct !== null && pct > 0 && pct <= 100 && (!f.maxCents || f.maxCents >= f.minCents)));

  return (
    <Modal
      open={table !== null}
      title={isNew ? 'Nova tabela de cobrança' : 'Editar tabela de cobrança'}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="vf-stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
          <Input label="Nome" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={errors.name} autoFocus placeholder="Ex.: Declaração completa 2026" />
          <Select label="Tipo de tabela" required value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Form['type'] })} options={PRICE_TABLE_TYPE_OPTIONS} />
          <Input label="Válida a partir de" required type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} error={errors.validFrom} />
          <Input
            label="Válida até (opcional)"
            type="date"
            value={f.validUntil}
            min={f.validFrom}
            onChange={(e) => setF({ ...f, validUntil: e.target.value })}
            error={errors.validUntil ?? (f.validUntil && f.validUntil < f.validFrom ? 'Deve ser depois da data inicial' : undefined)}
          />
        </div>

        <div className="vf-fin-panel">
          <span className="vf-text-sm-bold">Regra de cobrança</span>
          {f.type === 'fixed' && (
            <MoneyInput label="Valor" required value={f.amountCents} onChange={(v) => setF({ ...f, amountCents: v })} error={errors['config.amountCents']} style={{ maxWidth: 240 }} />
          )}
          {f.type === 'hourly' && (
            <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
              <MoneyInput label="Valor da hora" required value={f.hourRateCents} onChange={(v) => setF({ ...f, hourRateCents: v })} error={errors['config.hourRateCents']} />
              <Input label="Mínimo de horas" inputMode="decimal" value={f.minHours} onChange={(e) => setF({ ...f, minHours: e.target.value })} help="Cobrado mesmo que o trabalho leve menos tempo." />
            </div>
          )}
          {f.type === 'items' && (
            <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
              {errors['config.items'] && <span className="vf-field__error">{errors['config.items']}</span>}
              <div className="vf-fin-items vf-fin-items--head vf-text-xs-bold vf-muted">
                <span>Código</span>
                <span>Descrição</span>
                <span>Preço unitário</span>
                <span />
              </div>
              {f.items.map((it, i) => (
                <div key={i} className="vf-fin-items">
                  <Input aria-label="Código" value={it.code} placeholder="DEP" onChange={(e) => setItem(i, { code: e.target.value.toUpperCase() })} />
                  <Input aria-label="Descrição" value={it.label} placeholder="Dependente" onChange={(e) => setItem(i, { label: e.target.value })} />
                  <MoneyInput aria-label="Preço unitário" value={it.unitPriceCents} onChange={(v) => setItem(i, { unitPriceCents: v })} />
                  <IconButton label="Remover item" disabled={f.items.length === 1} onClick={() => setF({ ...f, items: f.items.filter((_, j) => j !== i) })}>
                    <X />
                  </IconButton>
                </div>
              ))}
              <div>
                <Button kind="tertiary" size="sm" icon={<Plus />} onClick={() => setF({ ...f, items: [...f.items, { code: '', label: '', unitPriceCents: 0 }] })}>
                  Adicionar item
                </Button>
              </div>
            </div>
          )}
          {f.type === 'percentage' && (
            <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
              <Input
                label="Percentual"
                required
                inputMode="decimal"
                suffix="%" className="vf-fin-plain"
                value={f.percent}
                onChange={(e) => setF({ ...f, percent: e.target.value })}
                error={errors['config.percent'] ?? (f.percent && !(pct !== null && pct > 0 && pct <= 100) ? 'De 0 a 100' : undefined)}
              />
              <Select label="Base de cálculo" required value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })} options={BASE_OPTIONS} help="Valor da declaração do exercício do orçamento." />
              <MoneyInput label="Valor mínimo" value={f.minCents} onChange={(v) => setF({ ...f, minCents: v })} />
              <MoneyInput
                label="Valor máximo"
                value={f.maxCents}
                onChange={(v) => setF({ ...f, maxCents: v })}
                error={errors['config.maxCents'] ?? (f.maxCents && f.maxCents < f.minCents ? 'Menor que o mínimo' : undefined)}
                help="Deixe zerado para não limitar."
              />
            </div>
          )}
        </div>

        <div className="vf-inline" style={{ '--gap': '24px' } as React.CSSProperties}>
          <Switch label={f.active ? 'Ativa' : 'Inativa'} checked={f.active} onChange={(v) => setF({ ...f, active: v, isDefault: v ? f.isDefault : false })} />
          <Checkbox label="Definir como padrão" checked={f.isDefault} disabled={!f.active} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} />
        </div>
      </div>
    </Modal>
  );
}
