import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { DarfStep } from './DarfStep';

/**
 * INT-17: quem tem só darf.view (sem declaration.view) abre a etapa DARF. A API devolve da
 * declaração só o que a etapa usa (id, exercício e imposto a pagar).
 */
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: (...p: string[]) => p.includes('darf.view') }),
}));

const server = vi.hoisted(() => ({ declaration: 200 as 200 | 403 }));
vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path.startsWith('/customers/c1/declarations/')) {
      if (server.declaration === 403) throw new original.ApiError(403, 'Você não tem permissão para esta ação.');
      return { id: 'd1', exists: true, customerId: 'c1', exerciseYear: 2026, taxDueCents: 300_001 };
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
  return { ...original, api: { ...original.api, get } };
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

describe('DarfStep só com darf.view (INT-17)', () => {
  afterEach(() => {
    cleanup();
    server.declaration = 200;
  });

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
});
