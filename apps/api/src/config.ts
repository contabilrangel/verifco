import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3333),
  HOST: z.string().default('0.0.0.0'),
  /** `postgres://...` para PostgreSQL; vazio ou `pglite:<pasta>` usa o PGlite embutido. */
  DATABASE_URL: z.string().default('pglite:.data/pglite'),
  /** Como preparar o banco: `migrate` (arquivos em drizzle/) ou `push` (direto do schema.ts). */
  DB_SYNC: z.enum(['migrate', 'push']).optional(),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  /** Chave de 32 bytes em base64 para cifrar credenciais e segredos de integrações. */
  ENCRYPTION_KEY: z.string().default('ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0zMi1ieXRlcyE='),
  STORAGE_DIR: z.string().default('.data/storage'),
  WEB_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:3333'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('Verifco <nao-responda@verifco.com.br>'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  RUN_WORKER: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.startsWith('dev-only')) throw new Error('Defina JWT_SECRET em produção.');
    if (cfg.ENCRYPTION_KEY === schema.shape.ENCRYPTION_KEY.parse(undefined)) throw new Error('Defina ENCRYPTION_KEY em produção.');
  }
  return cfg;
}
