import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Outlet, RouterProvider, createMemoryRouter } from 'react-router';
import { ToastProvider } from '../ds';
import { NAV } from './nav';
import { APP_ROUTES } from './routes';

/**
 * Página inicial e Kanban com as rotas reais dos módulos (as mesmas do App): quem não pode abrir o
 * dashboard vai ao primeiro destino do menu; quem não vê nenhum recebe um aviso, sem laço.
 */
const auth = vi.hoisted(() => ({ perms: [] as string[], owner: false }));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    me: { user: { name: 'Ana Rangel', isOwner: auth.owner }, office: { name: 'Escritório' }, permissions: auth.perms, favorites: [] },
    can: (...p: string[]) => auth.owner || p.some((x) => auth.perms.includes(x)),
    logout: () => {},
    refresh: async () => {},
  }),
}));

// as páginas ficam carregando: o teste olha só para o roteamento
vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  const pending = () => new Promise<never>(() => {});
  return { ...original, api: { ...original.api, get: pending, post: pending, put: pending } };
});

function open(path: string) {
  // como no App: o Shell em "/" com as rotas dos módulos, e endereço desconhecido volta para "/"
  const router = createMemoryRouter(
    [
      { path: '/', element: <Outlet />, children: APP_ROUTES },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('página inicial e permissões das rotas', () => {
  beforeEach(() => {
    auth.perms = [];
    auth.owner = false;
  });
  afterEach(cleanup);

  it('sem as permissões do dashboard (só report.billing), "/" leva ao primeiro destino do menu', async () => {
    auth.perms = ['report.billing'];
    const router = open('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/relatorios/faturamento'));
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('depois do login (navigate("/")) e em endereço desconhecido, o mesmo destino', async () => {
    auth.perms = ['radar.view'];
    const router = open('/nao-existe');
    await waitFor(() => expect(router.state.location.pathname).toBe('/radar'));
  });

  it('com declaration.view ou customer.list, "/" continua no dashboard', async () => {
    for (const perm of ['declaration.view', 'customer.list']) {
      cleanup();
      auth.perms = [perm];
      const router = open('/');
      await new Promise((r) => setTimeout(r, 0));
      expect(router.state.location.pathname, perm).toBe('/');
    }
  });

  it('o dono continua no dashboard e abre o Kanban', async () => {
    auth.owner = true;
    const router = open('/');
    await new Promise((r) => setTimeout(r, 0));
    expect(router.state.location.pathname).toBe('/');
    cleanup();
    open('/kanban');
    expect(await screen.findByRole('heading', { name: 'Kanban' })).toBeTruthy();
    expect(screen.queryByText('Sem permissão para esta página')).toBeNull();
  });

  it('Kanban pelo endereço, sem declaration.view: "sem permissão" e link para uma página liberada', async () => {
    auth.perms = ['customer.list'];
    const router = open('/kanban');
    expect(await screen.findByText('Sem permissão para esta página')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/kanban');
    expect(screen.getByRole('link', { name: 'Ir para uma página liberada' }).getAttribute('href')).toBe('/');

    cleanup();
    auth.perms = ['report.billing'];
    open('/kanban');
    expect(await screen.findByText('Sem permissão para esta página')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ir para uma página liberada' }).getAttribute('href')).toBe('/relatorios/faturamento');
  });

  it('sem nenhum destino no menu, "/" mostra um aviso em vez de redirecionar', async () => {
    // no menu real, a Central de downloads é de todos: simula um menu só com destinos restritos
    const original = NAV.splice(0, NAV.length, { id: 'x', label: 'X', icon: NAV[0].icon, to: '/backup', perms: ['backup.download'] });
    onTestFinished(() => void NAV.splice(0, NAV.length, ...original));
    const router = open('/');
    expect(await screen.findByText('Nenhuma área liberada para você')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');

    cleanup();
    open('/kanban');
    expect(await screen.findByText('Sem permissão para esta página')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Ir para uma página liberada' })).toBeNull();
  });
});
