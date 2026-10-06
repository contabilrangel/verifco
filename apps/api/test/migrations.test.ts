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
  it('apaga senhas INSS antigas, avisa uma vez e preserva as credenciais eCAC (COB-7)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verifco-inss-'));
    const client = new PGlite();
    try {
      cpSync(MIGRATIONS, dir, { recursive: true });
      const journal = readJournal(MIGRATIONS);
      const journalPath = join(dir, 'meta/_journal.json');
      const index = journal.entries.findIndex((e) => e.tag.endsWith('_remove_senha_inss'));
      expect(index).toBeGreaterThan(0);
      writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }));
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: dir });
      const [office] = await db.insert(schema.offices).values({ name: 'Escritório com INSS' }).returning();
      await db.insert(schema.customers).values([
        { officeId: office.id, name: 'Antigo', cpfCnpj: '52998224725', inssPasswordEnc: 'inss-cifrado', ecacPasswordEnc: 'ecac-cifrado' },
        { officeId: office.id, name: 'Sem senha', cpfCnpj: '11144477735' },
      ]);
      const [role] = await db.insert(schema.roles).values({ officeId: office.id, name: 'Importações', permissions: ['worksheet.inss', 'customer.list'] }).returning();
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db, { migrationsFolder: dir });
      await migrate(db, { migrationsFolder: dir });
      const rows = await db.select().from(schema.customers).where(eq(schema.customers.officeId, office.id));
      expect(rows.every((c) => c.inssPasswordEnc === null)).toBe(true);
      expect(rows.find((c) => c.name === 'Antigo')!.ecacPasswordEnc).toBe('ecac-cifrado');
      expect((await db.query.roles.findFirst({ where: eq(schema.roles.id, role.id) }))!.permissions).toEqual(['customer.list']);
      const notices = await db.select().from(schema.notifications).where(eq(schema.notifications.officeId, office.id));
      expect(notices).toHaveLength(1);
      expect(notices[0].body).toContain('1 senha(s)');
      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.officeId, office.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'inss_password.purge', data: { customers: 1 } });
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SERPRO já ativo continua com a sincronização automática diária; os demais ficam com o padrão (desligada)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verifco-autosync-'));
    const client = new PGlite();
    try {
      cpSync(MIGRATIONS, dir, { recursive: true });
      const journal = readJournal(MIGRATIONS);
      const journalPath = join(dir, 'meta/_journal.json');
      const index = journal.entries.findIndex((e) => e.tag.endsWith('_ecac_sincronizacao_automatica'));
      expect(index).toBeGreaterThan(0);
      writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }));
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: dir });
      const offices = await db.insert(schema.offices).values([{ name: 'Ativo' }, { name: 'Desativado' }, { name: 'Sem SERPRO' }]).returning();
      const [active, disabled, other] = offices;
      await db.insert(schema.integrations).values([
        { officeId: active.id, provider: 'serpro', enabled: true, publicConfig: { contractorCnpj: '11222333000181' } },
        { officeId: disabled.id, provider: 'serpro', enabled: false, publicConfig: { contractorCnpj: '11222333000181' } },
        { officeId: other.id, provider: 'asaas', enabled: true, publicConfig: { environment: 'sandbox' } },
      ]);
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db, { migrationsFolder: dir });
      await migrate(db, { migrationsFolder: dir });
      const rows = await db.select().from(schema.integrations);
      const configOf = (officeId: string) => rows.find((r) => r.officeId === officeId)!.publicConfig;
      expect(configOf(active.id)).toEqual({ contractorCnpj: '11222333000181', autoSync: 'daily' });
      expect(configOf(disabled.id)).toEqual({ contractorCnpj: '11222333000181' });
      expect(configOf(other.id)).toEqual({ environment: 'sandbox' });
      const audits = await db.select().from(schema.auditLogs);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ officeId: active.id, action: 'integration.update', data: { provider: 'serpro', autoSync: { from: null, to: 'daily' }, migration: true } });
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('criam os índices dos filtros frequentes e dos tokens das rotas públicas (DAD-7)', async () => {
    const migrated = await openDatabase('pglite:memory', { sync: 'migrate' });
    try {
      const { db } = migrated;
      const rows = (await db.execute(sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`)).rows as { indexname: string; indexdef: string }[];
      const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef ?? '';
      const expected: Record<string, string> = {
        documents_declaration_idx: 'documents USING btree (declaration_id)',
        documents_checklist_item_idx: 'documents USING btree (checklist_item_id)',
        darfs_declaration_idx: 'darfs USING btree (declaration_id)',
        deliveries_customer_idx: 'deliveries USING btree (customer_id, created_at)',
        installments_office_receipt_idx: 'installments USING btree (office_id, receipt_number)',
        ai_messages_conversation_idx: 'ai_messages USING btree (conversation_id, created_at)',
        password_resets_token_idx: 'password_resets USING btree (token_hash)',
        budgets_approval_token_uq: 'budgets USING btree (approval_token_hash)',
        checklists_access_token_uq: 'checklists USING btree (access_token_hash)',
        integrations_webhook_token_uq: 'integrations USING btree (webhook_token)',
      };
      for (const [name, body] of Object.entries(expected)) expect(def(name), name).toContain(`ON public.${body}`);
      for (const name of ['budgets_approval_token_uq', 'checklists_access_token_uq', 'integrations_webhook_token_uq']) expect(def(name)).toMatch(/^CREATE UNIQUE INDEX/);

      // os tokens repetidos são recusados; orçamentos ainda não enviados (sem token) continuam permitidos
      const [office] = await db.insert(schema.offices).values({ name: 'Escritório' }).returning();
      const [customer] = await db.insert(schema.customers).values({ officeId: office.id, name: 'Cliente', cpfCnpj: '52998224725' }).returning();
      const budget = { officeId: office.id, customerId: customer.id, exerciseYear: 2026, amountCents: 100, totalCents: 100 };
      await db.insert(schema.budgets).values([budget, budget]);
      await db.insert(schema.budgets).values({ ...budget, approvalTokenHash: 'hash-do-token' });
      await expect(db.insert(schema.budgets).values({ ...budget, approvalTokenHash: 'hash-do-token' })).rejects.toThrow();
      const [d1, d2] = await db.insert(schema.declarations).values([2025, 2026].map((exerciseYear) => ({ officeId: office.id, customerId: customer.id, exerciseYear }))).returning();
      await db.insert(schema.checklists).values({ officeId: office.id, declarationId: d1.id, accessTokenHash: 'mesmo', accessCodeHash: 'a' });
      await expect(db.insert(schema.checklists).values({ officeId: office.id, declarationId: d2.id, accessTokenHash: 'mesmo', accessCodeHash: 'b' })).rejects.toThrow();
      // contadores da elaboração: vazios até serem calculados
      expect(d1.elaborationCounts).toBeNull();
    } finally {
      await migrated.close();
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
    // cópia da pasta só com as migrações anteriores à própria: o banco fica como estava depois da 0002
    // (as posteriores ficam de fora também: o migrador não aplica uma migração mais antiga que a última aplicada)
    const dir = mkdtempSync(join(tmpdir(), 'verifco-migracoes-'));
    const client = new PGlite();
    try {
      cpSync(MIGRATIONS, dir, { recursive: true });
      const journal = readJournal(MIGRATIONS);
      const journalPath = join(dir, 'meta/_journal.json');
      // só as migrações anteriores à própria (o migrador não volta a uma migração mais antiga que a última aplicada)
      const before = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === CUSTOM));
      writeFileSync(journalPath, JSON.stringify({ ...journal, entries: before }));
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: dir });

      // linhas gravadas em SQL: o schema.ts atual tem colunas de migrações posteriores
      const one = async (query: string, params: unknown[]) => (await client.query<{ id: string; access_expires_at: Date | null }>(query, params)).rows[0];
      const office = await one(`insert into offices (name) values ($1) returning id`, ['Escritório']);
      const customer = await one(`insert into customers (office_id, name, cpf_cnpj) values ($1, $2, $3) returning id`, [office.id, 'Cliente', '52998224725']);
      const declaration = await one(`insert into declarations (office_id, customer_id, exercise_year) values ($1, $2, 2026) returning id`, [office.id, customer.id]);
      const old = await one(`insert into checklists (office_id, declaration_id, access_token_hash, access_code_hash) values ($1, $2, 'a', 'b') returning id, access_expires_at`, [
        office.id,
        declaration.id,
      ]);
      expect(old.access_expires_at).toBeNull();

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
