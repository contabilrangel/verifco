import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Db = ReturnType<typeof drizzlePglite<typeof schema>>;

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
  // PGlite (desenvolvimento e testes) sincroniza direto do schema.ts por padrão
  if ((opts.sync ?? 'push') === 'push') await pushFromSchema(db);
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
