import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { DeclarationStep } from './DeclarationStep';

/**
 * OBS-4 (TRI-9): na ficha "Atividade rural", a despesa marcada como investimento grava
 * `extra.investment`, que a análise de caixa usa para não contar o bem duas vezes.
 */
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

const declaration = {
  id: 'd1',
  exists: true,
  customerId: 'c1',
  exerciseYear: 2026,
  stage: 'filling',
  substatus: 'filling',
  ecacStatus: 'unknown',
  taxation: null,
  isRectification: false,
  receiptNumber: null,
  transmittedAt: null,
  taxDueCents: 0,
  refundCents: 0,
  refundLotDate: null,
  refundPaidAt: null,
  totalIncomeCents: 0,
  taxableIncomeCents: 0,
  exemptIncomeCents: 0,
  exclusiveIncomeCents: 0,
  deductionsCents: 0,
  withheldTaxCents: 0,
  assetsTotalCents: 0,
  assetsPrevTotalCents: 0,
  debtsTotalCents: 0,
  debtsPrevTotalCents: 0,
  cashBalanceCents: null,
  otherExpenses: {},
  finishedAt: null,
};
const cash = { sources: [], uses: [], totalSourcesCents: 0, totalUsesCents: 0, balanceCents: 0, netWorthVariationCents: 0, status: 'zero', warnings: [], itemCount: 0 };
const customer = { id: 'c1', name: 'Marta Campos', cpfCnpj: '52998224725' } as CustomerDetail;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let posted: { url: string; body: any }[] = [];

beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posted.push({ url, body });
        return json({ item: { id: 'i1', ...body }, declaration }, 201);
      }
      if (url.includes('/items')) return json([]);
      if (url.includes('/cash-analysis')) return json(cash);
      return json(declaration);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openRuralForm() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <CustomerCtx.Provider value={{ customer, refetch: () => {} }}>
            <DeclarationStep />
          </CustomerCtx.Provider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('tab', { name: /Atividade rural/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Adicionar em Atividade rural' }));
  return screen.findByRole('dialog');
}

describe('ficha Atividade rural: despesa de investimento (OBS-4)', () => {
  it('só a despesa rural mostra a marca, e ela é gravada em extra.investment', async () => {
    const modal = await openRuralForm();
    const label = 'Despesa de investimento (bem da atividade)';
    // receita da atividade (primeiro tipo): sem a marca
    expect(within(modal).queryByRole('checkbox', { name: label })).toBeNull();

    fireEvent.change(within(modal).getByLabelText(/^Tipo/), { target: { value: 'rural_expense' } });
    const box = within(modal).getByRole('checkbox', { name: label });
    fireEvent.click(box);
    fireEvent.change(within(modal).getByLabelText(/^Descrição/), { target: { value: 'Trator novo' } });
    fireEvent.change(within(modal).getByLabelText(/^Valor no ano/), { target: { value: '150000,00' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].url).toContain('/api/declarations/d1/items');
    expect(posted[0].body).toMatchObject({ kind: 'rural_expense', description: 'Trator novo', valueCents: 15_000_000, extra: { investment: true } });
  });

  it('sem a marca, ou trocando para receita, extra.investment não é gravado', async () => {
    const modal = await openRuralForm();
    const type = within(modal).getByLabelText(/^Tipo/);
    fireEvent.change(type, { target: { value: 'rural_expense' } });
    fireEvent.click(within(modal).getByRole('checkbox', { name: 'Despesa de investimento (bem da atividade)' }));
    // a marca é só da despesa: mudar o tipo para receita não a leva junto
    fireEvent.change(type, { target: { value: 'rural_income' } });
    fireEvent.change(within(modal).getByLabelText(/^Valor no ano/), { target: { value: '100,00' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body.kind).toBe('rural_income');
    expect(posted[0].body.extra).not.toHaveProperty('investment');
  });
});
