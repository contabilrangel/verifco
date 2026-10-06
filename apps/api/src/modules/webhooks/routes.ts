import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { integrations } from '../../db/schema';
import { safeEqual } from '../../lib/crypto';
import { parse } from '../../lib/http';
import { handleAsaasWebhook, type AsaasWebhookEvent } from '../../integrations/asaas';
import { decryptSecrets } from '../../integrations/store';
import type { WhatsAppSecrets } from '../../integrations/whatsapp';
import { applyDeliveryStatuses, normalizeEvolution, normalizeMeta, storeInbound, validMetaSignature } from '../../integrations/whatsapp-inbound';
import { WHATSAPP_WEBHOOK_RULE, allow } from '../../services/rate-limit';

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

/** Corpo do webhook do WhatsApp: mensagens de texto são pequenas (a Evolution deve enviar sem base64). */
const WHATSAPP_BODY_LIMIT = 512 * 1024;

/**
 * Webhooks públicos (sem login). Cada escritório tem uma URL própria com token aleatório;
 * quando o provedor oferece, o cabeçalho de autenticação também é conferido.
 */
export async function webhooksRoutes(app: FastifyInstance) {
  const { ctx } = app;

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

  /**
   * WhatsApp (Evolution API ou Cloud API da Meta): as respostas dos clientes entram na conversa
   * do cliente do escritório dono do token, localizado pelo celular. Na Meta, o GET confirma o
   * endereço (hub.verify_token) e cada POST vem assinado com a chave secreta do app.
   */
  await app.register(async (scope) => {
    // a assinatura da Meta é o HMAC do corpo exato: o JSON é lido à mão, depois de conferida
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: WHATSAPP_BODY_LIMIT }, (_req, body, done) => done(null, body));

    const findRow = async (req: { params: unknown }) => {
      const token = String((req.params as { token?: string }).token ?? '');
      if (token.length < 16) return null;
      return (await ctx.db.query.integrations.findFirst({ where: and(eq(integrations.provider, 'whatsapp'), eq(integrations.webhookToken, token)) })) ?? null;
    };

    scope.get('/webhooks/whatsapp/:token', async (req, reply) => {
      const row = await findRow(req);
      if (!row) return reply.status(401).send({ error: 'Webhook não autorizado.' });
      const q = req.query as Record<string, unknown>;
      const expected = (decryptSecrets(ctx, row) as WhatsAppSecrets).webhookVerifyToken;
      const challenge = typeof q['hub.challenge'] === 'string' ? q['hub.challenge'] : '';
      const received = q['hub.verify_token'];
      if (q['hub.mode'] !== 'subscribe' || !expected || typeof received !== 'string' || !safeEqual(received, expected) || !/^[\w-]{1,200}$/.test(challenge)) {
        return reply.status(403).send({ error: 'Verificação do webhook recusada: confira o token de verificação.' });
      }
      return reply.header('Content-Type', 'text/plain; charset=utf-8').send(challenge);
    });

    scope.post('/webhooks/whatsapp/:token', { bodyLimit: WHATSAPP_BODY_LIMIT }, async (req, reply) => {
      const row = await findRow(req);
      if (!row) return reply.status(401).send({ error: 'Webhook não autorizado.' });
      const config = row.publicConfig as { mode?: string; instance?: string; phoneNumberId?: string };
      const secrets = decryptSecrets(ctx, row) as WhatsAppSecrets;
      const meta = config.mode === 'meta';
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      if (meta) {
        const signature = req.headers['x-hub-signature-256'];
        if (!secrets.appSecret || typeof signature !== 'string' || !validMetaSignature(raw, signature, secrets.appSecret)) {
          return reply.status(401).send({ error: 'Assinatura do webhook inválida.' });
        }
      } else if (secrets.webhookAuthToken && !safeEqual(String(req.headers.authorization ?? ''), `Bearer ${secrets.webhookAuthToken}`)) {
        return reply.status(401).send({ error: 'Token de autenticação do webhook inválido.' });
      }
      if (!(await allow(ctx, `whatsapp-webhook:${row.id}`, WHATSAPP_WEBHOOK_RULE))) {
        return reply.status(429).send({ error: 'Muitas requisições. Aguarde alguns instantes e tente de novo.' });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.status(400).send({ error: 'Dados inválidos: o corpo da requisição não é um JSON válido.' });
      }
      // integração desativada: confirma o recebimento (o provedor não reenvia) e ignora
      if (!row.enabled) return { received: true, stored: 0 };
      if (meta) {
        const { messages, statuses } = normalizeMeta(payload, config.phoneNumberId);
        await applyDeliveryStatuses(ctx, row.officeId, statuses);
        return { received: true, ...(await storeInbound(ctx, row.officeId, messages)) };
      }
      return { received: true, ...(await storeInbound(ctx, row.officeId, normalizeEvolution(payload, config.instance))) };
    });
  });
}
