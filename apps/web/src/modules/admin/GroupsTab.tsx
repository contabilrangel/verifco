import { useState } from 'react';
import { Folders, Pencil, Plus, Trash2 } from 'lucide-react';
import { Alert, Button, Card, ConfirmDialog, EmptyState, Input, Loading, MenuItem, Modal } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { RowMenu, SearchBox, matches, plural } from './shared';

interface GroupRow {
  id: string;
  name: string;
  createdAt: string;
  customers: number;
}

/** Aba Grupos: agrupamentos de clientes usados em filtros, Kanban e envios em massa. */
export function GroupsTab() {
  const { can } = useAuth();
  const groups = useApi<GroupRow[]>(['customer-groups'], '/customer-groups');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<GroupRow | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<GroupRow | null>(null);
  const rows = (groups.data ?? []).filter((g) => matches(search, g.name));

  const remove = useAction((g: GroupRow) => api.del(`/customer-groups/${g.id}`), {
    success: 'Grupo excluído.',
    invalidate: [['customer-groups'], ['customers']],
    onSuccess: () => setToDelete(null),
  });
  const hasActions = can('customer_group.edit', 'customer_group.delete');

  return (
    <>
      <Card
        className="adm-card"
        flush
        title="Grupos de clientes"
        actions={
          can('customer_group.create') && (
            <Button icon={<Plus />} onClick={() => setEditing('new')}>
              Novo grupo
            </Button>
          )
        }
      >
        {(groups.data?.length ?? 0) > 0 && (
          <div className="adm-toolbar">
            <SearchBox value={search} onChange={setSearch} placeholder="Buscar grupo" />
          </div>
        )}
        {groups.isLoading ? (
          <Loading />
        ) : groups.isError ? (
          <div style={{ padding: 16 }}>
            <Alert tone="danger" title="Não foi possível carregar os grupos." />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Folders />}
            title={search ? 'Nenhum grupo encontrado' : 'Nenhum grupo cadastrado'}
            description={search ? 'Revise a busca.' : 'Use grupos para separar a carteira (ex.: Família Souza, Sócios, Mensalistas) e filtrar clientes, Kanban e envios.'}
            action={
              !search && can('customer_group.create') ? (
                <Button icon={<Plus />} onClick={() => setEditing('new')}>
                  Criar primeiro grupo
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Clientes</th>
                  <th>Criado em</th>
                  <th className="actions">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.id}>
                    <td className="vf-text-sm-bold">{g.name}</td>
                    <td>{plural(g.customers, 'cliente', 'clientes')}</td>
                    <td className="vf-muted">{formatDate(g.createdAt)}</td>
                    <td className="actions">
                      {hasActions && (
                        <RowMenu label={`Ações do grupo ${g.name}`}>
                          {(close) => (
                            <>
                              {can('customer_group.edit') && (
                                <MenuItem icon={<Pencil />} onClick={() => (close(), setEditing(g))}>
                                  Renomear
                                </MenuItem>
                              )}
                              {can('customer_group.delete') && (
                                <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setToDelete(g))}>
                                  Excluir
                                </MenuItem>
                              )}
                            </>
                          )}
                        </RowMenu>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <GroupForm group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={Boolean(toDelete)}
        danger
        title="Excluir grupo"
        message={
          toDelete?.customers
            ? `O grupo “${toDelete.name}” será excluído. Os ${plural(toDelete.customers, 'cliente', 'clientes')} dele não são apagados; só deixam de pertencer ao grupo.`
            : `O grupo “${toDelete?.name}” será excluído.`
        }
        confirmLabel="Excluir"
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete)}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}

function GroupForm({ group, onClose }: { group: GroupRow | null; onClose: () => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const save = useAction(() => (group ? api.put(`/customer-groups/${group.id}`, { name }) : api.post('/customer-groups', { name })), {
    success: group ? 'Grupo renomeado.' : 'Grupo criado.',
    invalidate: [['customer-groups'], ['customers']],
    onSuccess: onClose,
  });
  const valid = name.trim().length > 0 && name.trim() !== group?.name;
  return (
    <Modal
      open
      title={group ? 'Renomear grupo' : 'Novo grupo'}
      onClose={onClose}
      width={460}
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
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate(undefined);
        }}
      >
        <Input label="Nome do grupo" required value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
      </form>
    </Modal>
  );
}
