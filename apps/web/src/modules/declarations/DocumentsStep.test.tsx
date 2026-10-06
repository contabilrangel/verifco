import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { DocumentsStep } from './DocumentsStep';

/**
 * INT-3: o escritório deixa um arquivo que ele enviou visível no portal do cliente (e tira de lá).
 * A visibilidade é um campo próprio do documento (`sharedWithCustomer`), independente da categoria.
 * Arquivos do próprio cliente, da sincronização e do copiloto não têm a ação.
 */
const perms = vi.hoisted(() => ({ list: ['declaration.view', 'declaration.edit'] }));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: (...p: string[]) => p.some((x) => perms.list.includes(x)) }),
}));

const doc = (id: string, filename: string, category: string, uploadedBy: string, sharedWithCustomer = false) => ({
  id,
  fileId: `f-${id}`,
  filename,
  mimeType: 'application/pdf',
  size: 1024,
  category,
  uploadedBy,
  sharedWithCustomer,
  processingStatus: 'not_processed',
  exerciseYear: 2026,
  createdAt: '2026-04-10T12:00:00Z',
});

const server = vi.hoisted(() => ({
  patches: [] as { path: string; body: unknown }[],
  uploads: [] as { path: string; names: string[]; fields: Record<string, string> }[],
}));
vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path.startsWith('/customers/c1/documents')) {
      return [
        doc('d1', 'recibo-entrega.pdf', 'receipt', 'office', true),
        doc('d2', 'planilha.pdf', 'darf', 'office'),
        doc('d3', 'meu-rg.pdf', 'checklist', 'customer'),
        doc('d4', 'declaracao.dec', 'irpf_declaration', 'sync'),
        doc('d5', 'analise.pdf', 'copilot', 'office'),
      ];
    }
    throw new original.ApiError(404, 'Não encontrado.');
  };
  const patch = async (path: string, body: unknown) => {
    server.patches.push({ path, body });
    return {};
  };
  const upload = async (path: string, files: File[] | File, fields: Record<string, string> = {}) => {
    const list = Array.isArray(files) ? files : [files];
    server.uploads.push({ path, names: list.map((f) => f.name), fields });
    return list.map((f, i) => doc(`n${i}`, f.name, fields.category ?? 'other', 'office', fields.sharedWithCustomer === 'true'));
  };
  return { ...original, api: { ...original.api, get, patch, upload } };
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
const sendFile = (name: string) => fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(['%PDF'], name)] } });

describe('DocumentsStep: visível no portal do cliente (INT-3)', () => {
  afterEach(() => {
    cleanup();
    server.patches = [];
    server.uploads = [];
    perms.list = ['declaration.view', 'declaration.edit'];
  });

  it('marca e desmarca pelo endpoint próprio, sem mexer na categoria, e só nos arquivos do escritório', async () => {
    renderStep();
    await screen.findByText('recibo-entrega.pdf');

    // a etiqueta vem do campo, não da categoria
    const shared = rowOf('recibo-entrega.pdf');
    expect(within(shared).getByText('No portal')).toBeTruthy();
    expect((within(shared).getByLabelText('Categoria de recibo-entrega.pdf') as HTMLSelectElement).value).toBe('receipt');
    fireEvent.click(within(shared).getByRole('button', { name: 'Tirar do portal do cliente' }));
    await waitFor(() => expect(server.patches).toContainEqual({ path: '/documents/d1/portal', body: { shared: false } }));

    const internal = rowOf('planilha.pdf');
    expect(within(internal).queryByText('No portal')).toBeNull();
    fireEvent.click(within(internal).getByRole('button', { name: 'Mostrar no portal do cliente' }));
    await waitFor(() => expect(server.patches).toContainEqual({ path: '/documents/d2/portal', body: { shared: true } }));

    // a categoria não tem mais a opção do portal e mudar a categoria só muda a categoria
    const select = within(internal).getByLabelText('Categoria de planilha.pdf');
    expect(optionValues(select)).not.toContain('shared_with_customer');
    fireEvent.change(select, { target: { value: 'receipt' } });
    await waitFor(() => expect(server.patches).toContainEqual({ path: '/documents/d2', body: { category: 'receipt' } }));
    expect(server.patches.filter((p) => p.path === '/documents/d2')).toEqual([{ path: '/documents/d2', body: { category: 'receipt' } }]);

    // do cliente, da sincronização e do copiloto: sem a ação; a categoria do sistema tem rótulo
    for (const name of ['meu-rg.pdf', 'declaracao.dec', 'analise.pdf']) {
      const row = rowOf(name);
      expect(within(row).queryByRole('button', { name: /portal do cliente/ })).toBeNull();
      expect(optionValues(within(row).getByLabelText(`Categoria de ${name}`))).not.toContain('shared_with_customer');
    }
    expect(within(rowOf('declaracao.dec')).getByRole('option', { name: 'Declaração (.DEC)' })).toBeTruthy();
    expect(within(rowOf('meu-rg.pdf')).getByRole('option', { name: 'Enviado pelo checklist' })).toBeTruthy();
  });

  it('o envio tem a opção "Visível no portal do cliente", separada da categoria', async () => {
    renderStep();
    await screen.findByText('recibo-entrega.pdf');
    expect(optionValues(screen.getByLabelText('Categoria'))).not.toContain('shared_with_customer');
    const checkbox = screen.getByLabelText('Visível no portal do cliente') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    sendFile('interno.pdf');
    await waitFor(() => expect(server.uploads).toHaveLength(1));
    expect(server.uploads[0]).toEqual({ path: expect.stringMatching(/^\/customers\/c1\/documents\?year=\d{4}$/), names: ['interno.pdf'], fields: { category: 'other', sharedWithCustomer: 'false' } });

    fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: 'darf' } });
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    sendFile('darf.pdf');
    await waitFor(() => expect(server.uploads).toHaveLength(2));
    expect(server.uploads[1].fields).toEqual({ category: 'darf', sharedWithCustomer: 'true' });
    // o próximo envio não vai para o portal sem marcar de novo
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });

  it('sem declaration.edit mostra a situação, sem as ações', async () => {
    perms.list = ['declaration.view'];
    renderStep();
    const shared = (await screen.findByText('recibo-entrega.pdf')).closest('tr') as HTMLElement;
    expect(within(shared).getByText('No portal')).toBeTruthy();
    expect(within(shared).getByText('Recibo de entrega')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /portal do cliente/ })).toBeNull();
    expect(screen.queryByLabelText('Visível no portal do cliente')).toBeNull();
  });
});
