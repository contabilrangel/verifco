import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { integrations } from '../../db/schema';
import { safeEqual } from '../../lib/crypto';
import { parse } from '../../lib/http';
import { handleAsaasWebhook, type AsaasWebhookEvent } from '../../integrations/asaas';
import { decryptSecrets } from '../../integrations/store';
import { applyWhatsAppStatus, parseEvolutionWebhook, parseMetaWebhook, validMetaSignature, type InboundWhatsApp, type WhatsAppConfig, type WhatsAppSecrets } from '../../integrations/whatsapp';
import { WHATSAPP_INBOUND_JOB } from './jobs';

type RawRequest = { rawBody?: Buffer };

const asaasEvent = z
  .object({
    id: z.string().max(200).optional(),
    event: z.string().min(1).max(100),
    payment: z
      .object({
        id: z.string().min(1).max(100),
        value: z.number().optional(),
        externalReference: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Webhooks públicos (sem login). Cada escritório tem uma URL própria com token aleatório;
 * quando o provedor oferece, o cabeçalho de autenticação também é conferido.
 */
export async function webhooksRoutes(app: FastifyInstance) {
  const { ctx } = app;

  // guarda o corpo cru (a assinatura da Meta é calculada sobre os bytes recebidos); vale só para este plugin
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as RawRequest).rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(Object.assign(new Error('JSON inválido no corpo do webhook.'), { statusCode: 400 }), undefined);
    }
  });

  const integrationByToken = async (provider: 'asaas' | 'whatsapp', token: string) =>
    token.length >= 16 ? ((await ctx.db.query.integrations.findFirst({ where: and(eq(integrations.provider, provider), eq(integrations.webhookToken, token)) })) ?? null) : null;

  /**
   * WhatsApp Cloud API (Meta): verificação do webhook. O token de verificação cadastrado na Meta é o
   * código do fim da própria URL.
   */
  app.get('/webhooks/whatsapp/:token', async (req, reply) => {
    const token = String((req.params as { token?: string }).token ?? '');
    const q = req.query as Record<string, string | undefined>;
    const row = await integrationByToken('whatsapp', token);
    const verify = q['hub.verify_token'];
    if (!row || q['hub.mode'] !== 'subscribe' || typeof verify !== 'string' || !safeEqual(verify, token)) {
      return reply.status(403).send({ error: 'Verificação do webhook recusada.' });
    }
    return reply.type('text/plain').send(String(q['hub.challenge'] ?? ''));
  });

  /**
   * WhatsApp: respostas dos clientes (Evolution `messages.upsert` ou Meta `messages`) e, na Meta,
   * os status de envio. A URL tem token próprio do escritório; na Meta, com o App Secret
   * configurado, a assinatura `X-Hub-Signature-256` também é conferida. Cada mensagem vira um job
   * com chave de idempotência (o provedor reenvia avisos), que a grava na aba Mensagens do cliente.
   */
  app.post('/webhooks/whatsapp/:token', async (req, reply) => {
    const token = String((req.params as { token?: string }).token ?? '');
    const row = await integrationByToken('whatsapp', token);
    if (!row) return reply.status(401).send({ error: 'Webhook não autorizado.' });
    const config = (row.publicConfig ?? {}) as Partial<WhatsAppConfig>;
    const secrets = decryptSecrets(ctx, row) as WhatsAppSecrets;
    const mode = config.mode === 'meta' ? 'meta' : 'evolution';
    if (mode === 'meta' && secrets.appSecret) {
      const raw = (req as unknown as RawRequest).rawBody ?? Buffer.from('');
      if (!validMetaSignature(raw, req.headers['x-hub-signature-256'], secrets.appSecret)) {
        return reply.status(401).send({ error: 'Assinatura do webhook inválida.' });
      }
    }
    if (!row.enabled) return { received: true, ignored: 'Integração do WhatsApp desativada.' };
    let inbound: InboundWhatsApp[];
    let statuses = 0;
    if (mode === 'meta') {
      const parsed = parseMetaWebhook(req.body, config.phoneNumberId);
      inbound = parsed.messages;
      for (const s of parsed.statuses) statuses += await applyWhatsAppStatus(ctx, row.officeId, s);
    } else {
      inbound = parseEvolutionWebhook(req.body, config.instance);
    }
    let queued = 0;
    for (const m of inbound) {
      try {
        await ctx.jobs.enqueue(WHATSAPP_INBOUND_JOB, { message: m }, { officeId: row.officeId, idempotencyKey: `${row.officeId}:${m.id}` });
        queued++;
      } catch {
        // aviso repetido ao mesmo tempo: a chave de idempotência já existe
      }
    }
    return { received: true, messages: queued, statuses };
  });

  /**
   * Asaas: eventos de cobrança (https://docs.asaas.com/docs/webhook-para-cobrancas).
   * Responde 200 rápido para eventos tratados ou ignorados (o Asaas pausa a fila em erros).
   */
  app.post('/webhooks/asaas/:token', async (req, reply) => {
    const token = String((req.params as { token?: string }).token ?? '');
    const row =
      token.length >= 16
        ? await ctx.db.query.integrations.findFirst({ where: and(eq(integrations.provider, 'asaas'), eq(integrations.webhookToken, token)) })
        : null;
    if (!row) return reply.status(401).send({ error: 'Webhook não autorizado.' });

    const expected = decryptSecrets(ctx, row).webhookAuthToken;
    if (expected) {
      const received = req.headers['asaas-access-token'];
      if (typeof received !== 'string' || !safeEqual(received, expected)) {
        return reply.status(401).send({ error: 'Token de autenticação do webhook inválido.' });
      }
    }
    const evt = parse(asaasEvent, req.body) as AsaasWebhookEvent;
    const result = await handleAsaasWebhook(ctx, row.officeId, evt);
    return { received: true, ...result };
  });
}
