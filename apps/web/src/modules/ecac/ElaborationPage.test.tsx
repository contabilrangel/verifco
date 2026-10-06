import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { ElaborationPage } from './ElaborationPage';

/**
 * CON-14: a tela mostra processar/validar e a conferência das linhas com as mesmas permissões
 * que o servidor aceita (elaboration.process ou pre_declaration.create / pre_declaration.edit).
 */
let permissions: string[] = [];
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: (...p: string[]) => p.some((x) => permissions.includes(x)) }),
}));

const counts = { total: 1, eligible: 1, processed: 1, errors: 0, programFiles: 0, lines: 1, conflicts: 0, pendingLines: 1 };
const row = { customerId: 'c1', name: 'Maria Souza', cpfCnpj: '52998224725', declarationId: 'd1', status: 'awaiting_validation', counts, sourceFileId: null, exported: null };
const detail = {
  customer: { id: 'c1', name: 'Maria Souza', cpfCnpj: '52998224725' },
  declarationId: 'd1',
  status: 'awaiting_validation',
  counts,
  itemsCount: 0,
  documents: [
    {
      id: 'doc1',
      fileId: 'f1',
      filename: 'informe.pdf',
      mimeType: 'application/pdf',
      category: 'income_report',
      uploadedBy: 'customer',
      createdAt: '2026-04-01T10:00:00Z',
      extractable: true,
      processingStatus: 'processed',
      error: null,
      notes: null,
      discarded: 0,
      lines: [{ index: 0, kindLabel: 'Rendimento PJ', item: { kind: 'income_pj', valueCents: 100_00 }, match: 'new', existing: null, decision: null, appliedAt: null }],
    },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/elaboration/jobs')) return json([]);
      if (url.includes('/elaboration/customers/')) return json(detail);
      return json({ data: [row], total: 1, page: 1, pages: 1, statusCounts: {} });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderAs(perms: string[]) {
  permissions = perms;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <ElaborationPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('Maria Souza');
}

async function openReview() {
  fireEvent.click(screen.getByRole('button', { name: 'Conferir' }));
  const drawer = await screen.findByRole('dialog');
  await within(drawer).findByText('Rendimento PJ');
  return drawer;
}

describe('ElaborationPage: permissões iguais às do servidor (CON-14)', () => {
  it('pre_declaration.create processa e valida, sem decidir linhas', async () => {
    await renderAs(['pre_declaration.view', 'pre_declaration.create']);
    expect(screen.getByRole('button', { name: /Processar documentos/ })).toBeTruthy();
    const drawer = await openReview();
    expect(within(drawer).getByRole('button', { name: /Validar/ })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Aceitar linha' })).toBeNull();
  });

  it('pre_declaration.edit decide as linhas, sem processar nem validar', async () => {
    await renderAs(['pre_declaration.view', 'pre_declaration.edit']);
    expect(screen.queryByRole('button', { name: /Processar documentos/ })).toBeNull();
    const drawer = await openReview();
    expect(within(drawer).getByRole('button', { name: 'Aceitar linha' })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: /Validar/ })).toBeNull();
  });

  it('elaboration.process faz tudo; só visualizar não mostra ações', async () => {
    await renderAs(['elaboration.process']);
    expect(screen.getByRole('button', { name: /Processar documentos/ })).toBeTruthy();
    const drawer = await openReview();
    expect(within(drawer).getByRole('button', { name: 'Aceitar linha' })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: /Validar/ })).toBeTruthy();
    cleanup();
    await renderAs(['pre_declaration.view']);
    expect(screen.queryByRole('button', { name: /Processar documentos/ })).toBeNull();
    const view = await openReview();
    await waitFor(() => expect(within(view).queryByRole('button', { name: 'Aceitar linha' })).toBeNull());
    expect(within(view).queryByRole('button', { name: /Validar/ })).toBeNull();
  });
});
