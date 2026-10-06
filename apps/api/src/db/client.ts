import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite, type PgliteQueryResultHKT } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Db = ReturnType<typeof drizzlePglite<typeof schema>>;

/** Banco ou transação aberta (`db.transaction`): as funções que também rodam numa transação aceitam os dois. */
export type DbOrTx = PgDatabase<PgliteQueryResultHKT, typeof schema>;

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/**
 * Abre o banco. `postgres://` usa um pool do node-postgres; `pglite:memory`
 * cria um banco em memória (testes) e `pglite:<pasta>` persiste em disco (desenvolvimento).
 */
export async function openDatabase(url: string, opts: { sync?: 'migrate' | 'push' } = {}): Promise<DbHandle> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    if ((opts.sync ?? 'migrate') === 'push') await pushFromSchema(db);
    else await migratePg(drizzlePg(pool), { migrationsFolder: MIGRATIONS });
    return { db, close: () => pool.end() };
  }
  const target = url.replace(/^pglite:/, '');
  let client: PGlite;
  if (!target || target === 'memory') {
    client = new PGlite();
  } else {
    mkdirSync(target, { recursive: true });
    client = new PGlite(target);
  }
  const db = drizzlePglite(client, { schema });
  // banco em memória (testes) sincroniza direto do schema.ts; banco em disco usa as migrações,
  // porque o push do drizzle-kit não sabe atualizar um banco existente sem diálogo interativo
  const inMemory = !target || target === 'memory';
  if ((opts.sync ?? (inMemory ? 'push' : 'migrate')) === 'push') await pushFromSchema(db);
  else await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return { db, close: () => client.close() };
}

/** Aplica o schema.ts no banco sem arquivos de migração (drizzle-kit push). */
async function pushFromSchema(db: Db) {
  const { pushSchema } = await import('drizzle-kit/api');
  const log = console.log;
  console.log = () => {};
  try {
    const result = await pushSchema(schema, db as never);
    await result.apply();
  } finally {
    console.log = log;
  }
}

export { schema };
