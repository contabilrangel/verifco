/**
 * Envio de WhatsApp pela Evolution API ou pela WhatsApp Cloud API (Meta).
 *
 * Evolution API v2 (https://doc.evolution-api.com/v2/api-reference):
 * - POST {url}/message/sendText/{instância} `{ number, text }`, cabeçalho `apikey`.
 * - POST {url}/message/sendMedia/{instância} `{ number, mediatype, mimetype, media (base64 puro), fileName, caption }`.
 * - GET {url}/instance/connectionState/{instância} → `{ instance: { state: 'open' } }`.
 *
 * Meta WhatsApp Cloud API (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 * e .../reference/media), cabeçalho `Authorization: Bearer <token>`:
 * - POST https://graph.facebook.com/{versão}/{phone-number-id}/messages
 *   `{ messaging_product: 'whatsapp', to, type: 'text'|'document', ... }` → `messages[0].id`.
 * - POST .../{phone-number-id}/media (multipart: messaging_product, type, file) → `{ id }`.
 * Mensagens livres só valem dentro da janela de 24 h aberta pelo cliente.
 */
import { onlyDigits } from '@verifco/shared';
import type { AppContext } from '../context';
import { IntegrationError, ensureOk, httpRequest } from './http';
import type { OutgoingWhatsApp, WhatsAppSender } from './providers';
import { loadIntegration, type LoadedIntegration } from './store';

export interface WhatsAppConfig {
  mode: 'evolution' | 'meta';
  baseUrl?: string;
  instance?: string;
  phoneNumberId?: string;
  apiVersion?: string;
}
export interface WhatsAppSecrets {
  apiKey?: string;
  accessToken?: string;
}

export const META_GRAPH_URL = 'https://graph.facebook.com';
export const META_DEFAULT_VERSION = 'v25.0';
/** Legendas longas vão como mensagem de texto separada. */
const CAPTION_LIMIT = 1000;
const MEDIA_TIMEOUT_MS = 60_000;

const describeEvolutionError = (data: unknown) => {
  const d = data as { response?: { message?: unknown }; message?: unknown; error?: unknown } | null;
  const m = d?.response?.message ?? d?.message ?? d?.error;
  if (Array.isArray(m)) return m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ');
  return typeof m === 'string' ? m : null;
};

const describeMetaError = (data: unknown) => {
  const e = (data as { error?: { message?: string; code?: number; error_data?: { details?: string } } } | null)?.error;
  if (!e) return null;
  return [e.message, e.error_data?.details, e.code ? `código ${e.code}` : null].filter(Boolean).join(' – ');
};

const mediaTypeOf = (mime: string | undefined) => (mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : mime?.startsWith('audio/') ? 'audio' : 'document');

export class EvolutionClient {
  private baseUrl: string;

  constructor(
    private fetchImpl: typeof fetch,
    baseUrl: string,
    private instance: string,
    private apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number) {
    const res = await httpRequest<T>(this.fetchImpl, 'evolution', `${this.baseUrl}${path}`, { method, body, headers: { apikey: this.apiKey }, timeoutMs });
    return ensureOk('evolution', res, describeEvolutionError);
  }

  async connectionState() {
    const r = await this.request<{ instance?: { state?: string } }>('GET', `/instance/connectionState/${encodeURIComponent(this.instance)}`);
    return r.instance?.state ?? 'unknown';
  }

  async sendText(number: string, text: string) {
    const r = await this.request<{ key?: { id?: string } }>('POST', `/message/sendText/${encodeURIComponent(this.instance)}`, { number, text });
    return r.key?.id ?? `evo-${Date.now()}`;
  }

  async sendMedia(number: string, file: { filename: string; content: Buffer; contentType?: string }, caption?: string) {
    const mimetype = file.contentType || 'application/octet-stream';
    const r = await this.request<{ key?: { id?: string } }>(
      'POST',
      `/message/sendMedia/${encodeURIComponent(this.instance)}`,
      {
        number,
        mediatype: mediaTypeOf(mimetype),
        mimetype,
        // a Evolution decodifica `media` com Buffer.from(media, 'base64'): base64 puro, sem prefixo data:
        media: file.content.toString('base64'),
        fileName: file.filename,
        caption: caption || undefined,
      },
      MEDIA_TIMEOUT_MS,
    );
    return r.key?.id ?? `evo-${Date.now()}`;
  }
}

export class MetaWhatsAppClient {
  private base: string;

  constructor(
    private fetchImpl: typeof fetch,
    private phoneNumberId: string,
    private accessToken: string,
    version = META_DEFAULT_VERSION,
  ) {
    this.base = `${META_GRAPH_URL}/${version || META_DEFAULT_VERSION}`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async phoneInfo() {
    const res = await httpRequest<{ display_phone_number?: string; verified_name?: string }>(
      this.fetchImpl,
      'meta',
      `${this.base}/${encodeURIComponent(this.phoneNumberId)}?fields=display_phone_number,verified_name`,
      { headers: this.headers() },
    );
    return ensureOk('meta', res, describeMetaError);
  }

  private async sendMessage(body: Record<string, unknown>) {
    const res = await httpRequest<{ messages?: { id: string }[] }>(this.fetchImpl, 'meta', `${this.base}/${encodeURIComponent(this.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...body },
    });
    const data = ensureOk('meta', res, describeMetaError);
    return data.messages?.[0]?.id ?? `meta-${Date.now()}`;
  }

  sendText(to: string, text: string) {
    return this.sendMessage({ to, type: 'text', text: { preview_url: true, body: text.slice(0, 4096) } });
  }

  async uploadMedia(file: { filename: string; content: Buffer; contentType?: string }) {
    const type = file.contentType || 'application/pdf';
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', type);
    form.append('file', new Blob([new Uint8Array(file.content)], { type }), file.filename);
    const res = await httpRequest<{ id?: string }>(this.fetchImpl, 'meta', `${this.base}/${encodeURIComponent(this.phoneNumberId)}/media`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
      timeoutMs: MEDIA_TIMEOUT_MS,
    });
    const data = ensureOk('meta', res, describeMetaError);
    if (!data.id) throw new IntegrationError('meta', 'A Meta não devolveu o id do arquivo enviado.');
    return data.id;
  }

  async sendDocument(to: string, file: { filename: string; content: Buffer; contentType?: string }, caption?: string) {
    const id = await this.uploadMedia(file);
    const kind = mediaTypeOf(file.contentType);
    const media: Record<string, unknown> = { id };
    if (kind === 'document') media.filename = file.filename;
    if (caption && kind !== 'audio') media.caption = caption;
    return this.sendMessage({ to, type: kind, [kind]: media });
  }
}

type LoadedWhatsApp = LoadedIntegration<WhatsAppConfig, WhatsAppSecrets>;

function clientFor(fetchImpl: typeof fetch, loaded: LoadedWhatsApp) {
  const { config: c, secrets: s } = loaded;
  if (c.mode === 'meta') {
    if (!c.phoneNumberId || !s.accessToken) throw new IntegrationError('whatsapp', 'Informe o Phone number ID e o token de acesso da Meta em Administração › Integrações.');
    return { mode: 'meta' as const, client: new MetaWhatsAppClient(fetchImpl, c.phoneNumberId, s.accessToken, c.apiVersion) };
  }
  if (!c.baseUrl || !c.instance || !s.apiKey) throw new IntegrationError('whatsapp', 'Informe a URL, a instância e a API key da Evolution API em Administração › Integrações.');
  return { mode: 'evolution' as const, client: new EvolutionClient(fetchImpl, c.baseUrl, c.instance, s.apiKey) };
}

async function deliver(fetchImpl: typeof fetch, loaded: LoadedWhatsApp, msg: OutgoingWhatsApp) {
  const to = onlyDigits(msg.to);
  if (to.length < 10) throw new IntegrationError('whatsapp', `Número de WhatsApp inválido: ${msg.to}`);
  const c = clientFor(fetchImpl, loaded);
  const doc = msg.document;
  const text = msg.text?.trim() ?? '';
  if (!doc) return c.client.sendText(to, text);
  // texto curto vai como legenda do documento; longo, como mensagem antes do arquivo
  if (text.length > CAPTION_LIMIT) {
    await c.client.sendText(to, text);
    return c.mode === 'meta' ? c.client.sendDocument(to, doc) : c.client.sendMedia(to, doc);
  }
  return c.mode === 'meta' ? c.client.sendDocument(to, doc, text) : c.client.sendMedia(to, doc, text);
}

export function createWhatsAppSender(ctx: AppContext, getFetch: () => typeof fetch): WhatsAppSender {
  return {
    async send(officeId, msg) {
      const loaded = await loadIntegration<WhatsAppConfig, WhatsAppSecrets>(ctx, officeId, 'whatsapp');
      if (!loaded || !loaded.row.enabled) throw new IntegrationError('whatsapp', 'Configure o WhatsApp em Administração › Integrações.');
      return { messageId: await deliver(getFetch(), loaded, msg) };
    },
  };
}

/** Teste: confere a conexão; com `sendTo`, envia uma mensagem de teste. */
export async function testWhatsApp(fetchImpl: typeof fetch, loaded: LoadedWhatsApp, opts: { sendTo?: string } = {}) {
  const c = clientFor(fetchImpl, loaded);
  let message: string;
  if (c.mode === 'evolution') {
    const state = await c.client.connectionState();
    if (state !== 'open') {
      throw new IntegrationError('evolution', `A instância "${loaded.config.instance}" não está conectada (estado: ${state}). Leia o QR Code na Evolution API.`);
    }
    message = `Instância "${loaded.config.instance}" conectada.`;
  } else {
    const info = await c.client.phoneInfo();
    message = `Número ${info.display_phone_number ?? loaded.config.phoneNumberId}${info.verified_name ? ` (${info.verified_name})` : ''} conectado.`;
  }
  if (opts.sendTo) {
    await deliver(fetchImpl, loaded, { to: opts.sendTo, text: 'Mensagem de teste do Verifco: a integração com o WhatsApp está funcionando.' });
    message += ` Mensagem de teste enviada para ${opts.sendTo}.`;
  }
  return message;
}
