import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../ds';
import { Shell } from './Shell';

const auth = vi.hoisted(() => ({
  perms: [] as string[],
  favorites: [] as { path: string; label: string }[],
  refresh: vi.fn(async () => {}),
}));
const calls = vi.hoisted(() => ({ get: [] as string[], post: [] as string[], put: [] as unknown[] }));
const robot = vi.hoisted(() => ({ serpro: 'ready' as 'ready' | 'not_configured' | 'missing' }));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    me: { user: { name: 'Ana Rangel', isOwner: false }, office: { name: 'Escritório' }, permissions: auth.perms, favorites: auth.favorites },
    can: (...p: string[]) => p.some((x) => auth.perms.includes(x)),
    logout: () => {},
    refresh: auth.refresh,
  }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      get: async (path: string) => {
        calls.get.push(path);
        if (path === '/robot/overview') return { serpro: robot.serpro, customersWithProcurator: 3, activeTokens: 0, lastOfficeSync: null, activity: [] };
        return [];
      },
      post: async (path: string) => {
        calls.post.push(path);
        return { alreadyQueued: false, job: { id: 'j1' } };
      },
      put: async (path: string, body: unknown) => {
        calls.put.push({ path, body });
        return { ok: true };
      },
    },
  };
});

const renderShell = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/kanban']}>
          <Shell />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('Shell', () => {
  beforeEach(() => {
    auth.perms = [];
    auth.favorites = [];
    calls.get = [];
    calls.post = [];
    calls.put = [];
    robot.serpro = 'ready';
    auth.refresh.mockClear();
  });
  afterEach(cleanup);

  it('sem ecac.sync não mostra o atalho de sincronização', () => {
    renderShell();
    expect(screen.queryByRole('button', { name: 'Sincronizar eCAC' })).toBeNull();
  });

  it('com ecac.sync sincroniza o escritório pela barra superior, depois de confirmar', async () => {
    auth.perms = ['ecac.sync'];
    renderShell();
    // o estado do SERPRO só é consultado ao abrir o atalho
    expect(calls.get).not.toContain('/robot/overview');
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar eCAC' }));
    expect(await screen.findByText(/clientes ativos com procurador/)).toBeTruthy();
    expect(calls.get).toContain('/robot/overview');
    expect(calls.post).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar' }));
    await screen.findByText(/Sincronização do eCAC solicitada/);
    expect(calls.post).toEqual(['/robot/sync-office']);
  });

  it('sem o SERPRO configurado não enfileira: avisa e leva a Administração › Integrações', async () => {
    robot.serpro = 'not_configured';
    auth.perms = ['ecac.sync', 'integrations.manage'];
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar eCAC' }));
    expect(await screen.findByText('Integração SERPRO não configurada')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Administração › Integrações' });
    expect(link.getAttribute('href')).toBe('/admin/integracoes');
    expect(screen.queryByRole('button', { name: 'Sincronizar' })).toBeNull();
    expect(screen.queryByText(/você recebe uma notificação/)).toBeNull();
    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByText('Integração SERPRO não configurada')).toBeNull());
    expect(calls.post).toEqual([]);
  });

  it('sem o SERPRO e sem acesso às integrações, explica sem link', async () => {
    robot.serpro = 'not_configured';
    auth.perms = ['ecac.sync'];
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar eCAC' }));
    expect(await screen.findByText(/peça a quem administra o escritório/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Administração › Integrações' })).toBeNull();
    // o X do cabeçalho e o botão do rodapé fecham; usa o do rodapé
    fireEvent.click(screen.getAllByRole('button', { name: 'Fechar' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.post).toEqual([]);
  });

  it('mostra os favoritos no menu lateral e remove pelo X', async () => {
    auth.favorites = [
      { path: '/admin/colaboradores', label: 'Administração › Colaboradores' },
      { path: '/kanban', label: 'Kanban' },
    ];
    renderShell();
    const group = screen.getByRole('group', { name: 'Favoritos' });
    expect(group.querySelectorAll('a')).toHaveLength(2);
    expect(within(group).getByRole('link', { name: 'Kanban' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Remover Kanban dos favoritos' }));
    await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
    expect(calls.put).toEqual([{ path: '/auth/favorites', body: { path: '/kanban', label: 'Kanban', favorite: false } }]);
  });
});
