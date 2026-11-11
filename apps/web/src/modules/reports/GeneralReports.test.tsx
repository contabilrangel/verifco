import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { BacklogsReport, ResultsReport } from './GeneralReports';

/** Relatórios gerais: 50 linhas por página na tela; a impressão sai com o relatório inteiro. */
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ declarationId: `d${i + 1}`, customerId: `c${i + 1}`, name: `Cliente ${String(i + 1).padStart(3, '0')}`, cpfCnpj: '52998224725', substatus: 'filling', taxation: 'complete', taxDueCents: 100, refundCents: 0 }));
const groups = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ customerId: `c${i + 1}`, name: `Cliente ${String(i + 1).padStart(3, '0')}`, cpfCnpj: '52998224725', email: null, mobile: null, items: [{ id: `i${i + 1}`, description: `Informe ${i + 1}`, dueDate: null, createdAt: '2026-03-01T12:00:00Z', exerciseYear: 2026, overdueDays: 0 }] }));

let total = 120;
beforeEach(() => {
  total = 120;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = String(url).includes('/reports/results')
        ? { rows: rows(total), totals: { count: total, taxDueCents: total * 100, refundCents: 0, payable: total, refundable: 0, neutral: 0 } }
        : String(url).includes('/reports/backlogs')
          ? { groups: groups(total), totals: { customers: total, items: total, overdue: 0 } }
          : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderReport = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
const clients = () => screen.getAllByRole('link', { name: /^Cliente \d+$/ }).map((a) => a.textContent);
const generate = () => fireEvent.click(screen.getByRole('button', { name: 'Gerar relatório' }));

// Estes testes desenham tabelas de 120 linhas (duas vezes, na impressão): no jsdom isso leva
// alguns segundos numa máquina carregada, perto do limite padrão de 5 s do Vitest.
describe('relatórios gerais: paginação e impressão', { timeout: 30_000 }, () => {
  it('Resultados: 50 por página, com o total do relatório inteiro no rodapé', async () => {
    renderReport(<ResultsReport />);
    // sem relatório gerado não há o que imprimir
    expect((screen.getByRole('button', { name: 'Imprimir' }) as HTMLButtonElement).disabled).toBe(true);
    generate();
    await screen.findByText('Cliente 001');
    expect(clients()).toHaveLength(50);
    expect(screen.getByText('120 registro(s)')).toBeTruthy();
    expect(screen.getByText('1 de 3')).toBeTruthy();
    expect(screen.getByText('Total (120)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(clients()[0]).toBe('Cliente 051');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(clients()).toHaveLength(20);
    expect((screen.getByRole('button', { name: 'Próxima página' }) as HTMLButtonElement).disabled).toBe(true);

    // gerar de novo volta à primeira página
    generate();
    await screen.findByText('1 de 3');
    expect(clients()[0]).toBe('Cliente 001');
  });

  it('"Imprimir" desenha a tabela inteira antes de abrir a impressão e volta à página depois', async () => {
    let printed = 0;
    const print = vi.fn(() => {
      printed = clients().length;
    });
    vi.stubGlobal('print', print);
    renderReport(<ResultsReport />);
    generate();
    await screen.findByText('Cliente 001');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir' }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(printed).toBe(120);
    act(() => void window.dispatchEvent(new Event('afterprint')));
    expect(clients()).toHaveLength(50);
    expect(clients()[0]).toBe('Cliente 051');
    // os botões e a paginação não saem no papel
    expect(screen.getByRole('button', { name: 'Imprimir' }).closest('.vf-screen-only')).not.toBeNull();
    expect(screen.getByText('120 registro(s)').closest('.vf-screen-only')).not.toBeNull();
  });

  it('relatório pequeno cabe numa página', async () => {
    total = 12;
    renderReport(<ResultsReport />);
    generate();
    await screen.findByText('Cliente 001');
    expect(clients()).toHaveLength(12);
    expect(screen.getByText('1 de 1')).toBeTruthy();
  });

  it('Documentos faltantes: pagina por cliente (cada cliente com todos os seus documentos)', async () => {
    renderReport(<BacklogsReport />);
    generate();
    await screen.findByText('Cliente 001');
    expect(clients()).toHaveLength(50);
    expect(screen.getByText('Informe 50')).toBeTruthy();
    expect(screen.queryByText('Informe 51')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(screen.getByText('Informe 51')).toBeTruthy();
  });
});
