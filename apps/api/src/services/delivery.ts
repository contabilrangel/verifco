import { and, eq, inArray, sql } from 'drizzle-orm';
import { getTemplateDef, renderTemplate, onlyDigits, type DeliveryChannel } from '@verifco/shared';
import type { AppContext } from '../context';
import { customers, deliveries, emailTemplates, jobs, messages, offices, users } from '../db/schema';
import { badRequest } from '../lib/errors';

export type DeliveryRow = typeof deliveries.$inferSelect;
type OfficeRow = typeof offices.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;

/** Template efetivo do escritório: o personalizado ou o padrão do sistema. */
export async function resolveTemplate(ctx: AppContext, officeId: string, key: string) {
  const def = getTemplateDef(key);
  if (!def) throw badRequest(`Template desconhecido: ${key}`);
  const custom = await ctx.db.query.emailTemplates.findFirst({
    where: and(eq(emailTemplates.officeId, officeId), eq(emailTemplates.key, key)),
  });
  return { def, subject: custom?.subject ?? def.defaultSubject, body: custom?.body ?? def.defaultBody, customized: Boolean(custom) };
}

/** Valores comuns a todos os templates a partir das linhas já carregadas. */
function templateValuesOf(office: OfficeRow | null | undefined, customer: CustomerRow | null | undefined, responsibleName: string | null | undefined, exerciseYear?: number) {
  const year = exerciseYear ?? new Date().getFullYear();
  return {
    CLIENTE: customer?.name ?? '',
    ESCRITORIO: office?.name ?? '',
    CONTADOR: responsibleName ?? office?.name ?? '',
    ANO_EXERCICIO: year,
    ANO_CALENDARIO: year - 1,
    ANO_ANTERIOR: year - 1,
    PROXIMO_ANO: year + 1,
    WHATSAPP: office?.settings?.whatsappServiceNumber ?? '',
    CPF_CONTADOR: office?.cpfCnpj ?? '',
  } as Record<string, string | number>;
}

/** Valores comuns a todos os templates (cliente, escritório, contador, anos). */
export async function baseTemplateValues(ctx: AppContext, officeId: string, customerId: string | null, exerciseYear?: number) {
  const office = await ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId) });
  const customer = customerId ? await ctx.db.query.customers.findFirst({ where: eq(customers.id, customerId) }) : null;
  const responsible = customer?.responsibleUserId ? await ctx.db.query.users.findFirst({ where: eq(users.id, customer.responsibleUserId) }) : null;
  return templateValuesOf(office, customer, responsible?.name, exerciseYear);
}

/** Destino do envio para o cliente: o e-mail ou o celular com DDI (só dígitos). */
export function customerAddress(customer: Pick<CustomerRow, 'email' | 'mobile' | 'mobileCountry'>, channel: DeliveryChannel): string | null {
  if (channel === 'email') return customer.email?.trim() || null;
  return customer.mobile?.trim() ? `${onlyDigits(customer.mobileCountry ?? '55')}${onlyDigits(customer.mobile)}` : null;
}

// ---------------------------------------------------------------------------
// HTML → texto (WhatsApp, histórico das mensagens e prévia da mala direta)
// ---------------------------------------------------------------------------

/** Entidades nomeadas comuns em textos em português (as numéricas são decodificadas à parte). */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ordm: 'º', ordf: 'ª', deg: '°', copy: '©', reg: '®', euro: '€',
  aacute: 'á', Aacute: 'Á', eacute: 'é', Eacute: 'É', iacute: 'í', Iacute: 'Í', oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú',
  acirc: 'â', Acirc: 'Â', ecirc: 'ê', Ecirc: 'Ê', ocirc: 'ô', Ocirc: 'Ô', atilde: 'ã', Atilde: 'Ã', otilde: 'õ', Otilde: 'Õ',
  agrave: 'à', Agrave: 'À', ccedil: 'ç', Ccedil: 'Ç', uuml: 'ü', Uuml: 'Ü',
};

/** Decodifica as entidades HTML numa passada só (`&amp;lt;` vira `&lt;`, não `<`). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isFinite(code) || code > 0x10ffff) return match;
    // caracteres de controle (exceto tabulação e quebra de linha) não viram texto
    if (code < 32 && code !== 9 && code !== 10) return '';
    return code === 160 ? ' ' : String.fromCodePoint(code);
  });
}

/** Marcadores internos: início/fim de bloco (quebra de linha) e de parágrafo (linha em branco). */
const LINE = '\u0001';
const PARAGRAPH = '\u0002';

/** Link como texto: "texto: endereço", ou só o endereço quando o texto é o próprio endereço. */
function linkText(href: string, inner: string): string {
  const url = decodeEntities(href.trim());
  const label = decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  if (!url || url.startsWith('#')) return inner;
  const bare = (u: string) => u.replace(/^(https?:\/\/|mailto:|tel:)/i, '').replace(/\/$/, '').toLowerCase();
  if (!label || bare(label) === bare(url)) return ` ${url} `;
  if (/^(mailto|tel):/i.test(url)) return `${inner} (${url.replace(/^(mailto|tel):/i, '')})`;
  return `${inner}: ${url}`;
}

/**
 * Converte o HTML dos templates (e do editor rico) no texto do WhatsApp: o mesmo gravado no
 * histórico e mostrado na prévia da mala direta. Segue o que o e-mail mostra: espaços e quebras
 * do código-fonte não contam; `<br>` quebra a linha; `<div>`, `<li>` e linhas de tabela começam
 * linha nova; parágrafos, títulos e listas ficam separados por uma linha em branco; links viram
 * "texto: endereço"; todas as entidades (inclusive `&#39;` e `&quot;`, que o `renderTemplate`
 * usa ao escapar os valores) voltam a ser caracteres.
 */
export function htmlToText(html: string): string {
  const marked = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/[\u0001\u0002]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, h1?: string, h2?: string, h3?: string, inner = '') =>
      linkText(h1 ?? h2 ?? h3 ?? '', inner),
    )
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, `${LINE}• `)
    .replace(/<\/?(p|h[1-6]|ul|ol|table|blockquote|pre)\b[^>]*>/gi, PARAGRAPH)
    .replace(/<\/?(div|li|tr|dl|dt|dd|hr|center|caption|thead|tbody|tfoot)\b[^>]*>/gi, LINE)
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return (
    decodeEntities(marked)
      // cada sequência de quebras vira 0, 1 ou 2 linhas: cada <br> conta uma; início/fim de bloco
      // garante ao menos uma; início/fim de parágrafo, uma linha em branco
      .replace(/[ \t]*[\n\u0001\u0002][\n\u0001\u0002 \t]*/g, (run) => {
        const breaks = (run.match(/\n/g) ?? []).length;
        const paragraph = run.includes(PARAGRAPH);
        const block = paragraph || run.includes(LINE);
        return '\n'.repeat(Math.min(2, Math.max(paragraph ? 2 : 0, breaks + (block ? 1 : 0))));
      })
      .replace(/ {2,}/g, ' ')
      .trim()
  );
}

export interface QueueDeliveryInput {
  officeId: string;
  customerId: string | null;
  channel: DeliveryChannel;
  /** Template do catálogo; sem template, informe subject/body prontos. */
  templateKey?: string;
  values?: Record<string, string | number | null | undefined>;
  rawHtml?: string[];
  subject?: string;
  body?: string;
  /** Destino explícito; por padrão usa o e-mail/celular do cliente. */
  to?: string;
  attachments?: { fileId: string; filename: string }[];
  idempotencyKey?: string;
  userId?: string | null;
  exerciseYear?: number;
  /**
   * Trechos secretos (código de acesso, token do link): vão só na mensagem entregue. O que fica
   * gravado em `deliveries.body` e `messages.body` traz a versão mascarada; a versão real segue
   * cifrada no job de envio e é apagada depois que o envio dá certo.
   */
  redact?: string[];
}

/** Máscara gravada no lugar dos trechos secretos. */
export const REDACTED = '••••••';

/** Troca cada trecho secreto pela máscara. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join(REDACTED);
  return out;
}

const JOB_TYPE = 'delivery.send';

/**
 * Registra um envio e agenda o job que entrega por e-mail ou WhatsApp.
 * Com `idempotencyKey`, a mesma operação repetida não gera um segundo envio.
 */
export async function queueDelivery(ctx: AppContext, input: QueueDeliveryInput): Promise<DeliveryRow> {
  const { db } = ctx;
  if (input.idempotencyKey) {
    const existing = await db.query.deliveries.findFirst({
      where: and(eq(deliveries.officeId, input.officeId), eq(deliveries.idempotencyKey, input.idempotencyKey)),
    });
    if (existing) return existing;
  }
  const customer = input.customerId ? await db.query.customers.findFirst({ where: eq(customers.id, input.customerId) }) : null;
  let to = input.to ?? null;
  if (!to && customer) to = customerAddress(customer, input.channel);
  if (!to) throw badRequest(input.channel === 'email' ? 'O cliente não tem e-mail cadastrado.' : 'O cliente não tem celular cadastrado.');

  let subject = input.subject ?? '';
  let body = input.body ?? '';
  if (input.templateKey) {
    const tpl = await resolveTemplate(ctx, input.officeId, input.templateKey);
    const values = { ...(await baseTemplateValues(ctx, input.officeId, input.customerId, input.exerciseYear)), ...(input.values ?? {}) };
    subject = renderTemplate(tpl.subject, values, { html: false });
    body = renderTemplate(tpl.body, values, { rawHtml: input.rawHtml });
  }
  if (input.channel === 'whatsapp') body = htmlToText(body);
  const secrets = (input.redact ?? []).filter((v) => v.length >= 4);
  const storedSubject = redactSecrets(subject, secrets);
  const storedBody = redactSecrets(body, secrets);
  const sealed = storedSubject !== subject || storedBody !== body ? ctx.secrets.encrypt(JSON.stringify({ subject, body })) : undefined;

  const [row] = await db
    .insert(deliveries)
    .values({
      officeId: input.officeId,
      customerId: input.customerId,
      channel: input.channel,
      templateKey: input.templateKey ?? null,
      subject: storedSubject,
      toAddress: to,
      toName: customer?.name ?? null,
      body: storedBody,
      attachments: input.attachments ?? [],
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.userId ?? null,
    })
    .returning();
  if (input.channel === 'whatsapp' && input.customerId) {
    await db.insert(messages).values({
      officeId: input.officeId,
      customerId: input.customerId,
      direction: 'out',
      channel: 'whatsapp',
      body: storedBody,
      authorUserId: input.userId ?? null,
      deliveryId: row.id,
    });
  }
  await ctx.jobs.enqueue(JOB_TYPE, sealed ? { deliveryId: row.id, sealed } : { deliveryId: row.id }, { officeId: input.officeId, idempotencyKey: row.id });
  return row;
}

/** Um envio de {@link queueDeliveries}: o cliente já carregado e os valores dele. */
export interface BulkDeliveryItem {
  customer: CustomerRow;
  channel: DeliveryChannel;
  values?: Record<string, string | number | null | undefined>;
  rawHtml?: string[];
  /** Trechos secretos, como em {@link QueueDeliveryInput.redact}. */
  redact?: string[];
  attachments?: { fileId: string; filename: string }[];
  idempotencyKey: string;
}

const BULK_CHUNK = 500;

/**
 * Vários envios de um mesmo template de uma vez (mala direta), sem uma ida ao banco por envio:
 * template, escritório e responsáveis são lidos uma vez, e envios, mensagens do WhatsApp e jobs
 * entram em lote. Mesma regra de {@link queueDelivery} para o texto, o destino e os trechos
 * secretos. Chave de idempotência já usada é ignorada (o envio não se repete), e cliente sem o
 * contato do canal fica de fora. Devolve os envios novos.
 */
export async function queueDeliveries(
  ctx: AppContext,
  input: { officeId: string; templateKey: string; exerciseYear?: number; userId?: string | null; items: BulkDeliveryItem[] },
): Promise<{ id: string; customerId: string | null; channel: string; idempotencyKey: string | null }[]> {
  const { db } = ctx;
  if (!input.items.length) return [];
  const tpl = await resolveTemplate(ctx, input.officeId, input.templateKey);
  const office = await db.query.offices.findFirst({ where: eq(offices.id, input.officeId) });
  const responsibleIds = [...new Set(input.items.map((i) => i.customer.responsibleUserId).filter((x): x is string => Boolean(x)))];
  const responsible = new Map<string, string>();
  for (let i = 0; i < responsibleIds.length; i += BULK_CHUNK) {
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, responsibleIds.slice(i, i + BULK_CHUNK)));
    for (const r of rows) responsible.set(r.id, r.name);
  }

  const prepared = input.items.flatMap((item) => {
    const to = customerAddress(item.customer, item.channel);
    if (!to) return [];
    const values = { ...templateValuesOf(office, item.customer, item.customer.responsibleUserId ? responsible.get(item.customer.responsibleUserId) : null, input.exerciseYear), ...(item.values ?? {}) };
    const subject = renderTemplate(tpl.subject, values, { html: false });
    let body = renderTemplate(tpl.body, values, { rawHtml: item.rawHtml });
    if (item.channel === 'whatsapp') body = htmlToText(body);
    const secrets = (item.redact ?? []).filter((v) => v.length >= 4);
    const storedSubject = redactSecrets(subject, secrets);
    const storedBody = redactSecrets(body, secrets);
    const sealed = storedSubject !== subject || storedBody !== body ? ctx.secrets.encrypt(JSON.stringify({ subject, body })) : undefined;
    return [
      {
        sealed,
        row: {
          officeId: input.officeId,
          customerId: item.customer.id,
          channel: item.channel,
          templateKey: input.templateKey,
          subject: storedSubject,
          toAddress: to,
          toName: item.customer.name,
          body: storedBody,
          attachments: item.attachments ?? [],
          idempotencyKey: item.idempotencyKey,
          createdByUserId: input.userId ?? null,
        },
      },
    ];
  });

  const sealedByKey = new Map(prepared.map((p) => [p.row.idempotencyKey, p.sealed]));
  // envio, mensagem da conversa e job entram juntos: nunca fica um envio sem o job que o entrega
  const created = await db.transaction(async (tx) => {
    const rows: { id: string; customerId: string | null; channel: string; idempotencyKey: string | null; body: string }[] = [];
    for (let i = 0; i < prepared.length; i += BULK_CHUNK) {
      const chunk = await tx
        .insert(deliveries)
        .values(prepared.slice(i, i + BULK_CHUNK).map((p) => p.row))
        .onConflictDoNothing({ target: [deliveries.officeId, deliveries.idempotencyKey] })
        .returning({ id: deliveries.id, customerId: deliveries.customerId, channel: deliveries.channel, idempotencyKey: deliveries.idempotencyKey, body: deliveries.body });
      rows.push(...chunk);
    }
    for (let i = 0; i < rows.length; i += BULK_CHUNK) {
      const chunk = rows.slice(i, i + BULK_CHUNK);
      const chats = chunk.filter((d) => d.channel === 'whatsapp' && d.customerId);
      if (chats.length) {
        await tx
          .insert(messages)
          .values(chats.map((d) => ({ officeId: input.officeId, customerId: d.customerId!, direction: 'out', channel: 'whatsapp', body: d.body, authorUserId: input.userId ?? null, deliveryId: d.id })));
      }
      // mesmos campos de ctx.jobs.enqueue(JOB_TYPE, ...), com a mesma chave (o id do envio)
      await tx
        .insert(jobs)
        .values(
          chunk.map((d) => {
            const sealed = d.idempotencyKey ? sealedByKey.get(d.idempotencyKey) : undefined;
            return { type: JOB_TYPE, officeId: input.officeId, payload: sealed ? { deliveryId: d.id, sealed } : { deliveryId: d.id }, idempotencyKey: d.id };
          }),
        )
        .onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] });
    }
    return rows;
  });
  return created.map(({ body: _body, ...rest }) => rest);
}

/** Conteúdo real (cifrado) guardado no job original do envio, se houver trechos secretos. */
async function sealedContent(ctx: AppContext, deliveryId: string) {
  const job = await ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, JOB_TYPE), eq(jobs.idempotencyKey, deliveryId)) });
  const sealed = job?.payload?.sealed;
  if (typeof sealed !== 'string') return null;
  try {
    return { jobId: job!.id, content: JSON.parse(ctx.secrets.decrypt(sealed)) as { subject: string; body: string } };
  } catch {
    return null;
  }
}

/** Executor do job: entrega e registra o resultado. */
export async function sendDeliveryJob(ctx: AppContext, deliveryId: string) {
  const { db } = ctx;
  const d = await db.query.deliveries.findFirst({ where: eq(deliveries.id, deliveryId) });
  if (!d || d.status === 'sent' || d.status === 'delivered') return { skipped: true };
  const office = await db.query.offices.findFirst({ where: eq(offices.id, d.officeId) });
  const files = await Promise.all(d.attachments.map(async (a) => ({ a, f: await ctx.files.get(d.officeId, a.fileId) })));
  const secret = await sealedContent(ctx, d.id);
  const subject = secret?.content.subject ?? d.subject ?? '';
  const body = secret?.content.body ?? d.body;
  try {
    let result: { messageId: string };
    if (d.channel === 'email') {
      result = await ctx.providers.email.send(d.officeId, {
        to: d.toAddress,
        toName: d.toName,
        subject,
        html: body,
        fromName: office?.name,
        replyTo: office?.email,
        attachments: files.map(({ a, f }) => ({ filename: a.filename, content: f.data, contentType: f.row.mimeType })),
      });
    } else {
      const first = files[0];
      result = await ctx.providers.whatsapp.send(d.officeId, {
        to: d.toAddress,
        text: body,
        document: first ? { filename: first.a.filename, content: first.f.data, contentType: first.f.row.mimeType } : undefined,
      });
    }
    await db.update(deliveries).set({ status: 'sent', sentAt: new Date(), providerMessageId: result.messageId, error: null }).where(eq(deliveries.id, d.id));
    // entregue: a versão com o código não fica guardada nem cifrada
    if (secret) await db.update(jobs).set({ payload: sql`${jobs.payload} - 'sealed'` }).where(eq(jobs.id, secret.jobId));
    return { messageId: result.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(deliveries).set({ status: 'failed', error: message }).where(eq(deliveries.id, d.id));
    throw err;
  }
}
