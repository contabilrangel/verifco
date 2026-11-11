import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Download, FileSpreadsheet, Filter, Mail, Package, Plus, RefreshCw, Search, StickyNote, Tag as TagIcon, Trash2, UserCog, Users } from 'lucide-react';
import { CND_STATUS, DECLARATION_SUBSTATUS, PROCURATION_STATUS, isValidCpfCnpj } from '@verifco/shared';
import {
  Alert,
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
import { ApiError, api, errorMessage, qs } from '../../lib/api';
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

interface CustomerList {
  data: CustomerListItem[];
  total: number;
  page: number;
  pages: number;
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

const STAGES = ['not_started', 'negotiation', 'filling', 'transmitted', 'finished'] as const;

/**
 * A busca, os filtros, a ordem e a página ficam no endereço (?busca=ana&etapa=filling&pagina=2):
 * voltar/avançar do navegador, recarregar e os favoritos preservam a lista como estava.
 */
const SEARCH_PARAM = 'busca';
const PAGE_PARAM = 'pagina';
const SORT_PARAM = 'ordem';
const FILTER_PARAMS: Record<keyof Filters, string> = {
  responsible: 'responsavel',
  groups: 'grupos',
  noGroup: 'sem-grupo',
  email: 'email',
  status: 'situacao',
  procurator: 'procurador',
  procurationStatus: 'procuracao',
  mailbox: 'caixa-postal',
  govbrRequired: 'govbr',
  expiring: 'expirando',
  cnd: 'cnd',
  stage: 'etapa',
};

/** Ordem da lista (parâmetro `sort` de GET /customers) e o valor que vai no endereço. */
const SORTS = [
  { value: 'name', param: '', label: 'Nome (A–Z)' },
  { value: 'created', param: 'cadastro', label: 'Cadastro mais recente' },
  { value: 'updated', param: 'atualizacao', label: 'Atualização mais recente' },
] as const;
type Sort = (typeof SORTS)[number]['value'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const oneOf = (v: string | null, allowed: readonly string[]) => (v && allowed.includes(v) ? v : '');
const listOf = (v: string | null, ok: (x: string) => boolean) => [...new Set((v ?? '').split(',').filter((x) => x && ok(x)))];

/** Filtros do endereço; valores desconhecidos (link antigo ou digitado errado) são ignorados. */
export function filtersFromParams(p: URLSearchParams): Filters {
  const get = (k: keyof Filters) => p.get(FILTER_PARAMS[k]);
  return {
    responsible: listOf(get('responsible'), (x) => UUID.test(x)),
    groups: listOf(get('groups'), (x) => UUID.test(x)),
    noGroup: get('noGroup') === '1',
    email: oneOf(get('email'), ['with', 'without']),
    status: oneOf(get('status'), ['active', 'inactive']),
    procurator: oneOf(get('procurator'), ['with', 'without']),
    procurationStatus: listOf(get('procurationStatus'), (x) => x in PROCURATION_STATUS),
    mailbox: get('mailbox') === '1',
    govbrRequired: get('govbrRequired') === '1',
    expiring: get('expiring') === '1',
    cnd: listOf(get('cnd'), (x) => x in CND_STATUS),
    stage: listOf(get('stage'), (x) => (STAGES as readonly string[]).includes(x)),
  };
}

/** Grava os filtros no endereço (só os preenchidos). */
export function filtersToParams(p: URLSearchParams, f: Filters) {
  for (const k of Object.keys(FILTER_PARAMS) as (keyof Filters)[]) {
    const v = f[k];
    const text = Array.isArray(v) ? v.join(',') : v === true ? '1' : v || '';
    if (text) p.set(FILTER_PARAMS[k], text);
    else p.delete(FILTER_PARAMS[k]);
  }
}

/** Filtros no formato da API (GET /customers e `filters` de POST /customers/export): listas separadas por vírgula. */
const apiFilters = (f: Filters): Record<string, string | boolean | undefined> =>
  Object.fromEntries((Object.keys(f) as (keyof Filters)[]).map((k) => [k, Array.isArray(f[k]) ? (f[k] as string[]).join(',') || undefined : f[k] || undefined]));

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Status da declaração para a ação em massa: "Finalizado" só para quem pode finalizar. */
const substatusOptions = (canFinish: boolean) =>
  Object.entries(DECLARATION_SUBSTATUS)
    .filter(([v]) => canFinish || v !== 'finished')
    .map(([v, label]) => ({ value: v, label }));

/** Linhas por página da lista. */
const PAGE_SIZE = 25;
/** Máximo de clientes por chamada das ações que recebem ids (POST /customers/bulk, /customers/labels, /documents/zip). */
export const BULK_MAX = 2000;
/** Clientes por página ao reunir os ids de "todos os resultados" (máximo de `pageSize` da API). */
const IDS_PAGE_SIZE = 500;
/** A mala direta recebe a seleção pelo endereço: acima disto, o endereço fica longo demais. */
const MAILING_MAX = 200;

const n = (v: number) => v.toLocaleString('pt-BR');

export function CustomersPage() {
  const { can } = useAuth();
  const { year } = useYear();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const urlSearch = params.get(SEARCH_PARAM) ?? '';
  const [search, setSearch] = useState(urlSearch);
  const debounced = useDebounced(search).trim();
  const paramsKey = params.toString();
  const filters = useMemo(() => filtersFromParams(new URLSearchParams(paramsKey)), [paramsKey]);
  const page = Math.max(1, Math.floor(Number(params.get(PAGE_PARAM))) || 1);
  const sort: Sort = SORTS.find((o) => o.param && o.param === params.get(SORT_PARAM))?.value ?? 'name';
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** "Selecionar todos os N resultados": vale para todos os clientes da busca e dos filtros, não só os da página. */
  const [allMatching, setAllMatching] = useState(false);
  const [working, setWorking] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [bulk, setBulk] = useState<null | 'status' | 'responsible' | 'procurator' | 'groups' | 'delete' | 'substatus'>(null);

  /** Muda o endereço mantendo os demais parâmetros. `replace` não cria entrada no histórico (digitação). */
  const update = (change: (p: URLSearchParams) => void, replace = false) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        change(next);
        return next;
      },
      { replace },
    );

  // campo de busca -> endereço (depois da pausa na digitação)
  const written = useRef(urlSearch);
  useEffect(() => {
    if (debounced === (params.get(SEARCH_PARAM) ?? '')) return;
    written.current = debounced;
    update((p) => {
      if (debounced) p.set(SEARCH_PARAM, debounced);
      else p.delete(SEARCH_PARAM);
      p.delete(PAGE_PARAM);
    }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  // endereço -> campo de busca, quando muda por fora (voltar/avançar, busca da barra superior)
  useEffect(() => {
    if (urlSearch === written.current) return;
    written.current = urlSearch;
    setSearch(urlSearch);
  }, [urlSearch]);

  // outro exercício: volta à primeira página
  const shownYear = useRef(year);
  useEffect(() => {
    if (shownYear.current === year) return;
    shownYear.current = year;
    update((p) => p.delete(PAGE_PARAM), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  /** O que define "os resultados": busca, exercício e filtros, no formato da API. */
  const criteria = useMemo(() => ({ search: urlSearch || undefined, year, ...apiFilters(filters) }), [urlSearch, year, filters]);
  const criteriaKey = JSON.stringify(criteria);
  // mudou a busca ou os filtros: "todos os resultados" já não é a mesma lista
  useEffect(() => setAllMatching(false), [criteriaKey]);

  const query = qs({ ...criteria, page, pageSize: PAGE_SIZE, sort: sort === 'name' ? undefined : sort });
  const list = useApi<CustomerList>(['customers', query], `/customers${query}`);
  const facets = useApi<Facets>(['customers', 'facets'], '/customers/facets');
  const activeCount = useMemo(() => Object.values(filters).filter((v) => (Array.isArray(v) ? v.length : Boolean(v))).length, [filters]);

  // página além do fim (endereço antigo, clientes excluídos): vai para a última
  const lastPage = list.data?.pages;
  useEffect(() => {
    if (lastPage && page > lastPage) update((p) => (lastPage > 1 ? p.set(PAGE_PARAM, String(lastPage)) : p.delete(PAGE_PARAM)), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPage, page]);

  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const allOnPage = rows.length > 0 && rows.every((r) => allMatching || selected.has(r.id));
  const count = allMatching ? total : selected.size;
  const narrowed = Boolean(urlSearch) || activeCount > 0;

  const clearSelection = () => {
    setAllMatching(false);
    setSelected(new Set());
  };

  /**
   * Ids dos clientes da ação. Com "todos os resultados", reúne os ids pela própria listagem
   * (mesma busca e filtros), página a página: as rotas de ação em massa só aceitam ids.
   */
  const targetIds = async (max = BULK_MAX): Promise<string[]> => {
    if (!allMatching) return [...selected];
    if (total > max) throw new ApiError(400, `Esta ação aceita até ${n(max)} clientes por vez e a seleção tem ${n(total)}. Refine a busca ou os filtros.`);
    const ids: string[] = [];
    for (let p = 1; ; p++) {
      const r = await api.get<CustomerList>(`/customers${qs({ ...criteria, page: p, pageSize: IDS_PAGE_SIZE })}`);
      ids.push(...r.data.map((c) => c.id));
      if (!r.data.length || p >= r.pages) break;
    }
    if (!ids.length) throw new ApiError(400, 'Nenhum cliente atende mais à busca e aos filtros.');
    return ids;
  };

  /** Roda uma ação do menu mostrando o erro num aviso (download recusado, seleção grande demais, sem conexão). */
  const act = async (fn: () => Promise<void>, fallback: string) => {
    setWorking(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e, fallback));
    } finally {
      setWorking(false);
    }
  };

  const openMailing = (kit: boolean) =>
    act(async () => {
      if (allMatching && total > MAILING_MAX) {
        throw new ApiError(400, `Para enviar a mais de ${MAILING_MAX} clientes de uma vez, abra a Mala direta e escolha os destinatários por filtros.`);
      }
      const ids = await targetIds(MAILING_MAX);
      navigate(`/comunicacao/mala-direta?${kit ? 'tipo=kit&' : ''}clientes=${ids.join(',')}`);
    }, 'Não foi possível abrir a mala direta.');

  const runBulk = useAction(async (body: { action: string; value?: unknown }) => api.post<{ affected: number }>('/customers/bulk', { ids: await targetIds(), year, ...body }), {
    success: (r) => `${r.affected} cliente(s) atualizado(s).`,
    invalidate: [['customers']],
    onSuccess: () => {
      setBulk(null);
      clearSelection();
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
            <Input aria-label="Buscar" placeholder="Buscar por nome, CPF ou e-mail" icon={<Search />} value={search} onChange={(e) => setSearch(e.target.value)} />
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
            <Button
              kind="tertiary"
              onClick={() =>
                update((p) => {
                  filtersToParams(p, EMPTY);
                  p.delete(PAGE_PARAM);
                })
              }
            >
              Limpar filtros
            </Button>
          )}
          <div className="vf-cus-sort">
            <Select
              aria-label="Ordenar por"
              value={sort}
              onChange={(e) =>
                update((p) => {
                  const param = SORTS.find((o) => o.value === e.target.value)?.param;
                  if (param) p.set(SORT_PARAM, param);
                  else p.delete(SORT_PARAM);
                  p.delete(PAGE_PARAM);
                })
              }
              options={SORTS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </div>
          <div className="vf-grow" />
          {count > 0 && <span className="vf-muted">{n(count)} selecionado(s)</span>}
          <Menu
            trigger={(t) => (
              <Button kind="secondary" onClick={t} disabled={!count} loading={working} icon={<ChevronDown />}>
                Ações
              </Button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<Package />} onClick={() => (close(), void openMailing(true))}>
                  Kit pós-declaração
                </MenuItem>
                <MenuItem icon={<Mail />} onClick={() => (close(), void openMailing(false))}>
                  Mala direta
                </MenuItem>
                <MenuItem
                  icon={<TagIcon />}
                  onClick={() => {
                    close();
                    void act(async () => api.download('/customers/labels', 'etiquetas.pdf', { ids: await targetIds() }), 'Não foi possível gerar as etiquetas.');
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
                  onClick={() => {
                    close();
                    // com todos os resultados, a exportação vai pelos filtros (a rota aceita), sem lista de ids
                    void act(() => api.download('/customers/export', 'clientes.xlsx', allMatching ? { filters: criteria } : { ids: [...selected], filters: { year } }), 'Não foi possível exportar para Excel.');
                  }}
                >
                  Exportar para Excel
                </MenuItem>
                {can('customer.download_documents') && (
                  <MenuItem
                    icon={<Download />}
                    onClick={() => {
                      close();
                      void act(async () => api.download('/documents/zip', 'documentos.zip', { customerIds: await targetIds(), year }), 'Não foi possível baixar os documentos.');
                    }}
                  >
                    Baixar documentos
                  </MenuItem>
                )}
                {can('customer.delete') && (
                  <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setBulk('delete'))}>
                    {allMatching ? 'Excluir todos os resultados' : 'Excluir selecionados'}
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
        </div>

        {rows.length > 0 && (allMatching || (allOnPage && total > rows.length)) && (
          <div className="vf-cus-selectall" role="status">
            {allMatching ? (
              <>
                <span>
                  Todos os {n(total)} clientes {narrowed ? 'da busca e dos filtros' : 'da carteira'} estão selecionados.
                </span>
                <Button kind="tertiary" size="sm" onClick={clearSelection}>
                  Limpar seleção
                </Button>
              </>
            ) : (
              <>
                <span>Os {rows.length} clientes desta página estão selecionados.</span>
                <Button kind="tertiary" size="sm" onClick={() => setAllMatching(true)}>
                  Selecionar todos os {n(total)} resultados
                </Button>
              </>
            )}
          </div>
        )}

        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          // erro não é "nenhum cliente": diz o que houve e deixa tentar de novo
          <EmptyState
            icon={<AlertTriangle />}
            title="Não foi possível carregar os clientes"
            description={errorMessage(list.error, 'Tente de novo em instantes.')}
            action={
              <Button kind="secondary" icon={<RefreshCw />} loading={list.isFetching} onClick={() => void list.refetch()}>
                Tentar de novo
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={narrowed ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}
            description={narrowed ? 'Revise a busca ou os filtros.' : 'Cadastre clientes um a um ou importe uma planilha.'}
            action={
              !narrowed && can('customer.create') ? (
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
                      onChange={() => {
                        setAllMatching(false);
                        setSelected((s) => {
                          const next = new Set(s);
                          rows.forEach((r) => (allOnPage ? next.delete(r.id) : next.add(r.id)));
                          return next;
                        });
                      }}
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
                        checked={allMatching || selected.has(c.id)}
                        onChange={() => {
                          if (allMatching) {
                            // desmarcar um cliente desfaz "todos os resultados": ficam os outros desta página
                            setAllMatching(false);
                            setSelected(new Set(rows.filter((r) => r.id !== c.id).map((r) => r.id)));
                            return;
                          }
                          setSelected((s) => {
                            const next = new Set(s);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          });
                        }}
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
        {list.data && list.data.total > 0 && (
          <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onChange={(p) => update((q) => (p > 1 ? q.set(PAGE_PARAM, String(p)) : q.delete(PAGE_PARAM)))} />
        )}
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
                update((p) => {
                  filtersToParams(p, draft);
                  p.delete(PAGE_PARAM);
                });
                setShowFilters(false);
              }}
            >
              Aplicar filtros
            </Button>
          </>
        }
      >
        {facets.isError ? (
          <Alert tone="danger" title="Não foi possível carregar os filtros.">
            <Button kind="secondary" size="sm" loading={facets.isFetching} onClick={() => void facets.refetch()}>
              Tentar de novo
            </Button>
          </Alert>
        ) : !f ? (
          <Loading />
        ) : (
          <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
            <FilterSection title="Declaração no exercício">
              {STAGES.map((s) => (
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

      <BulkDialogs kind={bulk} count={count} loading={runBulk.isPending} onClose={() => setBulk(null)} onRun={(action, value) => runBulk.mutate({ action, value })} />
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
        <Select label="Novo status" placeholder="Selecione" value={value} onChange={(e) => setValue(e.target.value)} options={substatusOptions(can('declaration.finish'))} />
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
          {groupList.data?.length === 0 && <span className="vf-muted">Nenhum grupo cadastrado. Crie grupos em Meu escritório.</span>}
        </div>
      )}
    </Modal>
  );
}
