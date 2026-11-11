import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { EcacTab } from './EcacTab';
import { RobotAdminTab } from './RobotAdminTab';
import type { EcacPanel, InboxItem, MachineToken, RobotOverview } from './types';

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

let panel: EcacPanel;
const basePanel: EcacPanel = {
  customer: { id: 'c1', name: 'Maria', cpfCnpj: '52998224725' },
  credentials: { hasLogin: false, hasPassword: false },
  procuration: { status: 'valid', expiresAt: '2030-12-31', expiringSoon: false, expired: false, govbrLevel: null, mailboxMessages: 1, procurator: null },
  declarations: [],
  incomeStatements: [],
  darfs: [],
  cnd: { status: 'not_requested', checkedAt: null, autoGenerateCnd: false, latest: null },
  simplified: {
    id: 'r1',
    year: null,
    fileId: 'f-sitfis',
    source: 'serpro',
    fetchedAt: '2026-10-06T09:00:00Z',
    kind: 'fiscal_situation',
    situation: null,
    message: 'Relatório de situação fiscal emitido pela Receita Federal: abra o PDF para ver as pendências.',
    pendencies: [],
    status: 'unknown',
    certificate: null,
  },
  mailbox: [],
  others: [],
  lastSync: null,
};

const baseOverview: RobotOverview = {
  customersWithProcurator: 3,
  activeTokens: 0,
  serpro: 'ready',
  lastOfficeSync: null,
  nextAutoSync: '2026-10-07T07:12:00Z',
  inboxPending: 0,
  clientVersions: { sync: '0.3.0', extension: '0.2.0' },
  activity: [],
};
let overview: RobotOverview;
let inbox: InboxItem[];
let tokens: MachineToken[];
const posts: { path: string; body: unknown }[] = [];

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path.startsWith('/customers/c1/ecac')) return panel;
    if (path === '/robot/overview') return overview;
    if (path === '/robot/inbox') return inbox;
    if (path === '/robot/tokens') return tokens;
    return [];
  };
  const post = async (path: string, body: unknown) => {
    posts.push({ path, body });
    return { ok: true, duplicate: false, customer: { id: 'c1', name: 'Maria' } };
  };
  return { ...original, api: { ...original.api, get, post } };
});

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <MemoryRouter>{node}</MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>
);

const renderTab = () => {
  const customer = { id: 'c1', name: 'Maria', cpfCnpj: '52998224725' } as CustomerDetail;
  render(wrap(<CustomerCtx.Provider value={{ customer, refetch: () => {} }}><EcacTab /></CustomerCtx.Provider>));
};

describe('aba eCAC: textos do que o robô faz (COB-1, COB-6)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    panel = basePanel;
    overview = baseOverview;
    inbox = [];
    tokens = [];
    posts.length = 0;
  });

  it('mostra o PDF da situação fiscal e diz que a CND é lançada pelo escritório', async () => {
    renderTab();
    // declarações: o SERPRO não informa situação, malha nem lote
    expect(await screen.findByText(/Situação, malha e lote de restituição. O SERPRO Integra Contador não informa este dado/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Situação fiscal' }));
    expect(screen.getByText('Relatório de situação fiscal')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abrir relatório' })).toBeTruthy();
    // relatório sem leitura: "não interpretado", o PDF continua valendo
    expect(screen.getByText('Não interpretado')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'CND' }));
    expect(screen.getByText('A CND é lançada pelo escritório')).toBeTruthy();
    expect(screen.queryByText('Geração automática de CND desligada')).toBeNull();
  });

  it('mostra a leitura do relatório SITFIS: situação, pendências e certidão ao lado do PDF', async () => {
    panel = {
      ...basePanel,
      simplified: {
        ...basePanel.simplified!,
        status: 'pending',
        situation: 'Com pendências',
        message: 'O relatório lista pendências na Receita Federal ou na PGFN: confira os detalhes no PDF.',
        pendencies: ['Pendência - Débito (SIEF)', 'Pendência - Omissão de Declaração'],
        certificate: { type: 'Positiva com Efeitos de Negativa', code: 'A1B2.C3D4.E5F6.0789', issuedAt: '2026-03-15', validUntil: '2099-09-11' },
      },
    };
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: 'Situação fiscal' }));
    expect(screen.getByText('Com pendências')).toBeTruthy();
    expect(screen.getByText('Pendência - Débito (SIEF)')).toBeTruthy();
    expect(screen.getByText('Pendência - Omissão de Declaração')).toBeTruthy();
    expect(screen.getByText('Certidão Positiva com Efeitos de Negativa')).toBeTruthy();
    expect(screen.getByText(/A1B2\.C3D4\.E5F6\.0789/)).toBeTruthy();
    expect(screen.getByText(/válida até 11\/09\/2099/)).toBeTruthy();
    expect(screen.queryByText('Vencida')).toBeNull();
    expect(screen.getByRole('button', { name: 'Abrir relatório' })).toBeTruthy();
  });

  it('o robô mostra o que a sincronização faz e a próxima rodada automática', async () => {
    render(wrap(<RobotAdminTab />));
    expect(await screen.findByText(/Próxima sincronização automática:/)).toBeTruthy();
    expect(screen.getByText(/relatório de situação fiscal \(a cada 30 dias, com a leitura das pendências e da certidão vigente\)/)).toBeTruthy();
    expect(screen.getByText(/nem emite a CND de pessoa física/)).toBeTruthy();
  });

  it('outros registros: página registrada pela extensão com texto, endereço seguro e remoção', async () => {
    panel = {
      ...basePanel,
      others: [
        { id: 'o1', year: 2026, fileId: null, source: 'extension', fetchedAt: '2026-10-06T09:00:00Z', kind: 'other', data: { title: 'Consulta de restituição', text: 'Lote 3 de 2026', url: 'https://www.restituicao.receita.fazenda.gov.br/consulta' } },
        { id: 'o2', year: null, fileId: null, source: 'extension', fetchedAt: '2026-10-06T09:00:00Z', kind: 'other', data: { title: 'Endereço estranho', url: 'javascript:alert(1)' } },
        { id: 'o3', year: null, fileId: null, source: 'serpro', fetchedAt: '2026-10-06T09:00:00Z', kind: 'procuration', data: {} },
      ],
    };
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: 'Outros registros (3)' }));
    expect(screen.getByText('Consulta de restituição')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'www.restituicao.receita.fazenda.gov.br' }).getAttribute('rel')).toBe('noopener noreferrer');
    // só http(s) vira link
    expect(screen.getAllByRole('link').some((a) => (a.getAttribute('href') ?? '').startsWith('javascript:'))).toBe(false);
    // o card da procuração e a linha do histórico
    expect(screen.getAllByText('Procuração eletrônica')).toHaveLength(2);
    // a página da extensão e só ela pode ser removida; o registro do SERPRO fica
    expect(screen.getAllByRole('button', { name: 'Remover registro' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Ler o texto registrado' }));
    expect(await screen.findByText('Lote 3 de 2026')).toBeTruthy();
  });

  it('robô: arquivos sem cliente são atribuídos ao cliente sugerido e os tokens mostram a versão em uso', async () => {
    overview = { ...baseOverview, inboxPending: 1, activeTokens: 1 };
    inbox = [
      { id: 'i1', filename: '52998224725-IRPF-A-2026-2025-ORIGI.REC', originalPath: 'C:\\IRPF2026\\transmitidas', reason: 'cliente_nao_cadastrado', reasonLabel: 'CPF sem cliente cadastrado', cpf: '52998224725', exerciseYear: 2026, size: 2048, tokenName: 'Recepção', createdAt: '2026-10-06T09:00:00Z', suggestedCustomer: { id: 'c1', name: 'Maria' } },
    ];
    tokens = [
      { id: 't1', name: 'Recepção', scope: 'sync', prefix: 'vfk_abcd', createdByName: 'Ana', createdAt: '2026-10-01T09:00:00Z', lastUsedAt: '2026-10-06T09:00:00Z', lastUsedIp: null, revokedAt: null, active: true, clientVersion: '0.2.0', clientPlatform: 'win32' },
    ];
    render(wrap(<RobotAdminTab />));
    expect(await screen.findByText('Arquivos sem cliente')).toBeTruthy();
    expect(await screen.findByText('CPF sem cliente cadastrado')).toBeTruthy();
    expect(screen.getByText('Cadastrado: Maria')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Atualizar para 0.3.0' })).toBeTruthy();
    expect(screen.getByText(/Windows/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Atribuir' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Atribuir' }));
    await waitFor(() => expect(posts).toEqual([{ path: '/robot/inbox/i1/file', body: { customerId: 'c1', year: 2026 } }]));
  });

  it('robô: sem arquivos pendentes a caixa de entrada não aparece', async () => {
    render(wrap(<RobotAdminTab />));
    expect(await screen.findByText(/Próxima sincronização automática:/)).toBeTruthy();
    expect(screen.queryByText('Arquivos sem cliente')).toBeNull();
  });
});
