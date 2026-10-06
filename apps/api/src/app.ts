import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import type { AppContext } from './context';
import { HttpError } from './lib/errors';
import { authPlugin } from './plugins/auth';
import { registerModules } from './modules';
import { ROUTE_LIMITS, check, consume, hit, type RouteLimit } from './services/rate-limit';

/**
 * Corpo JSON padrão: 2 MB (o maior caso legítimo é o HTML de um template de e-mail, até 200 mil
 * caracteres). Uploads vão por multipart, com limite próprio; rotas que recebem arquivo em
 * base64 no JSON aumentam o limite na própria rota.
 */
const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const MAX_UPLOAD_MB = 25;

/** Erros nativos do Fastify e do @fastify/multipart traduzidos para a interface. */
const FASTIFY_ERRORS: Record<string, { status: number; message: string }> = {
  FST_REQ_FILE_TOO_LARGE: { status: 413, message: `O arquivo passa do limite de ${MAX_UPLOAD_MB} MB. Envie um arquivo menor.` },
  FST_FILES_LIMIT: { status: 413, message: 'Arquivos demais num só envio. Envie menos arquivos por vez.' },
  FST_PARTS_LIMIT: { status: 413, message: 'O formulário tem partes demais. Envie menos arquivos por vez.' },
  FST_FIELDS_LIMIT: { status: 413, message: 'O formulário tem campos demais.' },
  FST_PROTO_VIOLATION: { status: 400, message: 'Formulário inválido.' },
  FST_INVALID_MULTIPART_CONTENT_TYPE: { status: 400, message: 'Envie o arquivo pelo formulário de upload.' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, message: 'Dados inválidos: o corpo da requisição não é um JSON válido.' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, message: 'Dados inválidos: o corpo da requisição está vazio.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, message: 'Formato de envio não suportado.' },
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, message: 'Os dados enviados passam do tamanho permitido.' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, message: 'Tamanho do envio inválido.' },
  FST_ERR_VALIDATION: { status: 400, message: 'Dados inválidos.' },
};

/** Mensagem genérica para os demais erros 4xx sem tradução. */
const GENERIC_4XX: Record<number, string> = {
  400: 'Requisição inválida.',
  401: 'Faça login para continuar.',
  403: 'Você não tem permissão para esta ação.',
  404: 'Não encontrado.',
  405: 'Operação não permitida.',
  406: 'Formato de envio não suportado.',
  413: 'Os dados enviados passam do tamanho permitido.',
  415: 'Formato de envio não suportado.',
  429: 'Muitas requisições. Aguarde alguns instantes e tente de novo.',
};

const limitFor = (req: FastifyRequest): RouteLimit | undefined => {
  const url = req.routeOptions?.url;
  return url ? ROUTE_LIMITS[`${req.method} ${url}`] : undefined;
};

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: JSON_BODY_LIMIT,
    // atrás de proxy reverso, o IP real do cliente vem do X-Forwarded-For (limite por IP)
    trustProxy: ctx.config.TRUST_PROXY,
    ajv: { customOptions: { coerceTypes: true } },
  });
  app.decorate('ctx', ctx);

  await app.register(cors, {
    origin: ctx.config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20 } });
  await app.register(authPlugin);

  // limite de tentativas por IP nas rotas públicas (contador no banco, vale entre instâncias)
  app.addHook('onRequest', async (req, reply) => {
    const rule = limitFor(req);
    if (!rule) return;
    const key = `${rule.group}:${req.ip}`;
    try {
      if (rule.count === 'all') await consume(ctx, key, rule);
      else await check(ctx, key, rule);
    } catch (err) {
      const wait = ((err as HttpError).details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
      if (wait) reply.header('Retry-After', String(wait));
      throw err;
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    const rule = limitFor(req);
    if (!rule || rule.count === 'all' || !ctx.config.RATE_LIMIT || !rule.count.includes(reply.statusCode)) return;
    await hit(ctx, `${rule.group}:${req.ip}`, rule.windowSec).catch((err) => req.log.warn({ err }, 'falha ao registrar tentativa'));
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'Rota não encontrada.' }));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Dados inválidos.', details: err.issues });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    const known = e.code ? FASTIFY_ERRORS[e.code] : undefined;
    if (known) return reply.status(known.status).send({ error: known.message });
    if (e.statusCode && e.statusCode < 500) {
      // mensagens internas do Fastify e dos plugins vêm em inglês: a interface recebe o texto padrão
      req.log.info({ code: e.code, message: e.message }, 'erro 4xx sem tradução');
      return reply.status(e.statusCode).send({ error: GENERIC_4XX[e.statusCode] ?? 'Requisição inválida.' });
    }
    // violação de unicidade no PostgreSQL
    if (e.code === '23505') {
      return reply.status(409).send({ error: 'Já existe um registro com esses dados.' });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'Erro interno. Tente novamente em instantes.' });
  });

  app.get('/health', async () => ({ ok: true }));
  await registerModules(app);
  return app;
}
