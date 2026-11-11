import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../../ds';
import { CancelBudgetModal } from './BudgetStep';
import { CustomerPayments } from './CustomerPayments';
import { PublicBudgetPage } from './PublicBudgetPage';
import type { Budget, CustomerPayment, Installment, PublicBudget } from './types';

/**
 * O cliente consegue pagar: o cartão "Pagamentos" (link da proposta e portal) mostra cada parcela
 * com vencimento, valor, situação e o botão "Pagar"; e o escritório cancela o orçamento aprovado.
 */
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: () => true }),
}));
vi.mock('../customers/customerContext', () => ({ useCustomer: () => ({ customer: { id: 'c1', name: 'Maria' } }) }));

const pay = (p: Partial<CustomerPayment>): CustomerPayment => ({ number: 1, dueDate: '2031-01-10', amountCents: 30_000, status: 'open', paidAt: null, payUrl: null, ...p });

type Reply = { status?: number; json: unknown };
let calls: { url: string; method: string; body?: unknown }[] = [];
let respond: (url: string, method: string) => Reply = () => ({ json: {} });
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const r = respond(url, method);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);

describe('CustomerPayments: cartão "Pagamentos" do cliente', () => {
  it('mostra vencimento, valor e situação; "Pagar" abre o link em outra aba, sem dar acesso à janela de origem', () => {
    render(
      <CustomerPayments
        payments={[
          pay({ number: 1, status: 'paid', paidAt: '2031-01-08', payUrl: null }),
          pay({ number: 2, dueDate: '2031-02-10', status: 'overdue', payUrl: 'https://pagar.exemplo/2' }),
          pay({ number: 3, dueDate: '2031-03-10', payUrl: null }),
          pay({ number: 4, dueDate: '2031-04-10', status: 'canceled', payUrl: null }),
        ]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText(/1ª parcela · R\$\s300,00/)).toBeTruthy();
    expect(within(rows[0]).getByText('Paga em 08/01/2031')).toBeTruthy();
    expect(within(rows[0]).getByText('Pago')).toBeTruthy();
    expect(within(rows[0]).queryByRole('link')).toBeNull();

    expect(within(rows[1]).getByText('Vencimento em 10/02/2031')).toBeTruthy();
    expect(within(rows[1]).getByText('Vencido')).toBeTruthy();
    const link = within(rows[1]).getByRole('link', { name: 'Pagar a 2ª parcela' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://pagar.exemplo/2');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');

    // em aberto e ainda sem cobrança emitida: avisa em vez de mostrar um botão que não leva a lugar nenhum
    expect(within(rows[2]).getByText('Em aberto')).toBeTruthy();
    expect(within(rows[2]).getByText('O escritório vai enviar a cobrança')).toBeTruthy();
    expect(within(rows[2]).queryByRole('link')).toBeNull();
    // cancelada: nem link, nem aviso de cobrança
    expect(within(rows[3]).getByText('Cancelado')).toBeTruthy();
    expect(within(rows[3]).queryByText('O escritório vai enviar a cobrança')).toBeNull();
  });

  it('pagamento à vista não fala em parcela', () => {
    render(<CustomerPayments payments={[pay({ payUrl: 'https://pagar.exemplo/1' })]} />);
    expect(screen.getByText(/^Pagamento · R\$\s300,00/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pagar' })).toBeTruthy();
  });
});

describe('PublicBudgetPage: link da proposta', () => {
  const summary = (budget: Partial<PublicBudget['budget']>): PublicBudget => ({
    office: { name: 'Escritório Modelo', email: 'contato@modelo.com', phone: null, hasLogo: false },
    customer: { name: 'Maria Cliente' },
    expiresAt: null,
    budget: {
      id: 'b1',
      status: 'sent',
      exerciseYear: 2026,
      categoryLabel: 'Declaração IRPF',
      description: null,
      amountCents: 60_000,
      discountPercent: 0,
      totalCents: 60_000,
      installments: 2,
      installmentAmounts: [30_000, 30_000],
      plan: [
        { number: 1, dueDate: '2031-01-10', amountCents: 30_000 },
        { number: 2, dueDate: '2031-02-10', amountCents: 30_000 },
      ],
      payments: null,
      paymentMethod: 'Boleto Asaas',
      billingStartDate: '2031-01-10',
      approvedAt: null,
      rejectedAt: null,
      ...budget,
    },
  });
  const open = () =>
    render(
      wrap(
        <MemoryRouter initialEntries={['/orcamento/token-da-proposta-0001']}>
          <Routes>
            <Route path="/orcamento/:token" element={<PublicBudgetPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );

  it('aprovada e faturada: mostra o cartão "Pagamentos" com o botão de pagar de cada parcela', async () => {
    respond = () => ({
      json: summary({
        status: 'approved',
        approvedAt: '2030-12-20T12:00:00Z',
        payments: [pay({ number: 1, payUrl: 'https://pagar.exemplo/1' }), pay({ number: 2, dueDate: '2031-02-10', payUrl: 'https://pagar.exemplo/2' })],
      }),
    });
    open();
    const section = await screen.findByRole('region', { name: 'Pagamentos' });
    expect(within(section).getByRole('heading', { name: 'Pagamentos' })).toBeTruthy();
    expect((within(section).getByRole('link', { name: 'Pagar a 1ª parcela' }) as HTMLAnchorElement).href).toBe('https://pagar.exemplo/1');
    expect((within(section).getByRole('link', { name: 'Pagar a 2ª parcela' }) as HTMLAnchorElement).href).toBe('https://pagar.exemplo/2');
    expect(screen.getByText(/Pague por aqui, no botão de cada parcela/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aprovar proposta/ })).toBeNull();
  });

  it('ainda não aprovada: só o plano e as ações; ao aprovar, as parcelas aparecem (sem link até a cobrança sair)', async () => {
    respond = (url, method) =>
      method === 'POST'
        ? { json: { ok: true, budget: summary({ status: 'approved', payments: [pay({ number: 1 }), pay({ number: 2, dueDate: '2031-02-10' })] }).budget } }
        : { json: summary({}) };
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Aprovar proposta/ }));
    expect(screen.queryByRole('region', { name: 'Pagamentos' })).toBeNull();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Aprovar' }));
    const section = await screen.findByRole('region', { name: 'Pagamentos' });
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/public/budgets/token-da-proposta-0001/approve'))).toBe(true);
    expect(within(section).getAllByText('O escritório vai enviar a cobrança')).toHaveLength(2);
    expect(within(section).queryByRole('link')).toBeNull();
  });
});

describe('CancelBudgetModal: cancelar orçamento aprovado', () => {
  const inst = (i: Partial<Installment>): Installment => ({ id: 'i1', number: 1, dueDate: '2031-01-10', amountCents: 30_000, status: 'open', paidAt: null, paidAmountCents: null, receiptNumber: null, receiptFileId: null, receiptSentAt: null, externalId: 'pay_1', externalUrl: 'https://pagar.exemplo/1', ...i });
  const budget = {
    id: 'b1',
    customerId: 'c1',
    status: 'approved',
    categoryLabel: 'Declaração IRPF',
    totalCents: 90_000,
    billing: {
      id: 'bl1',
      totalCents: 90_000,
      provider: 'asaas',
      createdAt: '2030-12-20T12:00:00Z',
      paidCents: 30_000,
      openCents: 60_000,
      overdueCents: 0,
      externalSync: { status: 'done', error: null, attempts: 1, maxAttempts: 8, nextAttemptAt: null, finishedAt: null, integrationReady: true },
      installments: [inst({ status: 'paid', paidAt: '2031-01-08', paidAmountCents: 30_000 }), inst({ id: 'i2', number: 2, externalId: 'pay_2' }), inst({ id: 'i3', number: 3, externalId: 'pay_3' })],
    },
  } as unknown as Budget;

  it('explica o que é cancelado e o que fica, avisa do provedor e envia o motivo', async () => {
    const onClose = vi.fn();
    respond = () => ({ json: { status: 'canceled', canceledInstallments: [2, 3] } });
    render(wrap(<CancelBudgetModal budget={budget} customerId="c1" onClose={onClose} />));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/As 2 parcelas em aberto são canceladas \(R\$\s600,00\)/)).toBeTruthy();
    expect(within(dialog).getByText(/A parcela paga continua no histórico/)).toBeTruthy();
    expect(within(dialog).getByText(/também são canceladas no Asaas/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/Motivo/), { target: { value: 'Contrato encerrado' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar orçamento' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: expect.stringMatching(/\/api\/finance\/budgets\/b1\/cancel$/), body: { reason: 'Contrato encerrado' } });
  });

  it('o provedor recusou uma parcela: a janela fica aberta com o que foi e o que não foi cancelado', async () => {
    const onClose = vi.fn();
    const message = 'Parcela(s) 2 cancelada(s). A parcela 3 não foi cancelada: Asaas respondeu com erro (HTTP 400): Cobrança em processamento. O orçamento continua aprovado; tente de novo.';
    respond = () => ({ status: 409, json: { error: message } });
    render(wrap(<CancelBudgetModal budget={budget} customerId="c1" onClose={onClose} />));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancelar orçamento' }));
    expect(await within(screen.getByRole('dialog')).findByText(message)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
