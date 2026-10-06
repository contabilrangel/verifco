import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomersPage, type CustomerListItem } from './CustomersPage';

const customer = (over: Partial<CustomerListItem>): CustomerListItem => ({
  id: 'c1',
  name: 'Aline Almeida Carvalho',
  cpfCnpj: '81363539302',
  email: 'aline@exemplo.com.br',
  mobile: null,
  notes: null,
  status: 'active',
  procurationStatus: 'none',
  cndStatus: 'not_requested',
  ecacMailboxMessages: 0,
  responsibleName: 'Ana Rangel',
  procuratorName: null,
  groups: [],
  declaration: null,
  ...over,
});

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path.startsWith('/customers/facets')) {
      return { total: 2, email: { with: 2, without: 0 }, status: { active: 2, inactive: 0 }, procurator: { with: 0, without: 2 }, procurationStatus: {}, mailbox: 0, govbrRequired: 0, expiring: 0, cnd: {}, groups: [], noGroup: 2, responsible: [] };
    }
    if (path.startsWith('/customers')) {
      return {
        data: [
          customer({ id: 'c1', notes: 'Prefere contato por WhatsApp no período da tarde.' }),
          customer({ id: 'c2', name: 'Bruno Rodrigues Gomes', notes: '   ' }),
        ],
        total: 2,
        page: 1,
        pages: 1,
      };
    }
    return [];
  };
  return { ...original, api: { ...original.api, get } };
});

describe('listagem de clientes', () => {
  afterEach(cleanup);

  it('mostra as observações do cliente abaixo do e-mail (e nada quando estão vazias)', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <CustomersPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const note = await screen.findByText('Prefere contato por WhatsApp no período da tarde.');
    expect(note.classList.contains('vf-cus-notes')).toBe(true);
    expect(note.getAttribute('title')).toBe('Prefere contato por WhatsApp no período da tarde.');
    expect(note.textContent).toContain('Observações:');
    // só um cliente tem observação de verdade
    expect(document.querySelectorAll('.vf-cus-notes')).toHaveLength(1);
    expect(screen.getByText('Bruno Rodrigues Gomes')).toBeTruthy();
  });
});
