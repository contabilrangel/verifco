import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { IrpfReportsStep } from './IrpfReportsStep';

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path.startsWith('/reports/declaration')) return { declarationId: 'd1' };
    return {
      declaration: { id: 'd1', exerciseYear: 2026, stage: 'filling', substatus: 'elaboration', taxation: null, taxDueCents: 0, refundCents: 0, otherExpenses: {} },
      customer: { id: 'c1', name: 'Maria Souza', email: null, mobile: null },
      itemsCount: 0,
      itemsByKind: [],
      spouse: { available: false, reason: 'Cônjuge não cadastrado como cliente.', name: null },
      reports: [],
      hasLogo: true,
      canEditOtherExpenses: false,
      canSendKit: false,
    };
  };
  return { ...original, api: { ...original.api, get } };
});

describe('relatórios da declaração', () => {
  afterEach(cleanup);

  it('sem linhas, orienta a lançar ou extrair do PDF e não promete ler o arquivo do programa IRPF', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <CustomerCtx.Provider value={{ customer: { id: 'c1', name: 'Maria Souza' } as CustomerDetail, refetch: () => {} }}>
              <IrpfReportsStep />
            </CustomerCtx.Provider>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const title = await screen.findByText('A declaração 2026 ainda não tem linhas cadastradas');
    const text = title.closest('.vf-alert')?.textContent ?? '';
    expect(text).toContain('etapa Declaração');
    expect(text).toContain('PDF da declaração na Elaboração');
    expect(text).toContain('o conteúdo dele não é lido');
    expect(text).not.toMatch(/XML|importe a declaração/);
  });
});
