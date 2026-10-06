import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { loadConfig, assertSeparateDatabases } from '../src/config';
import { openDatabase, openPlatformDatabase } from '../src/db/client';
import { importLegacyPlatform } from '../src/db/import-platform';
import * as officeSchema from '../src/db/schema';
import { platformAiConnections, platformUsers, platformSettings, platformAuditLogs } from '../src/db/platform-schema';
import { Secrets } from '../src/lib/crypto';
import { createTestEnv, registerOffice, VALID_CPFS } from './helpers';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const prod = { NODE_ENV: 'production', JWT_SECRET: 'k'.repeat(48), ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATABASE_URL: 'postgres://offices:secret@db:5432/offices', PLATFORM_DATABASE_URL: 'postgres://owner:other@db:5432/platform' };

describe('bancos da plataforma e dos escritórios', () => {
  it('exige duas conexões em produção e recusa o mesmo database mesmo com outra senha, usuário, protocolo ou schema', () => {
    expect(() => loadConfig(prod)).not.toThrow();
    expect(() => loadConfig({ ...prod, PLATFORM_DATABASE_URL: undefined })).toThrow(/PLATFORM_DATABASE_URL/);
    for (const url of ['postgresql://owner:other@DB/offices?options=-csearch_path%3Dplatform', 'postgres://owner:other@db:5432/offices']) {
      expect(() => loadConfig({ ...prod, PLATFORM_DATABASE_URL: url })).toThrow(/bancos diferentes/);
    }
    expect(() => loadConfig({ ...prod, PLATFORM_DATABASE_URL: 'postgres://owner:other@elsewhere/platform?host=db&database=offices' })).toThrow(/inválida/);
    expect(() => assertSeparateDatabases({ DATABASE_URL: 'pglite:./same', PLATFORM_DATABASE_URL: 'pglite:same' })).toThrow(/bancos diferentes/);
    expect(() => assertSeparateDatabases({ DATABASE_URL: 'postgres://a:x@localhost/offices', PLATFORM_DATABASE_URL: 'postgres://b:y@127.0.0.1:5432/offices' })).toThrow(/bancos diferentes/);
    // Cada abertura de memory cria uma instância própria.
    expect(() => assertSeparateDatabases({ DATABASE_URL: 'pglite:memory', PLATFORM_DATABASE_URL: 'pglite:memory' })).not.toThrow();
  });

  it('migrações da plataforma produzem o mesmo esquema que o push e apenas tabelas administrativas', async () => {
    const migrated = await openPlatformDatabase('pglite:memory', { sync: 'migrate' });
    const pushed = await openPlatformDatabase('pglite:memory', { sync: 'push' });
    try {
      const shape = async (db: typeof migrated.db) => (await db.execute(sql`select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`)).rows;
      expect(await shape(migrated.db)).toEqual(await shape(pushed.db));
      const names = (await migrated.db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows.map(r => r.table_name);
      expect(names).toEqual(['platform_ai_connections', 'platform_audit_logs', 'platform_settings', 'platform_users', 'rate_limits']);
    } finally { await migrated.close(); await pushed.close(); }
  });

  it('contadores operam somente seus dados; tabelas e limites de login global ficam no outro banco', async () => {
    const env = await createTestEnv();
    try {
      const first = await registerOffice(env, 'Primeiro'); const second = await registerOffice(env, 'Segundo');
      const customer = await first.api.post('/api/customers', { name: 'Cliente Primeiro', cpfCnpj: VALID_CPFS[0] });
      expect(customer.status).toBe(201);
      expect((await second.api.get('/api/customers')).body.data).toEqual([]);
      expect((await second.api.get('/api/customers/' + customer.body.id)).status).toBe(404);
      expect((await second.api.put('/api/customers/' + customer.body.id, { name: 'Outra pessoa', cpfCnpj: VALID_CPFS[0] })).status).toBe(404);
      const office = await env.ctx.db.execute(sql`select to_regclass('public.platform_users') as admins`);
      const platform = await env.ctx.platformDb.execute(sql`select to_regclass('public.offices') as offices`);
      expect(office.rows[0].admins).toBeNull(); expect(platform.rows[0].offices).toBeNull();
      env.ctx.config.RATE_LIMIT = true;
      for (let i = 0; i < 16; i++) await env.app.inject({ method: 'POST', url: '/api/platform/login', payload: { email: `fake${i}@teste.com`, password: 'invalid' } });
      const limited = await env.app.inject({ method: 'POST', url: '/api/platform/login', payload: { email: 'fake@teste.com', password: 'invalid' } });
      expect(limited.statusCode).toBe(429);
      expect((await env.ctx.db.select().from(officeSchema.rateLimits))).toEqual([]);
      expect((await env.ctx.platformDb.execute(sql`select count(*)::int as count from rate_limits`)).rows[0].count).toBeGreaterThan(0);
    } finally { await env.close(); }
  });

  it('recusa um arquivo físico do banco de escritórios como plataforma antes de aplicar suas migrações', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verifco-purpose-'));
    try {
      const url = `pglite:${join(dir, 'db')}`;
      const original = await openDatabase(url);
      await original.db.insert(officeSchema.offices).values({ name: 'Preservado' });
      await original.close();
      await expect(openPlatformDatabase(url)).rejects.toThrow(/banco de escritórios/);
      const reopened = await openDatabase(url);
      try { expect((await reopened.db.select().from(officeSchema.offices))[0].name).toBe('Preservado'); }
      finally { await reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it('preserva e transfere a administração antiga com IDs, hash, chave cifrada, escolha e auditoria; reiniciar não repõe valores antigos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verifco-transfer-'));
  const client = new PGlite(); const source = drizzle(client, { schema: officeSchema });
  const destination = await openPlatformDatabase('pglite:memory', { sync: 'migrate' });
  const occupied = await openPlatformDatabase('pglite:memory');
  try {
    cpSync(MIGRATIONS, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e: { idx: number }) => e.idx <= 6) }));
    await migrate(source, { migrationsFolder: dir });
    const secrets = new Secrets(Buffer.alloc(32, 7).toString('base64'));
    const encrypted = secrets.encryptJson({ apiKey: 'legacy-secret' });
    const account = (await client.query<{ id: string }>(`insert into platform_users (name,email,password_hash,role) values ('Dono','owner@old.com','hash-preservado','owner') returning id`)).rows[0];
    const connection = (await client.query<{ id: string }>(`insert into platform_ai_connections (provider,name,model,base_url,secrets_enc) values ('openai','Antiga','modelo-antigo','https://api.openai.com/v1',$1) returning id`, [encrypted])).rows[0];
    await client.query(`insert into platform_settings (id,default_ai_id) values ('global',$1)`, [connection.id]);
    await client.query(`insert into platform_audit_logs (actor_id,action) values ($1,'legacy.audit')`, [account.id]);
    await source.insert(officeSchema.offices).values({ name: 'Escritório preservado' });
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(source, { migrationsFolder: dir });
    expect((await source.execute(sql`select to_regclass('public.platform_users') as admins`)).rows[0].admins).toBeNull();
    expect((await source.select().from(officeSchema.offices))[0].name).toBe('Escritório preservado');
    expect((await client.query<{ password_hash: string }>(`select password_hash from legacy_platform.platform_users`)).rows[0].password_hash).toBe('hash-preservado');
    // Conflito no destino nunca sobrescreve administração existente, nem copia parcialmente.
    await occupied.db.insert(platformUsers).values({ name: 'Outro', email: 'another@owner.com', passwordHash: 'other', role: 'owner' });
    await expect(importLegacyPlatform(source, occupied.db)).rejects.toThrow(/nenhum dado foi sobrescrito/);
    expect(await occupied.db.select().from(platformAiConnections)).toEqual([]);
    expect(await importLegacyPlatform(source, destination.db)).toBe(true);
    expect((await destination.db.query.platformUsers.findFirst())!).toMatchObject({ id: account.id, passwordHash: 'hash-preservado', role: 'owner' });
    const copied = (await destination.db.query.platformAiConnections.findFirst())!;
    expect(copied.id).toBe(connection.id); expect(copied.secretsEnc).toBe(encrypted);
    expect(secrets.decryptJson(copied.secretsEnc)).toEqual({ apiKey: 'legacy-secret' });
    expect((await destination.db.query.platformSettings.findFirst())!).toMatchObject({ defaultAiId: connection.id, legacyImportedAt: expect.any(Date) });
    expect((await destination.db.select().from(platformAuditLogs))[0]).toMatchObject({ actorId: account.id, action: 'legacy.audit' });
    await destination.db.update(platformAiConnections).set({ model: 'modelo-novo' }).where(eq(platformAiConnections.id, connection.id));
    expect(await importLegacyPlatform(source, destination.db)).toBe(false);
    expect((await destination.db.query.platformAiConnections.findFirst())!.model).toBe('modelo-novo');
  } finally {
    await client.close(); await destination.close(); await occupied.close(); rmSync(dir, { recursive: true, force: true });
  }
});
