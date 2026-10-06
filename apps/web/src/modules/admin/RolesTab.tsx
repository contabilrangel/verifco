import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Eye, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { PermissionCategory } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, Drawer, EmptyState, Input, Loading, MenuItem, Tag } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { RowMenu, SearchBox, matches, plural, type RoleRow } from './shared';

type Editing = { role: RoleRow | null; copyOf?: RoleRow } | null;

/** Aba Funções: perfis de acesso com a matriz de permissões por categoria. */
export function RolesTab() {
  const { can } = useAuth();
  const roles = useApi<RoleRow[]>(['roles'], '/roles');
  const catalog = useApi<PermissionCategory[]>(['permissions-catalog'], '/permissions/catalog');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [toDelete, setToDelete] = useState<RoleRow | null>(null);
  const total = useMemo(() => (catalog.data ?? []).reduce((n, c) => n + c.permissions.length, 0), [catalog.data]);
  const rows = (roles.data ?? []).filter((r) => matches(search, r.name));
  const blocked = Boolean(toDelete && toDelete.users > 0);

  const remove = useAction((r: RoleRow) => api.del(`/roles/${r.id}`), {
    success: 'Função excluída.',
    invalidate: [['roles']],
    onSuccess: () => setToDelete(null),
  });

  return (
    <>
      <Card
        className="adm-card"
        flush
        title="Funções"
        actions={
          can('role.create') && (
            <Button icon={<Plus />} onClick={() => setEditing({ role: null })}>
              Nova função
            </Button>
          )
        }
      >
        <div className="adm-toolbar">
          <SearchBox value={search} onChange={setSearch} placeholder="Buscar função" />
          <span className="vf-muted vf-text-xs">Cada colaborador tem uma função; a função define o que ele pode ver e fazer.</span>
        </div>
        {roles.isLoading || catalog.isLoading ? (
          <Loading />
        ) : roles.isError ? (
          <div style={{ padding: 16 }}>
            <Alert tone="danger" title="Não foi possível carregar as funções." />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<ShieldCheck />} title="Nenhuma função encontrada" description="Revise a busca." />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Permissões</th>
                  <th>Colaboradores</th>
                  <th className="actions">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="vf-inline">
                        <button type="button" className="adm-link" onClick={() => setEditing({ role: r })}>
                          {r.name}
                        </button>
                        {r.isSystem && <Tag tone="highlight">Acesso total</Tag>}
                      </span>
                    </td>
                    <td className="vf-muted">{r.isSystem ? 'Todas' : `${r.permissions.length} de ${total}`}</td>
                    <td>{plural(r.users, 'colaborador', 'colaboradores')}</td>
                    <td className="actions">
                      <RowMenu label={`Ações da função ${r.name}`}>
                        {(close) => (
                          <>
                            <MenuItem icon={r.isSystem || !can('role.edit') ? <Eye /> : <Pencil />} onClick={() => (close(), setEditing({ role: r }))}>
                              {r.isSystem || !can('role.edit') ? 'Ver permissões' : 'Editar'}
                            </MenuItem>
                            {can('role.create') && (
                              <MenuItem icon={<Copy />} onClick={() => (close(), setEditing({ role: null, copyOf: r }))}>
                                Duplicar
                              </MenuItem>
                            )}
                            {can('role.delete') && !r.isSystem && (
                              <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setToDelete(r))}>
                                Excluir
                              </MenuItem>
                            )}
                          </>
                        )}
                      </RowMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && catalog.data && <RoleDrawer editing={editing} catalog={catalog.data} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={Boolean(toDelete)}
        danger={!blocked}
        title={blocked ? 'Função em uso' : 'Excluir função'}
        message={
          toDelete && toDelete.users > 0
            ? `${plural(toDelete.users, 'colaborador usa', 'colaboradores usam')} esta função. Troque a função deles na aba Colaboradores antes de excluir.`
            : `A função “${toDelete?.name}” será excluída.`
        }
        confirmLabel={blocked ? 'Entendi' : 'Excluir'}
        loading={remove.isPending}
        onConfirm={() => toDelete && (blocked ? setToDelete(null) : remove.mutate(toDelete))}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}

function RoleDrawer({ editing, catalog, onClose }: { editing: NonNullable<Editing>; catalog: PermissionCategory[]; onClose: () => void }) {
  const { can } = useAuth();
  const { role, copyOf } = editing;
  const all = useMemo(() => catalog.flatMap((c) => c.permissions.map((p) => p.key)), [catalog]);
  const [name, setName] = useState(role?.name ?? (copyOf ? `${copyOf.name} (cópia)` : ''));
  const [perms, setPerms] = useState<Set<string>>(() => new Set(role?.isSystem ? all : (role?.permissions ?? copyOf?.permissions ?? [])));
  const readOnly = Boolean(role?.isSystem) || (role ? !can('role.edit') : !can('role.create'));

  const save = useAction(
    () => {
      const body = { name: name.trim(), permissions: all.filter((k) => perms.has(k)) };
      return role ? api.put(`/roles/${role.id}`, body) : api.post('/roles', body);
    },
    { success: role ? 'Função atualizada.' : 'Função criada.', invalidate: [['roles']], onSuccess: onClose },
  );

  const setMany = (keys: string[], on: boolean) =>
    setPerms((s) => {
      const n = new Set(s);
      keys.forEach((k) => (on ? n.add(k) : n.delete(k)));
      return n;
    });

  const title = role?.isSystem ? role.name : role ? (readOnly ? role.name : 'Editar função') : 'Nova função';

  return (
    <Drawer
      open
      title={title}
      onClose={onClose}
      width={840}
      footer={
        readOnly ? (
          <Button kind="secondary" onClick={onClose}>
            Fechar
          </Button>
        ) : (
          <>
            <span className="vf-muted vf-grow vf-text-xs">{plural(perms.size, 'permissão marcada', 'permissões marcadas')}</span>
            <Button kind="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button disabled={name.trim().length < 2} loading={save.isPending} onClick={() => save.mutate(undefined)}>
              Salvar função
            </Button>
          </>
        )
      }
    >
      <div className="vf-stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {role?.isSystem && <Alert>A função Administrador tem todas as permissões e não pode ser alterada.</Alert>}
        <Input label="Nome da função" required value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} maxLength={100} autoFocus={!readOnly} />
        <div className="vf-inline vf-between">
          <span className="vf-text-sm-bold">Permissões</span>
          <TriCheck label="Selecionar todas" checked={perms.size === all.length} partial={perms.size > 0 && perms.size < all.length} disabled={readOnly} onChange={(on) => setMany(all, on)} />
        </div>
        <div className="adm-perm-grid">
          {catalog.map((cat) => {
            const keys = cat.permissions.map((p) => p.key);
            const on = keys.filter((k) => perms.has(k)).length;
            return (
              <fieldset key={cat.id} className="adm-perm-cat" style={{ margin: 0, minWidth: 0 }}>
                <legend className="sr-only">{cat.label}</legend>
                <div className="adm-perm-cat__head">
                  <TriCheck label={<strong>{cat.label}</strong>} checked={on === keys.length} partial={on > 0 && on < keys.length} disabled={readOnly} onChange={(v) => setMany(keys, v)} />
                  <span className="vf-text-xs vf-muted">
                    {on}/{keys.length}
                  </span>
                </div>
                {cat.permissions.map((p) => (
                  <label key={p.key} className="vf-check">
                    <input type="checkbox" checked={perms.has(p.key)} disabled={readOnly} onChange={(e) => setMany([p.key], e.target.checked)} />
                    <span>{p.label}</span>
                  </label>
                ))}
              </fieldset>
            );
          })}
        </div>
      </div>
    </Drawer>
  );
}

/** Caixa de seleção com estado parcial (algumas marcadas). */
function TriCheck({ label, checked, partial, disabled, onChange }: { label: React.ReactNode; checked: boolean; partial: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);
  return (
    <label className="vf-check">
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-checked={partial ? 'mixed' : checked} />
      <span>{label}</span>
    </label>
  );
}
