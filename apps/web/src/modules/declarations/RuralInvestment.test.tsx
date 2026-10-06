import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { DeclarationStep } from './DeclarationStep';

/**
 * OBS-4: na ficha "Atividade rural", a despesa pode ser marcada como investimento (bem da
 * atividade), gravando `extra.investment` para a análise de caixa não contar o valor duas vezes.
 */
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: () => true }),
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
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const posted: { url: string; body: any }[] = [];

beforeEach(() => {
  posted.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(String(init.body)) });
        return json({ declaration });
      }
      if (url.includes('/cash-analysis')) return json(cash);
      if (url.includes('/items')) return json([]);
      return json(declaration);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderStep() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <CustomerCtx.Provider value={{ customer: { id: 'c1', name: 'Rui Produtor', cpfCnpj: '52998224725' } as CustomerDetail, refetch: () => {} }}>
            <DeclarationStep />
          </CustomerCtx.Provider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ficha Atividade rural', () => {
  it('marca a despesa de investimento e grava extra.investment', async () => {
    renderStep();
    fireEvent.click(await screen.findByRole('tab', { name: /Atividade rural/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar em Atividade rural' }));
    const modal = await screen.findByRole('dialog');
    // receita: a marca não aparece
    expect(within(modal).queryByLabelText('Despesa de investimento (bem da atividade)')).toBeNull();
    fireEvent.change(within(modal).getByLabelText(/^Tipo/), { target: { value: 'rural_expense' } });
    const box = within(modal).getByLabelText('Despesa de investimento (bem da atividade)');
    fireEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(modal).getByLabelText(/^Descrição/), { target: { value: 'Trator' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].url).toContain('/declarations/d1/items');
    expect(posted[0].body).toMatchObject({ kind: 'rural_expense', description: 'Trator', extra: { investment: true } });
  });

  it('a marca não é gravada em outros tipos de linha', async () => {
    renderStep();
    fireEvent.click(await screen.findByRole('tab', { name: /Atividade rural/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar em Atividade rural' }));
    const modal = await screen.findByRole('dialog');
    fireEvent.change(within(modal).getByLabelText(/^Tipo/), { target: { value: 'rural_expense' } });
    fireEvent.click(within(modal).getByLabelText('Despesa de investimento (bem da atividade)'));
    // trocou para receita depois de marcar: a marca some e não vai no envio
    fireEvent.change(within(modal).getByLabelText(/^Tipo/), { target: { value: 'rural_income' } });
    fireEvent.change(within(modal).getByLabelText(/^Descrição/), { target: { value: 'Venda de soja' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body.kind).toBe('rural_income');
    expect(posted[0].body.extra).not.toHaveProperty('investment');
  });
});
