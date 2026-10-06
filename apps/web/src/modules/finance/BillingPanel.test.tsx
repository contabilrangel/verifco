import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../ds';
import { BillingPanel } from './BillingPanel';
import type { Billing, BillingSync } from './types';

/**
 * DAD-4/INT-9: o painel mostra a situação real da emissão no Asaas/Omie (em vez de "sendo emitida"
 * para sempre) e oferece "Emitir novamente" a quem pode editar o faturamento.
 */
let permissions: string[] = [];
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: (...p: string[]) => p.some((x) => permissions.includes(x)) }),
}));

const installment = { id: 'i1', number: 1, dueDate: '2030-01-10', amountCents: 30_000, status: 'open' as const, paidAt: null, paidAmountCents: null, receiptNumber: null, receiptFileId: null, receiptSentAt: null, externalId: null, externalUrl: null };
const sync = (s: Partial<BillingSync>): BillingSync => ({ status: 'failed', error: null, attempts: 1, maxAttempts: 8, nextAttemptAt: null, finishedAt: null, integrationReady: true, ...s });
const billing = (externalSync: BillingSync | null, provider: string | null = 'asaas'): Billing => ({
  id: 'b1',
  totalCents: 30_000,
  provider,
  createdAt: '2026-04-01T10:00:00Z',
  paidCents: 0,
  openCents: 30_000,
  overdueCents: 0,
  installments: [installment],
  externalSync,
});

let calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ externalSync: sync({ status: 'queued', attempts: 0 }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel(b: Billing, perms: string[] = ['billing.edit']) {
  permissions = perms;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <BillingPanel billing={b} customerId="c1" contact={{ email: true, mobile: true }} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('BillingPanel: emissão da cobrança integrada (DAD-4, INT-9)', () => {
  it('falha de vez: mostra o erro real e "Emitir novamente" pede confirmação e chama a API', async () => {
    renderPanel(billing(sync({ status: 'failed', error: 'A integração Asaas está desativada. Ative em Administração › Integrações.', integrationReady: false })));
    expect(screen.getByText('Falha ao emitir a cobrança no Asaas')).toBeTruthy();
    expect(screen.getByText(/A integração Asaas está desativada/)).toBeTruthy();
    expect(screen.getByText(/a cobrança é emitida automaticamente/)).toBeTruthy();
    expect(screen.queryByText(/está sendo emitida/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Emitir novamente/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/não são duplicadas/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Emitir' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/finance/billings/b1/sync'))).toBe(true));
  });

  it('nova tentativa agendada mostra o erro, quando tenta de novo e "Tentar agora"', () => {
    renderPanel(billing(sync({ status: 'queued', error: 'Asaas respondeu com erro (HTTP 503).', attempts: 2, nextAttemptAt: '2030-01-01T12:00:00Z' })));
    expect(screen.getByText('Não foi possível emitir a cobrança no Asaas')).toBeTruthy();
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
    expect(screen.getByText(/Nova tentativa automática em .*\(tentativa 2 de 8\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Tentar agora/ })).toBeTruthy();
  });

  it('em emissão mostra o aviso de andamento; sem billing.edit não oferece o botão; sem provedor, nada', () => {
    renderPanel(billing(sync({ status: 'queued', attempts: 0 })));
    expect(screen.getByText(/A cobrança está sendo emitida no Asaas/)).toBeTruthy();
    cleanup();
    renderPanel(billing(sync({ status: 'failed', error: 'Credenciais recusadas pelo Asaas (HTTP 401).' })), ['billing.receive']);
    expect(screen.getByText(/Credenciais recusadas/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Emitir novamente/ })).toBeNull();
    cleanup();
    renderPanel(billing(null, null));
    expect(screen.queryByText(/emitida|emitir/i)).toBeNull();
  });
});

describe('BillingPanel: parcela com cobrança emitida no provedor (INT-10)', () => {
  const issued = { ...installment, externalId: 'pay_1', externalUrl: 'https://pagar.exemplo/1' };
  const paid = { ...installment, id: 'i2', number: 2, status: 'paid' as const, paidAt: '2030-01-05', paidAmountCents: 30_000, externalId: 'pay_2', externalUrl: null };
  const withInstallments = (ready: boolean): Billing => ({ ...billing(sync({ status: 'done', integrationReady: ready })), installments: [issued, paid] });
  const menuItem = (n: number, name: RegExp) => {
    fireEvent.click(screen.getByRole('button', { name: `Mais ações da parcela ${n}` }));
    return screen.getByRole('menuitem', { name }) as HTMLButtonElement;
  };

  it('com a integração ativa: baixa, alteração e estorno ficam desabilitados e o painel explica como fazer no provedor', () => {
    renderPanel(withInstallments(true), ['billing.edit', 'billing.receive']);
    expect(screen.getByText('Parcelas com cobrança emitida no Asaas')).toBeTruthy();
    expect(screen.getByText(/confirmar recebimento em dinheiro ou estornar, use a cobrança no Asaas/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Receber' }) as HTMLButtonElement).disabled).toBe(true);
    expect(menuItem(1, /Alterar vencimento ou valor \(pelo provedor\)/).disabled).toBe(true);
    expect(menuItem(2, /Desfazer recebimento \(pelo provedor\)/).disabled).toBe(true);
  });

  it('com a integração desativada: o controle volta a ser manual, com o aviso de cancelar a cobrança no provedor', async () => {
    renderPanel(withInstallments(false), ['billing.edit', 'billing.receive']);
    expect(screen.queryByText('Parcelas com cobrança emitida no Asaas')).toBeNull();
    const receive = screen.getByRole('button', { name: 'Receber' }) as HTMLButtonElement;
    expect(receive.disabled).toBe(false);
    fireEvent.click(receive);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/a integração está desativada: a mudança vale só no Verifco/)).toBeTruthy();
    cleanup();
    renderPanel(withInstallments(false), ['billing.edit', 'billing.receive']);
    expect(menuItem(1, /^Alterar vencimento ou valor$/).disabled).toBe(false);
  });
});
