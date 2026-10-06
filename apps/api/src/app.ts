import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import type { AppContext } from './context';
import { HttpError } from './lib/errors';
import { authPlugin } from './plugins/auth';
import { registerModules } from './modules';

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 25 * 1024 * 1024,
    ajv: { customOptions: { coerceTypes: true } },
  });
  app.decorate('ctx', ctx);

  await app.register(cors, {
    origin: ctx.config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 20 } });
  await app.register(authPlugin);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Dados inválidos.', details: err.issues });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: e.message });
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
