/**
 * Transferência única do arquivo preservado pela migração 0007 para o banco separado da plataforma.
 * Depois da transferência (ou quando ela já foi feita antes), o schema `legacy_platform` é removido
 * do banco do escritório: ele guarda hashes de senha e chaves de IA cifradas e, se o
 * PLATFORM_DATABASE_URL passasse a apontar para um banco vazio, seria reimportado em silêncio,
 * ressuscitando contas antigas (inclusive desativadas ou com chave trocada). A fonte viva passa a
 * ser o banco da plataforma. Em caso de conflito (destino já com dados), nada é removido.
 */
import { eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db, PlatformDb } from './client';
import { platformUsers, platformAiConnections, platformSettings, platformAuditLogs } from './platform-schema';

export async function importLegacyPlatform(source: Db, destination: PlatformDb) {
  const exists = await source.execute<{ table_name: string | null }>(sql`select to_regclass('legacy_platform.platform_users')::text as table_name`);
  if (!exists.rows[0]?.table_name) return false;
  const outcome = await destination.transaction(async (tx) => {
    // Mesmo lock do bootstrap de proprietário; importação e criação de conta não podem competir.
    await tx.execute(sql`select pg_advisory_xact_lock(728103)`);
    const settings = await tx.query.platformSettings.findFirst({ where: eq(platformSettings.id, 'global') });
    if (settings?.legacyImportedAt) return 'already' as const;
    async function load<T extends PgTable>(table: T): Promise<T['$inferSelect'][]> {
      const columns = Object.entries(getTableColumns(table)).map(([field, column]) => sql`${sql.identifier(column.name)} as ${sql.identifier(field)}`);
      const result = await source.execute<T['$inferSelect']>(sql`select ${sql.join(columns, sql`, `)} from ${sql.identifier('legacy_platform')}.${sql.identifier(getTableName(table))}`);
      // execute() não aplica os codecs do schema (timestamps podem vir como strings).
      return result.rows.map((row) => Object.fromEntries(Object.entries(getTableColumns(table)).map(([field, column]) => {
        const value = row[field];
        return [field, value == null ? value : column.mapFromDriverValue(value)];
      })) as T['$inferSelect']);
    }
    // O arquivo anterior não tem a coluna criada apenas no banco da plataforma.
    const accounts = await load(platformUsers);
    const connections = await load(platformAiConnections);
    const audit = await load(platformAuditLogs);
    const oldSettings = await source.execute<{ id: string; defaultAiId: string | null; updatedAt: Date }>(sql`select id, default_ai_id as "defaultAiId", updated_at as "updatedAt" from legacy_platform.platform_settings`);
    if (!accounts.length && !connections.length && !audit.length && !oldSettings.rows.length) return 'empty' as const;
    const occupied = await tx.execute<{ count: number }>(sql`select (
      (select count(*) from platform_users) + (select count(*) from platform_ai_connections) +
      (select count(*) from platform_settings) + (select count(*) from platform_audit_logs))::int as count`);
    if (occupied.rows[0].count) throw new Error('O banco da plataforma já contém dados e existe uma administração antiga para transferir. Use um banco vazio ou resolva a transferência antes de iniciar; nenhum dado foi sobrescrito.');
    if (accounts.length) await tx.insert(platformUsers).values(accounts);
    if (connections.length) await tx.insert(platformAiConnections).values(connections);
    if (oldSettings.rows.length) await tx.insert(platformSettings).values(oldSettings.rows.map(row => ({ ...row, updatedAt: new Date(row.updatedAt) })));
    if (audit.length) await tx.insert(platformAuditLogs).values(audit);
    await tx.insert(platformSettings).values({ id: 'global', legacyImportedAt: new Date() }).onConflictDoUpdate({
      target: platformSettings.id, set: { legacyImportedAt: new Date() },
    });
    return 'imported' as const;
  });
  // Os dados estão salvos no banco da plataforma (transferidos agora ou já antes): o arquivo com os
  // segredos sai do banco do escritório, e assim não pode ser reimportado em silêncio num banco vazio.
  // No caso "vazio" (instalação nova, sem nada a transferir) o arquivo fica: uma transferência real
  // ainda pode vir, e o CI preenche o legacy_platform depois do primeiro boot para exercitá-la.
  if (outcome !== 'empty') await source.execute(sql`drop schema if exists legacy_platform cascade`);
  return outcome === 'imported';
}
