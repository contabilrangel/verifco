import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ProcuratorAlerts, type ProcuratorAccessData, type ProcuratorAccessItem } from './ProcuratorAlerts';

/** INT-15 detalhado: alertas de acesso dos procuradores no dashboard, por gravidade e com o link para corrigir. */
const perms = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: (...p: string[]) => p.some((x) => perms.list.includes(x)) }),
}));

const item = (over: Partial<ProcuratorAccessItem>): ProcuratorAccessItem => ({
  id: over.name ?? 'p',
  name: 'Procurador',
  authType: 'certificate_cloud',
  access: 'certificate_expired',
  label: 'Certificado vencido',
  severity: 'danger',
  certificateExpiresAt: null,
  daysLeft: null,
  serpro: { status: null, at: null, usesThisCertificate: false },
  customers: 0,
  mine: false,
  ...over,
});

const data: ProcuratorAccessData = {
  warningDays: 30,
  total: 5,
  count: 4,
  counts: { danger: 2, warning: 1, info: 1, ok: 1 },
  items: [
    item({ name: 'Ana Vencida', certificateExpiresAt: '2026-09-30', daysLeft: -6, customers: 12, serpro: { status: 'ok', at: '2026-09-29T15:00:00Z', usesThisCertificate: true } }),
    item({ name: 'Bruno SERPRO', access: 'serpro_error', label: 'Falha no login do SERPRO', serpro: { status: 'error', at: '2026-10-05T13:30:00Z', usesThisCertificate: true } }),
    item({ name: 'Carla Vencendo', authType: 'certificate_local', access: 'certificate_expiring', label: 'Certificado vence em até 30 dias', severity: 'warning', certificateExpiresAt: '2026-10-16', daysLeft: 10, customers: 1, mine: true }),
    item({ name: 'Davi Gov', authType: 'govbr', access: 'govbr_unverified', label: 'Login gov.br sem verificação', severity: 'info' }),
  ],
};

const renderAlerts = (d: ProcuratorAccessData = data) =>
  render(
    <MemoryRouter>
      <ProcuratorAlerts data={d} />
    </MemoryRouter>,
  );

describe('ProcuratorAlerts', () => {
  afterEach(() => {
    cleanup();
    perms.list = [];
  });

  it('agrupa por gravidade, descreve cada situação e leva à tela de procuradores', () => {
    perms.list = ['procuration.certificate', 'integrations.manage'];
    renderAlerts();
    const danger = screen.getByRole('region', { name: 'Ação necessária' });
    const warning = screen.getByRole('region', { name: 'Atenção' });
    const info = screen.getByRole('region', { name: 'Sem verificação' });
    expect(within(danger).getAllByRole('listitem')).toHaveLength(2);
    expect(within(danger).getByText('Venceu em 30/09/2026.')).toBeTruthy();
    expect(within(danger).getByText(/12 clientes ativos · Certificado usado pelo SERPRO · Último login no SERPRO em/)).toBeTruthy();
    expect(within(danger).getByText(/O último login no SERPRO com este certificado falhou em/)).toBeTruthy();
    expect(within(warning).getByText('Vence em 16/10/2026 (10 dias).')).toBeTruthy();
    expect(within(info).getByText('Login gov.br sem verificação')).toBeTruthy();

    expect(screen.getByRole('link', { name: 'Enviar certificado: Ana Vencida' }).getAttribute('href')).toBe('/admin/procuradores');
    expect(screen.getByRole('link', { name: 'Atualizar validade: Carla Vencendo' }).getAttribute('href')).toBe('/admin/procuradores');
    expect(screen.getByRole('link', { name: /Testar o SERPRO/ }).getAttribute('href')).toBe('/admin/integracoes');
    expect(screen.getByRole('link', { name: /Gerenciar procuradores/ })).toBeTruthy();
  });

  it('sem permissão de procuradores, só o próprio procurador ganha link (Minha conta)', () => {
    renderAlerts();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('aria-label')).toBe('Atualizar validade: Carla Vencendo');
    expect(links[0].getAttribute('href')).toBe('/conta');
    expect(screen.getByText(/Você é este procurador/)).toBeTruthy();
  });

  it('tudo em ordem e escritório sem procuradores', () => {
    renderAlerts({ ...data, total: 2, count: 0, counts: { danger: 0, warning: 0, info: 0, ok: 2 }, items: [] });
    expect(screen.getByText('Acesso em ordem')).toBeTruthy();
    expect(screen.queryByRole('region')).toBeNull();
    cleanup();
    const { container } = renderAlerts({ ...data, total: 0, count: 0, counts: { danger: 0, warning: 0, info: 0, ok: 0 }, items: [] });
    expect(container.textContent).toBe('');
  });
});
