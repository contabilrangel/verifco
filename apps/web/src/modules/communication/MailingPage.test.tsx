import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { MAILING_TYPES } from '@verifco/shared';
import { ToastProvider } from '../../ds';
import { MailingPage } from './MailingPage';

/**
 * DAD-5: a mala direta é preparada na fila de tarefas. A tela avisa quando a seleção passa do
 * limite de destinatários e acompanha o pedido até o resumo final.
 */
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

const CUSTOMER = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
const planned = { customers: 5000, deliveries: { email: 5000, whatsapp: 0, total: 5000 }, skipped: [], truncated: true, matched: 5200 };
const polls: object[] = [
  { requestId: 'r1', status: 'running', progress: 40, error: null, ...planned, result: null, attachments: null },
  { requestId: 'r1', status: 'done', progress: 100, error: null, ...planned, result: { queued: 5000, alreadyQueued: 0, failed: [] }, attachments: null },
];
const sent: unknown[] = [];
/**
 * A primeira consulta do andamento só responde quando o teste libera: antes dela a tela mostra o
 * pedido devolvido pelo envio (0%); sem a trava, a barra podia ser lida antes ou depois da
 * resposta, conforme a carga da máquina.
 */
let releaseFirstPoll: () => void = () => {};
const firstPoll = new Promise<void>((resolve) => {
  releaseFirstPoll = resolve;
});

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path === '/mailing/types') return MAILING_TYPES.map((t) => ({ ...t, allowed: true }));
    if (path === '/mailing/requests/r1') {
      await firstPoll;
      return polls.length > 1 ? polls.shift() : polls[0];
    }
    return [];
  };
  const post = async (path: string, body: unknown) => {
    if (path === '/mailing/preview') {
      return {
        type: { key: 'marketing', label: 'Marketing', templateKey: 'marketing', note: null, attachment: null },
        total: 5000,
        withEmail: 5000,
        withoutEmail: 0,
        withMobile: 0,
        withoutMobile: 5000,
        customers: 5000,
        deliveries: planned.deliveries,
        skipped: [],
        truncated: true,
        matched: 5200,
        limit: 5000,
        recipients: [{ id: CUSTOMER, name: 'Ana Lima', email: 'ana@ex.com', mobile: null, channels: ['email'], skips: [], stage: 'not_started' }],
        sample: { customerId: CUSTOMER, customerName: 'Ana Lima', email: 'ana@ex.com', mobile: null, subject: 'Novidade', html: '<p>Olá</p>', text: 'Olá', attachment: null },
      };
    }
    if (path === '/mailing/send') {
      sent.push(body);
      return { requestId: 'r1', status: 'queued', progress: 0, error: null, ...planned, result: null, attachments: null, repeated: false };
    }
    throw new Error(`rota inesperada: ${path}`);
  };
  return { ...original, api: { ...original.api, get, post } };
});

afterEach(cleanup);

describe('MailingPage: envio pela fila e aviso de limite (DAD-5)', () => {
  it('avisa o corte acima do limite e acompanha o pedido até o resumo', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/comunicacao/mala-direta?tipo=marketing&clientes=${CUSTOMER}`]}>
            <MailingPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/A seleção tem 5\.200 clientes, mais que o limite de 5\.000 por envio/)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /Enviar para 5000 cliente/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Outros 200 cliente\(s\) da seleção ficam de fora pelo limite de 5\.000 por envio/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar agora' }));

    expect(await screen.findByText('Preparando os envios...')).toBeTruthy();
    expect(sent).toHaveLength(1);
    // antes da primeira consulta: o pedido como o envio devolveu
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    releaseFirstPoll();
    // a consulta do andamento atualiza a barra (a seguinte, 1,5 s depois, traz o resumo)
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40'));
    expect(await screen.findByText('5.000 envio(s) na fila para 5.000 cliente(s)', undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText(/refine os filtros e faça outro envio para os demais/)).toBeTruthy();
    // a segunda consulta só sai depois do intervalo de 1,5 s: folga para máquinas carregadas
  }, 15_000);
});
