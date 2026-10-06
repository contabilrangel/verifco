import { assertSeparateDatabases, loadConfig, type Config } from './config';
import type { AppContext } from './context';
import { openDatabase, openPlatformDatabase } from './db/client';
import { importLegacyPlatform } from './db/import-platform';
import { createProviders } from './integrations';
import { JobQueue } from './jobs/queue';
import { registerJobHandlers } from './jobs/handlers';
import { JOB_POLICIES } from './jobs/policies';
import { Secrets } from './lib/crypto';
import { FileService, LocalBlobStore, MemoryBlobStore } from './storage';
import type { Providers } from './integrations/providers';

/** Monta o contexto da aplicação (banco, arquivos, fila e provedores). */
export async function createContext(overrides: Partial<Config> = {}, opts: { providers?: Providers; memoryStorage?: boolean } = {}) {
  const config = { ...loadConfig(), ...overrides };
  assertSeparateDatabases(config);
  const operational = await openDatabase(config.DATABASE_URL, { sync: config.DB_SYNC });
  let platform: Awaited<ReturnType<typeof openPlatformDatabase>>;
  try { platform = await openPlatformDatabase(config.PLATFORM_DATABASE_URL, { sync: config.DB_SYNC }); }
  catch (error) { await operational.close(); throw error; }
  const close = async () => { await Promise.all([operational.close(), platform.close()]); };
  const db = operational.db; const platformDb = platform.db;
  try {
    if (await importLegacyPlatform(db, platformDb)) console.log('[verifco] Administração transferida para o banco separado; arquivo anterior preservado.');
    const secrets = new Secrets(config.ENCRYPTION_KEY);
    const files = new FileService(db, opts.memoryStorage ? new MemoryBlobStore() : new LocalBlobStore(config.STORAGE_DIR));
    const jobs = new JobQueue(db, { concurrency: config.JOB_CONCURRENCY, policies: JOB_POLICIES });
    const partial = { config, db, platformDb, secrets, files, jobs } as AppContext;
    partial.providers = opts.providers ?? createProviders(partial);
    await registerJobHandlers(partial);
    return { ctx: partial, close };
  } catch (error) { await close(); throw error; }
}
