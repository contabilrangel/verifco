import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { addDaysIso, todayIso } from '@verifco/shared';
import { ContractsTab } from './ContractsTab';

const server = vi.hoisted(() => ({ contracts: [] as Record<string, unknown>[] }));
vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return { ...original, api: { ...original.api, get: async () => server.contracts } };
});

const contract = (startsAt: string, expiresAt: string) => ({
  id: 'k1',
  name: 'Avaliação gratuita',
  plan: 'trial',
  declarationLimit: 30,
  year: 2026,
  startsAt,
  expiresAt,
  hasBackup: false,
  status: 'active',
  termsUrl: null,
});

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ContractsTab />
    </QueryClientProvider>,
  );

describe('ContractsTab (COB-12)', () => {
  afterEach(cleanup);

  it('avisa que o escritório está só em consulta quando nenhum contrato está vigente', async () => {
    const yesterday = addDaysIso(todayIso(), -1);
    server.contracts = [contract(addDaysIso(yesterday, -30), yesterday)];
    renderTab();
    expect(await screen.findByText('Expirado')).toBeTruthy();
    expect(screen.getByText('Nenhum contrato vigente')).toBeTruthy();
  });

  it('com contrato vigente (vence hoje, no dia de Brasília) não avisa', async () => {
    server.contracts = [contract(addDaysIso(todayIso(), -29), todayIso())];
    renderTab();
    expect(await screen.findByText('Ativo')).toBeTruthy();
    expect(screen.queryByText('Nenhum contrato vigente')).toBeNull();
  });
});
