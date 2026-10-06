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
const calls = vi.hoisted(() => ({ post: [] as string[], put: [] as unknown[] }));

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
      get: async () => [],
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
    calls.post = [];
    calls.put = [];
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
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar eCAC' }));
    expect(screen.getByText(/clientes ativos com procurador/)).toBeTruthy();
    expect(calls.post).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar' }));
    await screen.findByText(/Sincronização do eCAC solicitada/);
    expect(calls.post).toEqual(['/robot/sync-office']);
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
