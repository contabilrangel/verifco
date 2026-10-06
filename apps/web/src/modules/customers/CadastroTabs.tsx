import { useEffect, useState, type ReactNode } from 'react';
import { KeyRound, Save } from 'lucide-react';
import { SEX_OPTIONS, formatCep } from '@verifco/shared';
import { Button, Card, Checkbox, Input, Select, Textarea } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatCpfCnpj } from '../../lib/format';
import { useCustomer, type CustomerDetail } from './customerContext';

// ---------------------------------------------------------------- Identificação
export function IdentificationTab() {
  const { customer: c, refetch } = useCustomer();
  const { can } = useAuth();
  const employees = useApi<{ id: string; name: string }[]>(['employees'], '/employees');
  const procurators = useApi<{ id: string; name: string }[]>(['procurators'], '/procurators');
  const groups = useApi<{ id: string; name: string }[]>(['customer-groups'], '/customer-groups');
  const [form, setForm] = useState(() => toForm(c));
  useEffect(() => setForm(toForm(c)), [c]);
  const set = (k: keyof ReturnType<typeof toForm>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useAction(
    () =>
      api.put(`/customers/${c.id}/identification`, {
        ...form,
        responsibleUserId: form.responsibleUserId || null,
        procuratorId: form.procuratorId || null,
      }),
    { success: 'Identificação salva.', invalidate: [['customers']], onSuccess: refetch },
  );
  const portal = useAction(() => api.post<{ code?: string }>(`/customers/${c.id}/portal-access`), {
    success: (r) => (r.code ? `Acesso enviado por e-mail (código ${r.code}).` : 'Acesso enviado por e-mail ao cliente.'),
    onSuccess: refetch,
  });
  const readOnly = !can('customer.edit');

  return (
    <Card
      title="Identificação"
      actions={
        can('customer.portal_access') && (
          <Button kind="secondary" icon={<KeyRound />} loading={portal.isPending} disabled={!c.email} onClick={() => portal.mutate(undefined)} title={!c.email ? 'Cadastre o e-mail do cliente' : undefined}>
            {c.portalEnabled ? 'Reenviar acesso ao portal' : 'Gerar acesso ao portal do cliente'}
          </Button>
        )
      }
    >
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
          <Input label="Nome completo" required value={form.name} onChange={set('name')} span={2} />
          <Input label="CPF/CNPJ" value={formatCpfCnpj(c.cpfCnpj)} disabled help="Não pode ser alterado" />
          <Input label="Título de eleitor" value={form.voterTitle} onChange={set('voterTitle')} />
          <Input label="Data de nascimento" type="date" value={form.birthDate} onChange={set('birthDate')} />
          <Select label="Sexo" placeholder="Não informado" value={form.sex} onChange={set('sex')} options={SEX_OPTIONS} />
          <Input label="E-mail" type="email" value={form.email} onChange={set('email')} />
          <div className="vf-inline" style={{ alignItems: 'flex-end', flexWrap: 'nowrap' }}>
            <Input label="DDI" value={form.mobileCountry} onChange={set('mobileCountry')} style={{ width: 72 }} />
            <Input label="Celular" value={form.mobile} onChange={set('mobile')} style={{ flex: 1 }} />
          </div>
          <div className="vf-inline" style={{ alignItems: 'flex-end', flexWrap: 'nowrap' }}>
            <Input label="DDI" value={form.phoneCountry} onChange={set('phoneCountry')} style={{ width: 72 }} />
            <Input label="Telefone" value={form.phone} onChange={set('phone')} style={{ flex: 1 }} />
          </div>
          <Select label="Responsável" placeholder="Sem responsável" value={form.responsibleUserId} onChange={set('responsibleUserId')} options={(employees.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
          <Select label="Situação" value={form.status} onChange={set('status')} options={[{ value: 'active', label: 'Ativo' }, { value: 'inactive', label: 'Inativo' }]} />
          <Select label="Procurador" placeholder="Sem procurador" value={form.procuratorId} onChange={set('procuratorId')} options={(procurators.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        </div>
        <div style={{ marginTop: 16 }}>
          <span className="vf-field__label">Grupos</span>
          <div className="vf-inline" style={{ marginTop: 8, '--gap': '16px' } as React.CSSProperties}>
            {(groups.data ?? []).map((g) => (
              <Checkbox
                key={g.id}
                label={g.name}
                checked={form.groupIds.includes(g.id)}
                onChange={() => setForm((f) => ({ ...f, groupIds: f.groupIds.includes(g.id) ? f.groupIds.filter((x) => x !== g.id) : [...f.groupIds, g.id] }))}
              />
            ))}
            {groups.data?.length === 0 && <span className="vf-muted">Nenhum grupo cadastrado.</span>}
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <Textarea label="Observação" value={form.notes} onChange={set('notes')} />
        </div>
      </fieldset>
      {!readOnly && (
        <div className="vf-inline vf-end" style={{ marginTop: 24 }}>
          <Button icon={<Save />} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </div>
      )}
    </Card>
  );
}

function toForm(c: CustomerDetail) {
  return {
    name: c.name,
    voterTitle: c.voterTitle ?? '',
    birthDate: c.birthDate ?? '',
    sex: c.sex ?? '',
    email: c.email ?? '',
    mobileCountry: c.mobileCountry ?? '55',
    mobile: c.mobile ?? '',
    phoneCountry: c.phoneCountry ?? '55',
    phone: c.phone ?? '',
    responsibleUserId: c.responsibleUserId ?? '',
    procuratorId: c.procuratorId ?? '',
    status: c.status,
    notes: c.notes ?? '',
    groupIds: c.groups.map((g) => g.id),
  };
}

// ---------------------------------------------------------------- Endereço
const ADDRESS_FIELDS: [string, string, 1 | 2][] = [
  ['street', 'Endereço', 2],
  ['number', 'Número', 1],
  ['complement', 'Complemento', 1],
  ['neighborhood', 'Bairro', 1],
  ['city', 'Cidade', 1],
  ['state', 'UF', 1],
  ['zip', 'CEP', 1],
];

function AddressForm({ title, value, onChange, disabled }: { title: string; value: Record<string, string | undefined>; onChange: (v: Record<string, string>) => void; disabled?: boolean }) {
  return (
    <Card title={title}>
      <div className="vf-grid" style={{ '--cols': 4 } as React.CSSProperties}>
        {ADDRESS_FIELDS.map(([k, label, span]) => (
          <Input
            key={k}
            label={label}
            disabled={disabled}
            value={k === 'zip' ? formatCep(value[k] ?? '') : (value[k] ?? '')}
            onChange={(e) => onChange({ ...(value as Record<string, string>), [k]: e.target.value })}
            span={span === 2 ? 2 : undefined}
            maxLength={k === 'state' ? 2 : undefined}
          />
        ))}
      </div>
    </Card>
  );
}

export function AddressTab() {
  const { customer: c, refetch } = useCustomer();
  const { can } = useAuth();
  const [main, setMain] = useState<Record<string, string>>((c.address ?? {}) as Record<string, string>);
  const [second, setSecond] = useState<Record<string, string>>((c.secondaryAddress ?? {}) as Record<string, string>);
  const save = useAction(() => api.put(`/customers/${c.id}/address`, { address: main, secondaryAddress: second }), { success: 'Endereço salvo.', onSuccess: refetch });
  const ro = !can('customer.edit');
  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
      <AddressForm title="Endereço principal" value={main} onChange={setMain} disabled={ro} />
      <AddressForm title="Endereço secundário" value={second} onChange={setSecond} disabled={ro} />
      {!ro && (
        <div className="vf-inline vf-end">
          <Button icon={<Save />} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </div>
      )}
    </div>
  );
}

export function TabSection({ children }: { children: ReactNode }) {
  return <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>{children}</div>;
}
