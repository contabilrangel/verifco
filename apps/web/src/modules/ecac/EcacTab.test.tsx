import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { EcacTab } from './EcacTab';
import { RobotAdminTab } from './RobotAdminTab';
import type { EcacPanel, RobotOverview } from './types';

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

const panel: EcacPanel = {
  customer: { id: 'c1', name: 'Maria', cpfCnpj: '52998224725' },
  credentials: { hasLogin: false, hasPassword: false },
  procuration: { status: 'valid', expiresAt: '2030-12-31', expiringSoon: false, expired: false, govbrLevel: null, mailboxMessages: 1, procurator: null },
  declarations: [],
  incomeStatements: [],
  darfs: [],
  cnd: { status: 'not_requested', checkedAt: null, autoGenerateCnd: false, latest: null },
  simplified: {
    id: 'r1',
    year: null,
    fileId: 'f-sitfis',
    source: 'serpro',
    fetchedAt: '2026-10-06T09:00:00Z',
    kind: 'fiscal_situation',
    situation: null,
    message: 'Relatório de situação fiscal emitido pela Receita Federal: abra o PDF para ver as pendências.',
    pendencies: [],
  },
  mailbox: [],
  others: [],
  lastSync: null,
};

const overview: RobotOverview = { customersWithProcurator: 3, activeTokens: 0, serpro: 'ready', lastOfficeSync: null, nextAutoSync: '2026-10-07T07:12:00Z', activity: [] };

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path.startsWith('/customers/c1/ecac')) return panel;
    if (path === '/robot/overview') return overview;
    return [];
  };
  return { ...original, api: { ...original.api, get } };
});

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <MemoryRouter>{node}</MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>
);

describe('aba eCAC: textos do que o robô faz (COB-1, COB-6)', () => {
  afterEach(cleanup);

  it('mostra o PDF da situação fiscal e diz que a CND é lançada pelo escritório', async () => {
    const customer = { id: 'c1', name: 'Maria', cpfCnpj: '52998224725' } as CustomerDetail;
    render(wrap(<CustomerCtx.Provider value={{ customer, refetch: () => {} }}><EcacTab /></CustomerCtx.Provider>));
    // declarações: o SERPRO não informa situação, malha nem lote
    expect(await screen.findByText(/Situação, malha e lote de restituição. O SERPRO Integra Contador não informa este dado/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Situação fiscal' }));
    expect(screen.getByText('Relatório de situação fiscal')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abrir relatório' })).toBeTruthy();
    expect(screen.getByText('Veja as pendências no PDF')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'CND' }));
    expect(screen.getByText('A CND é lançada pelo escritório')).toBeTruthy();
    expect(screen.queryByText('Geração automática de CND desligada')).toBeNull();
  });

  it('o robô mostra o que a sincronização faz e a próxima rodada automática', async () => {
    render(wrap(<RobotAdminTab />));
    expect(await screen.findByText(/Próxima sincronização automática:/)).toBeTruthy();
    expect(screen.getByText(/relatório de situação fiscal \(a cada 30 dias\)/)).toBeTruthy();
    expect(screen.getByText(/nem emite a CND de pessoa física/)).toBeTruthy();
  });
});
