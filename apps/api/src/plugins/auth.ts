import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { customers, roles, users, platformUsers } from '../db/schema';

export type UserToken = { typ: 'user'; sub: string; oid: string; tv: number };
export type CustomerToken = { typ: 'customer'; cid: string; oid: string; scope: string };
type Token = UserToken | CustomerToken | { typ: 'platform'; sub: string; tv: number };

/**
 * Lê o token do cabeçalho `Authorization: Bearer` e carrega o usuário com as permissões
 * atuais da função. Como as permissões vêm do banco a cada requisição, revogar uma
 * permissão vale imediatamente. O token de sessão nunca é aceito na URL (`?token=`), onde
 * vazaria para logs, histórico do navegador e cabeçalho Referer.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  await app.register(jwt, { secret: app.ctx.config.JWT_SECRET });

  app.decorateRequest('auth', null);
  app.decorateRequest('customerAuth', null);
  app.decorateRequest('platformAuth', null);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const raw = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!raw) return;
    let payload: Token;
    try {
      payload = app.jwt.verify<Token>(raw);
    } catch {
      return;
    }
    const { db } = app.ctx;
    if (payload.typ === 'platform') {
      const user = await db.query.platformUsers.findFirst({ where: eq(platformUsers.id, payload.sub) });
      if (!user?.isActive || user.tokenVersion !== payload.tv) return;
      req.platformAuth = { id: user.id, name: user.name, email: user.email, role: user.role };
    } else if (payload.typ === 'user') {
      const user = await db.query.users.findFirst({ where: eq(users.id, payload.sub) });
      if (!user || !user.isActive || user.officeId !== payload.oid || user.tokenVersion !== payload.tv) return;
      const role = user.roleId ? await db.query.roles.findFirst({ where: eq(roles.id, user.roleId) }) : null;
      req.auth = {
        kind: 'user',
        userId: user.id,
        officeId: user.officeId,
        name: user.name,
        email: user.email,
        isOwner: user.isOwner,
        roleId: user.roleId,
        permissions: new Set(role?.permissions ?? []),
      };
    } else if (payload.typ === 'customer') {
      const customer = await db.query.customers.findFirst({ where: eq(customers.id, payload.cid) });
      if (!customer || customer.officeId !== payload.oid || customer.deletedAt) return;
      req.customerAuth = { kind: 'customer', customerId: customer.id, officeId: customer.officeId, scope: payload.scope };
    }
  });
});

export function signUserToken(app: FastifyInstance, user: { id: string; officeId: string; tokenVersion: number }) {
  const payload: UserToken = { typ: 'user', sub: user.id, oid: user.officeId, tv: user.tokenVersion };
  return app.jwt.sign(payload, { expiresIn: '12h' });
}

export function signCustomerToken(app: FastifyInstance, c: { id: string; officeId: string }, scope: string) {
  const payload: CustomerToken = { typ: 'customer', cid: c.id, oid: c.officeId, scope };
  return app.jwt.sign(payload, { expiresIn: '2h' });
}
