import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { INTEGRATION_CATALOG } from '@verifco/shared';
import { ToastProvider } from '../../ds';
import { IntegrationsPage, type IntegrationView } from './IntegrationsPage';

const view = (provider: string, over: Partial<IntegrationView> = {}): IntegrationView => ({
  provider,
  label: INTEGRATION_CATALOG.find((d) => d.key === provider)!.label,
  saved: false,
  enabled: false,
  status: 'not_configured',
  lastError: null,
  lastTestAt: null,
  updatedAt: null,
  config: {},
  secrets: {},
  missing: [],
  webhookUrl: null,
  platformFallback: false,
  ...over,
});

let whatsapp: IntegrationView;
vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => (path === '/integrations' ? INTEGRATION_CATALOG.map((d) => (d.key === 'whatsapp' ? whatsapp : view(d.key))) : []);
  return { ...original, api: { ...original.api, get } };
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <IntegrationsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openWhatsApp() {
  const title = await screen.findByText('WhatsApp');
  const card = title.closest('.vf-int-card') as HTMLElement;
  fireEvent.click(within(card).getByRole('button', { name: /Configurar|Conectar/ }));
  return card;
}

describe('WhatsApp em Administração › Integrações (COB-8)', () => {
  afterEach(cleanup);

  it('na Meta, mostra a chave do app, o token de verificação, os modelos e onde cadastrar o webhook', async () => {
    whatsapp = view('whatsapp', {
      saved: true,
      enabled: true,
      status: 'connected',
      config: { mode: 'meta', phoneNumberId: '123', apiVersion: 'v25.0', templates: 'darf = aviso_darf | pt_BR | CLIENTE' },
      webhookUrl: 'http://localhost:3333/api/webhooks/whatsapp/abcdefghijklmnopqrstuvwx',
    });
    renderPage();
    const card = await openWhatsApp();
    expect(within(card).getByLabelText('Chave secreta do app (App Secret)')).toBeTruthy();
    expect(within(card).getByLabelText('Token de verificação do webhook')).toBeTruthy();
    const templates = within(card).getByLabelText('Modelos aprovados (fora da janela de 24 h)') as HTMLTextAreaElement;
    expect(templates.tagName).toBe('TEXTAREA');
    expect(templates.value).toBe('darf = aviso_darf | pt_BR | CLIENTE');
    expect(within(card).getByText('http://localhost:3333/api/webhooks/whatsapp/abcdefghijklmnopqrstuvwx')).toBeTruthy();
    expect(within(card).getByText(/Cadastre esta URL como webhook da instância na Evolution API ou como Callback URL do app na Meta/)).toBeTruthy();
    expect(within(card).queryByText(/webhook de cobranças/)).toBeNull();
  });

  it('integração salva antes do webhook ganha o botão para gerar a URL', async () => {
    whatsapp = view('whatsapp', { saved: true, enabled: true, status: 'connected', config: { mode: 'evolution', baseUrl: 'https://evo.exemplo.com.br', instance: 'x' } });
    renderPage();
    const card = await openWhatsApp();
    expect(within(card).getByRole('button', { name: /Gerar URL do webhook/ })).toBeTruthy();
    // modo Evolution: sem os campos da Meta
    expect(within(card).queryByLabelText('Modelos aprovados (fora da janela de 24 h)')).toBeNull();
  });
});
