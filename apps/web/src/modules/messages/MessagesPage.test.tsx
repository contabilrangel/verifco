import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { ToastProvider } from '../../ds';
import { MessagesPage, THREADS_PAGE_SIZE, threadTime } from './MessagesPage';
import { MessagesNavItem } from './NavItem';
import { module } from './module';
import type { Conversation, Thread } from './api';

/**
 * Caixa de mensagens do escritório: lista de conversas com busca, filtro e paginação (no servidor),
 * não lidas em destaque, abrir a conversa ao lado (marca como lida e atualiza os contadores),
 * anexos na conversa e o selo do menu.
 */
// folga para a suíte inteira rodando em paralelo (a busca ainda espera os 300 ms de digitação)
configure({ asyncUtilTimeout: 5000 });

const state = vi.hoisted(() => ({
  threads: [] as any[] | 'error',
  conversations: {} as Record<string, any>,
  countShape: 'ok' as 'ok' | 'broken',
  perms: ['customer.list', 'message.send'] as string[],
}));
const calls = vi.hoisted(() => ({ get: [] as string[], post: [] as string[], upload: [] as { path: string; files: File[]; fields: Record<string, string> }[], download: [] as { path: string; name: string }[] }));

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { user: { name: 'Ana Dona' }, favorites: [] }, can: (...p: string[]) => p.some((x) => state.perms.includes(x)), refresh: async () => {} }),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const list = () => (state.threads === 'error' ? [] : state.threads);
  return {
    ...original,
    api: {
      ...original.api,
      get: async (path: string) => {
        calls.get.push(path);
        if (path === '/messages/unread-count') {
          if (state.countShape === 'broken') return [];
          const unread = list().filter((t) => t.unread > 0);
          return { count: unread.reduce((n, t) => n + t.unread, 0), threads: unread.length };
        }
        if (path.startsWith('/messages/threads')) {
          if (state.threads === 'error') throw new original.ApiError(500, 'Erro interno do servidor.');
          const sp = new URLSearchParams(path.split('?')[1] ?? '');
          const term = (sp.get('q') ?? '').toLowerCase();
          const rows = list().filter((t) => (sp.get('filter') === 'unread' ? t.unread > 0 : true) && t.customer.name.toLowerCase().includes(term));
          const page = Number(sp.get('page') ?? 1);
          const pageSize = Number(sp.get('pageSize') ?? 25);
          return { data: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, pages: Math.max(1, Math.ceil(rows.length / pageSize)) };
        }
        const id = /^\/customers\/([^/]+)\/messages$/.exec(path)?.[1];
        if (id && state.conversations[id]) return state.conversations[id];
        throw new original.ApiError(404, 'Cliente não encontrado.');
      },
      post: async (path: string) => {
        calls.post.push(path);
        const id = /^\/customers\/([^/]+)\/messages\/read$/.exec(path)?.[1];
        if (id) {
          if (state.threads !== 'error') state.threads = state.threads.map((t) => (t.customer.id === id ? { ...t, unread: 0 } : t));
          state.conversations[id] = { ...state.conversations[id], unread: 0 };
        }
        return { ok: true };
      },
      upload: async (path: string, files: File[], fields: Record<string, string>) => {
        calls.upload.push({ path, files, fields });
        return { messages: [{ id: 'novo', direction: 'out', channel: 'portal', body: fields.body, createdAt: '2026-11-11T10:00:00Z', readAt: null, authorName: 'Ana Dona', deliveryStatus: null, attachments: [] }] };
      },
      download: async (path: string, name: string) => {
        calls.download.push({ path, name });
      },
    },
  };
});

const thread = (id: string, name: string, unread: number, last: Partial<Thread['lastMessage']> = {}): Thread => ({
  customer: { id, name },
  unread,
  lastMessage: { id: `m-${id}`, direction: 'in', channel: 'portal', preview: `Mensagem de ${name}`, authorName: name, createdAt: '2026-11-10T12:00:00Z', hasAttachments: false, ...last },
});

const conversation = (id: string, name: string, unread: number): Conversation => ({
  customer: { id, name },
  unread,
  portalEnabled: true,
  hasMobile: true,
  messages: [
    { id: 'm1', direction: 'out', channel: 'portal', body: 'Olá! Pode mandar o informe?', createdAt: '2026-11-10T11:00:00Z', readAt: '2026-11-10T11:30:00Z', authorName: 'Ana Dona', deliveryStatus: null, attachments: [] },
    {
      id: 'm2',
      direction: 'in',
      channel: 'portal',
      body: 'Segue o informe do banco.',
      createdAt: '2026-11-10T12:00:00Z',
      readAt: null,
      authorName: null,
      deliveryStatus: null,
      attachments: [{ fileId: 'f1', filename: 'informe.pdf', mimeType: 'application/pdf', size: 20_480 }],
    },
  ],
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

const renderAt = (path = '/mensagens') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/mensagens/:customerId?" element={<MessagesPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const rows = () => within(screen.getByRole('list', { name: 'Conversas' })).getAllByRole('link');
const threadCalls = () => calls.get.filter((p) => p.startsWith('/messages/threads'));
const lastThreadQuery = () => new URLSearchParams(threadCalls().at(-1)!.split('?')[1]);

describe('caixa de mensagens', () => {
  beforeEach(() => {
    state.threads = [
      thread('c1', 'Carla Dias', 2, { preview: 'Segue o informe do banco.', hasAttachments: true }),
      thread('c2', 'Bruno Costa', 0, { direction: 'out', authorName: 'Ana Dona', preview: 'Recebemos tudo.', channel: 'whatsapp' }),
      thread('c3', 'Ana Lima', 1),
    ];
    state.conversations = { c1: conversation('c1', 'Carla Dias', 1), c2: conversation('c2', 'Bruno Costa', 0) };
    state.countShape = 'ok';
    state.perms = ['customer.list', 'message.send'];
    calls.get = [];
    calls.post = [];
    calls.upload = [];
    calls.download = [];
  });
  afterEach(cleanup);

  it('o módulo registra /mensagens com a conversa opcional no endereço', () => {
    expect(module.routes?.map((r) => r.path)).toEqual(['mensagens/:customerId?']);
  });

  it('lista as conversas com a última mensagem e as não lidas em destaque', async () => {
    renderAt();
    expect(await screen.findByText('Carla Dias')).toBeTruthy();
    const [carla, bruno, ana] = rows();
    expect(carla.getAttribute('href')).toBe('/mensagens/c1');
    expect(carla.className).toContain('msg-thread--unread');
    expect(within(carla).getByText(/Segue o informe do banco\./)).toBeTruthy();
    expect(within(carla).getByLabelText('Com anexo')).toBeTruthy();
    expect(within(carla).getByTitle('2 mensagens não lidas').textContent).toBe('2 não lidas');
    // enviada pelo escritório: quem mandou na frente, sem selo
    expect(bruno.className).not.toContain('msg-thread--unread');
    expect(within(bruno).getByText('Ana: Recebemos tudo. · WhatsApp')).toBeTruthy();
    expect(within(bruno).queryByTitle(/não lida/)).toBeNull();
    expect(within(ana).getByTitle('1 mensagem não lida').textContent).toBe('1 não lida');
    // o número da aba é o de conversas com mensagem por ler
    expect(await screen.findByRole('tab', { name: 'Não lidas (2)' })).toBeTruthy();
    expect(lastThreadQuery().get('filter')).toBe('all');
    expect(lastThreadQuery().get('pageSize')).toBe(String(THREADS_PAGE_SIZE));
    // nada aberto ainda
    expect(screen.getByText('Escolha uma conversa')).toBeTruthy();
    expect(calls.post).toEqual([]);
  });

  it('filtra as não lidas e busca pelo servidor', async () => {
    renderAt();
    await screen.findByText('Bruno Costa');
    fireEvent.click(screen.getByRole('tab', { name: 'Não lidas (2)' }));
    await waitFor(() => expect(screen.queryByText('Bruno Costa')).toBeNull());
    expect(rows()).toHaveLength(2);
    expect(lastThreadQuery().get('filter')).toBe('unread');

    fireEvent.change(screen.getByLabelText('Buscar conversa'), { target: { value: '  ana ' } });
    await waitFor(() => expect(lastThreadQuery().get('q')).toBe('ana'));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByText('Ana Lima')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Buscar conversa'), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nenhuma conversa encontrada')).toBeTruthy();
    expect(screen.getByText('Nenhum cliente com conversa corresponde a “zzz” entre as não lidas.')).toBeTruthy();

    // sem busca e sem nada por ler, o vazio diz isso (não "nenhuma conversa")
    state.threads = (state.threads as Thread[]).map((t) => ({ ...t, unread: 0 }));
    fireEvent.change(screen.getByLabelText('Buscar conversa'), { target: { value: '' } });
    expect(await screen.findByText('Nenhuma mensagem por ler')).toBeTruthy();
  });

  it('pagina no servidor e volta à primeira página ao trocar o filtro', async () => {
    state.threads = Array.from({ length: THREADS_PAGE_SIZE + 3 }, (_, i) => thread(`p${i + 1}`, `Cliente ${String(i + 1).padStart(2, '0')}`, i === 0 ? 1 : 0));
    renderAt();
    expect(await screen.findByText('Cliente 01')).toBeTruthy();
    expect(rows()).toHaveLength(THREADS_PAGE_SIZE);
    expect(screen.getByText(`${THREADS_PAGE_SIZE + 3} registro(s)`)).toBeTruthy();
    expect(screen.getByText('1 de 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(await screen.findByText(`Cliente ${THREADS_PAGE_SIZE + 1}`)).toBeTruthy();
    expect(rows()).toHaveLength(3);
    expect(lastThreadQuery().get('page')).toBe('2');

    fireEvent.click(screen.getByRole('tab', { name: 'Não lidas (1)' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(lastThreadQuery().get('page')).toBe('1');
    // uma página só: sem paginação
    expect(screen.queryByRole('button', { name: 'Próxima página' })).toBeNull();
  });

  it('clicar abre a conversa ao lado, marca como lida e atualiza os contadores', async () => {
    renderAt();
    fireEvent.click((await screen.findByText('Carla Dias')).closest('a')!);
    expect(screen.getAllByTestId('where')[0].textContent).toBe('/mensagens/c1');

    // a conversa abre com o nome do cliente, sem perder a lista
    expect(await screen.findByRole('heading', { name: 'Carla Dias' })).toBeTruthy();
    expect(screen.getByText('Olá! Pode mandar o informe?')).toBeTruthy();
    expect((screen.getByRole('link', { name: 'Abrir cliente' }) as HTMLAnchorElement).getAttribute('href')).toBe('/clientes/c1');
    expect(screen.getByRole('link', { name: 'Voltar às conversas' }).getAttribute('href')).toBe('/mensagens');
    expect(rows()).toHaveLength(3);
    expect(rows()[0].getAttribute('aria-current')).toBe('true');

    await waitFor(() => expect(calls.post).toEqual(['/customers/c1/messages/read']));
    // a linha perde o destaque e a aba passa a contar só a outra conversa
    await waitFor(() => expect(rows()[0].className).not.toContain('msg-thread--unread'));
    expect(await screen.findByRole('tab', { name: 'Não lidas (1)' })).toBeTruthy();
    // lida uma vez só: as atualizações seguintes não repetem o POST
    expect(calls.post).toHaveLength(1);
  });

  it('abre direto pelo endereço e a conversa lida não marca nada', async () => {
    renderAt('/mensagens/c2');
    expect(await screen.findByRole('heading', { name: 'Bruno Costa' })).toBeTruthy();
    expect(screen.queryByText('Escolha uma conversa')).toBeNull();
    expect(calls.post).toEqual([]);
  });

  it('na conversa: baixa o anexo com a sessão do painel e envia mensagem com arquivo', async () => {
    renderAt('/mensagens/c1');
    fireEvent.click(await screen.findByRole('button', { name: 'Baixar informe.pdf (20 KB)' }));
    await waitFor(() => expect(calls.download).toEqual([{ path: '/customers/c1/messages/m2/attachments/f1', name: 'informe.pdf' }]));

    const file = new File(['%PDF-1.4'], 'guia.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Anexar arquivos'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Segue a guia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(calls.upload).toHaveLength(1));
    expect(calls.upload[0].path).toBe('/customers/c1/messages');
    expect(calls.upload[0].files.map((f) => f.name)).toEqual(['guia.pdf']);
    expect(calls.upload[0].fields).toEqual({ body: 'Segue a guia', whatsapp: 'false' });
    expect(await screen.findByText('Mensagem enviada.')).toBeTruthy();
  });

  it('quem só lê não vê a caixa de envio', async () => {
    state.perms = ['customer.list'];
    renderAt('/mensagens/c1');
    expect(await screen.findByText('Seu perfil pode ler, mas não enviar mensagens.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Anexar' })).toBeNull();
  });

  it('cliente fora do alcance: a conversa avisa e a lista continua', async () => {
    renderAt('/mensagens/desconhecido');
    expect(await screen.findByText('Cliente não encontrado.')).toBeTruthy();
    expect(await screen.findByText('Carla Dias')).toBeTruthy();
  });

  it('erro ao carregar não vira "nenhuma conversa" e deixa tentar de novo', async () => {
    state.threads = 'error';
    renderAt();
    expect(await screen.findByText('Não foi possível carregar as conversas')).toBeTruthy();
    expect(screen.getByText('Erro interno do servidor.')).toBeTruthy();
    expect(screen.queryByText('Nenhuma conversa ainda')).toBeNull();

    state.threads = [thread('c1', 'Carla Dias', 0)];
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Carla Dias')).toBeTruthy();
  });

  it('sem conversas, explica por onde começar', async () => {
    state.threads = [];
    renderAt();
    expect(await screen.findByText('Nenhuma conversa ainda')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Não lidas' })).toBeTruthy();
  });

  it('sem a permissão de ver clientes, a rota mostra "sem permissão" e não consulta a API', async () => {
    state.perms = [];
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/mensagens']}>
            <Routes>
              <Route path="/mensagens/:customerId?" element={module.routes![0].element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Sem permissão para esta página')).toBeTruthy();
    expect(calls.get).toEqual([]);
  });
});

describe('item do menu', () => {
  beforeEach(() => {
    state.countShape = 'ok';
    calls.get = [];
  });
  afterEach(cleanup);

  const renderNav = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/kanban']}>
          <MessagesNavItem />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('mostra o número de mensagens não lidas e leva a /mensagens', async () => {
    state.threads = [thread('c1', 'Carla Dias', 2), thread('c3', 'Ana Lima', 1), thread('c2', 'Bruno Costa', 0)];
    renderNav();
    const link = screen.getByRole('link', { name: /Mensagens/ });
    expect(link.getAttribute('href')).toBe('/mensagens');
    await waitFor(() => expect(link.textContent).toBe('Mensagens3 não lidas'));
    expect(calls.get).toEqual(['/messages/unread-count']);
  });

  it('sem não lidas (ou com resposta fora do formato) não mostra selo', async () => {
    state.threads = [thread('c2', 'Bruno Costa', 0)];
    renderNav();
    await waitFor(() => expect(calls.get).toEqual(['/messages/unread-count']));
    expect(screen.getByRole('link', { name: 'Mensagens' }).textContent).toBe('Mensagens');
    cleanup();

    state.countShape = 'broken';
    state.threads = [thread('c1', 'Carla Dias', 2)];
    renderNav();
    await waitFor(() => expect(calls.get).toHaveLength(2));
    expect(screen.getByRole('link', { name: 'Mensagens' }).textContent).toBe('Mensagens');
  });
});

describe('hora da última mensagem', () => {
  it('hoje mostra a hora; ontem, "Ontem"; antes, a data (sempre no horário de Brasília)', () => {
    // 15h de Brasília de 11/11/2026 (UTC-3)
    const now = new Date('2026-11-11T18:00:00Z');
    expect(threadTime('2026-11-11T12:05:00Z', now)).toBe('09:05');
    // 23h de Brasília do dia 10 já é dia 11 em UTC: continua "Ontem"
    expect(threadTime('2026-11-11T02:00:00Z', now)).toBe('Ontem');
    expect(threadTime('2026-10-03T11:00:00Z', now)).toBe('03/10');
    expect(threadTime('2025-12-30T11:00:00Z', now)).toBe('30/12/25');
    expect(threadTime('', now)).toBe('');
  });
});
