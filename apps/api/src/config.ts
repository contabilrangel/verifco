import { resolve } from 'node:path';
import { isIP } from 'node:net';
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
  /** Banco exclusivo de identidades, chaves de IA, configuração e auditoria da plataforma. */
  PLATFORM_DATABASE_URL: z.string().default('pglite:.data/platform'),
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
   * Proxies reversos / balanceadores na frente da API, para ler o IP real do cliente no
   * `X-Forwarded-For` (sem isso o limite de tentativas por IP junta todo mundo no IP do proxy).
   * Use o número de saltos confiáveis (`1` = um proxy na frente; o IP do cliente é o último valor
   * que esse proxy acrescentou, e o proxy precisa conectar por rede interna, veja `lib/proxy.ts`)
   * ou a lista de IPs/CIDRs dos proxies (`10.0.0.0/8,192.168.1.10`).
   * `true` confia em todos os saltos: o cliente escolhe o primeiro valor do cabeçalho e escapa do
   * limite (aceito, com aviso no console). Vazio, `0` ou `false`: desligado (API exposta direto).
   * Obrigatório atrás de proxy; em produção, a API avisa no console se receber `X-Forwarded-For` com ele desligado.
   */
  TRUST_PROXY: z.string().optional(),
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
  /**
   * Quantas tarefas da fila cada instância com RUN_WORKER executa ao mesmo tempo. As longas (backup,
   * eCAC do escritório, elaboração, Radar) nunca ocupam a última vaga, que fica para envios e cobranças.
   */
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
});

type Parsed = z.infer<typeof schema>;
/** Como o Fastify (`trustProxy`) entende: desligado, todos os saltos, número de saltos ou IPs/CIDRs. */
export type TrustProxy = boolean | number | string;
export type Config = Omit<Parsed, 'RATE_LIMIT' | 'TRUST_PROXY'> & { RATE_LIMIT: boolean; TRUST_PROXY: TrustProxy };

/** Nomes de faixas que o Fastify (proxy-addr) aceita em `trustProxy`. */
const PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isProxyAddress(item: string) {
  if (PROXY_RANGES.has(item)) return true;
  const [ip, prefix, ...rest] = item.split('/');
  const family = isIP(ip);
  if (!family || rest.length) return false;
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128));
}

/** `TRUST_PROXY` do ambiente para o `trustProxy` do Fastify (veja o comentário no schema). */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = (raw ?? '').trim();
  const lower = v.toLowerCase();
  if (v === '' || ['0', 'false', 'off', 'no', 'nao', 'não'].includes(lower)) return false;
  if (['true', 'sim', 'yes', 'on'].includes(lower)) return true;
  if (/^\d+$/.test(v)) return Number(v);
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = list.filter((item) => !isProxyAddress(item));
  if (!list.length || invalid.length) {
    throw new Error(
      `TRUST_PROXY inválido (${invalid.join(', ') || v}): use o número de proxies na frente da API (ex.: 1) ou os IPs/CIDRs deles separados por vírgula.`,
    );
  }
  return list.join(',');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const cfg: Config = {
    ...parsed,
    RATE_LIMIT: parsed.RATE_LIMIT === undefined || parsed.RATE_LIMIT === '' ? parsed.NODE_ENV !== 'test' : ['1', 'true', 'on', 'sim', 'yes'].includes(parsed.RATE_LIMIT.toLowerCase()),
    TRUST_PROXY: parseTrustProxy(parsed.TRUST_PROXY),
  };
  if (cfg.TRUST_PROXY === true) {
    console.warn(
      '[verifco] TRUST_PROXY=true confia em todos os saltos do X-Forwarded-For: o cliente pode escolher o próprio IP e escapar do limite de tentativas. ' +
        'Use TRUST_PROXY=1 (número de proxies na frente da API) ou os IPs/CIDRs dos proxies (veja docs/ARQUITETURA.md, "Implantação").',
    );
  }
  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (PLACEHOLDER_SECRETS.has(cfg.JWT_SECRET) || cfg.JWT_SECRET.startsWith('dev-only')) problems.push('defina JWT_SECRET (o valor de exemplo não vale)');
    else if (cfg.JWT_SECRET.length < 32) problems.push('JWT_SECRET precisa ter ao menos 32 caracteres');
    if (cfg.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) problems.push('defina ENCRYPTION_KEY');
    if (!/^postgres(ql)?:\/\//i.test(cfg.DATABASE_URL) && !cfg.ALLOW_PGLITE) {
      problems.push('defina DATABASE_URL=postgres://... (o PGlite embutido é só para desenvolvimento; use ALLOW_PGLITE=true para assumir o risco)');
    }
    if (!/^postgres(ql)?:\/\//i.test(cfg.PLATFORM_DATABASE_URL) && !cfg.ALLOW_PGLITE) problems.push('defina PLATFORM_DATABASE_URL=postgres://... para um banco separado');
    if (cfg.DEV_SHOW_ACCESS_CODES) problems.push('DEV_SHOW_ACCESS_CODES não pode ser usado em produção');
    if (problems.length) throw new Error(`Configuração inválida para produção: ${problems.join('; ')}.`);
  } else if (cfg.NODE_ENV === 'development' && env.NODE_ENV === undefined && env.VITEST === undefined) {
    console.warn('[verifco] NODE_ENV não definido: a API está em modo de desenvolvimento. Em produção use NODE_ENV=production (o "pnpm start" já define).');
  }
  assertSeparateDatabases(cfg);
  return cfg;
}

/**
 * Pode devolver segredos de acesso (código do portal, link de convite) na resposta?
 * Só nos testes ou em desenvolvimento com `DEV_SHOW_ACCESS_CODES=true`.
 */
export function exposeDevSecrets(cfg: Pick<Config, 'NODE_ENV' | 'DEV_SHOW_ACCESS_CODES'>): boolean {
  return cfg.NODE_ENV === 'test' || (cfg.NODE_ENV === 'development' && cfg.DEV_SHOW_ACCESS_CODES);
}

/** Não basta trocar de usuário ou schema: a administração exige outro database. Nunca imprime URLs com senhas. */
export function assertSeparateDatabases(cfg: Pick<Config, 'DATABASE_URL' | 'PLATFORM_DATABASE_URL'>) {
  function identity(raw: string) {
    if (/^postgres(ql)?:\/\//i.test(raw)) {
      const url = new URL(raw);
      if (['host', 'port', 'database', 'dbname', 'user'].some((key) => url.searchParams.has(key))) throw new Error('Use host, porta, usuário e banco diretamente na URL.');
      let host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (['localhost', '127.0.0.1', '[::1]'].includes(host)) host = 'loopback';
      // PostgreSQL sem pathname usa o nome do usuário como database.
      return `pg:${host}:${url.port || '5432'}:${decodeURIComponent(url.pathname.slice(1) || url.username)}`;
    }
    const target = raw.replace(/^pglite:/, '');
    return !target || target === 'memory' ? null : `file:${resolve(target).toLowerCase()}`;
  }
  let office: string | null; let platform: string | null;
  try { office = identity(cfg.DATABASE_URL); platform = identity(cfg.PLATFORM_DATABASE_URL); }
  catch { throw new Error('DATABASE_URL ou PLATFORM_DATABASE_URL inválida. Confira as conexões, sem compartilhar as senhas.'); }
  if (office && office === platform) throw new Error('DATABASE_URL e PLATFORM_DATABASE_URL devem apontar para bancos diferentes, mesmo com usuários ou schemas diferentes.');
}
