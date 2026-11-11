/** Banco exclusivo da administração global; nenhum dado de clientes dos escritórios. */
import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Identidades da plataforma: nunca pertencem a um escritório. */
export const platformUsers = pgTable('platform_users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<'owner' | 'developer'>().notNull().default('developer'),
  isActive: boolean('is_active').notNull().default(true),
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: createdAt(),
  // colunas novas ficam no fim: a ordem bate com a do banco que recebeu a migração
  /** Verificação em duas etapas (TOTP): segredo cifrado; vale só depois de confirmado. */
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabledAt: ts('totp_enabled_at'),
  totpRecoveryHashes: jsonb('totp_recovery_hashes').$type<string[]>().notNull().default([]),
  lastLoginAt: ts('last_login_at'),
}, (t) => [uniqueIndex('platform_users_email_uq').on(sql`lower(${t.email})`)]);

export const platformAiConnections = pgTable('platform_ai_connections', {
  id: id(),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  model: text('model').notNull(),
  baseUrl: text('base_url').notNull(),
  supportsImages: boolean('supports_images').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  secretsEnc: text('secrets_enc'),
  lastTestAt: ts('last_test_at'),
  status: text('status').notNull().default('configured'),
  updatedAt: updatedAt(),
});

export const platformSettings = pgTable('platform_settings', {
  id: text('id').primaryKey().default('global'),
  legacyImportedAt: ts('legacy_imported_at'),
  defaultAiId: uuid('default_ai_id').references(() => platformAiConnections.id, { onDelete: 'restrict' }),
  updatedAt: updatedAt(),
  /** Cadastro de novos escritórios (null = vale a variável SIGNUP_ENABLED). */
  signupEnabled: boolean('signup_enabled'),
  /** Avaliação criada no cadastro: dias e limite de declarações (null = padrão do código). */
  trialDays: integer('trial_days'),
  trialDeclarationLimit: integer('trial_declaration_limit'),
  supportEmail: text('support_email'),
  termsUrl: text('terms_url'),
  privacyUrl: text('privacy_url'),
});

export const platformAuditLogs = pgTable('platform_audit_logs', {
  id: id(),
  actorId: uuid('actor_id').references(() => platformUsers.id),
  action: text('action').notNull(),
  entityId: text('entity_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  windowStartedAt: ts('window_started_at').notNull().defaultNow(),
});
