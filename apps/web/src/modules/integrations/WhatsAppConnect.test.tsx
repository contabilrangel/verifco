import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../ds';
import { ApiError } from '../../lib/api';
import { WhatsAppConnect, formatWhatsAppNumber, type WhatsAppConnectionView } from './WhatsAppConnect';

const connection = (over: Partial<WhatsAppConnectionView> = {}): WhatsAppConnectionView => ({ state: 'close', number: null, profileName: null, qrImage: null, qrCode: null, pairingCode: null, ...over });
const QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Respostas da API simulada: `states` é a fila do GET (a última se repete); `connects`, a do POST. */
const server = { states: [] as (WhatsAppConnectionView | Error)[], connects: [] as (WhatsAppConnectionView | Error)[], gets: 0, posts: 0, bodies: [] as unknown[] };
const next = (queue: (WhatsAppConnectionView | Error)[]) => {
  const r = queue.length > 1 ? queue.shift()! : queue[0];
  if (r instanceof Error) throw r;
  return r;
};
vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    expect(path).toBe('/integrations/whatsapp/connection');
    server.gets += 1;
    return next(server.states);
  };
  const post = async (path: string, body: unknown) => {
    expect(path).toBe('/integrations/whatsapp/connect');
    server.posts += 1;
    server.bodies.push(body);
    return next(server.connects);
  };
  return { ...original, api: { ...original.api, get, post } };
});

function renderBlock(props: Partial<Parameters<typeof WhatsAppConnect>[0]> = {}) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <WhatsAppConnect ready pollMs={15} qrRefreshMs={40} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('bloco Conectar do WhatsApp (Evolution API)', () => {
  beforeEach(() => {
    Object.assign(server, { states: [connection()], connects: [connection({ state: 'connecting', qrImage: QR, qrCode: '2@abc', pairingCode: 'WZYEH1YY' })], gets: 0, posts: 0, bodies: [] });
  });
  afterEach(cleanup);

  it('mostra o QR Code, consulta o estado até conectar e mostra o número', async () => {
    server.states = [connection(), connection({ state: 'connecting' }), connection({ state: 'connecting' }), connection({ state: 'open', number: '5511987654321', profileName: 'Escritório Teste' })];
    renderBlock();
    expect(await screen.findByText('Desconectado')).toBeTruthy();
    expect(server.gets).toBe(1);
    expect(server.posts).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    const img = (await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' })) as HTMLImageElement;
    expect(img.src).toBe(QR);
    expect(screen.getByText('WZYEH1YY')).toBeTruthy();
    expect(screen.getByText(/Dispositivos conectados › Conectar dispositivo/)).toBeTruthy();
    expect(screen.getByText(/Aguardando a leitura do QR Code/)).toBeTruthy();

    // o estado é consultado sozinho; ao conectar, o QR Code some e aparece o número
    await waitFor(() => expect(screen.getByText('+55 (11) 98765-4321')).toBeTruthy());
    expect(screen.getByText(/Conectado como/).textContent).toBe('Conectado como +55 (11) 98765-4321 (Escritório Teste)');
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conectar' })).toBeNull();
    expect(await screen.findByText('WhatsApp conectado.')).toBeTruthy();
    // conectado, a tela para de consultar
    const polled = server.gets;
    expect(polled).toBeGreaterThanOrEqual(4);
    await new Promise((r) => setTimeout(r, 80));
    expect(server.gets).toBe(polled);
  });

  it('instância já conectada: mostra o número sem oferecer o QR Code', async () => {
    server.states = [connection({ state: 'open', number: '5511987654321' })];
    renderBlock();
    expect((await screen.findByText(/Conectado como/)).textContent).toBe('Conectado como +55 (11) 98765-4321');
    expect(screen.queryByRole('button', { name: 'Conectar' })).toBeNull();
    cleanup();
    // sem o número informado pela instância
    server.states = [connection({ state: 'open' })];
    renderBlock();
    expect(await screen.findByText('A instância está conectada ao WhatsApp.')).toBeTruthy();
  });

  it('busca o QR Code da vez enquanto ninguém lê e desiste depois de um tempo', async () => {
    renderBlock({ qrRefreshMs: 10 });
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar' }));
    await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' });
    expect(await screen.findByText(/O QR Code não foi lido a tempo/, undefined, { timeout: 3000 })).toBeTruthy();
    // o primeiro pedido e as seis trocas (só o pedido vai para a auditoria)
    expect(server.posts).toBe(7);
    expect(server.bodies).toEqual([{ refresh: false }, ...Array(6).fill({ refresh: true })]);
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).toBeNull();
    // a tela para de consultar e oferece gerar outro
    const polled = server.gets;
    await new Promise((r) => setTimeout(r, 60));
    expect(server.gets).toBe(polled);
    fireEvent.click(screen.getByRole('button', { name: 'Gerar outro QR Code' }));
    expect(await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).toBeNull();
  });

  it('sem a imagem, desenha o QR Code pelo conteúdo; sem nada ainda, avisa que está gerando', async () => {
    server.connects = [connection({ state: 'connecting' }), connection({ state: 'connecting', qrCode: '2@AbCdEf123,xyz==,k9' })];
    renderBlock();
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar' }));
    expect(await screen.findByText(/Gerando o QR Code/)).toBeTruthy();
    // a instância ainda não tinha o código: a tela pede de novo logo em seguida
    const drawn = await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' });
    expect(drawn.tagName.toLowerCase()).toBe('svg');
    // desenhado em SVG pelo conteúdo do código (os três cantos de um QR Code têm dezenas de módulos escuros)
    expect(drawn.querySelectorAll('rect').length).toBeGreaterThan(100);
    expect(screen.getByText('Aponte a câmera para este código.')).toBeTruthy();
    expect(server.posts).toBeGreaterThanOrEqual(2);
  });

  it('mostra a mensagem do provedor quando a conexão falha', async () => {
    server.connects = [new ApiError(502, 'Evolution API respondeu com erro (HTTP 404): The "escritorio" instance does not exist.')];
    renderBlock();
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The "escritorio" instance does not exist');
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).toBeNull();
    // dá para tentar de novo
    expect(screen.getByRole('button', { name: 'Conectar' })).toBeTruthy();
    cleanup();
    // falha já na consulta do estado
    server.states = [new ApiError(502, 'Credenciais recusadas pelo Evolution API (HTTP 401): Unauthorized. Confira a chave configurada.')];
    renderBlock();
    expect((await screen.findByRole('alert')).textContent).toContain('Credenciais recusadas pelo Evolution API');
  });

  it('sem a configuração salva, não consulta nada e pede para salvar', async () => {
    renderBlock({ ready: false });
    expect(screen.getByText('Salve a URL, a instância e a API key para conectar o número do escritório por aqui.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conectar' })).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(server.gets).toBe(0);
  });

  it('formata o número conectado', () => {
    expect(formatWhatsAppNumber('5511987654321')).toBe('+55 (11) 98765-4321');
    expect(formatWhatsAppNumber('551133334444')).toBe('+55 (11) 3333-4444');
    expect(formatWhatsAppNumber('351912345678')).toBe('+351912345678');
  });
});
