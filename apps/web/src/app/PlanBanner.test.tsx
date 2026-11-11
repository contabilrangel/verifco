import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { todayIso } from '@verifco/shared';
import { PlanBanner, type PlanStatus } from './PlanBanner';

/** Faixa do contrato no Shell: vencido (modo de consulta), perto de vencer (dispensável por um dia) ou nada. */
const state = vi.hoisted(() => ({ plan: null as unknown, fail: false, perms: [] as string[], calls: 0 }));

vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: (...p: string[]) => p.some((x) => state.perms.includes(x)) }) }));
vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      get: async (path: string) => {
        state.calls++;
        if (path !== '/plan/status') throw new Error(`rota inesperada: ${path}`);
        if (state.fail) throw new original.ApiError(404, 'Rota não encontrada');
        return state.plan;
      },
    },
  };
});

const plan = (over: Partial<PlanStatus>): PlanStatus => ({ hasContracts: true, readOnly: false, validUntil: '2026-12-31', daysLeft: 50, lastExpiredAt: null, supportEmail: null, ...over });

const renderBanner = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PlanBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** Espera a consulta terminar e confere que nada foi mostrado. */
const expectNothing = async (container: HTMLElement) => {
  await waitFor(() => expect(state.calls).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 0));
  expect(container.textContent).toBe('');
};

describe('PlanBanner', () => {
  beforeEach(() => {
    state.plan = plan({});
    state.fail = false;
    state.perms = ['contracts.view'];
    state.calls = 0;
    localStorage.clear();
  });
  afterEach(cleanup);

  it('contrato vencido: faixa de erro com a data, "Ver contratos" e o e-mail do suporte, sem botão de dispensar', async () => {
    state.plan = plan({ readOnly: true, validUntil: null, daysLeft: null, lastExpiredAt: '2026-10-31', supportEmail: 'suporte@verifco.com.br' });
    renderBanner();
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('O contrato do escritório venceu em 31/10/2026: o Verifco está em modo de consulta.');
    expect(banner.className).toContain('shell-banner--danger');
    expect(screen.getByRole('link', { name: 'Ver contratos' }).getAttribute('href')).toBe('/admin/contratos');
    expect(screen.getByRole('link', { name: 'Falar com o suporte' }).getAttribute('href')).toBe('mailto:suporte@verifco.com.br');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('vencido, sem e-mail do suporte e sem acesso aos contratos: só o aviso', async () => {
    state.perms = [];
    state.plan = plan({ readOnly: true, lastExpiredAt: null, daysLeft: null });
    renderBanner();
    expect((await screen.findByRole('alert')).textContent).toContain('O contrato do escritório venceu: o Verifco está em modo de consulta.');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('vence em até 15 dias: aviso com os dias; dispensar vale só para o dia', async () => {
    state.plan = plan({ daysLeft: 7, validUntil: '2026-11-18', supportEmail: 'suporte@verifco.com.br' });
    const first = renderBanner();
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('O contrato vence em 7 dias (18/11/2026).');
    expect(banner.className).toContain('shell-banner--warning');
    expect(screen.getByRole('link', { name: 'Ver contratos' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Dispensar aviso até amanhã' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(localStorage.getItem('verifco.planBanner.dismissed')).toBe(todayIso());

    // recarregou no mesmo dia: continua dispensado
    first.unmount();
    state.calls = 0;
    await expectNothing(renderBanner().container);

    // no dia seguinte (a marca é de outro dia), o aviso volta
    cleanup();
    localStorage.setItem('verifco.planBanner.dismissed', '2020-01-01');
    renderBanner();
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('singular e "hoje"', async () => {
    state.plan = plan({ daysLeft: 1, validUntil: null });
    renderBanner();
    expect((await screen.findByRole('status')).textContent).toContain('O contrato vence em 1 dia.');
    cleanup();
    state.plan = plan({ daysLeft: 0, validUntil: null });
    renderBanner();
    expect((await screen.findByRole('status')).textContent).toContain('O contrato vence hoje.');
  });

  it('não mostra nada: longe do vencimento, escritório sem contratos, rota ausente (servidor antigo) ou resposta estranha', async () => {
    for (const p of [plan({ daysLeft: 16 }), plan({ hasContracts: false, readOnly: false, daysLeft: null }), plan({ daysLeft: null }), [], null]) {
      cleanup();
      state.calls = 0;
      state.plan = p;
      await expectNothing(renderBanner().container);
    }
    cleanup();
    state.calls = 0;
    state.fail = true;
    await expectNothing(renderBanner().container);
  });
});
