import type { Db } from '../db/client';
import { notifications } from '../db/schema';

/** Cria uma notificação no sino. Sem `userId`, todos do escritório veem. */
export async function notify(db: Db, input: { officeId: string; userId?: string | null; title: string; body?: string; link?: string }) {
  await db.insert(notifications).values({
    officeId: input.officeId,
    userId: input.userId ?? null,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
  });
}
