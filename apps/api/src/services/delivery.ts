import { and, eq, sql } from 'drizzle-orm';
import { currentYearInBrazil, getTemplateDef, renderTemplate, onlyDigits, type DeliveryChannel } from '@verifco/shared';
import type { AppContext } from '../context';
import { customers, deliveries, emailTemplates, jobs, messages, offices, users } from '../db/schema';
import { badRequest } from '../lib/errors';

export type DeliveryRow = typeof deliveries.$inferSelect;

/** Template efetivo do escritório: o personalizado ou o padrão do sistema. */
export async function resolveTemplate(ctx: AppContext, officeId: string, key: string) {
  const def = getTemplateDef(key);
  if (!def) throw badRequest(`Template desconhecido: ${key}`);
  const custom = await ctx.db.query.emailTemplates.findFirst({
    where: and(eq(emailTemplates.officeId, officeId), eq(emailTemplates.key, key)),
  });
  return { def, subject: custom?.subject ?? def.defaultSubject, body: custom?.body ?? def.defaultBody, customized: Boolean(custom) };
}

/** Valores comuns a todos os templates (cliente, escritório, contador, anos). */
export async function baseTemplateValues(ctx: AppContext, officeId: string, customerId: string | null, exerciseYear?: number) {
  const office = await ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId) });
  const customer = customerId ? await ctx.db.query.customers.findFirst({ where: eq(customers.id, customerId) }) : null;
  const responsible = customer?.responsibleUserId ? await ctx.db.query.users.findFirst({ where: eq(users.id, customer.responsibleUserId) }) : null;
  const year = exerciseYear ?? currentYearInBrazil();
  return {
    CLIENTE: customer?.name ?? '',
    ESCRITORIO: office?.name ?? '',
    CONTADOR: responsible?.name ?? office?.name ?? '',
    ANO_EXERCICIO: year,
    ANO_CALENDARIO: year - 1,
    ANO_ANTERIOR: year - 1,
    PROXIMO_ANO: year + 1,
    WHATSAPP: office?.settings?.whatsappServiceNumber ?? '',
    CPF_CONTADOR: office?.cpfCnpj ?? '',
  } as Record<string, string | number>;
}

const htmlToText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2: $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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
  if (!to && customer) {
    to = input.channel === 'email' ? customer.email : customer.mobile ? `${onlyDigits(customer.mobileCountry ?? '55')}${onlyDigits(customer.mobile)}` : null;
  }
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
