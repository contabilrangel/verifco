/** Cliente HTTP da API do Verifco. */
const TOKEN_KEY = 'verifco.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* navegação privada: segue só em memória */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export const OFFLINE_MESSAGE = 'Sem conexão com o servidor. Verifique sua internet e tente de novo.';

/** Mensagem de erro para a interface (os erros da API já vêm em português). */
export function errorMessage(e: unknown, fallback = 'Não foi possível concluir. Tente de novo.'): string {
  if (e instanceof ApiError) return e.message || fallback;
  if (e instanceof TypeError) return OFFLINE_MESSAGE;
  return fallback;
}

/**
 * Tipos que podem abrir numa aba do navegador sem rodar script (PDF e imagens; nunca HTML/SVG).
 * É a única lista do app: botões de "Visualizar" e aberturas de arquivo usam {@link isViewableType}.
 */
export const VIEWABLE_TYPES: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** O tipo (com ou sem parâmetros, como `; charset=...`) pode abrir no navegador? */
export const isViewableType = (mime: string | null | undefined) => VIEWABLE_TYPES.has((mime ?? '').split(';')[0].trim().toLowerCase());

const filenameOf = (res: Response, fallback: string) => {
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd) ?? /filename="?([^";]+)"?/.exec(cd);
  return m ? decodeURIComponent(m[1]) : fallback;
};

/** Dispara o download como binário (o navegador não interpreta o conteúdo). */
function saveBlob(data: ArrayBuffer | Blob, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = opts.token ?? getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { method, headers, body: payload });
  } catch {
    // sem rede, o navegador lança "Failed to fetch" (em inglês): a interface recebe a mensagem em português
    throw new ApiError(0, OFFLINE_MESSAGE);
  }
  if (res.status === 401 && !opts.token && token) onUnauthorized?.();
  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    let details: unknown;
    try {
      const j = await res.json();
      msg = j.error ?? msg;
      details = j.details;
    } catch {
      /* resposta sem JSON */
    }
    throw new ApiError(res.status, msg, details);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T>(path: string, opts?: { token?: string }) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: { token?: string }) => request<T>('POST', path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: { token?: string }) => request<T>('PUT', path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, files: File[] | File, fields: Record<string, string> = {}, opts?: { token?: string }) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const f of Array.isArray(files) ? files : [files]) fd.append('file', f, f.name);
    return request<T>('POST', path, fd, opts);
  },
  /**
   * Baixa um arquivo autenticado e dispara o download no navegador. Usa `blob()` (que o navegador
   * pode guardar em disco), não `arrayBuffer()`: um backup de alguns GB não cabe na memória da aba.
   */
  download: async (path: string, fallbackName = 'arquivo', body?: unknown) => {
    const res = await request<Response>(body ? 'POST' : 'GET', path, body, { raw: true });
    saveBlob(await res.blob(), filenameOf(res, fallbackName));
  },
  /**
   * Abre um arquivo autenticado em nova aba. Só PDF e imagens abrem (com o tipo fixado no blob,
   * que tem a origem do app); qualquer outro tipo é baixado, para um HTML/SVG enviado como
   * documento não rodar script com a sessão de quem abre.
   */
  open: async (path: string, fallbackName = 'arquivo') => {
    const res = await request<Response>('GET', path, undefined, { raw: true });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const data = await res.arrayBuffer();
    if (!isViewableType(type)) return saveBlob(data, filenameOf(res, fallbackName));
    const url = URL.createObjectURL(new Blob([data], { type }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

export const qs = (params: Record<string, unknown>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};
