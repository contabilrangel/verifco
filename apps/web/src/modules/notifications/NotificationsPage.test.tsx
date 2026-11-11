import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { ToastProvider } from '../../ds';
import { NOTIFICATIONS_PAGE_SIZE, NotificationsPage } from './NotificationsPage';
import { module } from './module';

/** Página "Ver todas" do sino: paginação no navegador, não lidas, erro com nova tentativa. */
const state = vi.hoisted(() => ({ list: [] as any[] | 'error', post: [] as string[], prefs: {} as { enabled?: boolean } }));

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { user: { notificationPrefs: state.prefs }, favorites: [] }, can: () => true, refresh: async () => {} }),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      get: async (path: string) => {
        if (path !== '/notifications') return [];
        if (state.list === 'error') throw new original.ApiError(500, 'Erro interno do servidor.');
        return state.list;
      },
      post: async (path: string) => {
        state.post.push(path);
        if (state.list !== 'error') {
          const id = /^\/notifications\/(.+)\/read$/.exec(path)?.[1];
          state.list = state.list.map((n) => (path === '/notifications/read-all' || n.id === id ? { ...n, readAt: '2026-11-11T10:00:00Z' } : n));
        }
        return { ok: true };
      },
    },
  };
});

const note = (i: number, read = false) => ({ id: `n${i}`, title: `Aviso ${i}`, body: i === 1 ? 'Sincronização concluída.' : null, link: i % 2 ? `/clientes/c${i}` : null, readAt: read ? '2026-11-10T09:00:00Z' : null, createdAt: '2026-11-10T12:00:00Z' });

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/notificacoes']}>
          <Routes>
            <Route path="/notificacoes" element={<NotificationsPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('página de notificações', () => {
  beforeEach(() => {
    state.list = [];
    state.post = [];
    state.prefs = {};
  });
  afterEach(cleanup);

  it('o módulo registra a rota /notificacoes', () => {
    expect(module.routes?.map((r) => r.path)).toEqual(['notificacoes']);
  });

  it('pagina a lista e filtra as não lidas', async () => {
    // 23 avisos: os 3 primeiros não lidos
    state.list = Array.from({ length: 23 }, (_, i) => note(i + 1, i >= 3));
    renderPage();
    expect(await screen.findByText('Aviso 1')).toBeTruthy();
    expect(screen.getByText('Sincronização concluída.')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(NOTIFICATIONS_PAGE_SIZE + 1);
    expect(screen.getByText('23 registro(s)')).toBeTruthy();
    expect(screen.getByText('1 de 3')).toBeTruthy();
    expect(screen.queryByText('Aviso 11')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(screen.getByText('Aviso 11')).toBeTruthy();
    expect(screen.queryByText('Aviso 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(screen.getAllByRole('row')).toHaveLength(3 + 1);

    // trocar o filtro volta à primeira página
    fireEvent.click(screen.getByRole('tab', { name: 'Não lidas (3)' }));
    expect(screen.getByText('1 de 1')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3 + 1);
    expect(screen.getByRole('tab', { name: 'Todas (23)' })).toBeTruthy();
  });

  it('marca uma como lida, todas como lidas e abre o destino da notificação', async () => {
    state.list = [note(1), note(2), note(3, true)];
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Marcar como lida: Aviso 2' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Não lidas (1)' })).toBeTruthy());
    expect(state.post).toEqual(['/notifications/n2/read']);
    // sem link interno, não há "Abrir"
    expect(screen.queryByRole('button', { name: 'Abrir: Aviso 2' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Marcar todas como lidas' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Não lidas (0)' })).toBeTruthy());
    expect(state.post).toContain('/notifications/read-all');
    expect((screen.getByRole('button', { name: 'Marcar todas como lidas' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Abrir: Aviso 3' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/clientes/c3'));
  });

  it('erro ao carregar: explica e "Tentar de novo" recarrega', async () => {
    state.list = 'error';
    renderPage();
    expect(await screen.findByText('Não foi possível carregar as notificações')).toBeTruthy();
    expect(screen.getByText('Erro interno do servidor.')).toBeTruthy();
    expect(screen.queryByText('Nenhuma notificação')).toBeNull();
    state.list = [note(1)];
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Aviso 1')).toBeTruthy();
  });

  it('lista vazia; com as notificações desligadas, aponta para as preferências', async () => {
    renderPage();
    expect(await screen.findByText('Nenhuma notificação')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Conta › Preferências' })).toBeNull();
    cleanup();
    state.prefs = { enabled: false };
    renderPage();
    expect((await screen.findByRole('link', { name: 'Conta › Preferências' })).getAttribute('href')).toBe('/conta/preferencias');
  });

  it('com 50 avisos (o máximo que a API devolve), diz que os mais antigos não aparecem', async () => {
    state.list = Array.from({ length: 50 }, (_, i) => note(i + 1, true));
    renderPage();
    expect(await screen.findByText(/Aparecem aqui as 50 notificações mais recentes/)).toBeTruthy();
    expect(screen.getByText('1 de 5')).toBeTruthy();
  });
});
