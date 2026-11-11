import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomersPage, filtersFromParams, filtersToParams, type CustomerListItem } from './CustomersPage';

/**
 * Lista de clientes: erro com "tentar de novo", "selecionar todos os N resultados" (exportação pelos
 * filtros, ações em massa pelos ids de todas as páginas), downloads com aviso de erro, ordem e
 * estado no endereço.
 */
const TOTAL = 60;
const GROUP = '11111111-1111-4111-8111-111111111111';
const customer = (i: number): CustomerListItem => ({
  id: `c${i}`,
  name: `Cliente ${String(i).padStart(2, '0')}`,
  cpfCnpj: '81363539302',
  email: null,
  mobile: null,
  notes: null,
  status: 'active',
  procurationStatus: 'none',
  cndStatus: 'not_requested',
  ecacMailboxMessages: 0,
  responsibleName: null,
  procuratorName: null,
  groups: [],
  declaration: null,
});

const state = vi.hoisted(() => ({
  fail: false,
  total: 60,
  get: [] as string[],
  post: [] as { path: string; body: any }[],
  downloads: [] as { path: string; body: any }[],
  downloadError: null as string | null,
}));

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    state.get.push(path);
    if (path.startsWith('/customers/facets')) {
      return { total: state.total, email: { with: 0, without: state.total }, status: { active: state.total, inactive: 0 }, procurator: { with: 0, without: state.total }, procurationStatus: {}, mailbox: 0, govbrRequired: 0, expiring: 0, cnd: {}, groups: [{ id: '11111111-1111-4111-8111-111111111111', name: 'VIP', n: 3 }], noGroup: 0, responsible: [] };
    }
    if (path.startsWith('/customers')) {
      if (state.fail) throw new original.ApiError(500, 'Erro interno do servidor.');
      const q = new URLSearchParams(path.split('?')[1] ?? '');
      const page = Number(q.get('page') ?? 1);
      const size = Number(q.get('pageSize') ?? 25);
      const all = Array.from({ length: state.total }, (_, i) => i + 1);
      return { data: all.slice((page - 1) * size, page * size).map(customer), total: state.total, page, pages: Math.max(1, Math.ceil(state.total / size)) };
    }
    return [];
  };
  const post = async (path: string, body: unknown) => {
    state.post.push({ path, body });
    return { ok: true, affected: (body as { ids: string[] }).ids.length };
  };
  const download = async (path: string, _name: string, body: unknown) => {
    state.downloads.push({ path, body });
    if (state.downloadError) throw new original.ApiError(400, state.downloadError);
  };
  return { ...original, api: { ...original.api, get, post, download } };
});

let location: ReturnType<typeof useLocation>;
function Spy() {
  location = useLocation();
  return null;
}

const renderPage = (entry = '/clientes') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Spy />
          <CustomersPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const listCalls = () => state.get.filter((p) => p.startsWith('/customers?'));
const query = (path: string) => Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? ''));
const action = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
  fireEvent.click(await screen.findByRole('menuitem', { name }));
};
const selectAllResults = async () => {
  fireEvent.click(await screen.findByLabelText('Selecionar todos da página'));
  fireEvent.click(screen.getByRole('button', { name: `Selecionar todos os ${TOTAL} resultados` }));
};

describe('lista de clientes: erro, seleção de todos e endereço', () => {
  beforeEach(() => {
    state.fail = false;
    state.total = TOTAL;
    state.get = [];
    state.post = [];
    state.downloads = [];
    state.downloadError = null;
  });
  afterEach(cleanup);

  it('falha ao carregar não vira "Nenhum cliente cadastrado": mostra o erro e "Tentar de novo" recarrega', async () => {
    state.fail = true;
    renderPage();
    expect(await screen.findByText('Não foi possível carregar os clientes')).toBeTruthy();
    expect(screen.getByText('Erro interno do servidor.')).toBeTruthy();
    expect(screen.queryByText('Nenhum cliente cadastrado')).toBeNull();
    expect(screen.queryByText('Nenhum cliente encontrado')).toBeNull();

    state.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Cliente 01')).toBeTruthy();
    expect(screen.queryByText('Não foi possível carregar os clientes')).toBeNull();
  });

  it('marcar a página oferece "Selecionar todos os N resultados"; a exportação vai pelos filtros, sem ids', async () => {
    renderPage(`/clientes?busca=cliente&etapa=filling,finished&grupos=${GROUP}&sem-grupo=1`);
    fireEvent.click(await screen.findByLabelText('Selecionar todos da página'));
    expect(screen.getByText('25 selecionado(s)')).toBeTruthy();
    expect(screen.getByText('Os 25 clientes desta página estão selecionados.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: `Selecionar todos os ${TOTAL} resultados` }));
    expect(screen.getByText(`${TOTAL} selecionado(s)`)).toBeTruthy();
    expect(screen.getByText(`Todos os ${TOTAL} clientes da busca e dos filtros estão selecionados.`)).toBeTruthy();

    await action('Exportar para Excel');
    await waitFor(() => expect(state.downloads).toHaveLength(1));
    expect(state.downloads[0].path).toBe('/customers/export');
    expect(state.downloads[0].body).toEqual({ filters: { search: 'cliente', year: expect.any(Number), stage: 'filling,finished', groups: GROUP, noGroup: true } });
    expect(state.downloads[0].body.ids).toBeUndefined();

    // "Limpar seleção" desfaz tudo
    fireEvent.click(screen.getByRole('button', { name: 'Limpar seleção' }));
    expect(screen.queryByText(/selecionado\(s\)/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Ações' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('seleção só da página continua exportando pelos ids', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText('Selecionar Cliente 02'));
    fireEvent.click(screen.getByLabelText('Selecionar Cliente 05'));
    await action('Exportar para Excel');
    await waitFor(() => expect(state.downloads).toHaveLength(1));
    expect(state.downloads[0].body).toEqual({ ids: ['c2', 'c5'], filters: { year: expect.any(Number) } });
  });

  it('ação em massa com todos os resultados: reúne os ids de todas as páginas com os mesmos filtros', async () => {
    renderPage('/clientes?situacao=active');
    await selectAllResults();
    state.get = [];
    await action('Ativar / inativar');
    const dialog = await screen.findByRole('dialog', { name: 'Ativar ou inativar' });
    fireEvent.change(within(dialog).getByLabelText('Situação'), { target: { value: 'inactive' } });
    fireEvent.click(within(dialog).getByRole('button', { name: `Aplicar a ${TOTAL} cliente(s)` }));

    await waitFor(() => expect(state.post).toHaveLength(1));
    expect(state.post[0].path).toBe('/customers/bulk');
    expect(state.post[0].body.action).toBe('status');
    expect(state.post[0].body.value).toBe('inactive');
    expect(state.post[0].body.ids).toHaveLength(TOTAL);
    expect(new Set(state.post[0].body.ids).size).toBe(TOTAL);
    // os ids vieram da própria listagem, com o filtro da tela e páginas de 500
    const idCalls = listCalls().filter((p) => query(p).pageSize === '500');
    expect(idCalls.map(query)).toEqual([expect.objectContaining({ status: 'active', page: '1', pageSize: '500' })]);
    expect(await screen.findByText(`${TOTAL} cliente(s) atualizado(s).`)).toBeTruthy();
    // depois da ação, a seleção é desfeita
    await waitFor(() => expect(screen.queryByText(/selecionado\(s\)/)).toBeNull());
  });

  it('desmarcar um cliente desfaz "todos os resultados" e mantém os outros da página', async () => {
    renderPage();
    await selectAllResults();
    fireEvent.click(screen.getByLabelText('Selecionar Cliente 03'));
    expect(screen.getByText('24 selecionado(s)')).toBeTruthy();
    expect(screen.queryByText(/Todos os 60 clientes/)).toBeNull();
    expect((screen.getByLabelText('Selecionar Cliente 03') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Selecionar Cliente 04') as HTMLInputElement).checked).toBe(true);
  });

  it('mais clientes do que a ação aceita: avisa em vez de enviar', async () => {
    state.total = 2001;
    renderPage();
    fireEvent.click(await screen.findByLabelText('Selecionar todos da página'));
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar todos os 2.001 resultados' }));
    await action('Imprimir etiquetas');
    expect(await screen.findByText('Esta ação aceita até 2.000 clientes por vez e a seleção tem 2.001. Refine a busca ou os filtros.')).toBeTruthy();
    expect(state.downloads).toEqual([]);
    // a exportação pelos filtros não tem esse limite
    await action('Exportar para Excel');
    await waitFor(() => expect(state.downloads).toHaveLength(1));
  });

  it('etiquetas e Excel que falham mostram o erro num aviso', async () => {
    state.downloadError = 'Nenhum cliente com endereço para as etiquetas.';
    renderPage();
    fireEvent.click(await screen.findByLabelText('Selecionar Cliente 01'));
    await action('Imprimir etiquetas');
    expect((await screen.findByRole('alert')).textContent).toContain('Nenhum cliente com endereço para as etiquetas.');
    expect(state.downloads[0]).toEqual({ path: '/customers/labels', body: { ids: ['c1'] } });

    fireEvent.click(screen.getByRole('button', { name: 'Dispensar aviso' }));
    state.downloadError = 'Falha ao montar a planilha.';
    await action('Exportar para Excel');
    expect((await screen.findByRole('alert')).textContent).toContain('Falha ao montar a planilha.');
  });

  it('busca, filtros, ordem e página vêm do endereço e vão para a API', async () => {
    renderPage(`/clientes?busca=maria&etapa=filling&grupos=${GROUP}&caixa-postal=1&ordem=cadastro&pagina=2`);
    await screen.findByText('Cliente 26');
    expect((screen.getByLabelText('Buscar') as HTMLInputElement).value).toBe('maria');
    expect((screen.getByLabelText('Ordenar por') as HTMLSelectElement).value).toBe('created');
    expect(screen.getByRole('button', { name: 'Filtros (3)' })).toBeTruthy();
    expect(query(listCalls().at(-1)!)).toMatchObject({ search: 'maria', stage: 'filling', groups: GROUP, mailbox: 'true', sort: 'created', page: '2', pageSize: '25' });
  });

  it('trocar a ordem, a página e os filtros atualiza o endereço (e volta à primeira página)', async () => {
    renderPage('/clientes?pagina=2');
    await screen.findByText('Cliente 26');

    fireEvent.change(screen.getByLabelText('Ordenar por'), { target: { value: 'updated' } });
    await waitFor(() => expect(location.search).toBe('?ordem=atualizacao'));
    await screen.findByText('Cliente 01');
    expect(query(listCalls().at(-1)!)).toMatchObject({ sort: 'updated', page: '1' });

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(location.search).toBe('?ordem=atualizacao&pagina=2'));

    fireEvent.click(screen.getByRole('button', { name: 'Filtros' }));
    fireEvent.click(await screen.findByLabelText('VIP (3)'));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }));
    await waitFor(() => expect(location.search).toBe(`?ordem=atualizacao&grupos=${GROUP}`));
    expect(query(listCalls().at(-1)!)).toMatchObject({ groups: GROUP, sort: 'updated', page: '1' });

    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => expect(location.search).toBe('?ordem=atualizacao'));
  });

  it('digitar na busca vai para o endereço depois da pausa, sem perder a ordem', async () => {
    renderPage('/clientes?ordem=cadastro&pagina=2');
    await screen.findByText('Cliente 26');
    fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'ana' } });
    await waitFor(() => expect(location.search).toBe('?ordem=cadastro&busca=ana'));
    expect(query(listCalls().at(-1)!)).toMatchObject({ search: 'ana', sort: 'created', page: '1' });
  });

  it('página além do fim (endereço antigo) vai para a última', async () => {
    renderPage('/clientes?pagina=99');
    await waitFor(() => expect(location.search).toBe('?pagina=3'));
    expect(await screen.findByText('Cliente 60')).toBeTruthy();
  });
});

describe('filtros no endereço', () => {
  it('ida e volta, ignorando valores desconhecidos', () => {
    const p = new URLSearchParams('responsavel=abc,22222222-2222-4222-8222-222222222222&email=with&situacao=talvez&etapa=filling,inventada&procuracao=valid,xyz&govbr=1&expirando=0&cnd=success');
    const f = filtersFromParams(p);
    expect(f).toMatchObject({ responsible: ['22222222-2222-4222-8222-222222222222'], email: 'with', status: '', stage: ['filling'], procurationStatus: ['valid'], govbrRequired: true, expiring: false, cnd: ['success'], mailbox: false, noGroup: false, groups: [] });
    const out = new URLSearchParams('busca=ana&situacao=talvez');
    filtersToParams(out, f);
    expect(out.toString()).toBe('busca=ana&responsavel=22222222-2222-4222-8222-222222222222&email=with&procuracao=valid&govbr=1&cnd=success&etapa=filling');
  });
});
