import { and, asc, count, countDistinct, desc, eq, gt, ilike, inArray, isNull, max, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { onlyDigits } from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { customers, messages, users } from '../../db/schema';
import { paginate } from '../../lib/http';
import { customerScope } from '../../services/customers';
import { messagePreview, publicAttachments } from './attachments';

export const threadsQuery = z.object({
  filter: z.enum(['unread', 'all']).default('all'),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Mensagem do cliente que o escritório ainda não leu. */
const unreadFromCustomer = (officeId: string) => and(eq(messages.officeId, officeId), eq(messages.direction, 'in'), isNull(messages.readAt))!;

/**
 * Caixa de mensagens do escritório: uma linha por cliente que tem conversa, da mais recente para
 * a mais antiga, com a última mensagem e quantas o cliente mandou e ninguém do escritório leu.
 * Só entram os clientes que o usuário enxerga (`customerScope`: escritório, não excluídos e, se o
 * escritório restringe, os de que ele é responsável).
 */
export async function listThreads(ctx: AppContext, user: AuthUser, q: z.infer<typeof threadsQuery>) {
  const { db } = ctx;
  const stats = db
    .select({
      customerId: messages.customerId,
      lastAt: max(messages.createdAt).as('last_at'),
      unread: sql<number>`(count(*) filter (where ${messages.direction} = 'in' and ${messages.readAt} is null))::int`.as('unread'),
    })
    .from(messages)
    .where(eq(messages.officeId, user.officeId))
    .groupBy(messages.customerId)
    .as('stats');

  const conds: SQL[] = [await customerScope(ctx, user)];
  if (q.q) {
    const digits = onlyDigits(q.q);
    const any = [ilike(customers.name, `%${q.q}%`)];
    if (digits.length >= 3) any.push(ilike(customers.cpfCnpj, `%${digits}%`));
    conds.push(or(...any)!);
  }
  if (q.filter === 'unread') conds.push(gt(stats.unread, 0));
  const where = and(...conds);

  const [{ total }] = await db.select({ total: count() }).from(stats).innerJoin(customers, eq(customers.id, stats.customerId)).where(where);
  const rows = await db
    .select({ id: customers.id, name: customers.name, unread: stats.unread })
    .from(stats)
    .innerJoin(customers, eq(customers.id, stats.customerId))
    .where(where)
    .orderBy(desc(stats.lastAt), asc(customers.name), asc(customers.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const last = rows.length
    ? await db
        .selectDistinctOn([messages.customerId], {
          customerId: messages.customerId,
          id: messages.id,
          direction: messages.direction,
          channel: messages.channel,
          body: messages.body,
          attachments: messages.attachments,
          createdAt: messages.createdAt,
          authorName: users.name,
        })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.authorUserId))
        .where(and(eq(messages.officeId, user.officeId), inArray(messages.customerId, rows.map((r) => r.id))))
        .orderBy(messages.customerId, desc(messages.createdAt), desc(messages.id))
    : [];
  const lastOf = new Map(last.map((m) => [m.customerId, m]));

  const data = rows.map((r) => {
    const m = lastOf.get(r.id)!;
    const attachments = publicAttachments(m.attachments).length;
    return {
      customer: { id: r.id, name: r.name },
      unread: r.unread,
      lastMessage: {
        id: m.id,
        direction: m.direction,
        channel: m.channel,
        /** Texto resumido; sem texto, "Anexo" ou "N anexos". */
        preview: messagePreview(m.body, attachments),
        authorName: m.direction === 'out' ? m.authorName : r.name,
        createdAt: m.createdAt,
        hasAttachments: attachments > 0,
      },
    };
  });
  return paginate(data, total, q.page, q.pageSize);
}

/** Não lidas do escritório no escopo do usuário: mensagens (`count`) e conversas (`threads`). */
export async function unreadCount(ctx: AppContext, user: AuthUser) {
  const [row] = await ctx.db
    .select({ count: count(), threads: countDistinct(messages.customerId) })
    .from(messages)
    .innerJoin(customers, eq(customers.id, messages.customerId))
    .where(and(await customerScope(ctx, user), unreadFromCustomer(user.officeId)));
  return { count: row?.count ?? 0, threads: row?.threads ?? 0 };
}
