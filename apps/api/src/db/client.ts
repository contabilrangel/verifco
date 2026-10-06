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
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import * as platformSchema from './platform-schema';

export type Db = ReturnType<typeof drizzlePglite<typeof schema>>;
export type PlatformDb = ReturnType<typeof drizzlePglite<typeof platformSchema>>;

/** Banco ou transação aberta (`db.transaction`): as funções que também rodam numa transação aceitam os dois. */
export type DbOrTx = PgDatabase<PgliteQueryResultHKT, typeof schema>;

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export interface DbHandle<T = Db> {
  db: T;
  close: () => Promise<void>;
}

/**
 * Abre o banco. `postgres://` usa um pool do node-postgres; `pglite:memory`
 * cria um banco em memória (testes) e `pglite:<pasta>` persiste em disco (desenvolvimento).
 */
export function openDatabase(url: string, opts: { sync?: 'migrate' | 'push' } = {}): Promise<DbHandle> {
  return openWithSchema(url, schema, MIGRATIONS, opts, false);
}

export function openPlatformDatabase(url: string, opts: { sync?: 'migrate' | 'push' } = {}): Promise<DbHandle<PlatformDb>> {
  return openWithSchema(url, platformSchema, resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle-platform'), opts, true);
}

async function openWithSchema<T extends Record<string, unknown>>(url: string, tables: T, migrationsFolder: string, opts: { sync?: 'migrate' | 'push' }, platform: boolean): Promise<DbHandle<ReturnType<typeof drizzlePglite<T>>>> {
  type Database = ReturnType<typeof drizzlePglite<T>>;
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema: tables }) as unknown as Database;
    try {
      await assertDatabasePurpose(db, platform);
      if ((opts.sync ?? 'migrate') === 'push') await pushFromSchema(tables, db);
      else await migratePg(drizzlePg(pool), { migrationsFolder });
    } catch (error) { await pool.end(); throw error; }
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
  const db = drizzlePglite(client, { schema: tables });
  // banco em memória (testes) sincroniza direto do schema.ts; banco em disco usa as migrações,
  // porque o push do drizzle-kit não sabe atualizar um banco existente sem diálogo interativo
  const inMemory = !target || target === 'memory';
  try {
    await assertDatabasePurpose(db, platform);
    if ((opts.sync ?? (inMemory ? 'push' : 'migrate')) === 'push') await pushFromSchema(tables, db);
    else await migratePglite(db, { migrationsFolder });
  } catch (error) { await client.close(); throw error; }
  return { db, close: () => client.close() };
}

/** Também detecta URLs com aliases de host que chegam ao mesmo banco físico. Antes de qualquer DDL. */
async function assertDatabasePurpose(db: Pick<Db, 'execute'>, platform: boolean) {
  const result = await db.execute<{ offices: string | null; admins: string | null }>(sql`select
    to_regclass('public.offices')::text as offices, to_regclass('public.platform_users')::text as admins`);
  const row = result.rows[0];
  if (platform ? Boolean(row.offices) : Boolean(row.admins && !row.offices)) {
    throw new Error(platform
      ? 'PLATFORM_DATABASE_URL aponta para um banco de escritórios. Use outro banco exclusivo da administração.'
      : 'DATABASE_URL aponta para um banco da administração. Use o banco dos escritórios.');
  }
}

/** Aplica o schema.ts no banco sem arquivos de migração (drizzle-kit push). */
async function pushFromSchema(tables: Record<string, unknown>, db: unknown) {
  const { pushSchema } = await import('drizzle-kit/api');
  const log = console.log;
  console.log = () => {};
  try {
    const result = await pushSchema(tables, db as never);
    await result.apply();
  } finally {
    console.log = log;
  }
}

export { schema };
