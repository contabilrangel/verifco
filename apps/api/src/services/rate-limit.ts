/**
 * Limite de tentativas com janela fixa, guardado no PostgreSQL (tabela `rate_limits`).
 *
 * Como o contador fica no banco e é atualizado num único `insert ... on conflict`, o limite
 * vale para todas as instâncias da API ao mesmo tempo (não é por processo).
 */
import { sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { HttpError } from '../lib/errors';

export interface RateRule {
  /** Máximo de eventos na janela. */
  max: number;
  /** Duração da janela, em segundos. */
  windowSec: number;
}

type Row = { count: number; window_started_at: string | Date };

const rowsOf = (r: unknown) => ((r as { rows?: Row[] }).rows ?? []) as Row[];

/** 429 com a espera em minutos. */
export function tooManyAttempts(retryAfterSec: number, message?: string) {
  const min = Math.max(1, Math.ceil(retryAfterSec / 60));
  return new HttpError(429, message ?? `Muitas tentativas. Aguarde ${min} minuto(s) e tente de novo.`, { retryAfterSec: Math.ceil(retryAfterSec) });
}

const retryAfter = (row: Row, windowSec: number) => Math.max(1, windowSec - (Date.now() - new Date(row.window_started_at).getTime()) / 1000);

/** Soma um evento à chave e devolve o total na janela atual (e quando ela termina). */
export async function hit(ctx: AppContext, key: string, windowSec: number): Promise<{ count: number; retryAfterSec: number }> {
  const res = await ctx.db.execute(sql`
    insert into rate_limits (key, count, window_started_at) values (${key}, 1, now())
    on conflict (key) do update set
      count = case when rate_limits.window_started_at <= now() - ${windowSec}::int * interval '1 second' then 1 else rate_limits.count + 1 end,
      window_started_at = case when rate_limits.window_started_at <= now() - ${windowSec}::int * interval '1 second' then now() else rate_limits.window_started_at end
    returning count, window_started_at`);
  const row = rowsOf(res)[0];
  // limpeza ocasional das janelas vencidas
  if (Math.random() < 0.01) await ctx.db.execute(sql`delete from rate_limits where window_started_at < now() - interval '1 day'`);
  return { count: Number(row?.count ?? 1), retryAfterSec: row ? retryAfter(row, windowSec) : windowSec };
}

/** Eventos já registrados na janela atual (sem somar). */
export async function peek(ctx: AppContext, key: string, windowSec: number): Promise<{ count: number; retryAfterSec: number }> {
  const res = await ctx.db.execute(
    sql`select count, window_started_at from rate_limits where key = ${key} and window_started_at > now() - ${windowSec}::int * interval '1 second'`,
  );
  const row = rowsOf(res)[0];
  return row ? { count: Number(row.count), retryAfterSec: retryAfter(row, windowSec) } : { count: 0, retryAfterSec: 0 };
}

export async function resetLimit(ctx: AppContext, key: string) {
  await ctx.db.execute(sql`delete from rate_limits where key = ${key}`);
}

/** Soma uma tentativa e lança 429 se passou do limite. */
export async function consume(ctx: AppContext, key: string, rule: RateRule, message?: string) {
  if (!ctx.config.RATE_LIMIT) return;
  const r = await hit(ctx, key, rule.windowSec);
  if (r.count > rule.max) throw tooManyAttempts(r.retryAfterSec, message);
}

/** Lança 429 se a chave já atingiu o limite (sem somar; use `hit` ao registrar a falha). */
export async function check(ctx: AppContext, key: string, rule: RateRule, message?: string) {
  if (!ctx.config.RATE_LIMIT) return;
  const r = await peek(ctx, key, rule.windowSec);
  if (r.count >= rule.max) throw tooManyAttempts(r.retryAfterSec, message);
}

/** Registra uma falha; devolve o total na janela (0 com o limite desligado). */
export async function fail(ctx: AppContext, key: string, rule: RateRule): Promise<number> {
  if (!ctx.config.RATE_LIMIT) return 0;
  return (await hit(ctx, key, rule.windowSec)).count;
}

/** Tenta reservar um evento: `false` se a janela já está cheia (para limitar sem revelar nada a quem chama). */
export async function allow(ctx: AppContext, key: string, rule: RateRule): Promise<boolean> {
  if (!ctx.config.RATE_LIMIT) return true;
  return (await hit(ctx, key, rule.windowSec)).count <= rule.max;
}

// ---------------------------------------------------------------------------
// Limites por IP das rotas públicas (aplicados em app.ts)
// ---------------------------------------------------------------------------
export interface RouteLimit extends RateRule {
  /** Grupo da chave (rotas do mesmo grupo somam no mesmo contador por IP). */
  group: string;
  /** `all` conta toda requisição; com uma lista, só as respostas com esses status (falhas). */
  count: 'all' | number[];
}

const FIFTEEN_MIN = 15 * 60;

/**
 * Rotas sem login (ou de login) com limite por IP, somado em todas as instâncias.
 * O portal e o link do checklist têm ainda o limite por CPF/link (`CUSTOMER_LOGIN_RULE`).
 * Chave: `MÉTODO /api/rota`.
 */
export const ROUTE_LIMITS: Record<string, RouteLimit> = {
  'POST /api/platform/login': { group: 'platform-login', count: 'all', max: 15, windowSec: FIFTEEN_MIN },
  'POST /api/auth/login': { group: 'login', count: [401], max: 20, windowSec: FIFTEEN_MIN },
  'POST /api/auth/register': { group: 'register', count: 'all', max: 10, windowSec: 60 * 60 },
  'POST /api/auth/forgot-password': { group: 'forgot', count: 'all', max: 10, windowSec: FIFTEEN_MIN },
  'POST /api/auth/reset-password': { group: 'reset', count: [400], max: 20, windowSec: FIFTEEN_MIN },
  'POST /api/portal/login': { group: 'portal-login', count: [401], max: 30, windowSec: FIFTEEN_MIN },
  'POST /api/portal/checklist-login': { group: 'checklist-login', count: [401, 404], max: 30, windowSec: FIFTEEN_MIN },
  'POST /api/portal/checklist-link': { group: 'checklist-login', count: [404], max: 30, windowSec: FIFTEEN_MIN },
  'GET /api/public/budgets/:token': { group: 'public-token', count: [404], max: 30, windowSec: FIFTEEN_MIN },
  'GET /api/public/budgets/:token/logo': { group: 'public-token', count: [404], max: 30, windowSec: FIFTEEN_MIN },
  'POST /api/public/budgets/:token/approve': { group: 'public-token', count: [404], max: 30, windowSec: FIFTEEN_MIN },
  'POST /api/public/budgets/:token/reject': { group: 'public-token', count: [404], max: 30, windowSec: FIFTEEN_MIN },
  'POST /api/webhooks/asaas/:token': { group: 'webhook', count: [401, 403, 404], max: 30, windowSec: FIFTEEN_MIN },
  'GET /api/webhooks/whatsapp/:token': { group: 'webhook', count: [401, 403, 404], max: 30, windowSec: FIFTEEN_MIN },
  'POST /api/webhooks/whatsapp/:token': { group: 'webhook', count: [401, 403, 404], max: 30, windowSec: FIFTEEN_MIN },
};

/** Webhook do WhatsApp: eventos aceitos por integração (além das falhas por IP de `ROUTE_LIMITS`). */
export const WHATSAPP_WEBHOOK_RULE: RateRule = { max: 300, windowSec: 60 };

/** Login da equipe: falhas por e-mail (além do limite por IP). */
export const LOGIN_EMAIL_RULE: RateRule = { max: 10, windowSec: FIFTEEN_MIN };
/** Falhas seguidas que bloqueiam o CPF (portal) ou o link do checklist. */
export const LOGIN_MAX_FAILURES = 5;
/**
 * Login do cliente: falhas por CPF (`portal:<cpf>`) ou por link do checklist
 * (`checklist:<sha256 do token>`), além do limite por IP. Bloqueia até a janela acabar.
 */
export const CUSTOMER_LOGIN_RULE: RateRule = { max: LOGIN_MAX_FAILURES, windowSec: FIFTEEN_MIN };
/** "Esqueci minha senha": no máximo um e-mail a cada 5 minutos por conta. */
export const FORGOT_PER_ACCOUNT_RULE: RateRule = { max: 1, windowSec: 5 * 60 };
