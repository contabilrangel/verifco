import { and, eq, inArray, sql } from 'drizzle-orm';
import { getTemplateDef, htmlToText, renderTemplate, onlyDigits, type DeliveryChannel } from '@verifco/shared';
import type { AppContext } from '../context';
import { customers, deliveries, emailTemplates, jobs, messages, offices, users } from '../db/schema';
import { badRequest } from '../lib/errors';

export type DeliveryRow = typeof deliveries.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;
type OfficeRow = typeof offices.$inferSelect;
type TemplateValues = Record<string, string | number | null | undefined>;

/** Template efetivo do escritório: o personalizado ou o padrão do sistema. */
export async function resolveTemplate(ctx: AppContext, officeId: string, key: string) {
  const def = getTemplateDef(key);
  if (!def) throw badRequest(`Template desconhecido: ${key}`);
  const custom = await ctx.db.query.emailTemplates.findFirst({
    where: and(eq(emailTemplates.officeId, officeId), eq(emailTemplates.key, key)),
  });
  return { def, subject: custom?.subject ?? def.defaultSubject, body: custom?.body ?? def.defaultBody, customized: Boolean(custom) };
}

/** Valores comuns a todos os templates a partir do escritório, do cliente e do nome do responsável já carregados. */
function commonValues(office: OfficeRow | null | undefined, customer: CustomerRow | null | undefined, responsibleName: string | null | undefined, exerciseYear?: number) {
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
  return commonValues(office, customer, responsible?.name, exerciseYear);
}

/** Destino do cliente no canal: o e-mail ou o celular com o código do país, só dígitos. */
function addressOf(customer: CustomerRow | null | undefined, channel: DeliveryChannel): string | null {
  if (!customer) return null;
  if (channel === 'email') return customer.email || null;
  return customer.mobile ? `${onlyDigits(customer.mobileCountry ?? '55')}${onlyDigits(customer.mobile)}` : null;
}

/** Assunto e corpo do template com os valores (escapados para HTML); no WhatsApp, o corpo vai em texto simples. */
function renderContent(tpl: { subject: string; body: string }, values: TemplateValues, channel: DeliveryChannel, rawHtml?: string[]) {
  const body = renderTemplate(tpl.body, values, { rawHtml });
  return { subject: renderTemplate(tpl.subject, values, { html: false }), body: channel === 'whatsapp' ? htmlToText(body) : body };
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

/** O que fica gravado (segredos mascarados) e, havendo segredo, a versão real cifrada para o job de envio. */
function protect(ctx: AppContext, content: { subject: string; body: string }, redact: string[] | undefined) {
  const secrets = (redact ?? []).filter((v) => v.length >= 4);
  const storedSubject = redactSecrets(content.subject, secrets);
  const storedBody = redactSecrets(content.body, secrets);
  const sealed = storedSubject !== content.subject || storedBody !== content.body ? ctx.secrets.encrypt(JSON.stringify(content)) : undefined;
  return { storedSubject, storedBody, sealed };
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
  const to = input.to || addressOf(customer, input.channel);
  if (!to) throw badRequest(input.channel === 'email' ? 'O cliente não tem e-mail cadastrado.' : 'O cliente não tem celular cadastrado.');

  let content = { subject: input.subject ?? '', body: input.body ?? '' };
  if (input.templateKey) {
    const tpl = await resolveTemplate(ctx, input.officeId, input.templateKey);
    const values = { ...(await baseTemplateValues(ctx, input.officeId, input.customerId, input.exerciseYear)), ...(input.values ?? {}) };
    content = renderContent(tpl, values, input.channel, input.rawHtml);
  } else if (input.channel === 'whatsapp') {
    content.body = htmlToText(content.body);
  }
  const { storedSubject, storedBody, sealed } = protect(ctx, content, input.redact);

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

export interface BulkDeliveryItem {
  customer: CustomerRow;
  channel: DeliveryChannel;
  /** Valores próprios deste envio, somados aos comuns (cliente, escritório, contador, anos). */
  values?: TemplateValues;
  /** Trechos secretos, como em {@link QueueDeliveryInput.redact}. */
  redact?: string[];
  idempotencyKey: string;
}

/**
 * Envio em lote do mesmo template (mala direta): o template, o escritório e os responsáveis pelos
 * clientes são carregados uma vez só, na criação. Cada `queue` grava um bloco de envios (algumas
 * centenas), com as mensagens do WhatsApp e os jobs de envio, numa transação: o bloco nunca fica
 * pela metade. Chaves de idempotência já usadas são ignoradas, então repetir a operação não
 * duplica nada. Itens sem contato no canal não são gravados e voltam em `missing`.
 */
export async function createDeliveryBatch(
  ctx: AppContext,
  input: { officeId: string; templateKey: string; exerciseYear?: number; userId?: string | null; customers: CustomerRow[] },
) {
  const { db } = ctx;
  const tpl = await resolveTemplate(ctx, input.officeId, input.templateKey);
  const office = await db.query.offices.findFirst({ where: eq(offices.id, input.officeId) });
  const responsibleIds = [...new Set(input.customers.flatMap((c) => (c.responsibleUserId ? [c.responsibleUserId] : [])))];
  const responsibles = new Map<string, string>();
  for (let i = 0; i < responsibleIds.length; i += 1000) {
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, responsibleIds.slice(i, i + 1000)));
    for (const u of rows) responsibles.set(u.id, u.name);
  }

  async function insertBlock(block: { item: BulkDeliveryItem; to: string; storedSubject: string; storedBody: string; sealed?: string }[]) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .insert(deliveries)
        .values(
          block.map((p) => ({
            officeId: input.officeId,
            customerId: p.item.customer.id,
            channel: p.item.channel,
            templateKey: input.templateKey,
            subject: p.storedSubject,
            toAddress: p.to,
            toName: p.item.customer.name,
            body: p.storedBody,
            idempotencyKey: p.item.idempotencyKey,
            createdByUserId: input.userId ?? null,
          })),
        )
        .onConflictDoNothing({ target: [deliveries.officeId, deliveries.idempotencyKey] })
        .returning({ id: deliveries.id, customerId: deliveries.customerId, channel: deliveries.channel, body: deliveries.body, idempotencyKey: deliveries.idempotencyKey });
      const whatsapp = rows.filter((r) => r.channel === 'whatsapp' && r.customerId);
      if (whatsapp.length) {
        await tx.insert(messages).values(
          whatsapp.map((r) => ({ officeId: input.officeId, customerId: r.customerId!, direction: 'out', channel: 'whatsapp', body: r.body, authorUserId: input.userId ?? null, deliveryId: r.id })),
        );
      }
      if (rows.length) {
        // os mesmos jobs que ctx.jobs.enqueue grava um a um (chave de idempotência = id do envio)
        const sealedBy = new Map(block.map((p) => [p.item.idempotencyKey, p.sealed]));
        await tx
          .insert(jobs)
          .values(
            rows.map((r) => {
              const sealed = sealedBy.get(r.idempotencyKey ?? '');
              return { type: JOB_TYPE, payload: sealed ? { deliveryId: r.id, sealed } : { deliveryId: r.id }, officeId: input.officeId, idempotencyKey: r.id };
            }),
          )
          .onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] });
      }
      return rows.length;
    });
  }

  return {
    async queue(items: BulkDeliveryItem[]) {
      const result = { queued: 0, existing: 0, missing: [] as BulkDeliveryItem[] };
      const prepared = items.flatMap((item) => {
        const to = addressOf(item.customer, item.channel);
        if (!to) {
          result.missing.push(item);
          return [];
        }
        const responsible = item.customer.responsibleUserId ? responsibles.get(item.customer.responsibleUserId) : null;
        const values = { ...commonValues(office, item.customer, responsible, input.exerciseYear), ...(item.values ?? {}) };
        return [{ item, to, ...protect(ctx, renderContent(tpl, values, item.channel), item.redact) }];
      });
      if (prepared.length) {
        const created = await insertBlock(prepared);
        result.queued += created;
        result.existing += prepared.length - created;
      }
      return result;
    },
  };
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
