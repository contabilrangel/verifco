import { useEffect, useState } from 'react';
import { CreditCard, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { PAYMENT_METHOD_TYPE_OPTIONS } from '@verifco/shared';
import { Alert, Button, Card, Checkbox, ConfirmDialog, EmptyState, IconButton, Input, Loading, Menu, MenuItem, Modal, Select, Switch, Tag } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fieldErrors, useAction, useApi } from '../../lib/hooks';
import type { PaymentMethod } from './types';

type Form = { type: string; name: string; maxInstallments: string; active: boolean; isDefault: boolean };
const EMPTY: Form = { type: 'pix', name: '', maxInstallments: '1', active: true, isDefault: false };
const KEY = ['finance', 'payment-methods'];

export function PaymentMethodsPage() {
  const { can } = useAuth();
  const list = useApi<PaymentMethod[]>(KEY, can('payment_method.list') ? '/finance/payment-methods' : null);
  const [editing, setEditing] = useState<PaymentMethod | 'new' | null>(null);
  const [removing, setRemoving] = useState<PaymentMethod | null>(null);

  const quick = useAction((m: PaymentMethod & { patch: Partial<PaymentMethod> }) => api.put(`/finance/payment-methods/${m.id}`, { ...pick(m), ...m.patch }), {
    success: 'Método atualizado.',
    invalidate: [KEY],
  });
  const remove = useAction((id: string) => api.del(`/finance/payment-methods/${id}`), {
    success: 'Método excluído.',
    invalidate: [KEY],
    onSuccess: () => setRemoving(null),
  });

  const rows = list.data ?? [];
  if (!can('payment_method.list')) return <EmptyState title="Sem acesso" description="Seu perfil não tem permissão para ver os métodos de pagamento." />;
  return (
    <>
      <PageHeader
        title="Métodos de pagamento"
        description="Formas de pagamento oferecidas nos orçamentos, com o limite de parcelas de cada uma."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Financeiro' }, { label: 'Métodos de pagamento' }]}
        actions={
          can('payment_method.create') && (
            <Button icon={<Plus />} onClick={() => setEditing('new')}>
              Novo método
            </Button>
          )
        }
      />
      <Card flush>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div style={{ padding: 24 }}>
            <Alert tone="danger" title="Não foi possível carregar os métodos.">
              Atualize a página ou tente novamente em instantes.
            </Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<CreditCard />}
            title="Nenhum método cadastrado"
            description="Cadastre Pix, boleto, cartão ou uma cobrança integrada para usar nos orçamentos."
            action={can('payment_method.create') && <Button onClick={() => setEditing('new')}>Novo método</Button>}
          />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Tipo</th>
                  <th className="num">Máx. de parcelas</th>
                  <th>Situação</th>
                  <th className="num">Orçamentos</th>
                  <th className="actions" aria-label="Opções" />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="vf-inline">
                        <span className="vf-text-sm-bold">{m.name}</span>
                        {m.isDefault && (
                          <Tag tone="primary" icon={<Star size={12} />}>
                            Padrão
                          </Tag>
                        )}
                      </div>
                    </td>
                    <td>{m.typeLabel}</td>
                    <td className="num">{m.maxInstallments}x</td>
                    <td>{m.active ? <Tag tone="success">Ativo</Tag> : <Tag>Inativo</Tag>}</td>
                    <td className="num">{m.budgets}</td>
                    <td className="actions">
                      {(can('payment_method.edit') || can('payment_method.delete')) && (
                        <Menu
                          trigger={(t) => (
                            <IconButton label={`Opções de ${m.name}`} onClick={t}>
                              <MoreHorizontal />
                            </IconButton>
                          )}
                        >
                          {(close) => (
                            <>
                              {can('payment_method.edit') && (
                                <>
                                  <MenuItem icon={<Pencil />} onClick={() => (close(), setEditing(m))}>
                                    Editar
                                  </MenuItem>
                                  {!m.isDefault && m.active && (
                                    <MenuItem icon={<Star />} onClick={() => (close(), quick.mutate({ ...m, patch: { isDefault: true } }))}>
                                      Definir como padrão
                                    </MenuItem>
                                  )}
                                  <MenuItem onClick={() => (close(), quick.mutate({ ...m, patch: { active: !m.active, isDefault: m.active ? false : m.isDefault } }))}>
                                    {m.active ? 'Inativar' : 'Ativar'}
                                  </MenuItem>
                                </>
                              )}
                              {can('payment_method.delete') && (
                                <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setRemoving(m))}>
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

      <MethodModal method={editing} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={Boolean(removing)}
        danger
        title="Excluir método de pagamento"
        message={
          removing && removing.budgets > 0
            ? `"${removing.name}" já foi usado em ${removing.budgets} orçamento(s) e não pode ser excluído. Inative-o para que não apareça em novos orçamentos.`
            : `O método "${removing?.name}" será excluído. Esta ação não pode ser desfeita.`
        }
        confirmLabel="Excluir"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}

const pick = (m: PaymentMethod) => ({ type: m.type, name: m.name, maxInstallments: m.maxInstallments, active: m.active, isDefault: m.isDefault });

function MethodModal({ method, onClose }: { method: PaymentMethod | 'new' | null; onClose: () => void }) {
  const [form, setForm] = useState<Form>(EMPTY);
  useEffect(() => {
    if (method === 'new') setForm(EMPTY);
    else if (method) setForm({ ...pick(method), maxInstallments: String(method.maxInstallments) });
  }, [method]);
  const isNew = method === 'new';
  const save = useAction(
    () => {
      const body = { ...form, maxInstallments: Number(form.maxInstallments) };
      return isNew ? api.post('/finance/payment-methods', body) : api.put(`/finance/payment-methods/${(method as PaymentMethod).id}`, body);
    },
    { success: isNew ? 'Método cadastrado.' : 'Método atualizado.', invalidate: [KEY], onSuccess: onClose },
  );
  const errors = fieldErrors(save.error);
  const max = Number(form.maxInstallments);
  const valid = form.name.trim().length >= 2 && Number.isInteger(max) && max >= 1 && max <= 48;
  return (
    <Modal
      open={method !== null}
      title={isNew ? 'Novo método de pagamento' : 'Editar método de pagamento'}
      onClose={onClose}
      width={520}
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
      <form
        className="vf-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate(undefined);
        }}
      >
        <Select label="Tipo" required value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={PAYMENT_METHOD_TYPE_OPTIONS} help={['asaas', 'omie'].includes(form.type) ? 'As parcelas aprovadas viram cobranças no provedor configurado em Integrações.' : undefined} />
        <Input label="Nome" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Pix, Boleto em até 3x" error={errors.name} autoFocus />
        <Input
          label="Máximo de parcelas"
          required
          type="number"
          min={1}
          max={48}
          value={form.maxInstallments}
          onChange={(e) => setForm({ ...form, maxInstallments: e.target.value })}
          error={errors.maxInstallments ?? (form.maxInstallments && !(max >= 1 && max <= 48) ? 'De 1 a 48' : undefined)}
          style={{ maxWidth: 200 }}
        />
        <Switch label={form.active ? 'Ativo' : 'Inativo'} checked={form.active} onChange={(v) => setForm({ ...form, active: v, isDefault: v ? form.isDefault : false })} />
        <Checkbox label="Definir como padrão nos novos orçamentos" checked={form.isDefault} disabled={!form.active} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
