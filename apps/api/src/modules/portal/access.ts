import type { FastifyRequest } from 'fastify';
import type { AuthCustomer } from '../../context';
import { forbidden, unauthorized } from '../../lib/errors';

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

/** Primeiro nome para saudações ("Olá, Maria!"). */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** CPF parcialmente oculto: ***.982.247-** */
export function maskCpf(cpf: string) {
  const d = cpf.replace(/\D+/g, '');
  if (d.length !== 11) return d.length === 14 ? `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-**` : '';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}
