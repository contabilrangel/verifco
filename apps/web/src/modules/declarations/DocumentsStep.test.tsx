import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { DocumentsStep } from './DocumentsStep';

/**
 * INT-3: o escritório deixa um arquivo que ele enviou visível no portal do cliente (e tira de lá).
 * Arquivos do próprio cliente e da sincronização não têm a ação nem a categoria.
 */
const perms = vi.hoisted(() => ({ list: ['declaration.view', 'declaration.edit'] }));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: (...p: string[]) => p.some((x) => perms.list.includes(x)) }),
}));

const doc = (id: string, filename: string, category: string, uploadedBy: string) => ({
  id,
  fileId: `f-${id}`,
  filename,
  mimeType: 'application/pdf',
  size: 1024,
  category,
  uploadedBy,
  processingStatus: 'not_processed',
  exerciseYear: 2026,
  createdAt: '2026-04-10T12:00:00Z',
});

const server = vi.hoisted(() => ({ patches: [] as { path: string; body: unknown }[] }));
vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path.startsWith('/customers/c1/documents')) {
      return [
        doc('d1', 'recibo-entrega.pdf', 'shared_with_customer', 'office'),
        doc('d2', 'planilha.pdf', 'darf', 'office'),
        doc('d3', 'meu-rg.pdf', 'checklist', 'customer'),
        doc('d4', 'declaracao.dec', 'irpf_declaration', 'sync'),
      ];
    }
    throw new original.ApiError(404, 'Não encontrado.');
  };
  const patch = async (path: string, body: unknown) => {
    server.patches.push({ path, body });
    return {};
  };
  return { ...original, api: { ...original.api, get, patch } };
});

const customer = { id: 'c1', name: 'Helena Prado', cpfCnpj: '52998224725' } as CustomerDetail;

function renderStep() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <CustomerCtx.Provider value={{ customer, refetch: () => {} }}>
            <DocumentsStep />
          </CustomerCtx.Provider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (filename: string) => screen.getByText(filename).closest('tr') as HTMLElement;
const optionValues = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map((o) => o.value);

describe('DocumentsStep: visível no portal do cliente (INT-3)', () => {
  afterEach(() => {
    cleanup();
    server.patches = [];
    perms.list = ['declaration.view', 'declaration.edit'];
  });

  it('marca e desmarca só os arquivos do escritório', async () => {
    renderStep();
    await screen.findByText('recibo-entrega.pdf');

    const shared = rowOf('recibo-entrega.pdf');
    expect(within(shared).getByText('No portal')).toBeTruthy();
    fireEvent.click(within(shared).getByRole('button', { name: 'Tirar do portal do cliente' }));
    await waitFor(() => expect(server.patches).toContainEqual({ path: '/documents/d1', body: { category: 'other' } }));

    const internal = rowOf('planilha.pdf');
    expect(within(internal).queryByText('No portal')).toBeNull();
    fireEvent.click(within(internal).getByRole('button', { name: 'Mostrar no portal do cliente' }));
    await waitFor(() => expect(server.patches).toContainEqual({ path: '/documents/d2', body: { category: 'shared_with_customer' } }));
    expect(optionValues(within(internal).getByLabelText('Categoria de planilha.pdf'))).toContain('shared_with_customer');

    // do cliente e da sincronização: sem a ação e sem a categoria; a categoria do sistema tem rótulo
    for (const name of ['meu-rg.pdf', 'declaracao.dec']) {
      const row = rowOf(name);
      expect(within(row).queryByRole('button', { name: /portal do cliente/ })).toBeNull();
      expect(optionValues(within(row).getByLabelText(`Categoria de ${name}`))).not.toContain('shared_with_customer');
    }
    expect(within(rowOf('declaracao.dec')).getByRole('option', { name: 'Declaração (.DEC)' })).toBeTruthy();
    expect(within(rowOf('meu-rg.pdf')).getByRole('option', { name: 'Enviado pelo checklist' })).toBeTruthy();
  });

  it('sem declaration.edit mostra a situação, sem as ações', async () => {
    perms.list = ['declaration.view'];
    renderStep();
    const shared = (await screen.findByText('recibo-entrega.pdf')).closest('tr') as HTMLElement;
    expect(within(shared).getByText('No portal')).toBeTruthy();
    expect(within(shared).getByText('Visível no portal do cliente')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /portal do cliente/ })).toBeNull();
  });
});
