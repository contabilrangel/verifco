/**
 * Utilitários HTTP comuns aos clientes das integrações: timeout em toda chamada,
 * leitura segura do corpo e mensagens de erro claras em português.
 * Nunca registre em log cabeçalhos ou corpos: eles carregam chaves de API.
 */

export const PROVIDER_LABELS: Record<string, string> = {
  asaas: 'Asaas',
  omie: 'Omie',
  whatsapp: 'WhatsApp',
  evolution: 'Evolution API',
  meta: 'WhatsApp Cloud API',
  smtp: 'servidor de e-mail',
  serpro: 'SERPRO',
  ai: 'serviço de IA',
};

/** Falha ao falar com um provedor externo (mensagem pronta para o usuário). */
export class IntegrationError extends Error {
  constructor(
    public provider: string,
    message: string,
    public status?: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export const DEFAULT_TIMEOUT_MS = 20_000;

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  /** Objeto serializado como JSON; string/FormData/URLSearchParams vão como estão. */
  body?: unknown;
  timeoutMs?: number;
  /**
   * Endereço informado pelo escritório: a mensagem de falha de rede não traz o motivo técnico
   * (ECONNREFUSED etc.), para a integração não virar ferramenta de varredura de portas.
   */
  opaqueErrors?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  text: string;
  headers: Headers;
}

const isRawBody = (b: unknown) => typeof b === 'string' || b instanceof FormData || b instanceof URLSearchParams || b instanceof Blob;

/**
 * Faz a requisição com timeout e devolve o corpo já interpretado (JSON quando possível).
 * Não lança para respostas HTTP de erro: quem chama decide (veja `ensureOk`).
 * Lança `IntegrationError` em falha de rede ou timeout.
 */
export async function httpRequest<T = unknown>(fetchImpl: typeof fetch, provider: string, url: string, req: HttpRequest = {}): Promise<HttpResponse<T>> {
  const label = PROVIDER_LABELS[provider] ?? provider;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
  let body: RequestInit['body'];
  if (req.body !== undefined && req.body !== null) {
    if (isRawBody(req.body)) body = req.body as RequestInit['body'];
    else {
      headers['Content-Type'] ??= 'application/json';
      body = JSON.stringify(req.body);
    }
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { method: req.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new IntegrationError(provider, `O ${label} não respondeu em ${Math.round(timeoutMs / 1000)} segundos. Tente novamente em instantes.`);
    }
    if (req.opaqueErrors) throw new IntegrationError(provider, `Não foi possível conectar ao ${label}. Confira o endereço e a conexão.`);
    const reason = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'erro de rede';
    throw new IntegrationError(provider, `Não foi possível conectar ao ${label} (${reason}). Confira o endereço e a conexão.`);
  }
  const text = await res.text().catch(() => '');
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  } else data = null;
  return { status: res.status, ok: res.ok, data: data as T, text, headers: res.headers };
}

/**
 * Lança `IntegrationError` se a resposta não for 2xx, usando `describe` para extrair a
 * mensagem do provedor. 401/403 viram uma mensagem sobre credenciais.
 */
export function ensureOk<T>(
  provider: string,
  res: HttpResponse<T>,
  describe?: (data: unknown) => string | null | undefined,
  opts: { rawBody?: boolean } = {},
): T {
  if (res.ok) return res.data;
  const label = PROVIDER_LABELS[provider] ?? provider;
  // com rawBody=false (endereço informado pelo escritório) o corpo cru da resposta não volta ao usuário
  const described = describe?.(res.data)?.slice(0, 200);
  const raw = described ?? (opts.rawBody !== false && typeof res.data === 'string' ? res.data.slice(0, 300) : null);
  const detail = raw ? raw.trim().replace(/[.\s]+$/, '') : null;
  if (res.status === 401 || res.status === 403) {
    throw new IntegrationError(provider, `Credenciais recusadas pelo ${label} (HTTP ${res.status})${detail ? `: ${detail}` : ''}. Confira a chave configurada.`, res.status);
  }
  if (res.status === 429) {
    throw new IntegrationError(provider, `Limite de requisições do ${label} atingido. Tente novamente em alguns minutos.`, res.status);
  }
  throw new IntegrationError(provider, `${label} respondeu com erro (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`, res.status, res.data);
}

/** Mensagem curta de qualquer erro, para gravar em `lastError` ou no job. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** AAAA-MM-DD de hoje (fuso de Brasília): o mesmo `todayIso` do pacote compartilhado. */
export { todayIso } from '@verifco/shared';

export const centsToDecimal = (cents: number) => Math.round(cents) / 100;
export const decimalToCents = (value: number | string) => Math.round(Number(value) * 100);
