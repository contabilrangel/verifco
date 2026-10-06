import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../context';
import { auditLogs } from '../db/schema';
import { badRequest, forbidden, unauthorized } from './errors';

/** Valida `data` com zod e devolve 400 com a lista de campos inválidos. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest('Dados inválidos: ' + fields.map((f) => `${f.path || 'campo'} (${f.message})`).join('; '), fields);
  }
  return r.data;
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function can(user: AuthUser, permission: string): boolean {
  return user.isOwner || user.permissions.has(permission);
}

/** Garante login e ao menos uma das permissões informadas. */
export function requirePermission(req: FastifyRequest, ...permissions: string[]): AuthUser {
  const user = requireUser(req);
  if (permissions.length && !permissions.some((p) => can(user, p))) throw forbidden();
  return user;
}

/** preHandler equivalente, para declarar a permissão junto da rota. */
export const guard =
  (...permissions: string[]) =>
  async (req: FastifyRequest, _reply: FastifyReply) => {
    requirePermission(req, ...permissions);
  };

export async function audit(
  req: FastifyRequest,
  action: string,
  entity: string,
  entityId?: string | null,
  data?: Record<string, unknown>,
) {
  const user = req.auth;
  if (!user) return;
  await req.server.ctx.db.insert(auditLogs).values({
    officeId: user.officeId,
    userId: user.userId,
    action,
    entity,
    entityId: entityId ?? null,
    data: data ?? null,
  });
}

// ----------------------------------------------------------------------------
// Esquemas reutilizáveis
// ----------------------------------------------------------------------------
export const uuidParam = z.object({ id: z.uuid() });
export const yearSchema = z.coerce.number().int().min(2000).max(2100);
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD');
export const centsSchema = z.coerce.number().int().min(0);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
});

export function paginate<T>(rows: T[], total: number, page: number, pageSize: number) {
  return { data: rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
export const optionalText = z.preprocess(emptyToNull, z.string().trim().max(5000).nullable().optional());
