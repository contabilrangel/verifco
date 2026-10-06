/**
 * Respostas dos clientes pelo WhatsApp (webhook): viram mensagens `in` (canal `whatsapp`) na
 * conversa do cliente e avisam o responsável no sino.
 *
 * Evolution API v2 (webhook da instância, evento MESSAGES_UPSERT; código em
 * src/api/integrations/event/webhook/webhook.controller.ts e whatsapp.baileys.service.ts):
 *   `{ event: 'messages.upsert', instance, data: { key: { remoteJid, fromMe, id, remoteJidAlt? },
 *      pushName, message: { conversation | imageMessage.caption | ... }, messageType, messageTimestamp } }`.
 * WhatsApp Cloud API (Meta), campo `messages` do webhook:
 *   `{ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
 *      metadata: { phone_number_id }, contacts: [{ wa_id, profile: { name } }],
 *      messages: [{ from, id, timestamp, type, text: { body } }], statuses: [{ id, status, errors }] } }] }] }`,
 *   assinado em `X-Hub-Signature-256: sha256=<HMAC-SHA256 do corpo com a chave secreta do app>`.
 */
import { createHmac } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { brazilPhoneVariants, onlyDigits } from '@verifco/shared';
import type { AppContext } from '../context';
import { customers, deliveries, messages, notifications } from '../db/schema';
import { safeEqual } from '../lib/crypto';
import { notify } from '../services/notify';

export interface InboundWhatsApp {
  /** Id da mensagem no provedor (o reenvio do webhook não duplica). */
  id: string;
  /** Celular de quem escreveu (só dígitos, como o provedor informou). */
  from: string;
  text: string;
  at: Date;
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
const withCaption = (label: string, caption: unknown) => (str(caption) ? `${label} ${str(caption)}` : label);

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

/** Texto de uma mensagem da Evolution (Baileys); `null` para o que não é mensagem (reação, edição...). */
function evolutionText(message: Obj | null, type: unknown): string | null {
  if (!message) return null;
  const sub = (k: string) => obj(message[k]);
  if (str(message.conversation)) return str(message.conversation);
  if (str(sub('extendedTextMessage')?.text)) return str(sub('extendedTextMessage')?.text);
  if (sub('reactionMessage') || sub('protocolMessage') || sub('senderKeyDistributionMessage')) return null;
  if (sub('imageMessage')) return withCaption('[Imagem]', sub('imageMessage')?.caption);
  if (sub('videoMessage')) return withCaption('[Vídeo]', sub('videoMessage')?.caption);
  if (sub('documentMessage')) {
    const doc = sub('documentMessage')!;
    return withCaption(`[Documento${str(doc.fileName) ? `: ${str(doc.fileName)}` : ''}]`, doc.caption);
  }
  if (sub('audioMessage')) return '[Áudio]';
  if (sub('stickerMessage')) return '[Figurinha]';
  if (sub('locationMessage')) return '[Localização]';
  if (sub('contactMessage') || sub('contactsArrayMessage')) return '[Contato]';
  return type ? '[Mensagem não suportada]' : null;
}

/** Celular do remetente: o JID com número; no endereçamento por LID, o número alternativo. */
function evolutionPhone(key: Obj): string | null {
  const jids = [key.remoteJid, key.remoteJidAlt, key.senderPn].map(str).filter((j): j is string => Boolean(j));
  // grupos, status e canais não são conversa com o cliente
  if (jids[0] && /@(g\.us|broadcast|newsletter)$/.test(jids[0])) return null;
  const phone = jids.find((j) => j.endsWith('@s.whatsapp.net'));
  return phone ? onlyDigits(phone.split('@')[0].split(':')[0]) || null : null;
}

/** Mensagens recebidas no evento `messages.upsert` da Evolution API (ignora as enviadas pelo escritório). */
export function normalizeEvolution(payload: unknown, instance?: string): InboundWhatsApp[] {
  const p = obj(payload);
  if (!p || String(p.event ?? '').toLowerCase().replace(/_/g, '.') !== 'messages.upsert') return [];
  if (instance && str(p.instance) && str(p.instance) !== instance) return [];
  const data = p.data;
  const list = Array.isArray(data) ? data : Array.isArray(obj(data)?.messages) ? (obj(data)!.messages as unknown[]) : [data];
  const out: InboundWhatsApp[] = [];
  for (const raw of list) {
    const m = obj(raw);
    const key = obj(m?.key);
    if (!m || !key || key.fromMe === true || !str(key.id)) continue;
    const from = evolutionPhone(key);
    const text = evolutionText(obj(m.message), m.messageType);
    if (!from || text === null) continue;
    out.push({ id: str(key.id)!, from, text: clip(text), at: sentAt(m.messageTimestamp) });
  }
  return out;
}

/** Texto de uma mensagem da Cloud API; `null` para reação e mensagens de sistema. */
function metaText(m: Obj): string | null {
  const type = str(m.type);
  const part = obj(type ? m[type] : null);
  switch (type) {
    case 'text':
      return str(part?.body);
    case 'image':
      return withCaption('[Imagem]', part?.caption);
    case 'video':
      return withCaption('[Vídeo]', part?.caption);
    case 'document':
      return withCaption(`[Documento${str(part?.filename) ? `: ${str(part?.filename)}` : ''}]`, part?.caption);
    case 'audio':
      return '[Áudio]';
    case 'sticker':
      return '[Figurinha]';
    case 'location':
      return '[Localização]';
    case 'contacts':
      return '[Contato]';
    case 'button':
      return str(obj(m.button)?.text);
    case 'interactive':
      return str(obj(part?.button_reply)?.title) ?? str(obj(part?.list_reply)?.title) ?? '[Resposta]';
    case 'reaction':
    case 'system':
    case 'request_welcome':
      return null;
    default:
      return '[Mensagem não suportada]';
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
        const text = m ? metaText(m) : null;
        if (!m || !id || !from || text === null) continue;
        out.messages.push({ id, from, text: clip(text), at: sentAt(m.timestamp) });
      }
      for (const raw of Array.isArray(v.statuses) ? v.statuses : []) {
        const s = obj(raw);
        if (str(s?.id) && str(s?.status)) out.statuses.push({ id: str(s!.id)!, status: str(s!.status)!, error: describeStatusError(s!.errors) });
      }
    }
  }
  return out;
}

/**
 * Cliente do escritório com este celular (com e sem 55 e nono dígito). Com mais de um cliente no
 * mesmo número, fica o que recebeu a última mensagem pelo WhatsApp.
 */
export async function findCustomerByPhone(ctx: AppContext, officeId: string, phone: string) {
  const variants = brazilPhoneVariants(phone);
  if (!variants.length) return null;
  const national = sql`regexp_replace(coalesce(${customers.mobile}, ''), '[^0-9]', '', 'g')`;
  const full = sql`regexp_replace(coalesce(${customers.mobileCountry}, '') || coalesce(${customers.mobile}, ''), '[^0-9]', '', 'g')`;
  const rows = await ctx.db
    .select({ id: customers.id, name: customers.name, responsibleUserId: customers.responsibleUserId })
    .from(customers)
    .where(and(eq(customers.officeId, officeId), isNull(customers.deletedAt), or(inArray(national, variants), inArray(full, variants))))
    .orderBy(asc(customers.name));
  if (rows.length <= 1) return rows[0] ?? null;
  const [last] = await ctx.db
    .select({ customerId: messages.customerId })
    .from(messages)
    .where(and(eq(messages.officeId, officeId), eq(messages.channel, 'whatsapp'), inArray(messages.customerId, rows.map((r) => r.id))))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return rows.find((r) => r.id === last?.customerId) ?? rows[0];
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

/** Situação dos envios informada pela Meta: entregue ou falhou (ex.: fora da janela de 24 h). */
export async function applyDeliveryStatuses(ctx: AppContext, officeId: string, statuses: WhatsAppStatusUpdate[]) {
  for (const s of statuses) {
    const sameMessage = and(eq(deliveries.officeId, officeId), eq(deliveries.channel, 'whatsapp'), eq(deliveries.providerMessageId, s.id));
    if (s.status === 'failed') {
      await ctx.db.update(deliveries).set({ status: 'failed', error: s.error ?? 'A Meta não entregou a mensagem.' }).where(sameMessage);
    } else if (s.status === 'delivered' || s.status === 'read') {
      await ctx.db.update(deliveries).set({ status: 'delivered' }).where(and(sameMessage, eq(deliveries.status, 'sent')));
    }
  }
}
