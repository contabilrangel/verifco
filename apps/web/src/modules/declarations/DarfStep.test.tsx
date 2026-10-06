import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { DarfStep } from './DarfStep';

const server = vi.hoisted(() => ({
  declaration: 200 as 200 | 403,
  /** false: o exercício ainda não tem declaração (a API devolve `id: null`). */
  exists: true,
  perms: ['darf.view'] as string[],
  puts: [] as string[],
}));

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: (...p: string[]) => p.some((x) => server.perms.includes(x)) }),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path.startsWith('/customers/c1/declarations/')) {
      if (server.declaration === 403) throw new original.ApiError(403, 'Você não tem permissão para esta ação.');
      return server.exists
        ? { id: 'd1', exists: true, customerId: 'c1', exerciseYear: 2026, taxDueCents: 300_001 }
        : { id: null, exists: false, customerId: 'c1', exerciseYear: 2026, taxDueCents: 0 };
    }
    if (path === '/declarations/d1/darfs') {
      return {
        autoSendDarfEmail: false,
        taxDueCents: 300_001,
        darfs: [
          { id: 'q1', quotaNumber: 1, valueCents: 150_000, dueDate: '2099-05-29', status: 'open', paidAt: null, barcode: null, source: 'manual', amount: null, file: null, sendStatus: 'not_sent', lastSend: null },
        ],
      };
    }
    throw new original.ApiError(404, 'Não encontrado.');
  };
  const put = async (path: string) => {
    server.puts.push(path);
    throw new original.ApiError(403, 'Você não tem permissão para esta ação.');
  };
  return { ...original, api: { ...original.api, get, put } };
});

const customer = { id: 'c1', name: 'João Pereira', cpfCnpj: '52998224725' } as CustomerDetail;

function renderStep() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <CustomerCtx.Provider value={{ customer, refetch: () => {} }}>
            <DarfStep />
          </CustomerCtx.Provider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const NOT_STARTED = /ainda não foi iniciada; peça a quem pode editar a declaração para iniciá-la/;

afterEach(() => {
  cleanup();
  server.declaration = 200;
  server.exists = true;
  server.perms = ['darf.view'];
  server.puts = [];
});

/**
 * INT-17: quem tem só darf.view (sem declaration.view) abre a etapa DARF. A API devolve da
 * declaração só o que a etapa usa (id, exercício e imposto a pagar).
 */
describe('DarfStep só com darf.view (INT-17)', () => {
  it('carrega as quotas a partir do resumo da declaração, sem ações de edição', async () => {
    renderStep();
    expect(await screen.findByText('Quotas do DARF')).toBeTruthy();
    expect(screen.getByText('R$ 3.000,01')).toBeTruthy();
    expect(screen.getByText('1ª')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Nova quota/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Gerar quotas/ })).toBeNull();
  });

  it('sem acesso à declaração avisa, em vez de mostrar a lista vazia', async () => {
    server.declaration = 403;
    renderStep();
    expect(await screen.findByText('Não foi possível carregar as quotas do DARF.')).toBeTruthy();
    expect(screen.queryByText('Nenhuma quota cadastrada')).toBeNull();
  });

  it('declaração não iniciada, sem darf.edit: lista vazia sem o aviso de iniciar', async () => {
    server.exists = false;
    renderStep();
    expect(await screen.findByText('Nenhuma quota cadastrada')).toBeTruthy();
    expect(screen.queryByText(NOT_STARTED)).toBeNull();
  });
});

/**
 * A 1ª quota de um exercício sem declaração cria a declaração (PUT do resumo, que a API só aceita
 * com declaration.edit). Quem tem darf.edit sem declaration.edit não recebe ações que dariam 403.
 */
describe('DarfStep com darf.edit', () => {
  it('declaração não iniciada e sem declaration.edit: esconde as ações e explica o motivo', async () => {
    server.exists = false;
    server.perms = ['darf.view', 'darf.edit'];
    renderStep();
    expect(await screen.findByText(NOT_STARTED)).toBeTruthy();
    expect(screen.getByText('Nenhuma quota cadastrada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Nova quota/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Gerar quotas/ })).toBeNull();
    expect(server.puts).toEqual([]);
  });

  it('declaração não iniciada com declaration.edit: oferece criar as quotas (a declaração nasce no 1º lançamento)', async () => {
    server.exists = false;
    server.perms = ['darf.view', 'darf.edit', 'declaration.edit'];
    renderStep();
    expect(await screen.findByRole('button', { name: /Nova quota/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Gerar quotas/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText(NOT_STARTED)).toBeNull();
  });

  it('declaração já iniciada: só darf.edit basta para cuidar das quotas', async () => {
    server.perms = ['darf.view', 'darf.edit'];
    renderStep();
    expect(await screen.findByRole('button', { name: /Nova quota/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Gerar quotas/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Anexar/ })).toBeTruthy();
    expect(screen.queryByText(NOT_STARTED)).toBeNull();
  });
});
