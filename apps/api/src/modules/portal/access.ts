import type { FastifyRequest } from 'fastify';
import type { AppContext, AuthCustomer } from '../../context';
import { HttpError, forbidden, unauthorized } from '../../lib/errors';

/**
 * Acesso do cliente final (portal e link do checklist).
 *
 * O token do cliente é assinado com um escopo: `portal` (portal completo) ou
 * `checklist:<id>` (só aquele checklist). Toda consulta do cliente filtra por
 * `customerId` e `officeId` do token.
 */
export function requireCustomer(req: FastifyRequest): AuthCustomer {
  if (!req.customerAuth) throw unauthorized('Sua sessão expirou. Entre novamente.');
  return req.customerAuth;
}

/** Só o token do portal (não vale o token restrito do link do checklist). */
export function requirePortal(req: FastifyRequest): AuthCustomer {
  const c = requireCustomer(req);
  if (c.scope !== 'portal') throw forbidden('Este acesso vale só para o checklist. Entre no portal para continuar.');
  return c;
}

/** Portal ou o checklist indicado. */
export function requireChecklistAccess(req: FastifyRequest, checklistId: string): AuthCustomer {
  const c = requireCustomer(req);
  if (c.scope !== 'portal' && c.scope !== `checklist:${checklistId}`) throw forbidden('Este acesso não vale para este checklist.');
  return c;
}

// ---------------------------------------------------------------------------
// Limite de tentativas de login (CPF + código)
// ---------------------------------------------------------------------------
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;

/**
 * Janela deslizante de falhas por chave (CPF ou link). Fica em memória do processo:
 * com várias instâncias da API, o limite vale por instância.
 */
export class LoginLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private max = LOGIN_MAX_FAILURES,
    private windowMs = LOGIN_WINDOW_MS,
  ) {}

  private recent(key: string, now: number) {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Lança 429 se a chave já estourou o limite na janela. */
  check(key: string, now = Date.now()) {
    const list = this.recent(key, now);
    if (list.length >= this.max) {
      const waitMin = Math.max(1, Math.ceil((this.windowMs - (now - list[0])) / 60_000));
      throw new HttpError(429, `Muitas tentativas sem sucesso. Aguarde ${waitMin} minuto(s) e tente de novo.`);
    }
  }

  fail(key: string, now = Date.now()) {
    const list = this.recent(key, now);
    list.push(now);
    this.failures.set(key, list);
    if (this.failures.size > 50_000) this.sweep(now);
  }

  reset(key: string) {
    this.failures.delete(key);
  }

  private sweep(now: number) {
    for (const key of [...this.failures.keys()]) this.recent(key, now);
  }
}

const limiters = new WeakMap<AppContext, LoginLimiter>();

/** Um limitador por instância da aplicação (compartilhado entre o portal e o checklist). */
export function loginLimiter(ctx: AppContext): LoginLimiter {
  let l = limiters.get(ctx);
  if (!l) {
    l = new LoginLimiter();
    limiters.set(ctx, l);
  }
  return l;
}

/** Primeiro nome para saudações ("Olá, Maria!"). */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** CPF parcialmente oculto: ***.982.247-** */
export function maskCpf(cpf: string) {
  const d = cpf.replace(/\D+/g, '');
  if (d.length !== 11) return d.length === 14 ? `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-**` : '';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}
