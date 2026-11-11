import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bell, ChevronRight, CircleHelp, LogOut, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings, Star, User, X } from 'lucide-react';
import { Alert, Avatar, Button, ConfirmDialog, IconButton, Loading, Menu, MenuItem, Modal, Select, cx, useToast } from '../ds';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useBrowserNotifications } from '../lib/deviceNotifications';
import { formatCpfCnpj } from '../lib/format';
import { useAction, useApi, useDebounced, useMediaQuery } from '../lib/hooks';
import { YEAR_OPTIONS, YEAR_OPTIONS_SHORT, useYear } from '../lib/year';
import type { RobotOverview } from '../modules/ecac/types';
import { MessagesNavItem } from '../modules/messages/NavItem';
import { NOTIFICATIONS_KEY, fetchNotifications, markAllNotificationsRead, markNotificationRead, notificationPath, type AppNotification } from '../modules/notifications/api';
import { ErrorBoundary } from './ErrorBoundary';
import { favoriteLabel, isCurrentFavorite, visibleFavorites, type Favorite } from './favorites';
import { visibleNav, type NavGroup } from './nav';
import { PlanBanner } from './PlanBanner';
import { EmailBanner } from './EmailBanner';
import './shell.css';

/** Seção "Favoritos" do menu lateral: atalhos gravados pela estrela do cabeçalho das páginas. */
export function FavoritesNav({ favorites, onRemove }: { favorites: Favorite[] | undefined; onRemove: (f: Favorite) => void }) {
  const location = useLocation();
  const list = visibleFavorites(favorites);
  if (!list.length) return null;
  return (
    <div className="sidebar__favs" role="group" aria-label="Favoritos">
      <div className="sidebar__section">Favoritos</div>
      {list.map((f) => (
        <div key={f.path} className="sidebar__fav">
          <Link to={f.path} className={cx('sidebar__link', isCurrentFavorite(f, location) && 'active')} title={f.label} aria-current={isCurrentFavorite(f, location) ? 'page' : undefined}>
            <Star />
            <span className="sidebar__label">{f.label}</span>
          </Link>
          <button type="button" className="sidebar__fav-remove" aria-label={`Remover ${f.label} dos favoritos`} title="Remover dos favoritos" onClick={() => onRemove(f)}>
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Atalho global: sincroniza pelo SERPRO o eCAC de todos os clientes com procurador (POST /robot/sync-office).
 * Ao abrir, confere o estado da integração (GET /robot/overview, campo `serpro`): sem o SERPRO pronto,
 * não enfileira nada e aponta para Meu escritório › Integrações.
 */
function EcacSyncButton() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  // só consulta ao abrir: o painel do robô monta o cliente do SERPRO, caro demais para cada página
  const overview = useApi<Pick<RobotOverview, 'serpro'>>(['robot', 'overview'], '/robot/overview', { enabled: open });
  const sync = useAction(() => api.post<{ alreadyQueued: boolean }>('/robot/sync-office'), {
    success: (r) => (r.alreadyQueued ? 'Já existe uma sincronização do eCAC na fila. Acompanhe em Meu escritório › Robô.' : 'Sincronização do eCAC solicitada. Acompanhe em Meu escritório › Robô.'),
    invalidate: [['robot']],
    onSuccess: () => setOpen(false),
  });
  const close = () => setOpen(false);
  // falha ao consultar o estado não bloqueia: o job avisa no sino se a sincronização falhar
  const serpro = overview.isError ? 'ready' : overview.data?.serpro;
  // um "não configurado" guardado de antes espera a resposta nova (pode ter sido configurado depois)
  const checking = !serpro || (serpro !== 'ready' && overview.isFetching);
  return (
    <>
      <IconButton label="Sincronizar eCAC" onClick={() => setOpen(true)} disabled={sync.isPending}>
        <RefreshCw />
      </IconButton>
      {open && checking ? (
        <Modal open title="Sincronizar o eCAC" onClose={close} width={460}>
          <Loading label="Verificando a integração com o SERPRO..." />
        </Modal>
      ) : open && serpro !== 'ready' ? (
        <Modal
          open
          title="Sincronizar o eCAC"
          onClose={close}
          width={460}
          footer={
            <Button kind="secondary" onClick={close}>
              Fechar
            </Button>
          }
        >
          <Alert tone="warning" title="Integração SERPRO não configurada">
            {serpro === 'missing' ? (
              <>A integração SERPRO Integra Contador não está disponível nesta instalação do Verifco, e sem ela o robô não consegue consultar o eCAC. Fale com o suporte do Verifco.</>
            ) : (
              <>
                A sincronização usa a integração SERPRO Integra Contador, que ainda não está configurada (ou está inativa) neste escritório. Configure-a em{' '}
                {can('integrations.manage') ? (
                  <Link to="/admin/integracoes" onClick={close}>
                    Meu escritório › Integrações
                  </Link>
                ) : (
                  'Meu escritório › Integrações (peça a quem administra o escritório)'
                )}{' '}
                e tente de novo.
              </>
            )}
          </Alert>
        </Modal>
      ) : (
        <ConfirmDialog
          open={open}
          title="Sincronizar o eCAC"
          message="O robô consulta pelo SERPRO a procuração eletrônica e a caixa postal de todos os clientes ativos com procurador. A consulta roda em segundo plano: você recebe uma notificação ao terminar (ou se ela falhar) e o andamento aparece em Meu escritório › Robô."
          confirmLabel="Sincronizar"
          loading={sync.isPending}
          onConfirm={() => sync.mutate(undefined)}
          onClose={close}
        />
      )}
    </>
  );
}

/** Item do menu lateral; recebe o grupo já filtrado pelas permissões (`visibleNav`). */
function NavGroupItem({ group }: { group: NavGroup }) {
  const location = useLocation();
  const children = group.children ?? [];
  const activeChild = children.some((c) => (c.end ? location.pathname === c.to : location.pathname.startsWith(c.to)));
  const [open, setOpen] = useState(activeChild);
  useEffect(() => {
    if (activeChild) setOpen(true);
  }, [activeChild]);
  const Icon = group.icon;

  if (group.to) {
    return (
      <NavLink to={group.to} className={({ isActive }) => cx('sidebar__link', isActive && 'active')} title={group.label}>
        <Icon />
        <span className="sidebar__label">{group.label}</span>
      </NavLink>
    );
  }
  if (!children.length) return null;
  return (
    <div>
      <button type="button" className="sidebar__link" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={group.label}>
        <Icon />
        <span className="sidebar__label">{group.label}</span>
        <ChevronRight size={16} className={cx('sidebar__chev', open && 'open')} />
      </button>
      {open && (
        <div className="sidebar__sub">
          {children.map((c) => (
            <NavLink key={c.to} to={c.to} end={c.end} className={({ isActive }) => cx('sidebar__link', isActive && 'active')}>
              <span className="sidebar__label">{c.label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/** Quantos clientes a busca global sugere enquanto a pessoa digita. */
export const SEARCH_SUGGESTIONS = 8;
const SEARCH_MIN_CHARS = 2;

interface SearchHit {
  id: string;
  name: string;
  cpfCnpj: string;
  email: string | null;
}

/**
 * Busca global de clientes (nome, CPF/CNPJ ou e-mail). Enquanto a pessoa digita, sugere os
 * primeiros clientes; ↓/↑ escolhem, Enter abre o escolhido. Enter sem escolher (ou a última opção)
 * abre a lista de clientes com a busca, como sempre. Esc fecha as sugestões.
 */
export function GlobalSearch() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const listId = useId();
  const box = useRef<HTMLFormElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = text.trim();
  const term = useDebounced(typed, 250);
  const suggest = can('customer.list');
  const ready = suggest && term.length >= SEARCH_MIN_CHARS;
  const q = useQuery({
    queryKey: ['customers', 'suggestions', term],
    queryFn: () => api.get<{ data?: SearchHit[] }>(`/customers${qs({ search: term, pageSize: SEARCH_SUGGESTIONS })}`),
    enabled: ready,
    retry: false,
    staleTime: 30_000,
  });
  const waiting = term !== typed || (ready && q.isLoading);
  const hits = ready && term === typed && Array.isArray(q.data?.data) ? q.data.data.slice(0, SEARCH_SUGGESTIONS) : [];
  const show = open && suggest && typed.length >= SEARCH_MIN_CHARS;
  // opções: os clientes sugeridos e, por último, "ver todos os resultados"
  const count = hits.length + 1;

  useEffect(() => setActive(-1), [term]);
  // mudou de página: fecha as sugestões
  useEffect(() => setOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!show) return;
    const onMouse = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onMouse);
    return () => document.removeEventListener('mousedown', onMouse);
  }, [show]);

  const openList = () => {
    setOpen(false);
    navigate(`/clientes?busca=${encodeURIComponent(typed)}`);
  };
  const openCustomer = (c: SearchHit) => {
    setOpen(false);
    setText('');
    navigate(`/clientes/${c.id}`);
  };
  const choose = (i: number) => (hits[i] ? openCustomer(hits[i]) : openList());

  return (
    <form
      ref={box}
      className="topbar__search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (show && active >= 0) choose(active);
        else openList();
      }}
    >
      <div className="vf-input-group vf-input-group--icon">
        <Search />
        <input
          className="vf-input"
          placeholder="Busque por nome, CPF ou e-mail"
          value={text}
          aria-label="Buscar clientes"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={show}
          aria-controls={show ? listId : undefined}
          aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && show) {
              // fecha só as sugestões (não o diálogo que estiver aberto por baixo)
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setActive(-1);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (!suggest || typed.length < SEARCH_MIN_CHARS) return;
              e.preventDefault();
              if (!show) return setOpen(true);
              setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % count : (i <= 0 ? count : i) - 1));
            }
          }}
        />
      </div>
      {show && (
        <ul className="topbar__results" id={listId} role="listbox" aria-label="Clientes encontrados">
          {waiting && !hits.length ? (
            <li className="topbar__results-note" role="presentation">
              Buscando...
            </li>
          ) : q.isError ? (
            <li className="topbar__results-note" role="presentation">
              Não foi possível buscar agora. Tecle Enter para abrir a lista de clientes.
            </li>
          ) : !hits.length ? (
            <li className="topbar__results-note" role="presentation">
              Nenhum cliente encontrado para “{typed}”.
            </li>
          ) : (
            hits.map((c, i) => (
              // mousedown não tira o foco do campo; o clique escolhe
              <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={active === i} className="topbar__result" onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => openCustomer(c)}>
                <span className="topbar__result-name">{c.name}</span>
                <span className="topbar__result-meta">
                  {formatCpfCnpj(c.cpfCnpj)}
                  {c.email ? ` · ${c.email}` : ''}
                </span>
              </li>
            ))
          )}
          <li
            id={`${listId}-${hits.length}`}
            role="option"
            aria-selected={active === hits.length}
            className="topbar__result topbar__result--all"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(hits.length)}
            onClick={openList}
          >
            Ver todos os resultados
            <ArrowRight aria-hidden />
          </li>
        </ul>
      )}
      <span className="sr-only" role="status">
        {show && !waiting && !q.isError ? (hits.length ? `${hits.length} cliente(s) sugerido(s). Use as setas para escolher.` : 'Nenhum cliente encontrado.') : ''}
      </span>
    </form>
  );
}

/** Notificações mostradas no sino; as demais ficam em "Ver todas" (/notificacoes). */
export const BELL_ITEMS = 8;

/**
 * Sino da barra superior: últimas notificações, marcar como lidas e o caminho para a página completa.
 * A consulta fica aqui (e não no Shell): o React Query só redesenha quem lê cada campo do resultado,
 * e é o sino que precisa saber de erro e carregamento.
 */
export function NotificationsBell() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [marking, setMarking] = useState(false);
  // os campos são lidos aqui, no desenho do sino: o conteúdo do menu é desenhado depois, pelo Menu,
  // e o React Query só avisa das mudanças nos campos que já foram lidos
  const { data, isError, isLoading, isFetching, refetch } = useQuery({ queryKey: NOTIFICATIONS_KEY, queryFn: fetchNotifications, refetchInterval: 60_000, retry: false });
  const list: AppNotification[] = Array.isArray(data) ? data : [];
  const unread = list.filter((n) => !n.readAt).length;
  // avisos do sistema neste navegador, se ligado em Conta › Preferências
  useBrowserNotifications(Array.isArray(data) ? data : undefined, me?.user.notificationPrefs, navigate);

  const markAll = async () => {
    setMarking(true);
    try {
      await markAllNotificationsRead();
      await refetch();
    } catch (e) {
      toast.error(errorMessage(e, 'Não foi possível marcar as notificações como lidas. Tente de novo.'));
    } finally {
      setMarking(false);
    }
  };

  return (
    <Menu
      trigger={(toggle) => (
        <IconButton label="Notificações" onClick={toggle} dot={unread > 0}>
          <Bell />
        </IconButton>
      )}
    >
      {(close) => (
        <div className="topbar__bell">
          <div className="topbar__bell-head">
            <strong>Notificações</strong>
            {unread > 0 && (
              <button type="button" className="vf-btn vf-btn--tertiary vf-btn--sm" disabled={marking} onClick={() => void markAll()}>
                Marcar todas como lidas
              </button>
            )}
          </div>
          {isError && (
            // erro não é "nenhuma notificação": diz o que houve e deixa tentar de novo
            <div className="topbar__bell-note" role="alert">
              <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
                <span>{list.length ? 'Não foi possível atualizar as notificações.' : 'Não foi possível carregar as notificações.'}</span>
                <div>
                  <button type="button" className="vf-btn vf-btn--secondary vf-btn--sm" disabled={isFetching} onClick={() => void refetch()}>
                    Tentar de novo
                  </button>
                </div>
              </div>
            </div>
          )}
          {isLoading ? <div className="topbar__bell-note">Carregando...</div> : !isError && list.length === 0 ? <div className="topbar__bell-note">Nenhuma notificação.</div> : null}
          {list.slice(0, BELL_ITEMS).map((n) => (
            <MenuItem
              key={n.id}
              onClick={async () => {
                close();
                if (!n.readAt) await markNotificationRead(n.id).catch(() => {});
                void refetch();
                const to = notificationPath(n);
                if (to) navigate(to);
              }}
            >
              <div className="vf-stack" style={{ '--gap': '2px', fontWeight: n.readAt ? 500 : 700 } as React.CSSProperties}>
                <span>{n.title}</span>
                {n.body && <span className="vf-text-xs vf-muted">{n.body}</span>}
              </div>
            </MenuItem>
          ))}
          <div className="topbar__bell-foot">
            <Link to="/notificacoes" onClick={close}>
              {list.length > BELL_ITEMS ? `Ver todas (${list.length})` : 'Ver todas'}
            </Link>
          </div>
        </div>
      )}
    </Menu>
  );
}

/**
 * Moldura das páginas do escritório: menu lateral, barra superior e o conteúdo da rota.
 * `children` substitui o conteúdo da rota (usado pelo 404 de endereços fora das rotas do Shell).
 */
export function Shell({ children }: { children?: ReactNode }) {
  const { me, logout, can, refresh } = useAuth();
  const { year, setYear } = useYear();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const narrow = useMediaQuery('(max-width: 600px)');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const removeFavorite = async (f: Favorite) => {
    try {
      await api.put('/auth/favorites', { path: f.path, label: f.label, favorite: false });
      await refresh();
    } catch {
      toast.error('Não foi possível remover o favorito. Tente novamente.');
    }
  };

  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className={cx('shell', collapsed && 'shell--collapsed', mobileOpen && 'shell--mobile-open')}>
      <nav className="sidebar" aria-label="Menu principal">
        <div className="sidebar__brand">
          <img src={collapsed ? '/favicon.svg' : '/verifco-logo-negativo.svg'} alt="Verifco" />
        </div>
        <FavoritesNav favorites={me?.favorites} onRemove={(f) => void removeFavorite(f)} />
        {visibleNav(can).map((g) => (
          <Fragment key={g.id}>
            <NavGroupItem group={g} />
            {/* caixa de mensagens (com o selo de não lidas), logo abaixo de Clientes, para quem lê as conversas */}
            {g.id === 'clientes' && can('customer.list') && <MessagesNavItem />}
          </Fragment>
        ))}
        <div className="sidebar__footer">
          <button type="button" className="sidebar__link" onClick={() => setCollapsed((c) => !c)} title={collapsed ? 'Expandir menu' : 'Recolher menu'}>
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            <span className="sidebar__label">Recolher menu</span>
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <span className="mobile-only" style={{ display: 'contents' }}>
            <IconButton label="Abrir menu" onClick={() => setMobileOpen((o) => !o)} className="topbar__burger">
              <MenuIcon />
            </IconButton>
          </span>
          <GlobalSearch />
          <div className="vf-grow" />
          <div className="topbar__year">
            <Select aria-label="Ano-exercício" value={String(year)} onChange={(e) => setYear(Number(e.target.value))} options={narrow ? YEAR_OPTIONS_SHORT : YEAR_OPTIONS} />
          </div>
          {can('ecac.sync') && <EcacSyncButton />}
          <IconButton label="Ajuda" onClick={() => navigate('/ajuda')}>
            <CircleHelp />
          </IconButton>
          <NotificationsBell />
          <Menu
            trigger={(toggle) => (
              <button type="button" onClick={toggle} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0 }} aria-label="Menu do usuário">
                <Avatar name={me?.user.name ?? '?'} />
              </button>
            )}
          >
            {(close) => (
              <>
                <div style={{ padding: '8px 12px' }}>
                  <div className="vf-text-sm-bold">{me?.user.name}</div>
                  <div className="vf-text-xs vf-muted">{me?.office?.name}</div>
                </div>
                <div className="vf-menu__sep" />
                <MenuItem icon={<User />} onClick={() => (close(), navigate('/conta'))}>
                  Detalhes da conta
                </MenuItem>
                <MenuItem icon={<Settings />} onClick={() => (close(), navigate('/conta/preferencias'))}>
                  Preferências
                </MenuItem>
                <div className="vf-menu__sep" />
                <MenuItem icon={<LogOut />} danger onClick={() => (close(), logout(), navigate('/entrar'))}>
                  Sair
                </MenuItem>
              </>
            )}
          </Menu>
        </header>
        <PlanBanner />
        <EmailBanner />
        <main className="content">
          {/* um erro ao desenhar a página fica dentro do conteúdo; navegar para outra página desfaz */}
          <ErrorBoundary resetKey={location.pathname}>{children ?? <Outlet />}</ErrorBoundary>
        </main>
        <footer className="footer">
          Verifco · gestão de IRPF para escritórios contábeis · <Link to="/ajuda">Ajuda</Link> · <Link to="/downloads">Downloads</Link>
        </footer>
      </div>
    </div>
  );
}

/** Cabeçalho de página com breadcrumb e atalho de favorito. */
export function PageHeader({
  title,
  description,
  actions,
  crumbs,
  section,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  crumbs?: { label: string; to?: string }[];
  /** Aba aberta da página; entra no nome do favorito ("Meu escritório › Colaboradores"). */
  section?: string;
}) {
  const { me, refresh } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const path = location.pathname + location.search;
  const fav = me?.favorites.some((f) => f.path === path);
  const label = typeof title === 'string' ? favoriteLabel(title, section) : '';
  return (
    <div className="vf-page-header">
      <div>
        {crumbs && (
          <nav className="vf-breadcrumb" aria-label="Você está em">
            {crumbs.map((c, i) => (
              <span key={i} className="vf-inline" style={{ '--gap': '8px' } as React.CSSProperties}>
                {c.to ? <NavLink to={c.to}>{c.label}</NavLink> : <span>{c.label}</span>}
                {i < crumbs.length - 1 && <ChevronRight />}
              </span>
            ))}
          </nav>
        )}
        <div className="vf-inline">
          <h1 className="vf-page-header__title">{title}</h1>
          {typeof title === 'string' && (
            <IconButton
              label={fav ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
              aria-pressed={Boolean(fav)}
              onClick={async () => {
                try {
                  await api.put('/auth/favorites', { path, label, favorite: !fav });
                  await refresh();
                  if (!fav) toast.success('Página adicionada aos favoritos do menu lateral.');
                } catch {
                  toast.error('Não foi possível atualizar os favoritos. Tente novamente.');
                }
              }}
            >
              <Star fill={fav ? 'var(--color-yellow-60)' : 'none'} color={fav ? 'var(--color-yellow-80)' : undefined} />
            </IconButton>
          )}
        </div>
        {description && <p className="vf-page-header__desc">{description}</p>}
      </div>
      {actions && <div className="vf-inline">{actions}</div>}
    </div>
  );
}
