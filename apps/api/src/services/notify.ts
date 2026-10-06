import type { Db } from '../db/client';
import { notifications } from '../db/schema';

/**
 * Cria uma notificação no sino. Sem `userId`, todos do escritório veem; com `customerId`, só quem
 * enxerga o cliente (o escritório pode restringir os contadores aos próprios clientes).
 * Informe `customerId` sempre que a notificação falar de um cliente.
 */
export async function notify(
  db: Db,
  input: { officeId: string; userId?: string | null; customerId?: string | null; title: string; body?: string; link?: string },
) {
  await db.insert(notifications).values({
    officeId: input.officeId,
    userId: input.userId ?? null,
    customerId: input.customerId ?? null,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
  });
}
