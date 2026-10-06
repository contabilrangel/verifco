import { z } from 'zod';

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'sim', 'yes', 'on'].includes(v.toLowerCase())));

/** Valores de exemplo que nunca valem em produção (padrão do código e do .env.example). */
const DEV_JWT_SECRET = 'dev-only-secret-change-me-please';
const DEV_ENCRYPTION_KEY = 'ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0zMi1ieXRlcyE=';
const PLACEHOLDER_SECRETS = new Set([DEV_JWT_SECRET, 'troque-esta-chave-com-pelo-menos-32-caracteres']);

const schema = z.object({
  /**
   * Sem NODE_ENV a API roda em modo de desenvolvimento (com aviso no console). `pnpm start`
   * define `production`; em produção os segredos e o banco precisam ser configurados.
   */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3333),
  HOST: z.string().default('0.0.0.0'),
  /** `postgres://...` para PostgreSQL; vazio ou `pglite:<pasta>` usa o PGlite embutido (só desenvolvimento e testes). */
  DATABASE_URL: z.string().default('pglite:.data/pglite'),
  /** Permite o PGlite com NODE_ENV=production (instalação de uma instância só, por sua conta). */
  ALLOW_PGLITE: flag(false),
  /** Como preparar o banco: `migrate` (arquivos em drizzle/) ou `push` (direto do schema.ts). */
  DB_SYNC: z.enum(['migrate', 'push']).optional(),
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  /** Chave de 32 bytes em base64 para cifrar credenciais e segredos de integrações. */
  ENCRYPTION_KEY: z.string().default(DEV_ENCRYPTION_KEY),
  STORAGE_DIR: z.string().default('.data/storage'),
  WEB_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:3333'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /**
   * A API está atrás de proxy reverso / balanceador? Com `true`, o IP do cliente vem do
   * `X-Forwarded-For` (necessário para o limite de tentativas por IP não juntar todo mundo no IP do proxy).
   */
  TRUST_PROXY: flag(false),
  /** Limite de tentativas (login, senha, cadastro e links públicos). Desligado por padrão só nos testes. */
  RATE_LIMIT: z.string().optional(),
  /**
   * Em desenvolvimento, devolve na resposta o código do portal e o link de convite (para testar sem
   * e-mail). Nunca vale em produção.
   */
  DEV_SHOW_ACCESS_CODES: flag(false),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('Verifco <nao-responda@verifco.com.br>'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  RUN_WORKER: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

type Parsed = z.infer<typeof schema>;
export type Config = Omit<Parsed, 'RATE_LIMIT'> & { RATE_LIMIT: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const cfg: Config = {
    ...parsed,
    RATE_LIMIT: parsed.RATE_LIMIT === undefined || parsed.RATE_LIMIT === '' ? parsed.NODE_ENV !== 'test' : ['1', 'true', 'on', 'sim', 'yes'].includes(parsed.RATE_LIMIT.toLowerCase()),
  };
  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (PLACEHOLDER_SECRETS.has(cfg.JWT_SECRET) || cfg.JWT_SECRET.startsWith('dev-only')) problems.push('defina JWT_SECRET (o valor de exemplo não vale)');
    else if (cfg.JWT_SECRET.length < 32) problems.push('JWT_SECRET precisa ter ao menos 32 caracteres');
    if (cfg.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) problems.push('defina ENCRYPTION_KEY');
    if (!/^postgres(ql)?:\/\//i.test(cfg.DATABASE_URL) && !cfg.ALLOW_PGLITE) {
      problems.push('defina DATABASE_URL=postgres://... (o PGlite embutido é só para desenvolvimento; use ALLOW_PGLITE=true para assumir o risco)');
    }
    if (cfg.DEV_SHOW_ACCESS_CODES) problems.push('DEV_SHOW_ACCESS_CODES não pode ser usado em produção');
    if (problems.length) throw new Error(`Configuração inválida para produção: ${problems.join('; ')}.`);
  } else if (cfg.NODE_ENV === 'development' && env.NODE_ENV === undefined && env.VITEST === undefined) {
    console.warn('[verifco] NODE_ENV não definido: a API está em modo de desenvolvimento. Em produção use NODE_ENV=production (o "pnpm start" já define).');
  }
  return cfg;
}

/**
 * Pode devolver segredos de acesso (código do portal, link de convite) na resposta?
 * Só nos testes ou em desenvolvimento com `DEV_SHOW_ACCESS_CODES=true`.
 */
export function exposeDevSecrets(cfg: Pick<Config, 'NODE_ENV' | 'DEV_SHOW_ACCESS_CODES'>): boolean {
  return cfg.NODE_ENV === 'test' || (cfg.NODE_ENV === 'development' && cfg.DEV_SHOW_ACCESS_CODES);
}
