import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { MAILING_TYPES } from '@verifco/shared';
import { ToastProvider } from '../../ds';
import { MailingPage, scheduleToIso } from './MailingPage';

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
/** Pedido agendado (r2): o servidor devolve "agendada" até o cancelamento. */
const scheduled = { canceled: false, cancelCalls: 0 };
const scheduledRequest = (runAt: string) => ({
  requestId: 'r2',
  jobId: 'j2',
  type: 'marketing',
  channel: 'email',
  year: 2026,
  status: scheduled.canceled ? 'canceled' : 'scheduled',
  scheduledFor: runAt,
  canceledAt: scheduled.canceled ? new Date().toISOString() : null,
  progress: 0,
  error: null,
  ...planned,
  result: null,
  attachments: null,
});
let scheduledFor = '';
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
    if (path === '/mailing/requests/r2') return scheduledRequest(scheduledFor);
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
    if (path === '/mailing/runs/j2/cancel') {
      scheduled.cancelCalls += 1;
      scheduled.canceled = true;
      return scheduledRequest(scheduledFor);
    }
    if (path === '/mailing/send') {
      sent.push(body);
      const runAt = (body as { runAt?: string }).runAt;
      if (runAt) {
        scheduledFor = new Date(runAt).toISOString();
        return { ...scheduledRequest(scheduledFor), repeated: false };
      }
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

describe('MailingPage: agendar o envio', () => {
  /** Valor de um campo datetime-local daqui a `hours` horas, no horário de Brasília. */
  const local = (hours: number) => new Date(Date.now() + hours * 3600_000 - 3 * 3600_000).toISOString().slice(0, 16);

  it('converte a data e a hora do campo (horário de Brasília) em ISO com fuso', () => {
    expect(scheduleToIso('2026-11-12T09:00')).toBe('2026-11-12T09:00:00-03:00');
    expect(new Date(scheduleToIso('2026-11-12T09:00')).toISOString()).toBe('2026-11-12T12:00:00.000Z');
    expect(scheduleToIso('')).toBe('');
    expect(scheduleToIso('12/11/2026 09:00')).toBe('');
  });

  it('agenda com data e hora no futuro, mostra "Agendado para" e permite cancelar', async () => {
    sent.length = 0;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/comunicacao/mala-direta?tipo=marketing&clientes=${CUSTOMER}`]}>
            <MailingPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    // por padrão o envio é imediato
    expect(await screen.findByRole('button', { name: /Enviar para 5000 cliente/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Enviar agora/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText(/Data e hora do envio/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Agendar/ }));
    const field = screen.getByLabelText(/Data e hora do envio \(horário de Brasília\)/) as HTMLInputElement;
    expect(field.type).toBe('datetime-local');
    // sem data, ou com data que já passou ou além de 60 dias, não dá para agendar
    const submit = () => screen.getByRole('button', { name: /Agendar para 5000 cliente/ }) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    fireEvent.change(field, { target: { value: local(-2) } });
    expect(screen.getByText('Escolha uma data e hora no futuro.')).toBeTruthy();
    expect(submit().disabled).toBe(true);
    fireEvent.change(field, { target: { value: local(61 * 24) } });
    expect(screen.getByText('O agendamento pode ser feito para até 60 dias à frente.')).toBeTruthy();
    expect(submit().disabled).toBe(true);

    const when = local(26);
    fireEvent.change(field, { target: { value: when } });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Confirmar agendamento')).toBeTruthy();
    expect(within(dialog).getByText(/Agendado para \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(horário de Brasília\)/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar' }));

    // o pedido leva o horário com o fuso de Brasília
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0] as { runAt: string }).runAt).toBe(`${when}:00-03:00`);
    const [date, time] = when.split('T');
    const shown = `Agendado para ${date.split('-').reverse().join('/')} ${time}`;
    expect(await screen.findByText(shown)).toBeTruthy();
    // nada está sendo preparado ainda
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText(/Os destinatários são calculados de novo na hora do envio/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar agendamento' }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Sim, cancelar o agendamento' }));
    expect(await screen.findByText('Agendamento cancelado')).toBeTruthy();
    expect(scheduled.cancelCalls).toBe(1);
  }, 15_000);
});
