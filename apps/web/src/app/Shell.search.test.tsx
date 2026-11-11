import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { ToastProvider } from '../ds';
import { BELL_ITEMS, Shell } from './Shell';

/** Barra superior: sugestões da busca global enquanto digita e estados do sino de notificações. */
const state = vi.hoisted(() => ({
  perms: ['customer.list'] as string[],
  get: [] as string[],
  post: [] as string[],
  notifications: [] as unknown[] | 'error',
  readAllFails: false,
  customers: [] as { id: string; name: string; cpfCnpj: string; email: string | null }[],
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    me: { user: { name: 'Ana Rangel', isOwner: false }, office: { name: 'Escritório' }, permissions: state.perms, favorites: [] },
    can: (...p: string[]) => p.some((x) => state.perms.includes(x)),
    logout: () => {},
    refresh: async () => {},
  }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      get: async (path: string) => {
        state.get.push(path);
        if (path === '/notifications') {
          if (state.notifications === 'error') throw new original.ApiError(500, 'Erro interno');
          return state.notifications;
        }
        if (path.startsWith('/customers?')) return { data: state.customers, total: state.customers.length, page: 1, pages: 1 };
        if (path === '/plan/status') throw new original.ApiError(404, 'Rota não encontrada');
        return [];
      },
      post: async (path: string) => {
        state.post.push(path);
        if (path === '/notifications/read-all' && state.readAllFails) throw new original.ApiError(500, 'Falha ao gravar.');
        return { ok: true };
      },
    },
  };
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

const renderShell = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/downloads']}>
          <Routes>
            <Route path="/" element={<Shell />}>
              <Route path="*" element={<Where />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const note = (i: number, readAt: string | null = null) => ({ id: `n${i}`, title: `Aviso ${i}`, body: null, link: `/clientes/c${i}`, readAt, createdAt: '2026-11-10T12:00:00Z' });
const where = () => screen.getByTestId('where').textContent;
const searchBox = () => screen.getByRole('combobox', { name: 'Buscar clientes' });

describe('busca global', () => {
  beforeEach(() => {
    state.perms = ['customer.list'];
    state.get = [];
    state.post = [];
    state.notifications = [];
    state.readAllFails = false;
    state.customers = [
      { id: 'c1', name: 'Ana Souza', cpfCnpj: '52998224725', email: 'ana@exemplo.com.br' },
      { id: 'c2', name: 'Anderson Lima', cpfCnpj: '81363539302', email: null },
    ];
  });
  afterEach(cleanup);

  it('sugere clientes enquanto digita (com pausa), sem precisar de Enter', async () => {
    renderShell();
    const input = searchBox();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(input, { target: { value: 'a' } });
    // um caractere só não busca
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: 'an' } });
    fireEvent.change(input, { target: { value: 'ana' } });

    const list = await screen.findByRole('listbox', { name: 'Clientes encontrados' });
    await within(list).findByRole('option', { name: /Ana Souza/ });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Ana Souza529.982.247-25 · ana@exemplo.com.br', 'Anderson Lima813.635.393-02', 'Ver todos os resultados']);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    // a pausa na digitação junta as teclas: uma busca só, com o texto final e limite de 8
    expect(state.get.filter((p) => p.startsWith('/customers?'))).toEqual(['/customers?search=ana&pageSize=8']);
  });

  it('teclado: ↓/↑ escolhem, Enter abre o cliente escolhido, Esc fecha', async () => {
    renderShell();
    const input = searchBox();
    fireEvent.change(input, { target: { value: 'ana' } });
    await screen.findByRole('option', { name: /Ana Souza/ });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Ana Souza/ }).getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Ana Souza/ }).id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Anderson Lima/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    // do primeiro, ↑ dá a volta para "ver todos"
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /Ver todos os resultados/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Ana Souza/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    // ↓ reabre as sugestões
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Anderson Lima/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.submit(input.closest('form')!);
    expect(where()).toBe('/clientes/c2');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('Enter sem escolher abre a lista completa, como antes; clicar numa sugestão abre o cliente', async () => {
    renderShell();
    const input = searchBox();
    fireEvent.change(input, { target: { value: ' ana souza ' } });
    fireEvent.submit(input.closest('form')!);
    expect(where()).toBe('/clientes?busca=ana%20souza');

    fireEvent.change(input, { target: { value: 'ana' } });
    fireEvent.click(await screen.findByRole('option', { name: /Ana Souza/ }));
    expect(where()).toBe('/clientes/c1');
  });

  it('sem resultados e sem permissão de listar clientes', async () => {
    state.customers = [];
    renderShell();
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nenhum cliente encontrado para “zzz”.')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Ver todos os resultados/ })).toBeTruthy();

    cleanup();
    state.perms = [];
    state.get = [];
    renderShell();
    fireEvent.change(searchBox(), { target: { value: 'ana' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(state.get.filter((p) => p.startsWith('/customers'))).toEqual([]);
  });
});

describe('sino de notificações', () => {
  beforeEach(() => {
    state.perms = [];
    state.get = [];
    state.post = [];
    state.notifications = [];
    state.readAllFails = false;
  });
  afterEach(cleanup);

  const openBell = () => fireEvent.click(screen.getByRole('button', { name: 'Notificações' }));

  it('erro ao carregar não vira "Nenhuma notificação": explica e deixa tentar de novo', async () => {
    state.notifications = 'error';
    renderShell();
    await waitFor(() => expect(state.get).toContain('/notifications'));
    openBell();
    expect(await screen.findByText('Não foi possível carregar as notificações.')).toBeTruthy();
    expect(screen.queryByText('Nenhuma notificação.')).toBeNull();

    state.notifications = [note(1)];
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('menuitem', { name: 'Aviso 1' })).toBeTruthy();
    expect(screen.queryByText('Não foi possível carregar as notificações.')).toBeNull();
  });

  it('lista vazia de verdade continua "Nenhuma notificação", com o link "Ver todas"', async () => {
    renderShell();
    await waitFor(() => expect(state.get).toContain('/notifications'));
    openBell();
    expect(await screen.findByText('Nenhuma notificação.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver todas' }).getAttribute('href')).toBe('/notificacoes');
  });

  it('mostra as mais recentes e leva às demais por "Ver todas"', async () => {
    state.notifications = Array.from({ length: 12 }, (_, i) => note(i + 1));
    renderShell();
    await waitFor(() => expect(state.get).toContain('/notifications'));
    openBell();
    expect(await screen.findAllByRole('menuitem')).toHaveLength(BELL_ITEMS);
    fireEvent.click(screen.getByRole('link', { name: 'Ver todas (12)' }));
    expect(where()).toBe('/notificacoes');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('"Marcar todas como lidas" que falha avisa o erro em vez de estourar', async () => {
    state.notifications = [note(1)];
    state.readAllFails = true;
    renderShell();
    await waitFor(() => expect(state.get).toContain('/notifications'));
    openBell();
    fireEvent.click(await screen.findByRole('button', { name: 'Marcar todas como lidas' }));
    expect(await screen.findByText('Falha ao gravar.')).toBeTruthy();
    expect(state.post).toEqual(['/notifications/read-all']);
  });
});
