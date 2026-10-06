import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { MAILING_TYPES } from '@verifco/shared';
import { ToastProvider } from '../../ds';
import { MailingPage } from './MailingPage';

/** Malas diretas recentes: a lista na primeira etapa e o detalhe com o andamento e as falhas. */
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

const RUN = '0b8a3f5e-2f0c-4a54-9a43-3c1f1f0c2a11';
const planned = { customers: 3, deliveries: { email: 3, whatsapp: 2, total: 5 }, truncated: false, matched: 3 };
const runItem = {
  id: RUN,
  jobId: RUN,
  requestId: 'f5d1d3a4-0d5e-4c1e-9a55-1c2b3d4e5f60',
  type: 'monthly',
  label: 'E-mail mensal',
  channel: 'both',
  year: 2026,
  status: 'done',
  progress: 100,
  error: null,
  createdAt: '2026-10-06T13:05:00.000Z',
  finishedAt: '2026-10-06T13:05:10.000Z',
  createdBy: 'Paula Dona',
  skippedCount: 1,
  ...planned,
};
const detail = {
  ...runItem,
  skipped: [{ reason: 'no_mobile', label: 'Sem celular cadastrado', count: 1, names: ['Rui Sem Celular'] }],
  result: { queued: 5, alreadyQueued: 0, failed: [] },
  attachments: null,
  sending: {
    email: { queued: 0, sent: 3, failed: 0, total: 3 },
    whatsapp: { queued: 0, sent: 1, failed: 1, total: 2 },
    total: { queued: 0, sent: 4, failed: 1, total: 5 },
  },
  failures: { count: 1, items: [{ customerId: 'c1', name: 'Bia Falhou', channel: 'whatsapp', stage: 'delivery', message: 'Número sem WhatsApp' }] },
};

const state: { runs: unknown[] } = { runs: [] };
const calls: string[] = [];

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    calls.push(path);
    if (path === '/mailing/types') return MAILING_TYPES.map((t) => ({ ...t, allowed: true }));
    if (path === '/mailing/runs') return state.runs;
    if (path === `/mailing/runs/${RUN}`) return detail;
    throw new Error(`rota inesperada: ${path}`);
  };
  return { ...original, api: { ...original.api, get } };
});

afterEach(() => {
  cleanup();
  calls.length = 0;
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/comunicacao/mala-direta']}>
          <MailingPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('MailingPage: malas diretas recentes', () => {
  it('sem malas diretas, mostra o estado vazio', async () => {
    state.runs = [];
    renderPage();
    expect(await screen.findByText('Nenhuma mala direta enviada ainda')).toBeTruthy();
    expect(calls).toContain('/mailing/runs');
  });

  it('lista as recentes e abre uma com os envios por canal e quem falhou', async () => {
    state.runs = [runItem];
    renderPage();
    const row = (await screen.findByText('E-mail mensal')).closest('tr')!;
    expect(within(row).getByText('Preparada')).toBeTruthy();
    expect(within(row).getByText('E-mail e WhatsApp')).toBeTruthy();
    expect(within(row).getByText('por Paula Dona')).toBeTruthy();
    expect(within(row).getByText('5 envio(s)')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: /Ver E-mail mensal/ }));
    expect(await screen.findByText('E-mail mensal · exercício 2026')).toBeTruthy();
    expect(calls).toContain(`/mailing/runs/${RUN}`);

    const table = screen.getByRole('table', { name: 'Envios por canal' });
    const cells = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((tr) => within(tr).getAllByRole('cell').map((c) => c.textContent));
    expect(cells).toEqual([
      ['E-mail', '0', '3', '0', '3'],
      ['WhatsApp', '0', '1', '1', '2'],
      ['Total', '0', '4', '1', '5'],
    ]);

    expect(screen.getByText('Clientes com falha (1)')).toBeTruthy();
    const failure = screen.getByText('Bia Falhou').closest('tr')!;
    expect(within(failure).getByText('Número sem WhatsApp')).toBeTruthy();
    expect(within(failure).getByText('Entrega')).toBeTruthy();
    expect(screen.getByText(/1 sem envio — sem celular cadastrado: Rui Sem Celular/)).toBeTruthy();
    expect(screen.getByText('5 envio(s) na fila para 3 cliente(s)')).toBeTruthy();

    // volta para a lista
    fireEvent.click(screen.getByRole('button', { name: 'Malas diretas recentes' }));
    expect(await screen.findByText('Qual envio você quer fazer?')).toBeTruthy();
  });
});
