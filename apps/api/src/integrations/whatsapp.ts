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
 * Mensagens livres só valem dentro da janela de 24 h aberta pelo cliente. Fora dela, com um
 * modelo aprovado configurado para o tipo de envio, vai `type: 'template'`
 * `{ template: { name, language: { code }, components: [header (documento), body (parâmetros)] } }`
 * (developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates).
 * O recebimento das respostas (webhook) fica em `whatsapp-inbound.ts`.
 */
import { and, eq, gt } from 'drizzle-orm';
import {
  WHATSAPP_MESSAGE_VARIABLE,
  WHATSAPP_SERVICE_WINDOW_MS,
  onlyDigits,
  parseWhatsAppTemplates,
  whatsappTemplateFor,
  whatsappTemplateParam,
  type WhatsAppTemplateConfig,
} from '@verifco/shared';
import type { AppContext } from '../context';
import { messages } from '../db/schema';
import { baseTemplateValues } from '../services/delivery';
import { IntegrationError, ensureOk, httpRequest } from './http';
import { assertSafeBaseUrl } from './ssrf';
import type { OutgoingWhatsApp, WhatsAppSender } from './providers';
import { loadIntegration, type LoadedIntegration } from './store';

export interface WhatsAppConfig {
  mode: 'evolution' | 'meta';
  baseUrl?: string;
  instance?: string;
  phoneNumberId?: string;
  apiVersion?: string;
  /** Modelos aprovados por tipo de envio (texto lido por `parseWhatsAppTemplates`). */
  templates?: string;
}
export interface WhatsAppSecrets {
  apiKey?: string;
  accessToken?: string;
  /** Chave secreta do app da Meta: confere a assinatura X-Hub-Signature-256 do webhook. */
  appSecret?: string;
  /** Token de verificação do webhook da Meta (hub.verify_token). */
  webhookVerifyToken?: string;
  /** Evolution API: token exigido no cabeçalho `Authorization: Bearer` do webhook (opcional). */
  webhookAuthToken?: string;
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
    // a URL vem do escritório: só https público, sem usuário/senha, "?" ou "#" (proteção contra SSRF)
    this.baseUrl = assertSafeBaseUrl('evolution', baseUrl).toString().replace(/\/+$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number) {
    const res = await httpRequest<T>(this.fetchImpl, 'evolution', `${this.baseUrl}${path}`, { method, body, headers: { apikey: this.apiKey }, timeoutMs, opaqueErrors: true });
    return ensureOk('evolution', res, describeEvolutionError, { rawBody: false });
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

  /** Modelo aprovado: parâmetros do corpo (posicionais ou nomeados) e, se houver, o PDF no cabeçalho. */
  async sendTemplate(
    to: string,
    tpl: { name: string; language: string; body: { name: string | null; text: string }[]; document?: { filename: string; content: Buffer; contentType?: string } },
  ) {
    const components: Record<string, unknown>[] = [];
    if (tpl.document) {
      const id = await this.uploadMedia(tpl.document);
      components.push({ type: 'header', parameters: [{ type: 'document', document: { id, filename: tpl.document.filename } }] });
    }
    if (tpl.body.length) {
      components.push({ type: 'body', parameters: tpl.body.map((p) => ({ type: 'text', ...(p.name ? { parameter_name: p.name } : {}), text: p.text })) });
    }
    return this.sendMessage({ to, type: 'template', template: { name: tpl.name, language: { code: tpl.language }, ...(components.length ? { components } : {}) } });
  }
}

type LoadedWhatsApp = LoadedIntegration<WhatsAppConfig, WhatsAppSecrets>;

/** `userFetch` é o fetch usado com a URL informada pelo escritório (Evolution). */
function clientFor(fetchImpl: typeof fetch, loaded: LoadedWhatsApp, userFetch: typeof fetch = fetchImpl) {
  const { config: c, secrets: s } = loaded;
  if (c.mode === 'meta') {
    if (!c.phoneNumberId || !s.accessToken) throw new IntegrationError('whatsapp', 'Informe o Phone number ID e o token de acesso da Meta em Administração › Integrações.');
    return { mode: 'meta' as const, client: new MetaWhatsAppClient(fetchImpl, c.phoneNumberId, s.accessToken, c.apiVersion) };
  }
  if (!c.baseUrl || !c.instance || !s.apiKey) throw new IntegrationError('whatsapp', 'Informe a URL, a instância e a API key da Evolution API em Administração › Integrações.');
  return { mode: 'evolution' as const, client: new EvolutionClient(userFetch, c.baseUrl, c.instance, s.apiKey) };
}

async function deliver(fetchImpl: typeof fetch, loaded: LoadedWhatsApp, msg: OutgoingWhatsApp, userFetch?: typeof fetch) {
  const to = onlyDigits(msg.to);
  if (to.length < 10) throw new IntegrationError('whatsapp', `Número de WhatsApp inválido: ${msg.to}`);
  const c = clientFor(fetchImpl, loaded, userFetch);
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

/**
 * Modelo a usar no envio: só na Cloud API da Meta, para um cliente conhecido, com modelo
 * configurado para o tipo de envio e sem mensagem dele pelo WhatsApp nas últimas 24 h.
 */
async function templateOutsideWindow(ctx: AppContext, officeId: string, loaded: LoadedWhatsApp, msg: OutgoingWhatsApp): Promise<WhatsAppTemplateConfig | null> {
  if (loaded.config.mode !== 'meta' || !msg.customerId) return null;
  const template = whatsappTemplateFor(parseWhatsAppTemplates(loaded.config.templates).templates, msg.templateKey);
  if (!template) return null;
  const since = new Date(Date.now() - WHATSAPP_SERVICE_WINDOW_MS);
  const recent = await ctx.db.query.messages.findFirst({
    where: and(eq(messages.officeId, officeId), eq(messages.customerId, msg.customerId), eq(messages.direction, 'in'), eq(messages.channel, 'whatsapp'), gt(messages.createdAt, since)),
  });
  return recent ? null : template;
}

/** Envia o modelo aprovado com as variáveis do envio (`MENSAGEM` = o texto inteiro, em uma linha). */
async function deliverTemplate(ctx: AppContext, fetchImpl: typeof fetch, loaded: LoadedWhatsApp, officeId: string, msg: OutgoingWhatsApp, template: WhatsAppTemplateConfig) {
  const to = onlyDigits(msg.to);
  if (to.length < 10) throw new IntegrationError('whatsapp', `Número de WhatsApp inválido: ${msg.to}`);
  const c = clientFor(fetchImpl, loaded);
  if (c.mode !== 'meta') throw new IntegrationError('whatsapp', 'Modelos aprovados só existem na WhatsApp Cloud API da Meta.');
  // fora da janela, o PDF só chega pelo cabeçalho de documento do modelo
  if (template.document && !msg.document) {
    throw new IntegrationError('whatsapp', `O modelo “${template.name}” leva um PDF no cabeçalho, mas este envio não tem anexo. Ajuste os modelos em Administração › Integrações › WhatsApp.`);
  }
  if (msg.document && !template.document) {
    throw new IntegrationError(
      'whatsapp',
      `O cliente não escreveu nas últimas 24 h e o modelo “${template.name}” não leva documento: marque “documento” num modelo com PDF no cabeçalho ou envie por e-mail.`,
    );
  }
  const values: Record<string, string | number | null | undefined> = {
    ...(msg.values ?? (await baseTemplateValues(ctx, officeId, msg.customerId ?? null))),
    [WHATSAPP_MESSAGE_VARIABLE]: msg.text,
  };
  return c.client.sendTemplate(to, {
    name: template.name,
    language: template.language,
    body: template.params.map((p) => ({ name: p.name, text: whatsappTemplateParam(values[p.variable]) })),
    document: template.document ? msg.document : undefined,
  });
}

export function createWhatsAppSender(ctx: AppContext, getFetch: () => typeof fetch, getUserFetch: () => typeof fetch = getFetch): WhatsAppSender {
  return {
    async send(officeId, msg) {
      const loaded = await loadIntegration<WhatsAppConfig, WhatsAppSecrets>(ctx, officeId, 'whatsapp');
      if (!loaded || !loaded.row.enabled) throw new IntegrationError('whatsapp', 'Configure o WhatsApp em Administração › Integrações.');
      const template = await templateOutsideWindow(ctx, officeId, loaded, msg);
      if (template) return { messageId: await deliverTemplate(ctx, getFetch(), loaded, officeId, msg, template) };
      return { messageId: await deliver(getFetch(), loaded, msg, getUserFetch()) };
    },
  };
}

/** Teste: confere a conexão; com `sendTo`, envia uma mensagem de teste. */
export async function testWhatsApp(fetchImpl: typeof fetch, loaded: LoadedWhatsApp, opts: { sendTo?: string } = {}, userFetch: typeof fetch = fetchImpl) {
  const c = clientFor(fetchImpl, loaded, userFetch);
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
    await deliver(fetchImpl, loaded, { to: opts.sendTo, text: 'Mensagem de teste do Verifco: a integração com o WhatsApp está funcionando.' }, userFetch);
    message += ` Mensagem de teste enviada para ${opts.sendTo}.`;
  }
  return message;
}
