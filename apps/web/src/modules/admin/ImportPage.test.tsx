import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../../ds';
import { NAV } from '../../app/nav';
import { ImportPage } from './ImportPage';
import { PreferencesTab } from './PreferencesTab';

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

const settings = {
  restrictCustomersToResponsible: false,
  autoSendDarfEmail: false,
  notifyMainEmailOnEcacChanges: false,
  simplifiedQueryWithoutProcurator: true,
  autoGenerateCnd: true,
  receiptTwoCopies: false,
  receiptShowDetails: false,
  authorizationShowDetails: false,
  allowAuthorizationWithoutBudget: false,
  cashAnalysisSimplifiedDiscount: 'standard',
  checklistReadOnlyAfterStart: false,
  lockChecklistFromSubstatus: null,
  highNetWorthBaseCents: 0,
  reportTitleColor: '#112233',
  reportSubtitleColor: '#445566',
  reportLineColor: '#778899',
  whatsappServiceNumber: '',
};

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path === '/office') return { id: 'o1', name: 'Escritório', cpfCnpj: null, email: null, phone: null, website: null, city: null, state: null, logoFileId: null, settings };
    return { data: [], total: 0, page: 1, pages: 1 };
  };
  return { ...original, api: { ...original.api, get } };
});

function renderAt(path: string, element: React.ReactNode, route = '*') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={element} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Login INSS em lote removido (COB-7)', () => {
  afterEach(cleanup);

  it('o menu não oferece mais a importação e o endereço antigo explica o motivo', () => {
    const links = NAV.flatMap((g) => g.children ?? []);
    expect(links.some((l) => l.to === '/importacoes/inss')).toBe(false);
    expect(links.some((l) => l.to === '/importacoes/ecac')).toBe(true);

    renderAt('/importacoes/inss', <ImportPage />, '/importacoes/:tipo');
    expect(screen.getByText('Importação removida: o Verifco não guarda mais a senha do INSS')).toBeTruthy();
    expect(screen.getByText(/apagou as senhas que estavam guardadas/)).toBeTruthy();
    // nada de envio de planilha nesta página
    expect(screen.queryByText('Baixe o modelo')).toBeNull();
  });
});

describe('Preferências do robô (COB-6, INT-16)', () => {
  afterEach(cleanup);

  it('não oferece CND automática nem consulta sem procurador e explica o que o robô faz', async () => {
    renderAt('/admin/preferencias', <PreferencesTab />);
    expect(await screen.findByText(/o robô consulta os clientes ativos com procurador quando você pede e na sincronização automática/)).toBeTruthy();
    expect(screen.getByText(/Não estão disponíveis: emissão automática da CND de pessoa física/)).toBeTruthy();
    expect(screen.queryByText('Emitir a certidão negativa (CND) automaticamente')).toBeNull();
    expect(screen.queryByText('Pedir consulta simplificada para clientes sem procurador')).toBeNull();
    // a DARF automática vale quando o PDF é anexado (não há robô que obtenha a guia)
    expect(screen.getByText('Quando o PDF da guia da quota é anexado na etapa DARF do IRPF.')).toBeTruthy();
  });
});
