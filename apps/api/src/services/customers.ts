import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { AppContext, AuthUser } from '../context';
import { customers } from '../db/schema';
import { notFound } from '../lib/errors';
import { getOfficeSettings } from './settings';

export type CustomerRow = typeof customers.$inferSelect;

/**
 * Condição de visibilidade dos clientes para o usuário:
 * mesmo escritório, não excluído e, se o escritório restringe,
 * apenas os clientes de que ele é responsável (o dono vê todos).
 */
export async function customerScope(ctx: AppContext, user: AuthUser): Promise<SQL> {
  const conds = [eq(customers.officeId, user.officeId), isNull(customers.deletedAt)];
  if (!user.isOwner) {
    const settings = await getOfficeSettings(ctx.db, user.officeId);
    if (settings.restrictCustomersToResponsible) conds.push(eq(customers.responsibleUserId, user.userId));
  }
  return and(...conds)!;
}

/** Carrega o cliente respeitando o escopo do usuário; 404 se não puder ver. */
export async function getCustomerForUser(ctx: AppContext, user: AuthUser, customerId: string): Promise<CustomerRow> {
  const scope = await customerScope(ctx, user);
  const c = await ctx.db.query.customers.findFirst({ where: and(scope, eq(customers.id, customerId)) });
  if (!c) throw notFound('Cliente');
  return c;
}

/** Remove segredos antes de devolver o cliente para o navegador. */
export function publicCustomer(c: CustomerRow) {
  const { ecacLoginEnc, ecacPasswordEnc, inssPasswordEnc, portalCodeHash, ...rest } = c;
  return {
    ...rest,
    hasEcacCredentials: Boolean(ecacLoginEnc && ecacPasswordEnc),
    hasInssPassword: Boolean(inssPasswordEnc),
    hasPortalCode: Boolean(portalCodeHash),
  };
}
