import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import { ToastProvider } from '../ds';
import { GuestOnly, RequireAuth, UnknownRoute } from './App';
import { APP_ROUTES } from './routes';

/**
 * 404 de verdade (em vez de voltar calado ao início), abas protegidas pelas permissões do
 * registro da aba e o endereço guardado para depois do login. Usa as rotas reais dos módulos.
 */
const auth = vi.hoisted(() => ({ perms: [] as string[], owner: false, logged: true, loading: false }));

vi.mock('../lib/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/auth')>();
  return {
    ...original,
    useAuth: () => ({
      me: auth.logged ? { user: { name: 'Ana Rangel', isOwner: auth.owner }, office: { name: 'Escritório' }, permissions: auth.perms, favorites: [] } : null,
      loading: auth.loading,
      can: (...p: string[]) => auth.owner || p.some((x) => auth.perms.includes(x)),
      logout: () => {},
      refresh: async () => {},
    }),
  };
});

const calls = vi.hoisted(() => ({ get: [] as string[] }));
vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  const get = async (path: string) => {
    calls.get.push(path);
    if (/^\/customers\/[^/]+$/.test(path)) return { id: 'c1', name: 'Maria Cliente', cpfCnpj: '52998224725', email: null, status: 'active', procurationStatus: 'none', cndStatus: 'not_requested', groups: [] };
    // as páginas ficam carregando: o teste olha só para o roteamento
    return new Promise<never>(() => {});
  };
  return { ...original, api: { ...original.api, get, post: () => new Promise<never>(() => {}), put: () => new Promise<never>(() => {}) } };
});

function Where() {
  const location = useLocation();
  return (
    <p data-testid="where">
      {location.pathname}
      {location.search}|{JSON.stringify(location.state)}
    </p>
  );
}

/** Como no App: rotas de acesso, rotas do escritório atrás do login e o endereço desconhecido. */
function open(path: string, state?: unknown) {
  const router = createMemoryRouter(
    [
      { element: <GuestOnly />, children: [{ path: '/entrar', element: <Where /> }] },
      { element: <RequireAuth />, children: [{ path: '/', element: <Outlet />, children: APP_ROUTES }] },
      { path: '*', element: <UnknownRoute /> },
    ],
    { initialEntries: [state === undefined ? path : { pathname: path, state }] },
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

describe('404, abas protegidas e volta depois do login', () => {
  beforeEach(() => {
    auth.perms = [];
    auth.owner = false;
    auth.logged = true;
    auth.loading = false;
    calls.get = [];
  });
  afterEach(cleanup);

  it('endereço desconhecido, com sessão: "Página não encontrada" dentro do Shell, sem redirecionar', async () => {
    auth.owner = true;
    const router = open('/nao-existe/abc');
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(screen.getByText('/nao-existe/abc')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/nao-existe/abc');
    // dentro do Shell: o menu lateral continua na tela
    expect(screen.getByRole('navigation', { name: 'Menu principal' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar ao início' }).getAttribute('href')).toBe('/');
  });

  it('endereço desconhecido, sem sessão: 404 público (não vai ao login)', async () => {
    auth.logged = false;
    const router = open('/nao-existe');
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/nao-existe');
    expect(screen.queryByRole('navigation', { name: 'Menu principal' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Ir para o login' }).getAttribute('href')).toBe('/entrar');
  });

  it('aba desconhecida em /admin, /relatorios e /clientes/:id: "Aba não encontrada" com o caminho de volta', async () => {
    auth.owner = true;
    open('/admin/nao-existe');
    expect(await screen.findByRole('heading', { name: 'Aba não encontrada' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir Meu escritório' }).getAttribute('href')).toBe('/admin');
    // a página com abas continua em volta
    expect(screen.getByRole('heading', { name: 'Meu escritório' })).toBeTruthy();

    cleanup();
    open('/relatorios/nao-existe');
    expect(await screen.findByRole('heading', { name: 'Aba não encontrada' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir Relatórios' }).getAttribute('href')).toBe('/relatorios');

    cleanup();
    open('/clientes/c1/nao-existe');
    expect(await screen.findByRole('heading', { name: 'Aba não encontrada' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir o painel do cliente' }).getAttribute('href')).toBe('/clientes/c1');
    expect(screen.getByRole('heading', { name: 'Maria Cliente' })).toBeTruthy();
  });

  it('aba de Meu escritório pelo endereço, sem a permissão da aba: "Sem permissão", e a página não chama a API', async () => {
    auth.perms = ['employee.list'];
    const router = open('/admin/contratos');
    expect(await screen.findByText('Sem permissão para esta página')).toBeTruthy();
    expect(screen.getByText(/Sua função não dá acesso a Contratos/)).toBeTruthy();
    expect(router.state.location.pathname).toBe('/admin/contratos');
    // a barra só mostra as abas liberadas
    expect(screen.getByRole('link', { name: 'Colaboradores' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Contratos' })).toBeNull();
    expect(calls.get.filter((p) => p.includes('contract'))).toEqual([]);
  });

  it('aba de relatório e aba do perfil do cliente também exigem a permissão', async () => {
    auth.perms = ['report.results'];
    open('/relatorios/faturamento');
    expect(await screen.findByText('Sem permissão para esta página')).toBeTruthy();
    expect(screen.getByText(/Sua função não dá acesso a Faturamento/)).toBeTruthy();

    cleanup();
    auth.perms = ['customer.list', 'declaration.view'];
    open('/clientes/c1/copiloto');
    expect(await screen.findByText('Sem permissão para esta página')).toBeTruthy();
    expect(screen.getByText(/Sua função não dá acesso a Copiloto Financeiro/)).toBeTruthy();
  });

  it('com a permissão, a aba abre normalmente', async () => {
    auth.perms = ['report.results'];
    open('/relatorios/resultados');
    expect(await screen.findByRole('heading', { name: 'Relatório de resultados' })).toBeTruthy();
    expect(screen.queryByText('Sem permissão para esta página')).toBeNull();
  });

  it('perfil do cliente sem acesso ao Painel: abre a primeira aba liberada em vez de "sem permissão"', async () => {
    auth.perms = ['customer.list', 'customer.edit'];
    const router = open('/clientes/c1');
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/clientes/c1'));
    expect(router.state.location.pathname).toMatch(/^\/clientes\/c1\/[a-z-]+/);
    expect(screen.queryByText('Sem permissão para esta página')).toBeNull();
  });

  it('sem sessão, guarda o endereço completo (com a busca) para voltar depois do login', async () => {
    auth.logged = false;
    open('/clientes?busca=ana&pagina=2');
    const where = await screen.findByTestId('where');
    expect(where.textContent).toBe('/entrar|{"from":"/clientes?busca=ana&pagina=2"}');
  });

  it('quem já entrou e cai no login volta ao endereço guardado; sem ele (ou com endereço de fora), ao início', async () => {
    const router = open('/entrar', { from: '/relatorios/resultados?x=1' });
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/relatorios/resultados?x=1'));

    // endereço de outro site no estado: ignorado, vai ao início (o dono fica no dashboard)
    cleanup();
    auth.owner = true;
    const other = open('/entrar', { from: 'https://exemplo.com/roubo' });
    await waitFor(() => expect(other.state.location.pathname).toBe('/'));
  });
});
