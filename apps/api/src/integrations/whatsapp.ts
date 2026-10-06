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
 * Mensagens livres só valem dentro da janela de 24 h aberta pelo cliente; fora dela vai o modelo
 * aprovado configurado (`type: 'template'`, .../cloud-api/guides/send-message-templates).
 *
 * Recebimento (webhook `POST /api/webhooks/whatsapp/:token`):
 * - Evolution: evento `messages.upsert` (`data.key.remoteJid`, `data.message`);
 * - Meta: `entry[].changes[].value.messages[]` e `statuses[]`, com a assinatura
 *   `X-Hub-Signature-256` (HMAC-SHA256 do corpo com o App Secret) e a verificação
 *   `GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
 *   (https://developers.facebook.com/docs/graph-api/webhooks/getting-started).
 */
import { createHmac } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { onlyDigits } from '@verifco/shared';
import type { AppContext } from '../context';
import { customers, deliveries, messages } from '../db/schema';
import { safeEqual } from '../lib/crypto';
import { notify } from '../services/notify';
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
  /** Modelo aprovado usado fora da janela de 24 h (Meta). */
  templateName?: string;
  templateLanguage?: string;
  /** 'message' = corpo com uma variável {{1}} que recebe o texto; 'none' = sem variáveis. */
  templateBody?: 'message' | 'none';
  /** O modelo tem cabeçalho do tipo documento. */
  templateDocument?: boolean;
}
export interface WhatsAppSecrets {
  apiKey?: string;
  accessToken?: string;
  /** App Secret da Meta (assinatura do webhook). */
  appSecret?: string;
}

/** Janela em que a Meta aceita mensagens livres depois da última mensagem do cliente. */
export const META_WINDOW_MS = 24 * 3600_000;

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

  /** Modelo aprovado (fora da janela de 24 h): corpo com o texto em {{1}} e, se houver, o PDF no cabeçalho. */
  async sendTemplate(to: string, t: { name: string; language: string; body: 'message' | 'none' }, text: string, document?: { filename: string; content: Buffer; contentType?: string }) {
    const components: Record<string, unknown>[] = [];
    if (document) {
      const id = await this.uploadMedia(document);
      components.push({ type: 'header', parameters: [{ type: 'document', document: { id, filename: document.filename } }] });
    }
    if (t.body === 'message') components.push({ type: 'body', parameters: [{ type: 'text', text: templateParam(text) }] });
    return this.sendMessage({ to, type: 'template', template: { name: t.name, language: { code: t.language || 'pt_BR' }, ...(components.length ? { components } : {}) } });
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

/** Texto para a variável {{1}} de um modelo: a Meta recusa quebra de linha, tabulação e 4+ espaços. */
export function templateParam(text: string) {
  const flat = text
    .replace(/\s*[\r\n\t]+\s*/g, ' · ')
    .replace(/ {4,}/g, ' ')
    .replace(/^(· )+|( ·)+$/g, '')
    .trim();
  return flat.length > 1000 ? `${flat.slice(0, 999)}…` : flat || '-';
}

/**
 * Entrega a mensagem. No modo Meta, com a janela de 24 h fechada (`windowOpen === false`) e um
 * modelo aprovado configurado, vai o modelo; sem modelo, vai a mensagem livre (a Meta a recusa e o
 * webhook de status marca o envio como falho).
 */
async function deliver(fetchImpl: typeof fetch, loaded: LoadedWhatsApp, msg: OutgoingWhatsApp, userFetch?: typeof fetch, windowOpen?: boolean) {
  const to = onlyDigits(msg.to);
  if (to.length < 10) throw new IntegrationError('whatsapp', `Número de WhatsApp inválido: ${msg.to}`);
  const c = clientFor(fetchImpl, loaded, userFetch);
  const doc = msg.document;
  const text = msg.text?.trim() ?? '';
  const cfg = loaded.config;
  if (c.mode === 'meta' && windowOpen === false && cfg.templateName?.trim()) {
    if (doc && !cfg.templateDocument) {
      throw new IntegrationError(
        'whatsapp',
        'O cliente não escreveu nas últimas 24 h e, fora dessa janela, a Meta só entrega arquivos num modelo com cabeçalho de documento. Marque essa opção em Administração › Integrações › WhatsApp (com um modelo assim aprovado) ou envie por e-mail.',
      );
    }
    const template = { name: cfg.templateName.trim(), language: cfg.templateLanguage?.trim() || 'pt_BR', body: cfg.templateBody === 'none' ? ('none' as const) : ('message' as const) };
    return c.client.sendTemplate(to, template, text, doc);
  }
  if (!doc) return c.client.sendText(to, text);
  // texto curto vai como legenda do documento; longo, como mensagem antes do arquivo
  if (text.length > CAPTION_LIMIT) {
    await c.client.sendText(to, text);
    return c.mode === 'meta' ? c.client.sendDocument(to, doc) : c.client.sendMedia(to, doc);
  }
  return c.mode === 'meta' ? c.client.sendDocument(to, doc, text) : c.client.sendMedia(to, doc, text);
}

// ---------------------------------------------------------------------------
// Celular do cliente
// ---------------------------------------------------------------------------

/**
 * Chave de comparação de celulares: no Brasil (55 + DDD), só os 8 últimos dígitos do número, porque
 * o WhatsApp ainda identifica muitos celulares sem o nono dígito (55 11 8765-4321 = 55 11 98765-4321).
 */
export function phoneKey(raw: string | null | undefined): string {
  const d = onlyDigits(raw);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `55${d.slice(2, 4)}${d.slice(-8)}`;
  return d;
}

/** Número completo do celular do cliente (país + número), sem repetir o país já digitado. */
export function customerPhone(country: string | null | undefined, mobile: string | null | undefined): string {
  const c = onlyDigits(country) || '55';
  const m = onlyDigits(mobile);
  if (!m) return '';
  return m.length >= 12 && m.startsWith(c) ? m : `${c}${m}`;
}

/** Clientes do escritório com esse celular (o de conversa mais recente pelo WhatsApp primeiro). */
export async function customersByPhone(ctx: AppContext, officeId: string, phone: string) {
  const key = phoneKey(phone);
  if (key.length < 10) return [];
  const rows = await ctx.db
    .select({ id: customers.id, name: customers.name, mobile: customers.mobile, mobileCountry: customers.mobileCountry, responsibleUserId: customers.responsibleUserId })
    .from(customers)
    .where(
      and(
        eq(customers.officeId, officeId),
        isNull(customers.deletedAt),
        sql`right(regexp_replace(coalesce(${customers.mobile}, ''), '[^0-9]', '', 'g'), 8) = ${key.slice(-8)}`,
      ),
    )
    .orderBy(asc(customers.name));
  const matches = rows.filter((r) => phoneKey(customerPhone(r.mobileCountry, r.mobile)) === key);
  if (matches.length < 2) return matches;
  const last = await ctx.db
    .select({ customerId: messages.customerId, at: max(messages.createdAt) })
    .from(messages)
    .where(and(eq(messages.officeId, officeId), eq(messages.channel, 'whatsapp'), inArray(messages.customerId, matches.map((m) => m.id))))
    .groupBy(messages.customerId);
  const at = new Map(last.map((l) => [l.customerId, l.at ? new Date(l.at).getTime() : 0]));
  return [...matches].sort((a, b) => (at.get(b.id) ?? 0) - (at.get(a.id) ?? 0));
}

/** Janela de 24 h da Meta aberta: o cliente com esse celular escreveu pelo WhatsApp nas últimas 24 h. */
export async function whatsappWindowOpen(ctx: AppContext, officeId: string, phone: string, now = new Date()) {
  const list = await customersByPhone(ctx, officeId, phone);
  if (!list.length) return false;
  const [row] = await ctx.db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.officeId, officeId), eq(messages.channel, 'whatsapp'), eq(messages.direction, 'in'), inArray(messages.customerId, list.map((c) => c.id))))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return Boolean(row && now.getTime() - row.at.getTime() < META_WINDOW_MS);
}

export function createWhatsAppSender(ctx: AppContext, getFetch: () => typeof fetch, getUserFetch: () => typeof fetch = getFetch): WhatsAppSender {
  return {
    async send(officeId, msg) {
      const loaded = await loadIntegration<WhatsAppConfig, WhatsAppSecrets>(ctx, officeId, 'whatsapp');
      if (!loaded || !loaded.row.enabled) throw new IntegrationError('whatsapp', 'Configure o WhatsApp em Administração › Integrações.');
      const windowOpen = loaded.config.mode === 'meta' ? await whatsappWindowOpen(ctx, officeId, msg.to) : undefined;
      return { messageId: await deliver(getFetch(), loaded, msg, getUserFetch(), windowOpen) };
    },
  };
}

/** Teste: confere a conexão; com `sendTo`, envia uma mensagem de teste (o modelo, se a janela estiver fechada). */
export async function testWhatsApp(
  fetchImpl: typeof fetch,
  loaded: LoadedWhatsApp,
  opts: { sendTo?: string; windowOpen?: boolean } = {},
  userFetch: typeof fetch = fetchImpl,
) {
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
    await deliver(fetchImpl, loaded, { to: opts.sendTo, text: 'Mensagem de teste do Verifco: a integração com o WhatsApp está funcionando.' }, userFetch, opts.windowOpen);
    message += ` Mensagem de teste enviada para ${opts.sendTo}.`;
    if (c.mode === 'meta' && opts.windowOpen === false) {
      message += loaded.config.templateName?.trim()
        ? ` Como esse número não escreveu nas últimas 24 h, foi usado o modelo "${loaded.config.templateName.trim()}".`
        : ' Atenção: esse número não escreveu nas últimas 24 h e não há modelo aprovado configurado; a Meta só entrega mensagens livres dentro da janela.';
    }
  }
  return message;
}

// ---------------------------------------------------------------------------
// Recebimento (webhook)
// ---------------------------------------------------------------------------

export interface InboundWhatsApp {
  /** Id da mensagem no provedor (evita gravar duas vezes quando o provedor repete o aviso). */
  id: string;
  /** Celular de quem escreveu (só dígitos, com o país). */
  from: string;
  name: string | null;
  text: string;
  /** Data/hora da mensagem (ISO). */
  at: string;
}

export interface WhatsAppStatusUpdate {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error: string | null;
}

const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const has = (v: unknown) => Object.keys(obj(v)).length > 0;
const fromEpoch = (v: unknown) => {
  const n = Number(str(v));
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
};
const fileNote = (kind: string, caption: string, filename = '') =>
  `[${kind} recebido pelo WhatsApp${filename ? `: ${filename}` : ''}. Abra a conversa no WhatsApp do escritório para ver o arquivo.]${caption ? ` ${caption}` : ''}`;

/** Texto de uma mensagem da Evolution (Baileys). Reações, figurinhas e avisos de sistema são ignorados. */
function evolutionText(m: Record<string, unknown>): string | null {
  if (str(m.conversation)) return str(m.conversation);
  if (str(obj(m.extendedTextMessage).text)) return str(obj(m.extendedTextMessage).text);
  const doc = has(m.documentMessage) ? obj(m.documentMessage) : obj(obj(obj(m.documentWithCaptionMessage).message).documentMessage);
  if (has(doc)) return fileNote('Documento', str(doc.caption), str(doc.fileName));
  if (has(m.imageMessage)) return fileNote('Imagem', str(obj(m.imageMessage).caption));
  if (has(m.videoMessage)) return fileNote('Vídeo', str(obj(m.videoMessage).caption));
  if (has(m.audioMessage)) return fileNote('Áudio', '');
  const reply = str(obj(m.buttonsResponseMessage).selectedDisplayText) || str(obj(m.templateButtonReplyMessage).selectedDisplayText) || str(obj(m.listResponseMessage).title);
  if (reply) return reply;
  if (has(m.locationMessage)) return '[Localização enviada pelo WhatsApp]';
  if (has(m.contactMessage)) return `[Contato enviado pelo WhatsApp: ${str(obj(m.contactMessage).displayName)}]`;
  return null;
}

/** Celular de um JID (`5511...@s.whatsapp.net`); grupos e ids anônimos (@lid) sem número voltam vazios. */
const jidPhone = (jid: unknown) => (/^\d{10,15}@s\.whatsapp\.net$/.test(str(jid)) ? str(jid).split('@')[0] : '');

/** Mensagens recebidas no webhook da Evolution API v2 (evento `messages.upsert`). */
export function parseEvolutionWebhook(body: unknown, instance?: string): InboundWhatsApp[] {
  const b = obj(body);
  const event = str(b.event).toLowerCase().replace(/_/g, '.');
  if (event !== 'messages.upsert') return [];
  if (instance && str(b.instance) && str(b.instance) !== instance) return [];
  const list = Array.isArray(b.data) ? b.data : [b.data];
  const out: InboundWhatsApp[] = [];
  for (const item of list) {
    const d = obj(item);
    const key = obj(d.key);
    if (key.fromMe === true) continue;
    const from = jidPhone(key.remoteJid) || jidPhone(key.senderPn) || jidPhone(key.remoteJidAlt) || jidPhone(d.senderPn);
    const text = evolutionText(obj(d.message));
    if (!from || !text || !str(key.id)) continue;
    out.push({ id: str(key.id), from, name: str(d.pushName) || null, text: text.slice(0, 4000), at: fromEpoch(d.messageTimestamp) });
  }
  return out;
}

/** Texto de uma mensagem da Cloud API. Reações e mensagens de sistema são ignoradas. */
function metaText(m: Record<string, unknown>): string | null {
  switch (str(m.type)) {
    case 'text':
      return str(obj(m.text).body) || null;
    case 'button':
      return str(obj(m.button).text) || null;
    case 'interactive': {
      const i = obj(m.interactive);
      return str(obj(i.button_reply).title) || str(obj(i.list_reply).title) || null;
    }
    case 'document':
      return fileNote('Documento', str(obj(m.document).caption), str(obj(m.document).filename));
    case 'image':
      return fileNote('Imagem', str(obj(m.image).caption));
    case 'video':
      return fileNote('Vídeo', str(obj(m.video).caption));
    case 'audio':
      return fileNote('Áudio', '');
    case 'location':
      return `[Localização enviada pelo WhatsApp${str(obj(m.location).name) ? `: ${str(obj(m.location).name)}` : ''}]`;
    case 'contacts':
      return '[Contato enviado pelo WhatsApp]';
    default:
      return null;
  }
}

/** Códigos de erro mais comuns da Cloud API (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes). */
const META_ERRORS: Record<string, string> = {
  '131047': 'O cliente não escreveu nas últimas 24 h e a Meta só entrega modelos aprovados fora dessa janela. Configure o modelo em Administração › Integrações › WhatsApp.',
  '131026': 'A Meta não conseguiu entregar: o número não tem WhatsApp ou não aceitou a mensagem.',
  '132000': 'A quantidade de variáveis não confere com o modelo aprovado.',
  '132001': 'O modelo informado não existe ou não está aprovado no idioma configurado.',
};

/** Mensagens recebidas e status de envio no webhook da Cloud API (só do número configurado). */
export function parseMetaWebhook(body: unknown, phoneNumberId?: string): { messages: InboundWhatsApp[]; statuses: WhatsAppStatusUpdate[] } {
  const out = { messages: [] as InboundWhatsApp[], statuses: [] as WhatsAppStatusUpdate[] };
  const b = obj(body);
  if (str(b.object) && str(b.object) !== 'whatsapp_business_account') return out;
  for (const entry of Array.isArray(b.entry) ? b.entry : []) {
    const changes = obj(entry).changes;
    for (const change of Array.isArray(changes) ? changes : []) {
      const c = obj(change);
      if (str(c.field) !== 'messages') continue;
      const value = obj(c.value);
      const target = str(obj(value.metadata).phone_number_id);
      if (phoneNumberId && target && target !== phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const ct of Array.isArray(value.contacts) ? value.contacts : []) names.set(str(obj(ct).wa_id), str(obj(obj(ct).profile).name));
      for (const raw of Array.isArray(value.messages) ? value.messages : []) {
        const m = obj(raw);
        const from = onlyDigits(str(m.from));
        const text = metaText(m);
        if (!from || !text || !str(m.id)) continue;
        out.messages.push({ id: str(m.id), from, name: names.get(from) || null, text: text.slice(0, 4000), at: fromEpoch(m.timestamp) });
      }
      for (const raw of Array.isArray(value.statuses) ? value.statuses : []) {
        const s = obj(raw);
        const status = str(s.status);
        if (!str(s.id) || !['sent', 'delivered', 'read', 'failed'].includes(status)) continue;
        const err = obj(Array.isArray(s.errors) ? s.errors[0] : null);
        const code = str(err.code);
        const detail = str(obj(err.error_data).details) || str(err.message) || str(err.title);
        out.statuses.push({
          id: str(s.id),
          status: status as WhatsAppStatusUpdate['status'],
          error: status === 'failed' ? (META_ERRORS[code] ?? `A Meta recusou a entrega${detail ? `: ${detail}` : ''}${code ? ` (código ${code})` : ''}.`) : null,
        });
      }
    }
  }
  return out;
}

/** Confere `X-Hub-Signature-256` (sha256= + HMAC-SHA256 do corpo cru com o App Secret). */
export function validMetaSignature(rawBody: Buffer, header: unknown, appSecret: string) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return safeEqual(header, expected);
}

/**
 * Grava a mensagem recebida na conversa do cliente (aba Mensagens, canal WhatsApp) e avisa no sino.
 * Sem cliente com esse celular, avisa o escritório com o número, para o cadastro.
 */
export async function receiveWhatsAppMessage(ctx: AppContext, officeId: string, msg: InboundWhatsApp) {
  const [customer] = await customersByPhone(ctx, officeId, msg.from);
  const preview = msg.text.length > 140 ? `${msg.text.slice(0, 139)}…` : msg.text;
  if (!customer) {
    await notify(ctx.db, {
      officeId,
      title: 'Mensagem de WhatsApp de número sem cliente',
      body: `+${msg.from}${msg.name ? ` (${msg.name})` : ''}: ${preview}`,
      link: '/clientes',
    });
    return { matched: false as const };
  }
  const [row] = await ctx.db
    .insert(messages)
    .values({ officeId, customerId: customer.id, direction: 'in', channel: 'whatsapp', body: msg.text, createdAt: new Date(msg.at) })
    .returning({ id: messages.id });
  await notify(ctx.db, {
    officeId,
    userId: customer.responsibleUserId ?? null,
    customerId: customer.id,
    title: `Nova mensagem de ${customer.name} pelo WhatsApp`,
    body: preview,
    link: `/clientes/${customer.id}/mensagens`,
  });
  return { matched: true as const, customerId: customer.id, messageId: row.id };
}

/** Status de envio da Meta: entregue/lido marca o envio como entregue; falha registra o motivo. */
export async function applyWhatsAppStatus(ctx: AppContext, officeId: string, s: WhatsAppStatusUpdate) {
  const where = and(eq(deliveries.officeId, officeId), eq(deliveries.channel, 'whatsapp'), eq(deliveries.providerMessageId, s.id));
  if (s.status === 'failed') {
    const rows = await ctx.db.update(deliveries).set({ status: 'failed', error: s.error }).where(where).returning({ id: deliveries.id });
    return rows.length;
  }
  if (s.status === 'delivered' || s.status === 'read') {
    const rows = await ctx.db
      .update(deliveries)
      .set({ status: 'delivered' })
      .where(and(where, inArray(deliveries.status, ['sent', 'queued'])))
      .returning({ id: deliveries.id });
    return rows.length;
  }
  return 0;
}
