import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../ds';
import { CustomerCtx, type CustomerDetail } from '../customers/customerContext';
import { IrpfReportsStep, KitSendModal } from './IrpfReportsStep';

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, me: { favorites: [] }, refresh: async () => {} }),
}));

const MB = 1024 * 1024;
const option = (fileId: string, label: string, filename: string, size: number, suggested: boolean, source = 'document') => ({ fileId, source, label, filename, size, mimeType: 'application/pdf', suggested });
const OPTIONS = [
  option('f-rec', 'Recibo de entrega', 'recibo.pdf', 300 * 1024, true),
  option('f-dec', 'Declaração (.DEC)', 'declaracao.DEC', 200 * 1024, true),
  option('f-inf', 'Informe de rendimentos', 'informe-banco.pdf', 2 * MB, false),
  option('f-darf1', 'DARF · 1ª quota · paga', 'darf-1.pdf', 100 * 1024, false, 'darf'),
  option('f-darf2', 'DARF · 2ª quota · vence em 30/06/2026', 'darf-2.pdf', 100 * 1024, true, 'darf'),
  option('f-zip', 'Pacote de conferência da elaboração (.zip)', 'conferencia.zip', 19 * MB, false, 'export'),
];

let options = OPTIONS;
let calls: { url: string; method: string; body?: any }[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  options = OPTIONS;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.includes('/reports/declaration')) return json({ declarationId: 'd1' });
      if (url.endsWith('/kit/attachments')) return json({ options, maxBytes: 20 * MB });
      if (url.endsWith('/kit/send')) return json({ queued: 1, alreadyQueued: 0, skipped: [], attachments: [] });
      return json({
        declaration: { id: 'd1', exerciseYear: 2026, stage: 'transmitted', substatus: 'ecac_processed', taxation: 'complete', taxDueCents: 90_000, refundCents: 0, otherExpenses: {} },
        customer: { id: 'c1', name: 'Maria Souza', email: 'maria@ex.com', mobile: '11987654321' },
        itemsCount: 3,
        itemsByKind: [],
        spouse: { available: false, reason: 'Cônjuge não cadastrado como cliente.', name: null },
        reports: [],
        hasLogo: true,
        canEditOtherExpenses: false,
        canSendKit: true,
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <CustomerCtx.Provider value={{ customer: { id: 'c1', name: 'Maria Souza' } as CustomerDetail, refetch: () => {} }}>{ui}</CustomerCtx.Provider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const customer = { id: 'c1', name: 'Maria Souza', email: 'maria@ex.com' as string | null, mobile: '11987654321' as string | null };
const openModal = async (c = customer) => {
  const onClose = vi.fn();
  wrap(<KitSendModal declarationId="d1" customer={c} onClose={onClose} />);
  const dialog = await screen.findByRole('dialog');
  return { dialog, onClose };
};
const box = (dialog: HTMLElement, name: RegExp) => within(dialog).getByRole('checkbox', { name }) as HTMLInputElement;
const sent = () => calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/declarations/d1/kit/send'));

describe('kit pós-declaração: escolha dos anexos', () => {
  it('pela etapa Relatórios, "Enviar ao cliente" abre a escolha de canais e anexos', async () => {
    wrap(<IrpfReportsStep />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar ao cliente' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Enviar kit pós-declaração')).toBeTruthy();
    expect(await within(dialog).findByRole('group', { name: 'Documentos anexos no e-mail' })).toBeTruthy();
  });

  it('marca por padrão o recibo, a declaração e o DARF em aberto, e envia a escolha ajustada', async () => {
    const { dialog, onClose } = await openModal();
    await within(dialog).findByRole('group', { name: 'Documentos anexos no e-mail' });
    expect(box(dialog, /Recibo de entrega/).checked).toBe(true);
    expect(box(dialog, /Declaração \(\.DEC\)/).checked).toBe(true);
    expect(box(dialog, /2ª quota/).checked).toBe(true);
    expect(box(dialog, /1ª quota · paga/).checked).toBe(false);
    expect(box(dialog, /Informe de rendimentos/).checked).toBe(false);
    expect(box(dialog, /Pacote de conferência/).checked).toBe(false);
    expect(within(dialog).getByText(/3 anexo\(s\) · 600 KB/)).toBeTruthy();
    expect(within(dialog).getByText(/informe-banco\.pdf · 2,0 MB/)).toBeTruthy();

    fireEvent.click(box(dialog, /Declaração \(\.DEC\)/));
    fireEvent.click(box(dialog, /Informe de rendimentos/));
    expect(within(dialog).getByText(/3 anexo\(s\) · 2,4 MB/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(sent()).toBeTruthy());
    expect(sent()!.body.channels).toEqual(['email']);
    expect(sent()!.body.attachmentIds).toEqual(['f-rec', 'f-inf', 'f-darf2']);
    expect(sent()!.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('acima de 20 MB, avisa e não deixa enviar até desmarcar', async () => {
    const { dialog } = await openModal();
    await within(dialog).findByRole('group', { name: 'Documentos anexos no e-mail' });
    const send = within(dialog).getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(box(dialog, /Pacote de conferência/));
    fireEvent.click(box(dialog, /Informe de rendimentos/));
    expect(within(dialog).getByText('Os anexos escolhidos somam 21,6 MB e passam do limite de 20,0 MB do e-mail. Desmarque algum anexo.')).toBeTruthy();
    expect(send.disabled).toBe(true);
    fireEvent.click(box(dialog, /Informe de rendimentos/));
    expect(within(dialog).queryByText(/passam do limite/)).toBeNull();
    expect(send.disabled).toBe(false);
  });

  it('só pelo WhatsApp, os anexos ficam de fora e a tela explica', async () => {
    const { dialog } = await openModal();
    await within(dialog).findByRole('group', { name: 'Documentos anexos no e-mail' });
    fireEvent.click(box(dialog, /Por WhatsApp/));
    expect(within(dialog).getByText('Pelo WhatsApp vai só o resumo em PDF. Os documentos anexos vão no e-mail.')).toBeTruthy();
    fireEvent.click(box(dialog, /Por e-mail/));
    expect(box(dialog, /Recibo de entrega/).disabled).toBe(true);
    expect(box(dialog, /Recibo de entrega/).checked).toBe(false);
    expect(within(dialog).getByText(/Nenhum anexo escolhido/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(sent()).toBeTruthy());
    expect(sent()!.body).toMatchObject({ channels: ['whatsapp'], attachmentIds: [] });
  });

  it('sem arquivos guardados e sem contato, diz o que vai e não envia', async () => {
    options = [];
    const { dialog } = await openModal({ ...customer, email: null, mobile: null });
    expect(await within(dialog).findByText(/O kit vai só com o resumo/)).toBeTruthy();
    expect(box(dialog, /cliente sem e-mail cadastrado/).disabled).toBe(true);
    expect(box(dialog, /cliente sem celular cadastrado/).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
