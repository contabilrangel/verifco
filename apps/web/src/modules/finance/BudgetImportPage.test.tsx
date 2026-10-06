import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { BudgetImportPage } from './BudgetImportPage';

/** DAD-5: a importação de orçamentos roda na fila; a tela acompanha o lote até o resultado. */
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

const base = { id: 'b1', createdAt: '2026-10-06T12:00:00Z', total: 3 };
const polls: object[] = [
  { ...base, status: 'processing', succeeded: 1, failed: 0, results: [] },
  {
    ...base,
    status: 'done',
    succeeded: 2,
    failed: 1,
    results: [
      { row: 2, ok: true, message: 'Orçamento criado.' },
      { row: 3, ok: false, message: 'Cliente 111.444.777-35 não encontrado.' },
      { row: 4, ok: true, message: 'Orçamento atualizado.' },
    ],
  },
];

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path === '/finance/budget-import/batches/b1') return polls.length > 1 ? polls.shift() : polls[0];
    if (path === '/finance/budget-import/batches') return [];
    throw new Error(`rota inesperada: ${path}`);
  };
  const upload = async () => ({ ...base, status: 'processing', succeeded: 0, failed: 0, results: [], skipped: 1, year: 2026 });
  return { ...original, api: { ...original.api, get, upload } };
});

afterEach(cleanup);

describe('BudgetImportPage: importação acompanhada pela fila (DAD-5)', () => {
  it('mostra o andamento do lote e depois o resultado linha a linha', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <BudgetImportPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'orcamentos.xlsx')] } });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Importar' }));

    expect(await screen.findByText('Importando a planilha')).toBeTruthy();
    expect(await screen.findByText(/1 de 3 linha\(s\) processada\(s\)/)).toBeTruthy();
    expect(await screen.findByText('Resultado da importação', undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('Cliente 111.444.777-35 não encontrado.')).toBeTruthy();
    // a contagem de linhas sem valor vem da resposta do envio e continua no resultado
    expect(screen.getByText('Ignoradas (sem valor)')).toBeTruthy();
    expect(screen.queryByText('Importando a planilha')).toBeNull();
  });
});
