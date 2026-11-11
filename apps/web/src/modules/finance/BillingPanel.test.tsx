import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../ds';
import { BillingPanel } from './BillingPanel';
import type { Billing, BillingSync, Installment } from './types';

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

let calls: { url: string; method: string; body?: unknown }[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
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

describe('BillingPanel: parcela com cobrança emitida no provedor', () => {
  const issued = { ...installment, externalId: 'pay_1', externalUrl: 'https://pagar.exemplo/1' };
  const paid = { ...installment, id: 'i2', number: 2, status: 'paid' as const, paidAt: '2030-01-05', paidAmountCents: 30_000, externalId: 'pay_2', externalUrl: null };
  const withInstallments = (ready: boolean, first: Partial<Installment> = {}): Billing => ({ ...billing(sync({ status: 'done', integrationReady: ready })), installments: [{ ...issued, ...first }, paid] });
  const ALL = ['billing.edit', 'billing.receive', 'budget.send'];
  const menuItem = (n: number, name: RegExp) => {
    fireEvent.click(screen.getByRole('button', { name: `Mais ações da parcela ${n}` }));
    return screen.getByRole('menuitem', { name }) as HTMLButtonElement;
  };
  const posted = (path: string) => calls.find((c) => c.method === 'POST' && c.url.endsWith(path));

  it('com a integração ativa: receber, alterar e desfazer ficam liberados e as janelas avisam que a mudança vale no provedor', async () => {
    renderPanel(withInstallments(true), ALL);
    expect(screen.getByText('Parcelas com cobrança emitida no Asaas')).toBeTruthy();
    expect(screen.getByText(/também muda a cobrança no Asaas/)).toBeTruthy();
    const receive = screen.getByRole('button', { name: 'Receber' }) as HTMLButtonElement;
    expect(receive.disabled).toBe(false);
    fireEvent.click(receive);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/também é registrado no Asaas \(recebimento em dinheiro\)/)).toBeTruthy();
    expect(within(dialog).queryByText(/a integração está desativada/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar recebimento' }));
    await waitFor(() => expect(posted('/api/finance/installments/i1/receive')).toBeTruthy());
    cleanup();
    renderPanel(withInstallments(true), ALL);
    expect(menuItem(1, /^Alterar vencimento ou valor$/).disabled).toBe(false);
    cleanup();
    renderPanel(withInstallments(true), ALL);
    fireEvent.click(menuItem(2, /^Desfazer recebimento$/));
    expect(within(await screen.findByRole('dialog')).getByText(/estorne a cobrança por lá/)).toBeTruthy();
  });

  it('com a integração desativada: o controle volta a ser manual, com o aviso de cancelar a cobrança no provedor', async () => {
    renderPanel(withInstallments(false), ALL);
    expect(screen.queryByText('Parcelas com cobrança emitida no Asaas')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Receber' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/a integração está desativada: a mudança vale só no Verifco/)).toBeTruthy();
  });

  it('"Enviar cobrança": mostra se o link já foi enviado, pede confirmação e chama a API com o canal', async () => {
    renderPanel(withInstallments(true), ALL);
    expect(screen.getByText('cobrança não enviada ao cliente')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Boleto \/ Pix/ }) as HTMLAnchorElement;
    expect(link.rel).toContain('noopener');
    fireEvent.click(menuItem(1, /Enviar cobrança por e-mail/));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/O link de pagamento da parcela 1\/2 .* será enviado por e-mail ao cliente/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(posted('/api/finance/installments/i1/charge/send')?.body).toEqual({ channel: 'email' }));
    cleanup();

    // já enviada: a data aparece na parcela e a confirmação avisa do reenvio
    renderPanel(withInstallments(true, { chargeSentAt: '2030-01-02T13:00:00Z' }), ALL);
    expect(screen.getByText(/^cobrança enviada 02\/01\/2030/)).toBeTruthy();
    fireEvent.click(menuItem(1, /Enviar cobrança por WhatsApp/));
    expect(within(await screen.findByRole('dialog')).getByText(/Já foi enviado em 02\/01\/2030/)).toBeTruthy();
    cleanup();

    // sem budget.send ou sem link de pagamento, a ação não aparece
    renderPanel(withInstallments(true), ['billing.edit', 'billing.receive']);
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações da parcela 1' }));
    expect(screen.queryByRole('menuitem', { name: /Enviar cobrança/ })).toBeNull();
    cleanup();
    renderPanel(withInstallments(true, { externalUrl: null }), ALL);
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações da parcela 1' }));
    expect(screen.queryByRole('menuitem', { name: /Enviar cobrança/ })).toBeNull();
    expect(screen.queryByText('cobrança não enviada ao cliente')).toBeNull();
  });

  it('"Cancelar parcela": confirma com o aviso do provedor, envia o motivo e mostra a parcela cancelada', async () => {
    renderPanel(withInstallments(true), ALL);
    fireEvent.click(menuItem(1, /^Cancelar parcela$/));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/deixa de ser cobrada e sai do total do faturamento/)).toBeTruthy();
    expect(within(dialog).getByText(/também é cancelada no Asaas: o link de pagamento do cliente deixa de funcionar/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/Motivo/), { target: { value: 'Cliente desistiu' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar parcela' }));
    await waitFor(() => expect(posted('/api/finance/installments/i1/cancel')?.body).toEqual({ reason: 'Cliente desistiu' }));
    cleanup();

    // parcela paga não tem a ação; quem não edita o faturamento também não
    renderPanel(withInstallments(true), ALL);
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações da parcela 2' }));
    expect(screen.queryByRole('menuitem', { name: /Cancelar parcela/ })).toBeNull();
    cleanup();
    renderPanel(withInstallments(true), ['billing.receive', 'budget.send']);
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações da parcela 1' }));
    expect(screen.queryByRole('menuitem', { name: /Cancelar parcela/ })).toBeNull();
    cleanup();

    // cancelada: motivo e data na situação, sem link nem ações de cobrança
    renderPanel(withInstallments(true, { status: 'canceled', canceledAt: '2030-01-03T12:00:00Z', cancelReason: 'Cliente desistiu' }), ALL);
    expect(screen.getByText(/03\/01\/2030 · Cliente desistiu/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Boleto \/ Pix/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Receber' })).toBeNull();
  });
});
