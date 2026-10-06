// Executado apenas na stack descartável de CI, nunca no Dokploy de produção.
import assert from 'node:assert/strict';
import pg from 'pg';
import { createContext } from './src/bootstrap.ts';

const office = new pg.Client({ connectionString: process.env.DATABASE_URL });
const platform = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
try {
  await office.connect(); await platform.connect();
  const query = "select to_regclass('public.offices') as offices, to_regclass('public.platform_users') as admins";
  const a = (await office.query(query)).rows[0]; const b = (await platform.query(query)).rows[0];
  assert(a.offices && !a.admins && !b.offices && b.admins, 'Tabelas dos bancos misturadas');
  // Exercita os codecs reais do driver PostgreSQL na transferência de uma conta legada.
  await office.query("insert into legacy_platform.platform_users (name,email,password_hash,role) values ('CI owner','owner@ci.invalid','ci-only-hash','owner')");
  await office.query("insert into legacy_platform.platform_ai_connections (provider,name,model,base_url,secrets_enc) values ('openai','CI','ci-model','https://api.openai.com/v1','ci-only-ciphertext')");
  await office.query("insert into legacy_platform.platform_settings (id,default_ai_id) select 'global',id from legacy_platform.platform_ai_connections");
  await office.query("insert into legacy_platform.platform_audit_logs (actor_id,action) select id,'ci.import' from legacy_platform.platform_users");
  const context = await createContext({ RUN_WORKER: false });
  await context.close();
  const copied = (await platform.query('select password_hash, created_at from platform_users')).rows[0];
  assert.equal(copied.password_hash, 'ci-only-hash'); assert(copied.created_at instanceof Date);
  assert.equal((await platform.query('select secrets_enc from platform_ai_connections')).rows[0].secrets_enc, 'ci-only-ciphertext');
  assert((await platform.query('select legacy_imported_at from platform_settings')).rows[0].legacy_imported_at instanceof Date);
  assert.equal((await platform.query('select action from platform_audit_logs')).rows[0].action, 'ci.import');
  console.log('Bancos separados e transferência no PostgreSQL verificados');
} finally { await Promise.all([office.end(), platform.end()]); }
