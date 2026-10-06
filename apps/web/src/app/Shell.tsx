import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronRight, CircleHelp, LogOut, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings, Star, User, X } from 'lucide-react';
import { Avatar, ConfirmDialog, IconButton, Menu, MenuItem, Select, cx, useToast } from '../ds';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useMediaQuery } from '../lib/hooks';
import { YEAR_OPTIONS, YEAR_OPTIONS_SHORT, useYear } from '../lib/year';
import { favoriteLabel, isCurrentFavorite, visibleFavorites, type Favorite } from './favorites';
import { NAV, type NavGroup } from './nav';
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

/** Atalho global: sincroniza pelo SERPRO o eCAC de todos os clientes com procurador (POST /robot/sync-office). */
function EcacSyncButton() {
  const [confirming, setConfirming] = useState(false);
  const sync = useAction(() => api.post<{ alreadyQueued: boolean }>('/robot/sync-office'), {
    success: (r) => (r.alreadyQueued ? 'Já existe uma sincronização do eCAC na fila. Acompanhe em Administração › Robô.' : 'Sincronização do eCAC solicitada. Acompanhe em Administração › Robô.'),
    invalidate: [['robot']],
    onSuccess: () => setConfirming(false),
  });
  return (
    <>
      <IconButton label="Sincronizar eCAC" onClick={() => setConfirming(true)} disabled={sync.isPending}>
        <RefreshCw />
      </IconButton>
      <ConfirmDialog
        open={confirming}
        title="Sincronizar o eCAC"
        message="O robô consulta pelo SERPRO a procuração eletrônica e a caixa postal de todos os clientes ativos com procurador. A consulta roda em segundo plano: você recebe uma notificação ao terminar e o andamento aparece em Administração › Robô."
        confirmLabel="Sincronizar"
        loading={sync.isPending}
        onConfirm={() => sync.mutate(undefined)}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

function NavGroupItem({ group, can }: { group: NavGroup; can: (...p: string[]) => boolean }) {
  const location = useLocation();
  const children = (group.children ?? []).filter((c) => !c.perms?.length || can(...c.perms));
  const activeChild = children.some((c) => (c.end ? location.pathname === c.to : location.pathname.startsWith(c.to)));
  const [open, setOpen] = useState(activeChild);
  useEffect(() => {
    if (activeChild) setOpen(true);
  }, [activeChild]);
  const Icon = group.icon;

  if (group.to) {
    if (group.perms?.length && !can(...group.perms)) return null;
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

interface Notification {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export function Shell() {
  const { me, logout, can, refresh } = useAuth();
  const { year, setYear } = useYear();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const narrow = useMediaQuery('(max-width: 600px)');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState('');

  const removeFavorite = async (f: Favorite) => {
    try {
      await api.put('/auth/favorites', { path: f.path, label: f.label, favorite: false });
      await refresh();
    } catch {
      toast.error('Não foi possível remover o favorito. Tente novamente.');
    }
  };

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<Notification[]>('/notifications'),
    refetchInterval: 60_000,
    retry: false,
  });
  const unread = (notifications.data ?? []).filter((n) => !n.readAt).length;

  return (
    <div className={cx('shell', collapsed && 'shell--collapsed', mobileOpen && 'shell--mobile-open')}>
      <nav className="sidebar" aria-label="Menu principal">
        <div className="sidebar__brand">
          <img src={collapsed ? '/favicon.svg' : '/verifco-logo-negativo.svg'} alt="Verifco" />
        </div>
        <FavoritesNav favorites={me?.favorites} onRemove={(f) => void removeFavorite(f)} />
        {NAV.map((g) => (
          <NavGroupItem key={g.id} group={g} can={can} />
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
          <form
            className="topbar__search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              navigate(`/clientes?busca=${encodeURIComponent(search.trim())}`);
            }}
          >
            <div className="vf-input-group vf-input-group--icon">
              <Search />
              <input className="vf-input" placeholder="Busque por nome, CPF ou e-mail e tecle Enter" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar clientes" />
            </div>
          </form>
          <div className="vf-grow" />
          <div className="topbar__year">
            <Select aria-label="Ano-exercício" value={String(year)} onChange={(e) => setYear(Number(e.target.value))} options={narrow ? YEAR_OPTIONS_SHORT : YEAR_OPTIONS} />
          </div>
          {can('ecac.sync') && <EcacSyncButton />}
          <IconButton label="Ajuda" onClick={() => navigate('/ajuda')}>
            <CircleHelp />
          </IconButton>
          <Menu
            trigger={(toggle) => (
              <IconButton label="Notificações" onClick={toggle} dot={unread > 0}>
                <Bell />
              </IconButton>
            )}
          >
            {(close) => (
              <div style={{ width: 340, maxHeight: 420, overflowY: 'auto' }}>
                <div className="vf-inline vf-between" style={{ padding: '8px 12px' }}>
                  <strong>Notificações</strong>
                  {unread > 0 && (
                    <button
                      type="button"
                      className="vf-btn vf-btn--tertiary vf-btn--sm"
                      onClick={async () => {
                        await api.post('/notifications/read-all');
                        void notifications.refetch();
                      }}
                    >
                      Marcar todas como lidas
                    </button>
                  )}
                </div>
                {(notifications.data ?? []).length === 0 && <div className="vf-muted" style={{ padding: 12 }}>Nenhuma notificação.</div>}
                {(notifications.data ?? []).map((n) => (
                  <MenuItem
                    key={n.id}
                    onClick={async () => {
                      close();
                      if (!n.readAt) await api.post(`/notifications/${n.id}/read`).catch(() => {});
                      void notifications.refetch();
                      if (n.link) navigate(n.link);
                    }}
                  >
                    <div className="vf-stack" style={{ '--gap': '2px', fontWeight: n.readAt ? 500 : 700 } as React.CSSProperties}>
                      <span>{n.title}</span>
                      {n.body && <span className="vf-text-xs vf-muted">{n.body}</span>}
                    </div>
                  </MenuItem>
                ))}
              </div>
            )}
          </Menu>
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
        <main className="content">
          <Outlet />
        </main>
        <footer className="footer">Verifco · gestão de IRPF para escritórios contábeis</footer>
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
  /** Aba aberta da página; entra no nome do favorito ("Administração › Colaboradores"). */
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
