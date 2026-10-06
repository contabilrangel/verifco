import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, FileSpreadsheet, Filter, Mail, Package, Plus, Search, StickyNote, Tag as TagIcon, Trash2, UserCog, Users } from 'lucide-react';
import { CND_STATUS, DECLARATION_SUBSTATUS, PROCURATION_STATUS, isValidCpfCnpj } from '@verifco/shared';
import {
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Input,
  Loading,
  Menu,
  MenuItem,
  Modal,
  Pagination,
  Select,
  Tag,
  useToast,
} from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi, useDebounced } from '../../lib/hooks';
import { formatCpfCnpj, procurationLabel, procurationTone, stageLabel, stageTone, substatusLabel } from '../../lib/format';
import { useYear } from '../../lib/year';

export interface CustomerListItem {
  id: string;
  name: string;
  cpfCnpj: string;
  email: string | null;
  mobile: string | null;
  notes: string | null;
  status: string;
  procurationStatus: string;
  cndStatus: string;
  ecacMailboxMessages: number;
  responsibleName: string | null;
  procuratorName: string | null;
  groups: { id: string; name: string }[];
  declaration: { id: string; stage: string; substatus: string } | null;
}

interface Facets {
  total: number;
  email: { with: number; without: number };
  status: { active: number; inactive: number };
  procurator: { with: number; without: number };
  procurationStatus: Record<string, number>;
  mailbox: number;
  govbrRequired: number;
  expiring: number;
  cnd: Record<string, number>;
  groups: { id: string; name: string; n: number }[];
  noGroup: number;
  responsible: { id: string; name: string; n: number }[];
}

type Filters = {
  responsible: string[];
  groups: string[];
  noGroup: boolean;
  email: string;
  status: string;
  procurator: string;
  procurationStatus: string[];
  mailbox: boolean;
  govbrRequired: boolean;
  expiring: boolean;
  cnd: string[];
  stage: string[];
};

const EMPTY: Filters = {
  responsible: [],
  groups: [],
  noGroup: false,
  email: '',
  status: '',
  procurator: '',
  procurationStatus: [],
  mailbox: false,
  govbrRequired: false,
  expiring: false,
  cnd: [],
  stage: [],
};

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function CustomersPage() {
  const { can } = useAuth();
  const { year } = useYear();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('busca') ?? '');
  const debounced = useDebounced(search);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showNew, setShowNew] = useState(false);
  const [bulk, setBulk] = useState<null | 'status' | 'responsible' | 'procurator' | 'groups' | 'delete' | 'substatus'>(null);

  useEffect(() => {
    const b = params.get('busca');
    if (b !== null && b !== search) setSearch(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  useEffect(() => setPage(1), [debounced, filters, year]);

  const query = qs({ search: debounced, year, page, pageSize: 25, ...filters, noGroup: filters.noGroup || undefined, mailbox: filters.mailbox || undefined, govbrRequired: filters.govbrRequired || undefined, expiring: filters.expiring || undefined });
  const list = useApi<{ data: CustomerListItem[]; total: number; page: number; pages: number }>(['customers', query], `/customers${query}`);
  const facets = useApi<Facets>(['customers', 'facets'], '/customers/facets');
  const activeCount = useMemo(
    () => Object.entries(filters).filter(([, v]) => (Array.isArray(v) ? v.length : Boolean(v))).length,
    [filters],
  );

  const rows = list.data?.data ?? [];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const ids = [...selected];

  const runBulk = useAction((body: { action: string; value?: unknown }) => api.post('/customers/bulk', { ids, year, ...body }), {
    success: (r: any) => `${r.affected} cliente(s) atualizado(s).`,
    invalidate: [['customers']],
    onSuccess: () => {
      setBulk(null);
      setSelected(new Set());
    },
  });

  const f = facets.data;

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Carteira do escritório com procurações, grupos e status da declaração no exercício selecionado."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Clientes' }]}
        actions={
          can('customer.create') && (
            <Button icon={<Plus />} onClick={() => setShowNew(true)}>
              Novo cliente
            </Button>
          )
        }
      />

      <Card flush>
        <div className="vf-inline" style={{ padding: 16, borderBottom: '1px solid var(--color-border)' }}>
          <div className="vf-grow" style={{ maxWidth: 420 }}>
            <Input
              aria-label="Buscar"
              placeholder="Buscar por nome, CPF ou e-mail"
              icon={<Search />}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (params.get('busca')) setParams({});
              }}
            />
          </div>
          <Button
            kind="secondary"
            icon={<Filter />}
            onClick={() => {
              setDraft(filters);
              setShowFilters(true);
            }}
          >
            Filtros{activeCount ? ` (${activeCount})` : ''}
          </Button>
          {activeCount > 0 && (
            <Button kind="tertiary" onClick={() => setFilters(EMPTY)}>
              Limpar filtros
            </Button>
          )}
          <div className="vf-grow" />
          {selected.size > 0 && <span className="vf-muted">{selected.size} selecionado(s)</span>}
          <Menu
            trigger={(t) => (
              <Button kind="secondary" onClick={t} disabled={!selected.size} icon={<ChevronDown />}>
                Ações
              </Button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<Package />} onClick={() => (close(), navigate(`/comunicacao/mala-direta?tipo=kit&clientes=${ids.join(',')}`))}>
                  Kit pós-declaração
                </MenuItem>
                <MenuItem icon={<Mail />} onClick={() => (close(), navigate(`/comunicacao/mala-direta?clientes=${ids.join(',')}`))}>
                  Mala direta
                </MenuItem>
                <MenuItem
                  icon={<TagIcon />}
                  onClick={async () => {
                    close();
                    await api.download('/customers/labels', 'etiquetas.pdf', { ids });
                  }}
                >
                  Imprimir etiquetas
                </MenuItem>
                <div className="vf-menu__sep" />
                {can('declaration.edit') && <MenuItem onClick={() => (close(), setBulk('substatus'))}>Alterar status da declaração</MenuItem>}
                {can('customer.edit') && (
                  <>
                    <MenuItem onClick={() => (close(), setBulk('status'))}>Ativar / inativar</MenuItem>
                    <MenuItem icon={<UserCog />} onClick={() => (close(), setBulk('responsible'))}>
                      Alterar responsável
                    </MenuItem>
                    <MenuItem onClick={() => (close(), setBulk('procurator'))}>Associar procurador</MenuItem>
                    <MenuItem icon={<Users />} onClick={() => (close(), setBulk('groups'))}>
                      Grupos
                    </MenuItem>
                  </>
                )}
                <div className="vf-menu__sep" />
                <MenuItem
                  icon={<FileSpreadsheet />}
                  onClick={async () => {
                    close();
                    await api.download('/customers/export', 'clientes.xlsx', { ids, filters: { year } });
                  }}
                >
                  Exportar para Excel
                </MenuItem>
                {can('customer.download_documents') && (
                  <MenuItem
                    icon={<Download />}
                    onClick={async () => {
                      close();
                      try {
                        await api.download('/documents/zip', 'documentos.zip', { customerIds: ids, year });
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : 'Falha no download.');
                      }
                    }}
                  >
                    Baixar documentos
                  </MenuItem>
                )}
                {can('customer.delete') && (
                  <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setBulk('delete'))}>
                    Excluir selecionados
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
        </div>

        {list.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={debounced || activeCount ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}
            description={debounced || activeCount ? 'Revise a busca ou os filtros.' : 'Cadastre clientes um a um ou importe uma planilha.'}
            action={
              !debounced && !activeCount && can('customer.create') ? (
                <div className="vf-inline">
                  <Button onClick={() => setShowNew(true)}>Novo cliente</Button>
                  <Button kind="secondary" onClick={() => navigate('/importacoes/novos-clientes')}>
                    Importar planilha
                  </Button>
                </div>
              ) : undefined
            }
          />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos da página"
                      checked={allOnPage}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          rows.forEach((r) => (allOnPage ? n.delete(r.id) : n.add(r.id)));
                          return n;
                        })
                      }
                    />
                  </th>
                  <th>Cliente</th>
                  <th>CPF/CNPJ</th>
                  <th>Responsável</th>
                  <th>Procuração</th>
                  <th>Declaração {year}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${c.name}`}
                        checked={selected.has(c.id)}
                        onChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(c.id)) n.delete(c.id);
                            else n.add(c.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td>
                      <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                        <Link to={`/clientes/${c.id}`} className="vf-text-sm-bold">
                          {c.name}
                        </Link>
                        <span className="vf-text-xs vf-muted">{c.email || 'sem e-mail'}</span>
                        {c.notes?.trim() && (
                          <span className="vf-cus-notes" title={c.notes}>
                            <StickyNote aria-hidden />
                            <span className="sr-only">Observações: </span>
                            {c.notes}
                          </span>
                        )}
                        {(c.groups.length > 0 || c.status === 'inactive' || c.ecacMailboxMessages > 0) && (
                          <div className="vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
                            {c.status === 'inactive' && <Tag tone="danger">Inativo</Tag>}
                            {c.ecacMailboxMessages > 0 && <Tag tone="warning">{c.ecacMailboxMessages} msg. caixa postal</Tag>}
                            {c.groups.map((g) => (
                              <Tag key={g.id}>{g.name}</Tag>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="vf-mono">{formatCpfCnpj(c.cpfCnpj)}</td>
                    <td>{c.responsibleName ?? <span className="vf-muted">—</span>}</td>
                    <td>
                      <Tag tone={procurationTone(c.procurationStatus)}>{procurationLabel(c.procurationStatus)}</Tag>
                    </td>
                    <td>
                      <Tag tone={stageTone(c.declaration?.stage ?? 'not_started')}>{substatusLabel(c.declaration?.substatus ?? 'not_started')}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && list.data.total > 0 && <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onChange={setPage} />}
      </Card>

      <Drawer
        open={showFilters}
        title="Filtros"
        onClose={() => setShowFilters(false)}
        footer={
          <>
            <Button kind="secondary" onClick={() => setDraft(EMPTY)}>
              Limpar
            </Button>
            <Button
              onClick={() => {
                setFilters(draft);
                setShowFilters(false);
              }}
            >
              Aplicar filtros
            </Button>
          </>
        }
      >
        {!f ? (
          <Loading />
        ) : (
          <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
            <FilterSection title="Declaração no exercício">
              {(['not_started', 'negotiation', 'filling', 'transmitted', 'finished'] as const).map((s) => (
                <Checkbox key={s} label={stageLabel(s)} checked={draft.stage.includes(s)} onChange={() => setDraft((d) => ({ ...d, stage: toggle(d.stage, s) }))} />
              ))}
            </FilterSection>
            <FilterSection title="Colaboradores">
              {f.responsible.map((r) => (
                <Checkbox key={r.id} label={`${r.name} (${r.n})`} checked={draft.responsible.includes(r.id)} onChange={() => setDraft((d) => ({ ...d, responsible: toggle(d.responsible, r.id) }))} />
              ))}
            </FilterSection>
            <FilterSection title="Geral">
              <Checkbox label={`Clientes com e-mail (${f.email.with})`} checked={draft.email === 'with'} onChange={() => setDraft((d) => ({ ...d, email: d.email === 'with' ? '' : 'with' }))} />
              <Checkbox label={`Clientes sem e-mail (${f.email.without})`} checked={draft.email === 'without'} onChange={() => setDraft((d) => ({ ...d, email: d.email === 'without' ? '' : 'without' }))} />
              <Checkbox label={`Ativos (${f.status.active})`} checked={draft.status === 'active'} onChange={() => setDraft((d) => ({ ...d, status: d.status === 'active' ? '' : 'active' }))} />
              <Checkbox label={`Inativos (${f.status.inactive})`} checked={draft.status === 'inactive'} onChange={() => setDraft((d) => ({ ...d, status: d.status === 'inactive' ? '' : 'inactive' }))} />
            </FilterSection>
            <FilterSection title="Procurações">
              <Checkbox label={`Sem procurador associado (${f.procurator.without})`} checked={draft.procurator === 'without'} onChange={() => setDraft((d) => ({ ...d, procurator: d.procurator === 'without' ? '' : 'without' }))} />
              <Checkbox label={`Com procurador associado (${f.procurator.with})`} checked={draft.procurator === 'with'} onChange={() => setDraft((d) => ({ ...d, procurator: d.procurator === 'with' ? '' : 'with' }))} />
              {Object.entries(PROCURATION_STATUS)
                .filter(([k]) => k !== 'none')
                .map(([k, label]) => (
                  <Checkbox key={k} label={`${label} (${f.procurationStatus[k] ?? 0})`} checked={draft.procurationStatus.includes(k)} onChange={() => setDraft((d) => ({ ...d, procurationStatus: toggle(d.procurationStatus, k) }))} />
                ))}
              <Checkbox label={`Mensagens na caixa postal (${f.mailbox})`} checked={draft.mailbox} onChange={() => setDraft((d) => ({ ...d, mailbox: !d.mailbox }))} />
              <Checkbox label={`Requer nível ouro ou prata (${f.govbrRequired})`} checked={draft.govbrRequired} onChange={() => setDraft((d) => ({ ...d, govbrRequired: !d.govbrRequired }))} />
              <Checkbox label={`Expira nos próximos 30 dias (${f.expiring})`} checked={draft.expiring} onChange={() => setDraft((d) => ({ ...d, expiring: !d.expiring }))} />
            </FilterSection>
            <FilterSection title="CND">
              {Object.entries(CND_STATUS)
                .filter(([k]) => k !== 'not_requested')
                .map(([k, label]) => (
                  <Checkbox key={k} label={`${label} (${f.cnd[k] ?? 0})`} checked={draft.cnd.includes(k)} onChange={() => setDraft((d) => ({ ...d, cnd: toggle(d.cnd, k) }))} />
                ))}
            </FilterSection>
            <FilterSection title="Grupos de clientes">
              <Checkbox label={`Sem grupo (${f.noGroup})`} checked={draft.noGroup} onChange={() => setDraft((d) => ({ ...d, noGroup: !d.noGroup }))} />
              {f.groups.map((g) => (
                <Checkbox key={g.id} label={`${g.name} (${g.n})`} checked={draft.groups.includes(g.id)} onChange={() => setDraft((d) => ({ ...d, groups: toggle(d.groups, g.id) }))} />
              ))}
            </FilterSection>
          </div>
        )}
      </Drawer>

      <NewCustomerModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={(id) => {
          void qc.invalidateQueries({ queryKey: ['customers'] });
          navigate(`/clientes/${id}/identificacao`);
        }}
      />

      <BulkDialogs kind={bulk} count={selected.size} loading={runBulk.isPending} onClose={() => setBulk(null)} onRun={(action, value) => runBulk.mutate({ action, value })} />
    </>
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="vf-text-sm-bold" style={{ marginBottom: 8 }}>
        {title}
      </legend>
      <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
        {children}
      </div>
    </fieldset>
  );
}

export function NewCustomerModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ name: '', cpfCnpj: '', email: '', responsibleUserId: '' });
  const employees = useApi<{ id: string; name: string }[]>(['employees'], open ? '/employees' : null);
  const valid = form.name.trim().length >= 2 && isValidCpfCnpj(form.cpfCnpj);
  const create = useAction(() => api.post<{ id: string }>('/customers', { ...form, responsibleUserId: form.responsibleUserId || null }), {
    success: 'Cliente cadastrado.',
    onSuccess: (r) => {
      setForm({ name: '', cpfCnpj: '', email: '', responsibleUserId: '' });
      onClose();
      onCreated(r.id);
    },
  });
  return (
    <Modal
      open={open}
      title="Novo cliente"
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} loading={create.isPending} onClick={() => create.mutate(undefined)}>
            Adicionar cliente
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <Input label="Nome" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <Input
          label="CPF ou CNPJ"
          required
          value={form.cpfCnpj}
          onChange={(e) => setForm({ ...form, cpfCnpj: e.target.value })}
          error={form.cpfCnpj.length >= 11 && !isValidCpfCnpj(form.cpfCnpj) ? 'CPF/CNPJ inválido' : undefined}
        />
        <Input label="E-mail" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Select
          label="Responsável"
          placeholder="Eu mesmo"
          value={form.responsibleUserId}
          onChange={(e) => setForm({ ...form, responsibleUserId: e.target.value })}
          options={(employees.data ?? []).map((u) => ({ value: u.id, label: u.name }))}
        />
      </div>
    </Modal>
  );
}

function BulkDialogs({
  kind,
  count,
  loading,
  onClose,
  onRun,
}: {
  kind: null | 'status' | 'responsible' | 'procurator' | 'groups' | 'delete' | 'substatus';
  count: number;
  loading: boolean;
  onClose: () => void;
  onRun: (action: string, value?: unknown) => void;
}) {
  const { can } = useAuth();
  const [value, setValue] = useState('');
  const [groups, setGroups] = useState<string[]>([]);
  const [groupMode, setGroupMode] = useState<'groups_add' | 'groups_remove' | 'groups_set'>('groups_add');
  useEffect(() => {
    setValue('');
    setGroups([]);
  }, [kind]);
  const employees = useApi<{ id: string; name: string }[]>(['employees'], kind === 'responsible' ? '/employees' : null);
  const procurators = useApi<{ id: string; name: string }[]>(['procurators'], kind === 'procurator' ? '/procurators' : null);
  const groupList = useApi<{ id: string; name: string }[]>(['customer-groups'], kind === 'groups' ? '/customer-groups' : null);

  if (kind === 'delete') {
    return (
      <ConfirmDialog
        open
        danger
        title="Excluir clientes"
        message={`Os ${count} cliente(s) selecionados deixarão de aparecer nas listas e relatórios. Esta ação não pode ser desfeita pelo sistema.`}
        confirmLabel="Excluir"
        loading={loading}
        onConfirm={() => onRun('delete')}
        onClose={onClose}
      />
    );
  }
  if (!kind) return null;
  const titles = { status: 'Ativar ou inativar', responsible: 'Alterar responsável', procurator: 'Associar procurador', groups: 'Grupos de clientes', substatus: 'Status da declaração' };
  const canRun = kind === 'groups' ? groups.length > 0 || groupMode === 'groups_set' : kind === 'responsible' || kind === 'procurator' ? true : value !== '';
  return (
    <Modal
      open
      title={titles[kind]}
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={loading}
            disabled={!canRun}
            onClick={() => {
              if (kind === 'groups') onRun(groupMode, groups);
              else if (kind === 'responsible' || kind === 'procurator') onRun(kind, value || null);
              else onRun(kind, value);
            }}
          >
            Aplicar a {count} cliente(s)
          </Button>
        </>
      }
    >
      {kind === 'status' && (
        <Select label="Situação" placeholder="Selecione" value={value} onChange={(e) => setValue(e.target.value)} options={[{ value: 'active', label: 'Ativo' }, { value: 'inactive', label: 'Inativo' }]} />
      )}
      {kind === 'substatus' && (
        <Select
          label="Novo status"
          placeholder="Selecione"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          // finalizar exige a permissão de finalização (a API também confere)
          options={Object.entries(DECLARATION_SUBSTATUS)
            .filter(([v]) => v !== 'finished' || can('declaration.finish'))
            .map(([v, label]) => ({ value: v, label }))}
        />
      )}
      {kind === 'responsible' && (
        <Select label="Responsável" placeholder="Sem responsável" value={value} onChange={(e) => setValue(e.target.value)} options={(employees.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
      )}
      {kind === 'procurator' && (
        <Select label="Procurador" placeholder="Remover procurador" value={value} onChange={(e) => setValue(e.target.value)} options={(procurators.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
      )}
      {kind === 'groups' && (
        <div className="vf-stack">
          <Select
            label="Operação"
            value={groupMode}
            onChange={(e) => setGroupMode(e.target.value as typeof groupMode)}
            options={[
              { value: 'groups_add', label: 'Adicionar aos grupos' },
              { value: 'groups_remove', label: 'Remover dos grupos' },
              { value: 'groups_set', label: 'Substituir os grupos' },
            ]}
          />
          {(groupList.data ?? []).map((g) => (
            <Checkbox key={g.id} label={g.name} checked={groups.includes(g.id)} onChange={() => setGroups((l) => toggle(l, g.id))} />
          ))}
          {groupList.data?.length === 0 && <span className="vf-muted">Nenhum grupo cadastrado. Crie grupos em Administração.</span>}
        </div>
      )}
    </Modal>
  );
}
