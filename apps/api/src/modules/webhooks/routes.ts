import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { integrations } from '../../db/schema';
import { safeEqual } from '../../lib/crypto';
import { parse } from '../../lib/http';
import { handleAsaasWebhook, type AsaasWebhookEvent } from '../../integrations/asaas';
import { decryptSecrets } from '../../integrations/store';

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
