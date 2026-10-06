import { loadConfig, type Config } from './config';
import type { AppContext } from './context';
import { openDatabase } from './db/client';
import { createProviders } from './integrations';
import { JobQueue } from './jobs/queue';
import { registerJobHandlers } from './jobs/handlers';
import { Secrets } from './lib/crypto';
import { FileService, LocalBlobStore, MemoryBlobStore } from './storage';
import type { Providers } from './integrations/providers';

/** Monta o contexto da aplicação (banco, arquivos, fila e provedores). */
export async function createContext(overrides: Partial<Config> = {}, opts: { providers?: Providers; memoryStorage?: boolean } = {}) {
  const config = { ...loadConfig(), ...overrides };
  const { db, close } = await openDatabase(config.DATABASE_URL, { sync: config.DB_SYNC });
  const secrets = new Secrets(config.ENCRYPTION_KEY);
  const files = new FileService(db, opts.memoryStorage ? new MemoryBlobStore() : new LocalBlobStore(config.STORAGE_DIR));
  const jobs = new JobQueue(db);
  const partial = { config, db, secrets, files, jobs } as AppContext;
  partial.providers = opts.providers ?? createProviders(partial);
  await registerJobHandlers(partial);
  return { ctx: partial, close };
}
