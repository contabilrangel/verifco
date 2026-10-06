import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { DeliveriesPage } from './DeliveriesPage';

/** DAD-4: reenvio em massa dos envios que falharam, com confirmação e só para quem pode enviar. */
let permissions: string[] = [];
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ me: { favorites: [] }, refresh: async () => {}, can: (...p: string[]) => p.some((x) => permissions.includes(x)) }),
}));

const row = {
  id: 'd1',
  customerId: null,
  customerName: null,
  channel: 'email',
  templateKey: null,
  subject: 'Aviso importante',
  toAddress: 'cliente@exemplo.com',
  toName: 'Cliente',
  status: 'failed',
  error: 'Caixa cheia',
  attachments: 0,
  sentAt: null,
  createdAt: '2026-04-01T10:00:00Z',
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
let posts: { url: string; body: unknown }[] = [];

beforeEach(() => {
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
        return json({ queued: 2 });
      }
      return json({ data: [row], total: 1, page: 1, pageSize: 25, pages: 1, failedCount: 2 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAs(perms: string[]) {
  permissions = perms;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <DeliveriesPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('DeliveriesPage: reenvio em massa (DAD-4)', () => {
  it('reenvia os que falharam depois de confirmar', async () => {
    renderAs(['mailing.list', 'mailing.send_marketing']);
    fireEvent.click(await screen.findByRole('button', { name: 'Reenviar com falha (2)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2 envio\(s\) com falha voltam para a fila/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reenviar' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toMatch(/\/api\/deliveries\/resend-failed$/);
    expect(posts[0].body).toEqual({});
  });

  it('só consulta (mailing.list) não vê o reenvio em massa', async () => {
    renderAs(['mailing.list']);
    await screen.findByText('Aviso importante');
    expect(screen.queryByRole('button', { name: /Reenviar com falha/ })).toBeNull();
  });
});
