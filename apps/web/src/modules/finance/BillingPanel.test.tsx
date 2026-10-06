import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../ds';
import { BillingPanel } from './BillingPanel';
import type { Billing, ExternalSync } from './types';

/**
 * INT-9/DAD-4: a falha na emissão da cobrança integrada aparece no faturamento (antes a tela dizia
 * "está sendo emitida" para sempre) e quem pode editar o faturamento emite de novo.
 */
let permissions: string[] = [];
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: (...p: string[]) => p.some((x) => permissions.includes(x)) }),
}));

const installment = { id: 'i1', number: 1, dueDate: '2030-01-10', amountCents: 30_000, status: 'open' as const, paidAt: null, paidAmountCents: null, receiptNumber: null, receiptFileId: null, receiptSentAt: null, externalId: null, externalUrl: null };
const billing = (externalSync: ExternalSync | null): Billing => ({
  id: 'b1',
  totalCents: 30_000,
  provider: 'asaas',
  createdAt: '2026-04-01T10:00:00Z',
  paidCents: 0,
  openCents: 30_000,
  overdueCents: 0,
  installments: [installment],
  externalSync,
});
const sync = (state: ExternalSync['state'], error: string | null = null): ExternalSync => ({ state, pendingInstallments: 1, error, attempts: 3, maxAttempts: 3, at: '2026-04-01T10:01:00Z' });

const calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ alreadyQueued: false, budget: null }), { status: 202, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (b: Billing) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <BillingPanel billing={b} customerId="c1" contact={{ email: true, mobile: true }} />
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('emissão da cobrança integrada no faturamento', () => {
  it('mostra a falha com o motivo e "Emitir de novo" para quem edita o faturamento', async () => {
    permissions = ['billing.edit'];
    show(billing(sync('failed', 'A integração Asaas não está configurada. Configure em Administração › Integrações.')));
    expect(screen.getByText('Não foi possível emitir a cobrança no Asaas')).toBeTruthy();
    expect(screen.getByText(/não está configurada/)).toBeTruthy();
    expect(screen.queryByText(/está sendo emitida/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Emitir de novo/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/finance/billings/b1/sync'))).toBe(true));
  });

  it('sem billing.edit mostra a falha sem o botão; em andamento e falhando mostram o estado certo', () => {
    permissions = ['budget.list'];
    show(billing(sync('failed', 'Credenciais recusadas')));
    expect(screen.getByText(/Credenciais recusadas/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Emitir de novo/ })).toBeNull();
    cleanup();
    show(billing(sync('retrying', 'Asaas indisponível')));
    expect(screen.getByText('A emissão no Asaas falhou (tentativa 3 de 3)')).toBeTruthy();
    cleanup();
    show(billing(sync('pending')));
    expect(screen.getByText(/está sendo emitida no Asaas/)).toBeTruthy();
    cleanup();
    show(billing(sync('ok')));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
