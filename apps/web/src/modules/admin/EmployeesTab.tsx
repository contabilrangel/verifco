import { useEffect, useMemo, useState } from 'react';
import { Copy, Mail, Pencil, Power, Trash2, UserPlus, Users } from 'lucide-react';
import { isValidEmail } from '@verifco/shared';
import { Alert, Avatar, Button, Card, ConfirmDialog, EmptyState, Input, Loading, MenuItem, Modal, Select, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { RowMenu, SearchBox, matches, type EmployeeRow, type RoleRow } from './shared';

type StatusFilter = '' | 'active' | 'inactive' | 'pending';
type Confirm = { kind: 'toggle' | 'delete' | 'invite'; employee: EmployeeRow } | null;
/** Resposta do convite: sem e-mail (`emailSent: false`), vem o link para entregar por outro meio. */
interface InviteResult {
  emailSent?: boolean;
  inviteLink?: string;
}

/** Aba Colaboradores: equipe do escritório, convites, funções e situação de acesso. */
export function EmployeesTab() {
  const { can, me } = useAuth();
  const list = useApi<EmployeeRow[]>(['employees'], '/employees');
  const roles = useApi<RoleRow[]>(['roles'], '/roles');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [editing, setEditing] = useState<EmployeeRow | 'new' | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const rows = useMemo(
    () =>
      (list.data ?? []).filter(
        (e) =>
          matches(search, e.name, e.email, e.roleName) &&
          (status === '' ||
            (status === 'active' && e.isActive && !e.invitePending) ||
            (status === 'inactive' && !e.isActive) ||
            (status === 'pending' && e.isActive && e.invitePending)),
      ),
    [list.data, search, status],
  );

  const toggleActive = useAction(
    (e: EmployeeRow) => api.put(`/employees/${e.id}`, { name: e.name, email: e.email, roleId: e.roleId, isActive: !e.isActive }),
    { success: 'Situação do colaborador atualizada.', invalidate: [['employees']], onSuccess: () => setConfirm(null) },
  );
  const remove = useAction((e: EmployeeRow) => api.del(`/employees/${e.id}`), {
    success: 'Colaborador excluído.',
    invalidate: [['employees'], ['roles']],
    onSuccess: () => setConfirm(null),
  });
  const toast = useToast();
  // quando o e-mail não sai, quem convidou recebe o link para entregar por outro meio
  const [manualInvite, setManualInvite] = useState<{ name: string; link: string } | null>(null);
  const resend = useAction((e: EmployeeRow) => api.post<InviteResult>(`/employees/${e.id}/invite`), {
    onSuccess: (r, e) => {
      setConfirm(null);
      if (r.emailSent === false && r.inviteLink) setManualInvite({ name: e.name, link: r.inviteLink });
      else toast.success('Convite reenviado por e-mail.');
    },
  });

  const canInvite = can('employee.create', 'employee.edit');

  return (
    <>
      <Card
        className="adm-card"
        flush
        title="Colaboradores"
        actions={
          can('employee.create') && (
            <Button icon={<UserPlus />} onClick={() => setEditing('new')}>
              Convidar colaborador
            </Button>
          )
        }
      >
        <div className="adm-toolbar">
          <SearchBox value={search} onChange={setSearch} placeholder="Buscar por nome, e-mail ou função" />
          <Select
            aria-label="Situação"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            options={[
              { value: '', label: 'Todas as situações' },
              { value: 'active', label: 'Ativos' },
              { value: 'pending', label: 'Convite pendente' },
              { value: 'inactive', label: 'Inativos' },
            ]}
            style={{ width: 220 }}
          />
        </div>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div style={{ padding: 16 }}>
            <Alert tone="danger" title="Não foi possível carregar os colaboradores." />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={search || status ? 'Nenhum colaborador encontrado' : 'Só você por aqui'}
            description={search || status ? 'Revise a busca ou o filtro.' : 'Convide a equipe para dividir a carteira de clientes. Cada pessoa recebe um link por e-mail para criar a senha.'}
          />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>E-mail</th>
                  <th>Função</th>
                  <th>Situação</th>
                  <th>Último acesso</th>
                  <th className="actions">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const self = e.id === me?.user.id;
                  const canToggle = can('employee.edit') && !e.isOwner && !self;
                  const canDelete = can('employee.delete') && !e.isOwner && !self;
                  return (
                    <tr key={e.id}>
                      <td>
                        <div className="adm-person">
                          <Avatar name={e.name} size={32} />
                          <div className="adm-person__text">
                            <span className="vf-text-sm-bold">{e.name}</span>
                            {(self || e.isOwner) && (
                              <span className="vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
                                {self && <Tag tone="primary">Você</Tag>}
                                {e.isOwner && <Tag tone="highlight">Dono da conta</Tag>}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{e.email}</td>
                      <td>{e.roleName ?? <span className="vf-muted">Sem função</span>}</td>
                      <td>
                        {!e.isActive ? <Tag tone="danger">Inativo</Tag> : e.invitePending ? <Tag tone="warning">Convite pendente</Tag> : <Tag tone="success">Ativo</Tag>}
                      </td>
                      <td className="vf-muted">{e.lastLoginAt ? formatDateTime(e.lastLoginAt) : 'Nunca acessou'}</td>
                      <td className="actions">
                        {(can('employee.edit') || canDelete || (canInvite && e.invitePending)) && (
                          <RowMenu label={`Ações de ${e.name}`}>
                            {(close) => (
                              <>
                                {can('employee.edit') && (
                                  <MenuItem icon={<Pencil />} onClick={() => (close(), setEditing(e))}>
                                    Editar
                                  </MenuItem>
                                )}
                                {canInvite && e.invitePending && e.isActive && (
                                  <MenuItem icon={<Mail />} onClick={() => (close(), setConfirm({ kind: 'invite', employee: e }))}>
                                    Reenviar convite
                                  </MenuItem>
                                )}
                                {canToggle && (
                                  <MenuItem icon={<Power />} onClick={() => (close(), setConfirm({ kind: 'toggle', employee: e }))}>
                                    {e.isActive ? 'Inativar' : 'Reativar'}
                                  </MenuItem>
                                )}
                                {canDelete && (
                                  <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setConfirm({ kind: 'delete', employee: e }))}>
                                    Excluir
                                  </MenuItem>
                                )}
                              </>
                            )}
                          </RowMenu>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <EmployeeForm employee={editing === 'new' ? null : editing} roles={roles.data ?? []} onClose={() => setEditing(null)} onManualInvite={setManualInvite} />}
      <Modal open={Boolean(manualInvite)} title="O e-mail do convite não saiu" onClose={() => setManualInvite(null)} width={560} footer={<Button onClick={() => setManualInvite(null)}>Fechar</Button>}>
        {manualInvite && (
          <div className="vf-stack">
            <Alert tone="warning" title="Entregue o link por outro meio">
              O convite de {manualInvite.name} foi criado, mas o envio por e-mail falhou. Copie o link abaixo e mande por WhatsApp ou outro canal: ele vale 7 dias e serve só para essa pessoa criar a senha. Confira o envio de e-mail em Meu
              escritório › Integrações.
            </Alert>
            <div className="adm-invite-link">
              <code>{manualInvite.link}</code>
              <Button
                kind="secondary"
                size="sm"
                icon={<Copy />}
                onClick={() =>
                  void navigator.clipboard.writeText(manualInvite.link).then(
                    () => toast.success('Link copiado.'),
                    () => toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.'),
                  )
                }
              >
                Copiar
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirm?.kind === 'toggle'}
        danger={confirm?.employee.isActive}
        title={confirm?.employee.isActive ? 'Inativar colaborador' : 'Reativar colaborador'}
        message={
          confirm?.employee.isActive
            ? `${confirm.employee.name} perde o acesso imediatamente e é desconectado de todas as sessões. Os clientes dele continuam com ele como responsável.`
            : `${confirm?.employee.name} volta a acessar o Verifco com a mesma função.`
        }
        confirmLabel={confirm?.employee.isActive ? 'Inativar' : 'Reativar'}
        loading={toggleActive.isPending}
        onConfirm={() => confirm && toggleActive.mutate(confirm.employee)}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        danger
        title="Excluir colaborador"
        message={`${confirm?.employee.name} será removido da equipe e os clientes dele ficarão sem responsável. Se quiser só bloquear o acesso, prefira inativar.`}
        confirmLabel="Excluir"
        loading={remove.isPending}
        onConfirm={() => confirm && remove.mutate(confirm.employee)}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'invite'}
        title="Reenviar convite"
        message={`Um novo link para criar a senha será enviado para ${confirm?.employee.email}. O link anterior deixa de funcionar.`}
        confirmLabel="Reenviar"
        loading={resend.isPending}
        onConfirm={() => confirm && resend.mutate(confirm.employee)}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

function EmployeeForm({
  employee,
  roles,
  onClose,
  onManualInvite,
}: {
  employee: EmployeeRow | null;
  roles: RoleRow[];
  onClose: () => void;
  onManualInvite: (invite: { name: string; link: string }) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ name: employee?.name ?? '', email: employee?.email ?? '', roleId: employee?.roleId ?? '' });
  useEffect(() => {
    if (!employee && !form.roleId) {
      const suggested = roles.find((r) => !r.isSystem) ?? roles[0];
      if (suggested) setForm((f) => ({ ...f, roleId: suggested.id }));
    }
  }, [roles, employee, form.roleId]);
  const valid = form.name.trim().length >= 2 && isValidEmail(form.email) && Boolean(form.roleId);
  const save = useAction(
    () =>
      employee
        ? api.put<InviteResult>(`/employees/${employee.id}`, { ...form, isActive: employee.isActive })
        : api.post<InviteResult>('/employees', form),
    {
      invalidate: [['employees'], ['roles']],
      onSuccess: (r) => {
        onClose();
        if (employee) toast.success('Colaborador atualizado.');
        else if (r.emailSent === false && r.inviteLink) onManualInvite({ name: form.name, link: r.inviteLink });
        else toast.success(`Convite enviado para ${form.email}.`);
      },
    },
  );
  const ownerLocked = Boolean(employee?.isOwner);
  return (
    <Modal
      open
      title={employee ? 'Editar colaborador' : 'Convidar colaborador'}
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {employee ? 'Salvar' : 'Enviar convite'}
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <Input label="Nome" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus maxLength={200} />
        <Input
          label="E-mail"
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          error={form.email && !isValidEmail(form.email) ? 'E-mail inválido' : undefined}
          help={employee ? undefined : 'O colaborador recebe neste e-mail o link para criar a senha (vale 7 dias).'}
        />
        <Select
          label="Função"
          required
          value={form.roleId}
          disabled={ownerLocked}
          onChange={(e) => setForm({ ...form, roleId: e.target.value })}
          placeholder="Selecione"
          options={roles.map((r) => ({ value: r.id, label: r.name }))}
          help={ownerLocked ? 'O dono da conta é sempre Administrador.' : 'As permissões de cada função ficam na aba Funções.'}
        />
      </div>
    </Modal>
  );
}
