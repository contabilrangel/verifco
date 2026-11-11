/**
 * Respostas dos clientes pelo WhatsApp (webhook): viram mensagens `in` (canal `whatsapp`) na
 * conversa do cliente e avisam o responsável no sino. Imagens, documentos e áudios viram anexos
 * da mensagem (`messages.attachments`); a legenda vira o texto.
 *
 * Evolution API v2 (webhook da instância; código em
 * src/api/integrations/event/webhook/webhook.controller.ts e whatsapp.baileys.service.ts):
 * - MESSAGES_UPSERT:
 *   `{ event: 'messages.upsert', instance, data: { key: { remoteJid, fromMe, id, remoteJidAlt? },
 *      pushName, message: { conversation | imageMessage { caption, mimetype, fileLength } |
 *      documentMessage { fileName, mimetype } | audioMessage | ..., base64? }, messageType, messageTimestamp } }`.
 *   Com "Webhook Base64" ligado na instância, o arquivo vem em `data.message.base64`; sem ele, é
 *   pedido à instância (POST /chat/getBase64FromMediaMessage/{instância}, em `whatsapp.ts`).
 * - MESSAGES_UPDATE (situação do envio):
 *   `{ event: 'messages.update', instance, data: { keyId, remoteJid, fromMe, status } }`, com
 *   `status` em ERROR, PENDING, SERVER_ACK, DELIVERY_ACK, READ ou PLAYED.
 * WhatsApp Cloud API (Meta), campo `messages` do webhook:
 *   `{ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
 *      metadata: { phone_number_id }, contacts: [{ wa_id, profile: { name } }],
 *      messages: [{ from, id, timestamp, type, text: { body } |
 *        image|document|audio|video: { id, mime_type, sha256, caption?, filename? } }],
 *      statuses: [{ id, status, errors }] } }] }] }`,
 *   assinado em `X-Hub-Signature-256: sha256=<HMAC-SHA256 do corpo com a chave secreta do app>`.
 *   A mídia é buscada pelo id (GET /{media-id} e download autenticado, em `whatsapp.ts`).
 */
import { createHmac } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { brazilPhoneVariants, fileExtension, onlyDigits, todayIso } from '@verifco/shared';
import type { AppContext } from '../context';
import { customers, deliveries, messages, notifications } from '../db/schema';
import { PermanentJobError, type JobRow } from '../jobs/queue';
import { safeEqual } from '../lib/crypto';
import { notify } from '../services/notify';
import { KNOWN_FILE_TYPES, contentMatches, safeFilename } from '../services/uploads';
import { IntegrationError } from './http';

export type WhatsAppMediaKind = 'image' | 'video' | 'audio' | 'document';

/** De onde vem o arquivo de uma mensagem com mídia (é o que vai no job, sem o conteúdo). */
export interface InboundMediaRef {
  kind: WhatsAppMediaKind;
  /** Tipo e nome informados por quem enviou: são só pistas; o tipo gravado sai do conteúdo. */
  mimeType: string | null;
  filename: string | null;
  /** Cloud API da Meta: id da mídia (GET /{media-id}). */
  metaId?: string;
  /** Evolution API: chave da mensagem, para pedir o base64 à instância. */
  evolutionKey?: { id: string; remoteJid: string | null; fromMe: boolean };
}

export interface InboundMedia extends InboundMediaRef {
  /** Tamanho informado pelo provedor, em bytes, quando houver. */
  size: number | null;
  /** Evolution API com "Webhook Base64": o conteúdo veio no próprio evento. */
  base64?: string;
}

/** Arquivo baixado do provedor (o tipo e o nome que ele informou valem como pista). */
export interface DownloadedMedia {
  data: Buffer;
  mimeType?: string | null;
  filename?: string | null;
}

export interface InboundWhatsApp {
  /** Id da mensagem no provedor (o reenvio do webhook não duplica). */
  id: string;
  /** Celular de quem escreveu (só dígitos, como o provedor informou). */
  from: string;
  /** Texto da mensagem; na mídia, a legenda (sem legenda, "[Imagem]", "[Documento: nome]"...). */
  text: string;
  at: Date;
  media?: InboundMedia;
}

export interface WhatsAppStatusUpdate {
  id: string;
  status: string;
  error: string | null;
}

/** Texto guardado na conversa (o mesmo limite das mensagens escritas no Verifco). */
const MAX_TEXT = 4000;
/** Mensagens seguidas do mesmo cliente geram um aviso só enquanto ele não for lido. */
const NOTIFY_COALESCE_MS = 30 * 60_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

// ---------------------------------------------------------------------------
// Mídia recebida: tipos aceitos, limite e textos
// ---------------------------------------------------------------------------
/** Tamanho máximo de um arquivo recebido pelo WhatsApp. */
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** Motivo da recusa por tamanho (também usado por quem baixa o arquivo, em `whatsapp.ts`). */
export const MEDIA_TOO_LARGE = `o arquivo passa de ${MEDIA_MAX_BYTES / (1024 * 1024)} MB`;

/**
 * Tipos aceitos (extensão gravada → tipo gravado): imagens comuns, PDF, áudio ogg/mp3/m4a,
 * planilhas e documentos de escritório. Vídeo e os demais tipos são recusados.
 */
const MEDIA_TYPES: Record<string, string> = {
  ...Object.fromEntries(['jpg', 'png', 'webp', 'gif', 'heic', 'heif', 'pdf', 'xls', 'xlsx', 'ods', 'csv', 'doc', 'docx', 'odt', 'txt'].map((ext) => [ext, KNOWN_FILE_TYPES[ext]])),
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
};
/** Tipo informado pelo provedor → extensão (com os apelidos que o WhatsApp e os celulares usam). */
const EXTENSION_BY_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MEDIA_TYPES).map(([ext, mime]) => [mime, ext])),
  'image/jpg': 'jpg',
  'audio/opus': 'ogg',
  'audio/mp3': 'mp3',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'application/csv': 'csv',
};

const baseMime = (mime: string | null | undefined) => str(mime)?.split(';')[0].trim().toLowerCase() || null;

/** Extensões aceitas que o tipo e o nome informados sugerem (o conteúdo decide entre elas). */
function mediaCandidates(mimes: (string | null | undefined)[], names: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const mime of mimes) {
    const ext = EXTENSION_BY_MIME[baseMime(mime) ?? ''];
    if (ext && !out.includes(ext)) out.push(ext);
  }
  for (const name of names) {
    const raw = fileExtension(str(name) ?? '');
    const ext = raw === 'jpeg' ? 'jpg' : raw;
    if (ext in MEDIA_TYPES && !out.includes(ext)) out.push(ext);
  }
  return out;
}

/** O conteúdo tem a assinatura do tipo? (para os áudios, que `contentMatches` não conhece, confere aqui) */
function mediaContentMatches(ext: string, data: Buffer): boolean {
  const head = data.subarray(0, 12);
  switch (ext) {
    case 'ogg':
      return head.subarray(0, 4).toString('latin1') === 'OggS';
    case 'mp3':
      // marca ID3 ou início de quadro MPEG (11 bits de sincronismo)
      return head.subarray(0, 3).toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case 'm4a':
      return head.subarray(4, 8).toString('latin1') === 'ftyp';
    default:
      return contentMatches(ext, data);
  }
}

/** Arquivo recusado: a mensagem entra na conversa com este motivo no lugar do anexo. */
export class MediaRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MediaRefused';
  }
}

const typeRefused = (mime: string | null | undefined) => {
  const shown = baseMime(mime);
  // o tipo vem de quem enviou: só entra no texto se tiver cara de tipo MIME
  return `tipo de arquivo não aceito${shown && /^[\w.+-]{1,40}\/[\w.+-]{1,60}$/.test(shown) ? ` (${shown})` : ''}; aceitos: imagem, PDF, áudio, planilha e documento`;
};

const KIND_NAME: Record<WhatsAppMediaKind, { label: string; file: string; missing: string }> = {
  image: { label: 'Imagem', file: 'imagem', missing: 'Imagem não recebida' },
  video: { label: 'Vídeo', file: 'video', missing: 'Vídeo não recebido' },
  audio: { label: 'Áudio', file: 'audio', missing: 'Áudio não recebido' },
  document: { label: 'Documento', file: 'documento', missing: 'Documento não recebido' },
};

/** Texto da mensagem com mídia e sem legenda: "[Imagem]", "[Documento: informe.pdf]"... */
const mediaLabel = (m: Pick<InboundMediaRef, 'kind' | 'filename'>) => `[${KIND_NAME[m.kind].label}${m.kind === 'document' && m.filename ? `: ${m.filename}` : ''}]`;
const mediaText = (m: Pick<InboundMediaRef, 'kind' | 'filename'>, caption: unknown) => str(caption) ?? mediaLabel(m);

/**
 * Confere o arquivo recebido (tamanho, tipo aceito e assinatura do conteúdo) e monta o que vai
 * para o armazenamento, com nome seguro e a extensão do tipo conferido. Lança `MediaRefused`.
 */
export function checkMedia(ref: InboundMediaRef, got: DownloadedMedia, at: Date = new Date()): { data: Buffer; filename: string; mimeType: string } {
  const { data } = got;
  if (!data.length) throw new MediaRefused('o arquivo veio vazio');
  if (data.length > MEDIA_MAX_BYTES) throw new MediaRefused(MEDIA_TOO_LARGE);
  const candidates = mediaCandidates([got.mimeType, ref.mimeType], [ref.filename, got.filename]);
  if (!candidates.length) throw new MediaRefused(typeRefused(got.mimeType ?? ref.mimeType));
  const ext = candidates.find((e) => mediaContentMatches(e, data));
  if (!ext) throw new MediaRefused('o conteúdo do arquivo não confere com o tipo informado');
  // o nome que a instância inventa para foto e áudio (id da mensagem) não ajuda ninguém
  const given = str(ref.filename) ?? (ref.kind === 'document' ? str(got.filename) : null);
  const base = given ? safeFilename(given) : `${KIND_NAME[ref.kind].file}-whatsapp-${todayIso(at)}`;
  const current = fileExtension(base);
  const filename = current === ext || (ext === 'jpg' && current === 'jpeg') ? base : `${base.slice(0, 170)}.${ext}`;
  return { data, filename, mimeType: MEDIA_TYPES[ext] };
}

/** Tamanho informado pela Evolution (número, texto ou o Long do protobuf `{ low, high }`). */
function byteCount(v: unknown): number | null {
  const long = obj(v);
  const n = long ? Number(long.high ?? 0) * 2 ** 32 + (Number(long.low ?? 0) >>> 0) : Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Data da mensagem (segundos desde 1970); sem data ou no futuro, agora. */
function sentAt(v: unknown): Date {
  const n = Number(v);
  const now = Date.now();
  return Number.isFinite(n) && n > 0 && n * 1000 <= now ? new Date(n * 1000) : new Date(now);
}

/** Assinatura da Meta: HMAC-SHA256 do corpo exato com a chave secreta do app. */
export function validMetaSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
  return safeEqual(header.trim().toLowerCase(), expected);
}

// ---------------------------------------------------------------------------
// Evolution API
// ---------------------------------------------------------------------------
const EVOLUTION_WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];
const EVOLUTION_MEDIA: [key: string, kind: WhatsAppMediaKind][] = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['ptvMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
];

/** Mensagem de dentro dos invólucros do WhatsApp (temporária, visualização única, documento com legenda). */
function unwrapEvolution(message: Obj): Obj {
  let current = message;
  for (let depth = 0; depth < 4; depth++) {
    const inner = EVOLUTION_WRAPPERS.map((k) => obj(obj(current[k])?.message)).find(Boolean);
    if (!inner) break;
    current = inner;
  }
  return current;
}

/** Texto e mídia de uma mensagem da Evolution (Baileys); `null` para o que não é mensagem (reação, edição...). */
function evolutionContent(outer: Obj | null, type: unknown, key: Obj, data: Obj): { text: string; media?: InboundMedia } | null {
  if (!outer) return null;
  const message = unwrapEvolution(outer);
  const sub = (k: string) => obj(message[k]);
  if (str(message.conversation)) return { text: str(message.conversation)! };
  if (str(sub('extendedTextMessage')?.text)) return { text: str(sub('extendedTextMessage')?.text)! };
  if (sub('reactionMessage') || sub('protocolMessage') || sub('senderKeyDistributionMessage')) return null;
  for (const [field, kind] of EVOLUTION_MEDIA) {
    const part = sub(field);
    if (!part) continue;
    const media: InboundMedia = {
      kind,
      mimeType: str(part.mimetype),
      filename: kind === 'document' ? (str(part.fileName) ?? str(part.title)) : null,
      size: byteCount(part.fileLength),
      evolutionKey: { id: str(key.id)!, remoteJid: str(key.remoteJid), fromMe: false },
    };
    // "Webhook Base64" da instância: o conteúdo vem ao lado da mensagem
    const base64 = str(outer.base64) ?? str(message.base64) ?? str(data.base64);
    if (base64) media.base64 = base64;
    return { text: mediaText(media, part.caption), media };
  }
  if (sub('stickerMessage')) return { text: '[Figurinha]' };
  if (sub('locationMessage') || sub('liveLocationMessage')) return { text: '[Localização]' };
  if (sub('contactMessage') || sub('contactsArrayMessage')) return { text: '[Contato]' };
  return type ? { text: '[Mensagem não suportada]' } : null;
}

/** Celular do remetente: o JID com número; no endereçamento por LID, o número alternativo. */
function evolutionPhone(key: Obj): string | null {
  const jids = [key.remoteJid, key.remoteJidAlt, key.senderPn].map(str).filter((j): j is string => Boolean(j));
  // grupos, status e canais não são conversa com o cliente
  if (jids[0] && /@(g\.us|broadcast|newsletter)$/.test(jids[0])) return null;
  const phone = jids.find((j) => j.endsWith('@s.whatsapp.net'));
  return phone ? onlyDigits(phone.split('@')[0].split(':')[0]) || null : null;
}

/** Evento da Evolution deste nome e desta instância? (`MESSAGES_UPSERT` e `messages.upsert` são o mesmo) */
function evolutionEvent(payload: unknown, name: string, instance?: string): Obj | null {
  const p = obj(payload);
  if (!p || String(p.event ?? '').toLowerCase().replace(/_/g, '.') !== name) return null;
  if (instance && str(p.instance) && str(p.instance) !== instance) return null;
  return p;
}

/** Mensagens recebidas no evento `messages.upsert` da Evolution API (ignora as enviadas pelo escritório). */
export function normalizeEvolution(payload: unknown, instance?: string): InboundWhatsApp[] {
  const p = evolutionEvent(payload, 'messages.upsert', instance);
  if (!p) return [];
  const data = p.data;
  const list = Array.isArray(data) ? data : Array.isArray(obj(data)?.messages) ? (obj(data)!.messages as unknown[]) : [data];
  const out: InboundWhatsApp[] = [];
  for (const raw of list) {
    const m = obj(raw);
    const key = obj(m?.key);
    if (!m || !key || key.fromMe === true || !str(key.id)) continue;
    const from = evolutionPhone(key);
    const content = evolutionContent(obj(m.message), m.messageType, key, m);
    if (!from || !content) continue;
    out.push({ id: str(key.id)!, from, text: clip(content.text), at: sentAt(m.messageTimestamp), ...(content.media ? { media: content.media } : {}) });
  }
  return out;
}

/** Situações do Baileys, na ordem do número que ele usa (0 = erro ... 5 = áudio ouvido). */
const BAILEYS_STATUS = ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'];
/** Situação da Evolution → a mesma palavra que a Meta usa (`applyDeliveryStatuses`). */
const EVOLUTION_STATUS: Record<string, string> = { ERROR: 'failed', PENDING: 'sent', SERVER_ACK: 'sent', DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read' };
const EVOLUTION_FAILED = 'O WhatsApp informou erro no envio da mensagem pela Evolution API. Confira se o número existe e se a instância está conectada.';

/**
 * Situação dos envios no evento `messages.update` da Evolution API (ack de entrega, leitura, erro).
 * O id é o da mensagem no WhatsApp (`keyId` na v2; `key.id`/`id` em outras versões), o mesmo que o
 * envio devolveu e ficou em `deliveries.providerMessageId`.
 */
export function normalizeEvolutionStatuses(payload: unknown, instance?: string): WhatsAppStatusUpdate[] {
  const p = evolutionEvent(payload, 'messages.update', instance);
  if (!p) return [];
  const out: WhatsAppStatusUpdate[] = [];
  for (const raw of Array.isArray(p.data) ? p.data : [p.data]) {
    const u = obj(raw);
    if (!u) continue;
    const key = obj(u.key);
    const id = str(u.keyId) ?? str(key?.id) ?? str(u.id);
    // só interessam as mensagens enviadas pelo escritório
    if (!id || (u.fromMe ?? key?.fromMe) === false) continue;
    const value = u.status ?? obj(u.update)?.status;
    const name = typeof value === 'number' ? BAILEYS_STATUS[value] : str(value)?.toUpperCase();
    const status = name ? EVOLUTION_STATUS[name] : undefined;
    if (status) out.push({ id, status, error: status === 'failed' ? EVOLUTION_FAILED : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cloud API da Meta
// ---------------------------------------------------------------------------
const META_MEDIA: Record<string, WhatsAppMediaKind> = { image: 'image', video: 'video', audio: 'audio', document: 'document' };

/** Texto e mídia de uma mensagem da Cloud API; `null` para reação e mensagens de sistema. */
function metaContent(m: Obj): { text: string; media?: InboundMedia } | null {
  const type = str(m.type);
  const part = obj(type ? m[type] : null);
  const text = (t: string | null) => (t === null ? null : { text: t });
  const kind = type ? META_MEDIA[type] : undefined;
  if (kind) {
    const media: InboundMedia = { kind, mimeType: str(part?.mime_type), filename: kind === 'document' ? str(part?.filename) : null, size: null };
    // o id vai para a URL da Graph API: só o formato que a Meta usa
    const id = str(part?.id);
    if (id && /^[\w.-]{1,200}$/.test(id)) media.metaId = id;
    return { text: mediaText(media, part?.caption), media };
  }
  switch (type) {
    case 'text':
      return text(str(part?.body));
    case 'sticker':
      return text('[Figurinha]');
    case 'location':
      return text('[Localização]');
    case 'contacts':
      return text('[Contato]');
    case 'button':
      return text(str(obj(m.button)?.text));
    case 'interactive':
      return text(str(obj(part?.button_reply)?.title) ?? str(obj(part?.list_reply)?.title) ?? '[Resposta]');
    case 'reaction':
    case 'system':
    case 'request_welcome':
      return null;
    default:
      return text('[Mensagem não suportada]');
  }
}

const describeStatusError = (errors: unknown) => {
  const e = Array.isArray(errors) ? obj(errors[0]) : null;
  if (!e) return null;
  const detail = (str(obj(e.error_data)?.details) ?? str(e.message) ?? str(e.title))?.replace(/[.\s]+$/, '');
  return `A Meta não entregou a mensagem${detail ? `: ${detail}` : ''}${e.code ? ` (código ${String(e.code)})` : ''}.`.slice(0, 1000);
};

/** Mensagens e situações de entrega do webhook da Cloud API (só as do número configurado). */
export function normalizeMeta(payload: unknown, phoneNumberId?: string): { messages: InboundWhatsApp[]; statuses: WhatsAppStatusUpdate[] } {
  const out = { messages: [] as InboundWhatsApp[], statuses: [] as WhatsAppStatusUpdate[] };
  const entries = obj(payload)?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = obj(entry)?.changes;
    for (const change of Array.isArray(changes) ? changes : []) {
      const c = obj(change);
      const v = obj(c?.value);
      if (!v || (c?.field && c.field !== 'messages')) continue;
      const number = str(obj(v.metadata)?.phone_number_id);
      if (phoneNumberId && number && number !== phoneNumberId) continue;
      for (const raw of Array.isArray(v.messages) ? v.messages : []) {
        const m = obj(raw);
        const id = str(m?.id);
        const from = onlyDigits(str(m?.from));
        const content = m ? metaContent(m) : null;
        if (!m || !id || !from || !content) continue;
        out.messages.push({ id, from, text: clip(content.text), at: sentAt(m.timestamp), ...(content.media ? { media: content.media } : {}) });
      }
      for (const raw of Array.isArray(v.statuses) ? v.statuses : []) {
        const s = obj(raw);
        if (str(s?.id) && str(s?.status)) out.statuses.push({ id: str(s!.id)!, status: str(s!.status)!, error: describeStatusError(s!.errors) });
      }
    }
  }
  return out;
}

/** Clientes do escritório com este celular (com e sem 55 e nono dígito), por nome. */
export async function customersByPhone(ctx: AppContext, officeId: string, phone: string) {
  const variants = brazilPhoneVariants(phone);
  if (!variants.length) return [];
  const national = sql`regexp_replace(coalesce(${customers.mobile}, ''), '[^0-9]', '', 'g')`;
  const full = sql`regexp_replace(coalesce(${customers.mobileCountry}, '') || coalesce(${customers.mobile}, ''), '[^0-9]', '', 'g')`;
  return ctx.db
    .select({ id: customers.id, name: customers.name, responsibleUserId: customers.responsibleUserId })
    .from(customers)
    .where(and(eq(customers.officeId, officeId), isNull(customers.deletedAt), or(inArray(national, variants), inArray(full, variants))))
    .orderBy(asc(customers.name));
}

/**
 * Cliente do escritório com este celular (com e sem 55 e nono dígito). Com mais de um cliente no
 * mesmo número, fica o que recebeu a última mensagem pelo WhatsApp.
 */
export async function findCustomerByPhone(ctx: AppContext, officeId: string, phone: string) {
  const rows = await customersByPhone(ctx, officeId, phone);
  if (rows.length <= 1) return rows[0] ?? null;
  const [last] = await ctx.db
    .select({ customerId: messages.customerId })
    .from(messages)
    .where(and(eq(messages.officeId, officeId), eq(messages.channel, 'whatsapp'), inArray(messages.customerId, rows.map((r) => r.id))))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return rows.find((r) => r.id === last?.customerId) ?? rows[0];
}

// ---------------------------------------------------------------------------
// Anexo da mensagem
// ---------------------------------------------------------------------------
/** Job que baixa a mídia do provedor e a anexa à mensagem: `{ messageId, media }`. */
export const WHATSAPP_MEDIA_JOB = 'whatsapp.media';
/** Busca o arquivo no provedor do escritório (implementado em `whatsapp.ts`). */
export type MediaDownloader = (officeId: string, media: InboundMediaRef) => Promise<DownloadedMedia>;

const ownMessage = (officeId: string, messageId: string) => and(eq(messages.id, messageId), eq(messages.officeId, officeId));

async function attachMedia(ctx: AppContext, officeId: string, messageId: string, file: { data: Buffer; filename: string; mimeType: string }) {
  const saved = await ctx.files.save({ officeId, data: file.data, filename: file.filename, mimeType: file.mimeType, userId: null });
  await ctx.db
    .update(messages)
    .set({ attachments: [{ fileId: saved.id, filename: saved.filename, mimeType: saved.mimeType, size: saved.size }] })
    .where(ownMessage(officeId, messageId));
  return saved;
}

/** Sem o arquivo, a mensagem fica na conversa dizendo o motivo (no lugar de "[Imagem]" ou depois da legenda). */
async function markMediaMissing(ctx: AppContext, officeId: string, messageId: string, media: Pick<InboundMediaRef, 'kind' | 'filename'>, reason: string) {
  const row = await ctx.db.query.messages.findFirst({ where: ownMessage(officeId, messageId) });
  if (!row || row.attachments.length) return;
  const what = `${KIND_NAME[media.kind].missing}${media.kind === 'document' && media.filename ? ` (${media.filename})` : ''}`;
  const note = `[${what}: ${reason.replace(/[.\s]+$/, '')}.]`;
  if (row.body.includes(note)) return;
  const body = row.body === clip(mediaLabel(media)) ? note : `${row.body}\n${note}`;
  await ctx.db.update(messages).set({ body: clip(body) }).where(ownMessage(officeId, messageId));
}

/**
 * Mídia de uma mensagem recém-gravada: o que veio no webhook (base64) é anexado na hora; o que
 * precisa ser buscado no provedor vai para a fila, para o webhook responder logo. Nunca lança:
 * o que não dá para receber fica explicado no texto da mensagem.
 */
async function receiveMedia(ctx: AppContext, officeId: string, messageId: string, m: InboundWhatsApp & { media: InboundMedia }) {
  const { base64, size, ...ref } = m.media;
  try {
    if (size !== null && size > MEDIA_MAX_BYTES) throw new MediaRefused(MEDIA_TOO_LARGE);
    // tipo que já se sabe recusado (vídeo, por exemplo) nem é baixado
    if ((ref.mimeType || ref.filename) && !mediaCandidates([ref.mimeType], [ref.filename]).length) throw new MediaRefused(typeRefused(ref.mimeType));
    if (base64) {
      const content = base64.replace(/^data:[^,]{0,200},/, '');
      if (content.length > Math.ceil(MEDIA_MAX_BYTES / 3) * 4 + 4) throw new MediaRefused(MEDIA_TOO_LARGE);
      await attachMedia(ctx, officeId, messageId, checkMedia(ref, { data: Buffer.from(content, 'base64') }, m.at));
      return;
    }
    if (!ref.metaId && !ref.evolutionKey) throw new MediaRefused('o WhatsApp não informou onde buscar o arquivo');
    await ctx.jobs.enqueue(WHATSAPP_MEDIA_JOB, { messageId, media: ref }, { officeId, idempotencyKey: messageId });
  } catch (err) {
    if (!(err instanceof MediaRefused)) ctx.reportError(err, { source: 'http', route: '/api/webhooks/whatsapp/:token', officeId });
    const reason = err instanceof MediaRefused ? err.message : 'não foi possível guardar o arquivo; peça para o cliente enviar de novo';
    await markMediaMissing(ctx, officeId, messageId, ref, reason).catch(() => undefined);
  }
}

/** Referência da mídia guardada no job (lida com cuidado: o job pode ter sido criado por outra versão). */
function mediaRefOf(v: unknown): InboundMediaRef | null {
  const o = obj(v);
  const kind = str(o?.kind) as WhatsAppMediaKind | null;
  if (!o || !kind || !(kind in KIND_NAME)) return null;
  const key = obj(o.evolutionKey);
  return {
    kind,
    mimeType: str(o.mimeType),
    filename: str(o.filename),
    ...(str(o.metaId) ? { metaId: str(o.metaId)! } : {}),
    ...(key && str(key.id) ? { evolutionKey: { id: str(key.id)!, remoteJid: str(key.remoteJid), fromMe: key.fromMe === true } } : {}),
  };
}

/** Erro do provedor que repetir não resolve (mídia expirada, credencial recusada, requisição recusada). */
const permanentDownloadError = (err: IntegrationError) =>
  err.message.startsWith('Credenciais recusadas') || (err.status !== undefined && err.status >= 400 && err.status < 500 && ![408, 425, 429].includes(err.status));

/**
 * Executor do job `whatsapp.media`: baixa, confere e anexa o arquivo à mensagem. Recusa (tamanho,
 * tipo) e erro definitivo do provedor viram o motivo no texto da mensagem; falha passageira é
 * repetida pela fila e, na última tentativa, também vira o motivo.
 */
export async function runMediaJob(ctx: AppContext, job: JobRow, download: MediaDownloader) {
  const officeId = job.officeId ?? '';
  const messageId = String(job.payload.messageId ?? '');
  const media = mediaRefOf(job.payload.media);
  if (!officeId || !messageId || !media) throw new PermanentJobError('Job whatsapp.media sem escritório, mensagem ou mídia.');
  const row = await ctx.db.query.messages.findFirst({ where: ownMessage(officeId, messageId) });
  if (!row) return { attached: false, skipped: 'mensagem removida' };
  if (row.attachments.length) return { attached: true, skipped: 'já anexado' };
  try {
    const file = checkMedia(media, await download(officeId, media), row.createdAt);
    const saved = await attachMedia(ctx, officeId, messageId, file);
    return { attached: true, fileId: saved.id, size: saved.size };
  } catch (err) {
    const lastAttempt = job.attempts >= job.maxAttempts;
    const reason =
      err instanceof MediaRefused
        ? err.message
        : err instanceof IntegrationError && (lastAttempt || permanentDownloadError(err))
          ? `não foi possível baixar o arquivo: ${err.message}`
          : null;
    if (reason === null) throw err;
    await markMediaMissing(ctx, officeId, messageId, media, reason);
    return { attached: false, reason };
  }
}

/** Falha final do job por outro motivo (erro inesperado, servidor reiniciado): a mensagem também fica explicada. */
export async function mediaJobFailed(ctx: AppContext, job: JobRow) {
  const media = mediaRefOf(job.payload.media);
  if (!job.officeId || !media) return;
  await markMediaMissing(ctx, job.officeId, String(job.payload.messageId ?? ''), media, 'não foi possível baixar o arquivo; peça para o cliente enviar de novo');
}

/** Grava as mensagens recebidas na conversa de cada cliente e avisa o responsável. */
export async function storeInbound(ctx: AppContext, officeId: string, list: InboundWhatsApp[]) {
  let stored = 0;
  let unknown = 0;
  for (const m of list) {
    const customer = await findCustomerByPhone(ctx, officeId, m.from);
    if (!customer) {
      unknown += 1;
      continue;
    }
    const [row] = await ctx.db
      .insert(messages)
      .values({ officeId, customerId: customer.id, direction: 'in', channel: 'whatsapp', body: m.text, externalId: m.id, createdAt: m.at })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    // o provedor reenvia o que não teve resposta a tempo: a mesma mensagem não entra duas vezes
    if (!row) continue;
    stored += 1;
    if (m.media) await receiveMedia(ctx, officeId, row.id, { ...m, media: m.media });
    const link = `/clientes/${customer.id}/mensagens`;
    const [{ n }] = await ctx.db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.officeId, officeId), eq(notifications.link, link), isNull(notifications.readAt), gte(notifications.createdAt, new Date(Date.now() - NOTIFY_COALESCE_MS))));
    if (!n) {
      await notify(ctx.db, {
        officeId,
        userId: customer.responsibleUserId ?? null,
        customerId: customer.id,
        title: `Nova mensagem de ${customer.name} pelo WhatsApp`,
        body: m.text.length > 140 ? `${m.text.slice(0, 139)}…` : m.text,
        link,
      });
    }
  }
  return { stored, unknown };
}

/**
 * Situação dos envios informada pelo provedor (status da Meta ou ack da Evolution): entregue ou
 * falhou (ex.: fora da janela de 24 h). Casa pelo id da mensagem no provedor e nunca volta atrás:
 * "entregue" só sai de "enviado", e um erro que chega depois da entrega não desfaz a entrega.
 */
export async function applyDeliveryStatuses(ctx: AppContext, officeId: string, statuses: WhatsAppStatusUpdate[]) {
  for (const s of statuses) {
    const sameMessage = and(eq(deliveries.officeId, officeId), eq(deliveries.channel, 'whatsapp'), eq(deliveries.providerMessageId, s.id));
    if (s.status === 'failed') {
      await ctx.db
        .update(deliveries)
        .set({ status: 'failed', error: s.error ?? 'A Meta não entregou a mensagem.' })
        .where(and(sameMessage, ne(deliveries.status, 'delivered')));
    } else if (s.status === 'delivered' || s.status === 'read') {
      await ctx.db.update(deliveries).set({ status: 'delivered' }).where(and(sameMessage, eq(deliveries.status, 'sent')));
    }
  }
}
