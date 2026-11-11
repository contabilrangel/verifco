import type { SyncConfig } from './config';
import { clientHeader, type ClientInfo } from './version';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const toApiError = (err: unknown) => (err instanceof ApiError ? err : new ApiError(0, err instanceof Error ? err.message : String(err)));

/** Token recusado (revogado, inválido ou de outro escopo): não adianta tentar de novo. */
export const isAuthError = (err: ApiError) => err.status === 401 || err.status === 403;

export const isConfigured = (cfg: SyncConfig) => Boolean(cfg.apiUrl && cfg.token);

const base = (cfg: SyncConfig) => {
  if (!isConfigured(cfg)) throw new ApiError(0, 'Configure o endereço e o token: verifco-sync configurar (ou verifco-sync config --url <endereço> --token vfk_...)');
  return cfg.apiUrl.replace(/\/+$/, '').replace(/\/api$/, '');
};

async function call<T>(cfg: SyncConfig, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: T }> {
  const { timeoutMs, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${base(cfg)}/api${path}`, {
      ...rest,
      headers: { ...(rest.headers ?? {}), Authorization: `Bearer ${cfg.token}`, 'X-Verifco-Client': clientHeader() },
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'o servidor não respondeu a tempo' : err instanceof Error ? err.message : String(err);
    throw new ApiError(0, `Sem conexão com ${cfg.apiUrl}: ${reason}`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `Erro ${res.status}`);
  return { status: res.status, body: body as T };
}

export interface WhoAmI {
  office: { name: string };
  token: { name: string; scope: string };
  /** Versões do sincronizador aceitas e a mais recente (ausente em servidores anteriores). */
  client?: ClientInfo | null;
}

export const whoami = (cfg: SyncConfig, opts: { timeoutMs?: number } = {}) => call<WhoAmI>(cfg, '/sync/whoami', { timeoutMs: opts.timeoutMs ?? 30_000 });

export interface UploadResult {
  duplicate: boolean;
  customer: { id: string; name: string };
  year: number;
  type?: string;
}

/** Envia um arquivo (multipart) para /api/sync/files ou /api/sync/prefilled. */
export function upload(
  cfg: SyncConfig,
  input: {
    destination: 'files' | 'prefilled';
    data: Buffer;
    name: string;
    path: string;
    cpf?: string | null;
    year?: number | null;
    type?: string;
    /** Data de modificação do arquivo (mtime): no recibo (.REC) vira a data da transmissão. */
    modifiedAt?: Date | null;
  },
) {
  const form = new FormData();
  if (input.cpf) form.set('cpf', input.cpf);
  if (input.year) form.set('ano', String(input.year));
  if (input.type && input.destination === 'files') form.set('tipo', input.type);
  form.set('caminho', input.path);
  // ISO 8601 em UTC; a API converte para o dia de Brasília (versões da API que não conhecem o campo o ignoram)
  if (input.destination === 'files' && input.modifiedAt && !Number.isNaN(input.modifiedAt.getTime())) form.set('modificadoEm', input.modifiedAt.toISOString());
  form.set('file', new Blob([new Uint8Array(input.data)]), input.name);
  return call<UploadResult>(cfg, `/sync/${input.destination}`, { method: 'POST', body: form });
}

/** Por que o arquivo vai para a caixa de entrada do escritório em vez de para um cliente. */
export type InboxReason = 'sem_cpf' | 'cliente_nao_cadastrado';

export interface InboxResult {
  id: string;
  duplicate: boolean;
}

/**
 * Envia à caixa de entrada do escritório (POST /api/sync/inbox, multipart) um arquivo que não pôde
 * ser vinculado a um cliente. Servidores anteriores respondem 404/405 (rota inexistente).
 */
export function sendInbox(cfg: SyncConfig, input: { data: Buffer; name: string; path: string; reason: InboxReason; cpf?: string | null; year?: number | null }) {
  const form = new FormData();
  form.set('motivo', input.reason);
  form.set('caminho', input.path);
  if (input.cpf) form.set('cpf', input.cpf);
  if (input.year) form.set('ano', String(input.year));
  form.set('file', new Blob([new Uint8Array(input.data)]), input.name);
  return call<InboxResult>(cfg, '/sync/inbox', { method: 'POST', body: form });
}

/** A rota da caixa de entrada não existe neste servidor (versão anterior da API). */
export const inboxUnavailable = (err: ApiError) => err.status === 404 || err.status === 405;
