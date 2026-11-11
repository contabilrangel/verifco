import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../../ds';
import { PortalHome, PortalLayout } from './Portal';

/**
 * Portal do cliente: orçamento aprovado continua visível com o cartão "Pagamentos" (botão "Pagar"),
 * as quotas do DARF com a guia para baixar, a recusa com motivo e o contato do escritório no rodapé.
 */
const token = `x.${btoa(JSON.stringify({ sub: 'c1' }))}.y`;

const overview = {
  exerciseYear: 2026,
  declarations: [
    { exerciseYear: 2026, calendarYear: 2025, stage: 'transmitted', status: { title: 'Entregue', description: 'Sua declaração foi entregue.', tone: 'success' }, transmittedAt: null, refundCents: 0, taxDueCents: 100_000 },
    { exerciseYear: 2025, calendarYear: 2024, stage: 'finished', status: { title: 'Concluída', description: 'Tudo certo.', tone: 'success' }, transmittedAt: null, refundCents: 0, taxDueCents: 0 },
  ],
  pendencies: [],
  checklist: null,
  darfs: [
    { id: 'd1', exerciseYear: 2026, quotaNumber: 1, dueDate: '2031-05-30', valueCents: 50_000, amount: null, status: 'open', paidAt: null, hasFile: true },
    { id: 'd2', exerciseYear: 2026, quotaNumber: 2, dueDate: '2031-06-30', valueCents: 50_000, amount: { totalCents: 50_500, note: 'Principal + juros de 1,00%, se paga até o vencimento.' }, status: 'open', paidAt: null, hasFile: false },
    { id: 'd3', exerciseYear: 2025, quotaNumber: 1, dueDate: '2030-05-30', valueCents: 12_345, amount: null, status: 'paid', paidAt: '2030-05-20', hasFile: false },
  ],
  documents: [],
  unreadMessages: 0,
};
const approved = {
  id: 'b1',
  status: 'approved',
  category: 'irpf',
  categoryLabel: 'Declaração IRPF',
  exerciseYear: 2026,
  totalCents: 60_000,
  installments: 2,
  payments: [
    { number: 1, dueDate: '2031-01-10', amountCents: 30_000, status: 'paid', paidAt: '2031-01-08', payUrl: null },
    { number: 2, dueDate: '2031-02-10', amountCents: 30_000, status: 'open', paidAt: null, payUrl: 'https://pagar.exemplo/2' },
  ],
};
const sent = { id: 'b2', status: 'sent', category: 'consulting', categoryLabel: 'Consultoria', exerciseYear: 2026, totalCents: 20_000, installments: 1, payments: null };
const me = { customer: { name: 'Maria Cliente', firstName: 'Maria', cpf: '***', email: null }, office: { name: 'Escritório Modelo', email: 'contato@modelo.com', phone: '1133334444', whatsapp: '11987654321' } };

let calls: { url: string; method: string; body?: unknown }[] = [];
beforeEach(() => {
  calls = [];
  sessionStorage.setItem('verifco.portal', JSON.stringify({ token, firstName: 'Maria', officeName: 'Escritório Modelo' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const path = url.replace(/^.*\/api/, '');
      if (path.startsWith('/portal/darfs/')) return new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } });
      const json = path === '/portal/overview' ? overview : path === '/portal/budgets' ? [approved, sent] : path === '/portal/me' ? me : {};
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  URL.createObjectURL = vi.fn(() => 'blob:guia');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function open() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/portal']}>
          <Routes>
            <Route path="/portal" element={<PortalLayout />}>
              <Route index element={<PortalHome />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const card = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('.vf-card') as HTMLElement;

describe('Portal do cliente: pagamentos, DARF e contato', () => {
  it('orçamento aprovado fica no cartão "Pagamentos", com o botão "Pagar" abrindo o link em outra aba', async () => {
    open();
    const pagamentos = await card('Pagamentos');
    expect(within(pagamentos).getByText(/Declaração IRPF · IR 2026/)).toBeTruthy();
    expect(within(pagamentos).getByText('Paga em 08/01/2031')).toBeTruthy();
    const link = within(pagamentos).getByRole('link', { name: 'Pagar a 2ª parcela' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://pagar.exemplo/2');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    // o enviado segue em "para aprovar", sem cartão de pagamento próprio
    const pending = await card('Orçamentos para aprovar');
    expect(within(pending).getAllByRole('button', { name: 'Aprovar' })).toHaveLength(1);
    expect(within(pagamentos).queryByText(/Consultoria/)).toBeNull();
  });

  it('recusar deixa o cliente escrever o motivo, que vai para a API', async () => {
    open();
    fireEvent.click(within(await card('Orçamentos para aprovar')).getByRole('button', { name: 'Recusar' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Quer contar o motivo/), { target: { value: '  Achei caro  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recusar' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/portal/budgets/b2/reject'))?.body).toEqual({ reason: 'Achei caro' }));
  });

  it('"DARF do imposto" lista as quotas com o valor atualizado, a situação e a guia para baixar', async () => {
    open();
    const darf = await card('DARF do imposto');
    const rows = within(darf).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText(/1ª quota · IR 2026/)).toBeTruthy();
    expect(within(rows[0]).getByText(/R\$\s500,00 · vencimento em 30\/05\/2031/)).toBeTruthy();
    expect(within(rows[0]).getByText('Em aberto')).toBeTruthy();
    // 2ª quota gerada: mostra o valor com juros e explica
    expect(within(rows[1]).getByText(/R\$\s505,00 · vencimento em 30\/06\/2031/)).toBeTruthy();
    expect(within(rows[1]).getByText(/Principal \+ juros de 1,00%/)).toBeTruthy();
    expect(within(rows[1]).getByText('O escritório vai enviar a guia')).toBeTruthy();
    expect(within(rows[1]).queryByRole('button')).toBeNull();
    expect(within(rows[2]).getByText(/paga em 20\/05\/2030/)).toBeTruthy();
    expect(within(rows[2]).getByText('Paga')).toBeTruthy();

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Baixar a guia da 1ª quota de 2026' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/portal/darfs/d1/file'))).toBe(true));
  });

  it('o rodapé traz o contato do escritório (e-mail, telefone e WhatsApp)', async () => {
    open();
    const contact = await screen.findByLabelText('Contato do escritório');
    expect(within(contact).getByText('Fale com Escritório Modelo')).toBeTruthy();
    expect((within(contact).getByRole('link', { name: 'contato@modelo.com' }) as HTMLAnchorElement).href).toBe('mailto:contato@modelo.com');
    expect((within(contact).getByRole('link', { name: '(11) 3333-4444' }) as HTMLAnchorElement).href).toBe('tel:1133334444');
    const wa = within(contact).getByRole('link', { name: /WhatsApp \(11\) 98765-4321/ }) as HTMLAnchorElement;
    expect(wa.href).toBe('https://wa.me/5511987654321');
    expect(wa.rel).toContain('noopener');
  });
});
