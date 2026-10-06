/**
 * Migrações de `drizzle/` (SEG-4): aplicam num banco vazio, chegam exatamente ao schema.ts e o
 * SQL escrito à mão fica só em migração própria (`drizzle-kit generate --custom`).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client';
import * as schema from '../src/db/schema';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const CUSTOM = '0003_checklist_validade_links';

type Journal = { entries: { tag: string }[] };
const readJournal = (dir: string): Journal => JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));

describe('migrações (SEG-4)', () => {
  it('aplicam num PGlite vazio e chegam ao mesmo banco que o schema.ts', async () => {
    const migrated = await openDatabase('pglite:memory', { sync: 'migrate' });
    const pushed = await openDatabase('pglite:memory', { sync: 'push' });
    const shape = async (db: typeof migrated.db) => {
      const columns = await db.execute(sql`
        select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
      const indexes = await db.execute(sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`);
      const constraints = await db.execute(sql`
        select c.conrelid::regclass::text as table_name, c.conname, pg_get_constraintdef(c.oid) as def
        from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public' order by 1, 2`);
      return { columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows };
    };
    try {
      const a = await shape(migrated.db);
      const b = await shape(pushed.db);
      expect(a.columns.length).toBeGreaterThan(100);
      expect(a.columns).toContainEqual(expect.objectContaining({ table_name: 'checklists', column_name: 'access_expires_at' }));
      expect(a.columns).toContainEqual(expect.objectContaining({ table_name: 'rate_limits', column_name: 'window_started_at' }));
      expect(a).toEqual(b);
    } finally {
      await migrated.close();
      await pushed.close();
    }
  });

  it('as migrações geradas não têm SQL à mão; o preenchimento dos links fica na migração própria', () => {
    const tags = readJournal(MIGRATIONS).entries.map((e) => e.tag);
    expect(tags).toContain(CUSTOM);
    expect(readFileSync(join(MIGRATIONS, '0002_seguranca_conta_mensagens.sql'), 'utf8')).not.toMatch(/\bUPDATE\s+"checklists"/i);
    const custom = readFileSync(join(MIGRATIONS, `${CUSTOM}.sql`), 'utf8');
    const statements = custom
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('--'))
      .join('\n');
    expect(statements).toMatch(/^UPDATE "checklists" SET "access_expires_at"/);
  });

  it('a migração própria dá 30 dias aos links do checklist enviados antes da validade', async () => {
    // cópia da pasta sem a migração própria: o banco fica como estava depois da 0002
    const dir = mkdtempSync(join(tmpdir(), 'verifco-migracoes-'));
    const client = new PGlite();
    try {
      cpSync(MIGRATIONS, dir, { recursive: true });
      const journal = readJournal(MIGRATIONS);
      const journalPath = join(dir, 'meta/_journal.json');
      // sem a própria e sem as posteriores: o migrador só aplica migrações mais novas que a última aplicada
      const upTo = journal.entries.findIndex((e) => e.tag === CUSTOM);
      writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }));
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: dir });

      const [office] = await db.insert(schema.offices).values({ name: 'Escritório' }).returning();
      const [customer] = await db.insert(schema.customers).values({ officeId: office.id, name: 'Cliente', cpfCnpj: '52998224725' }).returning();
      const [declaration] = await db.insert(schema.declarations).values({ officeId: office.id, customerId: customer.id, exerciseYear: 2026 }).returning();
      const [old] = await db.insert(schema.checklists).values({ officeId: office.id, declarationId: declaration.id, accessTokenHash: 'a', accessCodeHash: 'b' }).returning();
      expect(old.accessExpiresAt).toBeNull();

      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db, { migrationsFolder: dir });
      const row = await db.query.checklists.findFirst({ where: eq(schema.checklists.id, old.id) });
      const days = (row!.accessExpiresAt!.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
