/** Bootstrap explícito: nenhuma conta administrativa é criada na inicialização da API. */
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadConfig } from '../config';
import { openDatabase } from './client';
import { platformAuditLogs, platformUsers } from './schema';

const input = z.object({
  PLATFORM_OWNER_NAME: z.string().trim().min(1).max(100),
  PLATFORM_OWNER_EMAIL: z.email().max(320).transform((v) => v.toLowerCase()),
  PLATFORM_OWNER_PASSWORD: z.string().min(12).max(200),
}).safeParse(process.env);
if (!input.success) throw new Error('Defina PLATFORM_OWNER_NAME, PLATFORM_OWNER_EMAIL e PLATFORM_OWNER_PASSWORD (mínimo 12 caracteres).');
const handle = await openDatabase(loadConfig().DATABASE_URL);
try {
  await handle.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(728103)`);
    if ((await tx.select({ id: platformUsers.id }).from(platformUsers).limit(1)).length) throw new Error('A administração global já possui uma conta. Crie as próximas pelo painel.');
    const [user] = await tx.insert(platformUsers).values({
      name: input.data.PLATFORM_OWNER_NAME, email: input.data.PLATFORM_OWNER_EMAIL,
      passwordHash: await bcrypt.hash(input.data.PLATFORM_OWNER_PASSWORD, 12), role: 'owner',
    }).returning({ id: platformUsers.id });
    await tx.insert(platformAuditLogs).values({ actorId: user.id, action: 'platform.bootstrap' });
  });
  console.log('Conta do proprietário criada. Entre em /sistema.');
} finally { await handle.close(); }
