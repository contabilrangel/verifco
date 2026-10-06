import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { BillingReportPage, EXTERNAL_SYNC_FAILED_HINT } from './BillingReport';
import type { BillingReport, BillingReportRow } from './types';

/** Relatórios › Faturamento: marca "Cobrança não emitida" quando a emissão no Asaas/Omie falhou. */
const row = (r: Partial<BillingReportRow>): BillingReportRow => ({
  budgetId: 'b1',
  customerId: 'c1',
  customerName: 'Maria Cliente',
  cpfCnpj: '52998224725',
  responsibleName: null,
  category: 'irpf',
  categoryLabel: 'Declaração IRPF',
  type: 'integration',
  status: 'approved',
  paymentMethodName: 'Boleto Asaas',
  installmentsCount: 2,
  budgetedCents: 60_000,
  billedCents: 60_000,
  receivedCents: 0,
  openCents: 60_000,
  overdueCents: 0,
  paymentStatus: 'open',
  externalSyncFailed: false,
  ...r,
});

let report: BillingReport;
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = String(url).includes('/finance/reports/billing') ? report : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function generate(data: BillingReportRow[]) {
  report = { data, totals: { budgetedCents: 0, billedCents: 0, receivedCents: 0, openCents: 0, overdueCents: 0 }, customers: data.length, generatedAt: '2026-10-06T12:00:00Z' };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <BillingReportPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Gerar relatório/ }));
  await screen.findByText(data[0].customerName);
}

describe('BillingReportPage: cobrança não emitida', () => {
  it('marca a linha com a emissão que falhou, com a explicação na dica e no aviso', async () => {
    await generate([row({ budgetId: 'b1', customerName: 'Ana Falhou', externalSyncFailed: true }), row({ budgetId: 'b2', customerName: 'Bruno Emitido' })]);
    const flags = screen.getAllByText('Cobrança não emitida');
    expect(flags).toHaveLength(1);
    expect(flags[0].closest('[title]')?.getAttribute('title')).toBe(EXTERNAL_SYNC_FAILED_HINT);
    expect(EXTERNAL_SYNC_FAILED_HINT).toMatch(/Emitir novamente/);
    const failedRow = screen.getByText('Ana Falhou').closest('tr')!;
    expect(within(failedRow).getByText('Cobrança não emitida')).toBeTruthy();
    expect(within(screen.getByText('Bruno Emitido').closest('tr')!).queryByText('Cobrança não emitida')).toBeNull();
    expect(screen.getByText('1 orçamento(s) com cobrança não emitida')).toBeTruthy();
  });

  it('sem falha de emissão, não mostra marca nem aviso', async () => {
    await generate([row({ customerName: 'Carla Ok' })]);
    expect(screen.queryByText('Cobrança não emitida')).toBeNull();
    expect(screen.queryByText(/com cobrança não emitida/)).toBeNull();
  });
});
