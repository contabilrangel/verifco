import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { addDaysIso, todayIso, type ContractUsage } from '@verifco/shared';
import { ContractsTab } from './ContractsTab';

const server = vi.hoisted(() => ({ contracts: [] as Record<string, unknown>[], status: null as unknown }));
vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return { ...original, api: { ...original.api, get: async (path: string) => (path === '/office/contracts/status' ? server.status : server.contracts) } };
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

const today = todayIso();
const usage = (over: Partial<ContractUsage> = {}): ContractUsage => ({
  today,
  hasContracts: true,
  readOnly: false,
  active: [{ id: 'k1', name: 'Pacote Básico', plan: 'basic', year: 2026, declarationLimit: 30, startsAt: addDaysIso(today, -10), expiresAt: addDaysIso(today, 60), daysLeft: 60 }],
  validUntil: addDaysIso(today, 60),
  daysLeft: 60,
  lastExpiredAt: null,
  nextStartsAt: null,
  exercises: [{ year: 2026, limit: 30, used: 12, remaining: 18, percent: 40 }],
  ...over,
});

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ContractsTab />
    </QueryClientProvider>,
  );

const bar = () => screen.getByRole('progressbar', { name: 'Declarações do exercício 2026' });

describe('ContractsTab (COB-12)', () => {
  afterEach(cleanup);

  it('avisa que o escritório está só em consulta quando nenhum contrato está vigente', async () => {
    const yesterday = addDaysIso(today, -1);
    server.contracts = [contract(addDaysIso(yesterday, -30), yesterday)];
    server.status = usage({ readOnly: true, active: [], validUntil: null, daysLeft: null, lastExpiredAt: yesterday, exercises: [{ year: 2026, limit: null, used: 7, remaining: null, percent: null }] });
    renderTab();
    expect(await screen.findByText('Expirado')).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nenhum contrato vigente');
    expect(alert.textContent).toContain('só em consulta');
    expect(alert.textContent).toContain(`O último pacote venceu em ${yesterday.split('-').reverse().join('/')}.`);
    // sem pacote vigente não há "sem limite" nem barra
    expect(screen.getByText('7 declarações')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('Dias restantes')).toBeNull();
  });

  it('com contrato vigente mostra a vigência, os dias restantes e o uso sem aviso', async () => {
    server.contracts = [contract(addDaysIso(today, -29), today)];
    server.status = usage();
    renderTab();
    expect(await screen.findByText('Ativo')).toBeTruthy();
    expect(await screen.findByText('Uso do contrato')).toBeTruthy();
    expect(screen.queryByText('Nenhum contrato vigente')).toBeNull();
    expect(screen.getByText('Dias restantes')).toBeTruthy();
    expect(screen.getByText('60')).toBeTruthy();
    expect(screen.getByText('12 de 30 (40%)')).toBeTruthy();
    expect(bar().getAttribute('aria-valuenow')).toBe('40');
    expect(bar().className).toBe('vf-progress');
    expect(screen.getByText('Restam 18 declarações no pacote.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Perto do limite')).toBeNull();
  });

  it('perto do limite (80%) avisa quantas restam', async () => {
    server.contracts = [contract(addDaysIso(today, -10), addDaysIso(today, 60))];
    server.status = usage({ exercises: [{ year: 2026, limit: 30, used: 24, remaining: 6, percent: 80 }] });
    renderTab();
    expect(await screen.findByText('Perto do limite')).toBeTruthy();
    expect(bar().className).toContain('vf-progress--warning');
    expect(screen.getByText(/Restam 6 declarações no pacote do exercício 2026/)).toBeTruthy();
  });

  it('no limite avisa que novas declarações são recusadas', async () => {
    server.contracts = [contract(addDaysIso(today, -10), addDaysIso(today, 60))];
    server.status = usage({ exercises: [{ year: 2026, limit: 30, used: 30, remaining: 0, percent: 100 }] });
    renderTab();
    expect(await screen.findByText('Limite atingido')).toBeTruthy();
    expect(bar().className).toContain('vf-progress--danger');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Não é possível criar novas declarações do exercício 2026: o pacote permite 30 declarações/);
  });

  it('avisa quando o contrato vence em breve; pacote ilimitado mostra o uso sem barra', async () => {
    server.contracts = [contract(addDaysIso(today, -10), addDaysIso(today, 5))];
    server.status = usage({ validUntil: addDaysIso(today, 5), daysLeft: 5, exercises: [{ year: 2026, limit: null, used: 140, remaining: null, percent: null }] });
    renderTab();
    expect(await screen.findByText('O contrato vence em 5 dias')).toBeTruthy();
    expect(screen.getByText(/só em consulta até a renovação/)).toBeTruthy();
    expect(screen.getByText('140 declarações (sem limite)')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('escritório sem contrato cadastrado não mostra o card', async () => {
    server.contracts = [];
    server.status = usage({ hasContracts: false, active: [], validUntil: null, daysLeft: null });
    renderTab();
    expect(await screen.findByText('Nenhum pacote contratado')).toBeTruthy();
    expect(screen.queryByText('Uso do contrato')).toBeNull();
  });
});
