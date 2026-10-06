import type { SyncConfig } from './config';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const base = (cfg: SyncConfig) => {
  if (!cfg.apiUrl || !cfg.token) throw new ApiError(0, 'Configure o endereço e o token: npm run config -- --url <endereço> --token vfk_...');
  return cfg.apiUrl.replace(/\/+$/, '').replace(/\/api$/, '');
};

async function call<T>(cfg: SyncConfig, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    res = await fetch(`${base(cfg)}/api${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${cfg.token}` } });
  } catch (err) {
    throw new ApiError(0, `Sem conexão com ${cfg.apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
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

export const whoami = (cfg: SyncConfig) => call<{ office: { name: string }; token: { name: string; scope: string } }>(cfg, '/sync/whoami');

export interface UploadResult {
  duplicate: boolean;
  customer: { id: string; name: string };
  year: number;
  type?: string;
}

/** Envia um arquivo (multipart) para /api/sync/files ou /api/sync/prefilled. */
export function upload(
  cfg: SyncConfig,
  input: { destination: 'files' | 'prefilled'; data: Buffer; name: string; path: string; cpf?: string | null; year?: number | null; type?: string },
) {
  const form = new FormData();
  if (input.cpf) form.set('cpf', input.cpf);
  if (input.year) form.set('ano', String(input.year));
  if (input.type && input.destination === 'files') form.set('tipo', input.type);
  form.set('caminho', input.path);
  form.set('file', new Blob([new Uint8Array(input.data)]), input.name);
  return call<UploadResult>(cfg, `/sync/${input.destination}`, { method: 'POST', body: form });
}
