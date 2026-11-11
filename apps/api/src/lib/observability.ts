import { randomUUID } from 'node:crypto';
import type { Config } from '../config';

/**
 * Envio de erros para o Sentry (ou serviço compatível) quando `SENTRY_DSN` está definido.
 * Sem SDK: um POST no formato de envelope, sem esperar a resposta e sem derrubar a requisição.
 * Vão só os erros 500 e as falhas finais da fila; nunca o corpo da requisição nem cabeçalhos.
 */
export interface ErrorContext {
  /** Onde aconteceu: `http` ou `job`. */
  source: 'http' | 'job' | 'process';
  requestId?: string;
  route?: string;
  method?: string;
  officeId?: string | null;
  jobType?: string;
  jobId?: string;
}

interface ParsedDsn {
  url: string;
  key: string;
}

export function parseSentryDsn(dsn: string | undefined): ParsedDsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!u.username || !project || !/^https?:$/.test(u.protocol)) return null;
    const base = project.includes('/') ? `/${project.split('/').slice(0, -1).join('/')}` : '';
    return { url: `${u.protocol}//${u.host}${base}/api/${project.split('/').pop()}/envelope/`, key: u.username };
  } catch {
    return null;
  }
}

/** Monta o envelope (exportado para teste). */
export function sentryEnvelope(err: unknown, ctx: ErrorContext, environment: string, now = new Date()) {
  const eventId = randomUUID().replace(/-/g, '');
  const e = err instanceof Error ? err : new Error(String(err));
  const event = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: 'node',
    level: 'error',
    environment,
    server_name: 'verifco-api',
    exception: { values: [{ type: e.name || 'Error', value: e.message.slice(0, 2000), stacktrace: undefined as undefined }] },
    tags: { source: ctx.source, ...(ctx.route ? { route: ctx.route } : {}), ...(ctx.method ? { method: ctx.method } : {}), ...(ctx.jobType ? { job_type: ctx.jobType } : {}) },
    extra: {
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx.officeId ? { officeId: ctx.officeId } : {}),
      ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
      stack: (e.stack ?? '').split('\n').slice(0, 30).join('\n'),
    },
  };
  return { eventId, body: `${JSON.stringify({ event_id: eventId, sent_at: now.toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n` };
}

export type ErrorReporter = (err: unknown, ctx: ErrorContext) => void;

/** Cria o envio de erros; sem DSN válido, não faz nada. */
export function createErrorReporter(config: Pick<Config, 'SENTRY_DSN' | 'NODE_ENV'>, fetchImpl: typeof fetch = fetch): ErrorReporter {
  const dsn = parseSentryDsn(config.SENTRY_DSN);
  if (!dsn) return () => undefined;
  return (err, ctx) => {
    const { body } = sentryEnvelope(err, ctx, config.NODE_ENV);
    fetchImpl(dsn.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=verifco/1.0` },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  };
}
