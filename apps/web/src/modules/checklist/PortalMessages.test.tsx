import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../../ds';
import { PortalLayout, PortalMessages } from './Portal';

/** Chat do portal: o cliente anexa arquivos à mensagem e baixa os anexos da conversa com o próprio acesso. */
const token = `x.${btoa(JSON.stringify({ sub: 'c1' }))}.y`;
const me = { customer: { name: 'Maria Cliente', firstName: 'Maria', cpf: '***', email: null }, office: { name: 'Escritório Modelo', email: null, phone: null, whatsapp: null } };
const overview = { exerciseYear: 2026, declarations: [], pendencies: [], checklist: null, darfs: [], documents: [], unreadMessages: 0 };
const received = {
  id: 'm1',
  direction: 'out',
  channel: 'portal',
  body: 'Segue o recibo.',
  createdAt: '2026-11-10T12:00:00Z',
  readAt: '2026-11-10T12:10:00Z',
  fromMe: false,
  attachments: [{ fileId: 'f1', filename: 'recibo.pdf', mimeType: 'application/pdf', size: 20_480 }],
};

let calls: { path: string; method: string; headers: Record<string, string>; json?: unknown; form?: { body: FormDataEntryValue | null; files: string[] } }[] = [];
let failUpload: { status: number; error: string } | null = null;

beforeEach(() => {
  calls = [];
  failUpload = null;
  sessionStorage.setItem('verifco.portal', JSON.stringify({ token, firstName: 'Maria', officeName: 'Escritório Modelo' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = url.replace(/^.*\/api/, '');
      const form = init?.body instanceof FormData ? init.body : null;
      calls.push({
        path,
        method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        json: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        form: form ? { body: form.get('body'), files: form.getAll('file').map((f) => (f as File).name) } : undefined,
      });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (path.startsWith('/portal/messages/m1/attachments/')) return new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } });
      if (path === '/portal/messages' && method === 'POST') {
        if (failUpload) return json({ error: failUpload.error }, failUpload.status);
        const sent = { id: 'm2', direction: 'in', channel: 'portal', body: form ? String(form.get('body') ?? '') : '', createdAt: '2026-11-10T13:00:00Z', readAt: null, fromMe: true, attachments: form ? [{ fileId: 'f2', filename: 'informe.pdf', mimeType: 'application/pdf', size: 8 }] : [] };
        return json({ officeName: 'Escritório Modelo', messages: [received, sent], unread: 0 }, 201);
      }
      if (path === '/portal/messages') return json({ officeName: 'Escritório Modelo', messages: [received], unread: 0 });
      return json(path === '/portal/overview' ? overview : path === '/portal/me' ? me : {});
    }),
  );
  URL.createObjectURL = vi.fn(() => 'blob:anexo');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

/** Abre o chat e espera a conversa (com folga: o primeiro teste também carrega o portal). */
async function open() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/portal/mensagens']}>
          <Routes>
            <Route path="/portal" element={<PortalLayout />}>
              <Route path="mensagens" element={<PortalMessages />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('Segue o recibo.', {}, { timeout: 5000 });
}

describe('Portal do cliente: mensagens com anexos', () => {
  it('baixa o anexo da conversa com o token do portal', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Baixar recibo.pdf (20 KB)' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const got = calls.find((c) => c.path === '/portal/messages/m1/attachments/f1')!;
    expect(got.method).toBe('GET');
    expect(got.headers.Authorization).toBe(`Bearer ${token}`);
    click.mockRestore();
  });

  it('envia o texto com o arquivo em formulário e mostra o anexo enviado', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Anexar arquivos'), { target: { files: [new File(['%PDF-1.4'], 'informe.pdf', { type: 'application/pdf' })] } });
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Meu informe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByText('Mensagem enviada ao escritório.')).toBeTruthy();
    const sent = calls.find((c) => c.path === '/portal/messages' && c.method === 'POST')!;
    expect(sent.form).toEqual({ body: 'Meu informe', files: ['informe.pdf'] });
    // o navegador define o Content-Type do formulário (com o boundary)
    expect(sent.headers['Content-Type']).toBeUndefined();
    expect(sent.headers.Authorization).toBe(`Bearer ${token}`);
    expect(await screen.findByRole('button', { name: 'Baixar informe.pdf (8 B)' })).toBeTruthy();
    // o portal não oferece WhatsApp
    expect(screen.queryByLabelText('Enviar também por WhatsApp')).toBeNull();
  });

  it('só texto continua indo em JSON', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Obrigada!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/portal/messages' && c.method === 'POST')?.json).toEqual({ body: 'Obrigada!' }));
  });

  it('recusa da API aparece para o cliente e o arquivo continua escolhido', async () => {
    failUpload = { status: 413, error: 'O arquivo “informe.pdf” passa de 10 MB. Envie um arquivo menor.' };
    await open();
    fireEvent.change(screen.getByLabelText('Anexar arquivos'), { target: { files: [new File(['%PDF-1.4'], 'informe.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('O arquivo “informe.pdf” passa de 10 MB. Envie um arquivo menor.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remover informe.pdf' })).toBeTruthy();
  });
});
