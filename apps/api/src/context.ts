import type { Config } from './config';
import type { Db } from './db/client';
import type { JobQueue } from './jobs/queue';
import type { Secrets } from './lib/crypto';
import type { FileService } from './storage';
import type { Providers } from './integrations/providers';

/** Dependências compartilhadas pelos módulos (injetadas no Fastify como `app.ctx`). */
export interface AppContext {
  config: Config;
  db: Db;
  secrets: Secrets;
  files: FileService;
  jobs: JobQueue;
  providers: Providers;
}

export interface AuthUser {
  kind: 'user';
  userId: string;
  officeId: string;
  name: string;
  email: string;
  isOwner: boolean;
  roleId: string | null;
  permissions: Set<string>;
}

export interface AuthCustomer {
  kind: 'customer';
  customerId: string;
  officeId: string;
  /** Escopo do acesso: checklist de uma declaração ou aprovação de orçamento. */
  scope: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    platformAuth: { id: string; name: string; email: string; role: 'owner' | 'developer' } | null;
    auth: AuthUser | null;
    customerAuth: AuthCustomer | null;
  }
}
