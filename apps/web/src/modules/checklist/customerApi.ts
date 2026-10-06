/**
 * Acesso do cliente final (portal e link do checklist).
 * Usa um token próprio (não o do escritório), guardado só na aba do navegador (sessionStorage).
 */
import { CHECKLIST_MAX_UPLOAD_BYTES, checklistUploadMime } from '@verifco/shared';
import { ApiError, isViewableType } from '../../lib/api';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export interface CustomerClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  upload<T>(path: string, files: File[]): Promise<T>;
  /** Abre (PDF/imagem) ou baixa um arquivo protegido. */
  open(path: string, filename: string, inline: boolean): Promise<void>;
}

async function call<T>(method: string, path: string, body: unknown, token: string | null, onExpired?: () => void, raw = false): Promise<T> {
  const headers: Record<string, string> = {};
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
    throw new ApiError(0, 'Sem conexão com o servidor. Verifique sua internet e tente de novo.');
  }
  if (res.status === 401 && token) onExpired?.();
  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    let details: unknown;
    try {
      const j = await res.json();
      msg = j.error ?? msg;
      details = j.details;
    } catch {
      /* sem JSON */
    }
    throw new ApiError(res.status, msg, details);
  }
  if (raw) return res as unknown as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

/** Chamadas públicas (login, dados do link). */
export const publicApi = {
  post: <T>(path: string, body: unknown) => call<T>('POST', path, body, null),
};

export function customerClient(token: string, onExpired: () => void): CustomerClient {
  return {
    get: (path) => call('GET', path, undefined, token, onExpired),
    post: (path, body) => call('POST', path, body ?? {}, token, onExpired),
    put: (path, body) => call('PUT', path, body ?? {}, token, onExpired),
    del: (path) => call('DELETE', path, undefined, token, onExpired),
    upload: (path, files) => {
      const fd = new FormData();
      for (const f of files) fd.append('file', f, f.name);
      return call('POST', path, fd, token, onExpired);
    },
    open: async (path, filename, inline) => {
      const res = await call<Response>('GET', `${path}${inline ? '?inline=1' : ''}`, undefined, token, onExpired, true);
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const data = await res.arrayBuffer();
      // só PDF e imagens abrem no navegador (lista única de lib/api); o resto baixa como binário
      const view = inline && isViewableType(type);
      const url = URL.createObjectURL(new Blob([data], { type: view ? type : 'application/octet-stream' }));
      if (view) window.open(url, '_blank', 'noopener');
      else {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}

// ---------------------------------------------------------------------------
// Sessões (sessionStorage: some ao fechar o navegador)
// ---------------------------------------------------------------------------
function read<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* navegação privada: segue só em memória */
  }
}

/** Token JWT ainda válido (com folga de 1 minuto)? */
export function tokenAlive(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp !== 'number' || payload.exp * 1000 > Date.now() + 60_000;
  } catch {
    return false;
  }
}

export interface PortalSession {
  token: string;
  firstName: string;
  officeName: string;
}
const PORTAL_KEY = 'verifco.portal';
export const portalSession = {
  get(): PortalSession | null {
    const s = read<PortalSession>(PORTAL_KEY);
    return s && tokenAlive(s.token) ? s : null;
  },
  set: (s: PortalSession | null) => write(PORTAL_KEY, s),
};

export interface ChecklistSession {
  link: string;
  token: string;
  checklistId: string;
}
const CHECKLIST_KEY = 'verifco.checklist';
export const checklistSession = {
  get(link: string): ChecklistSession | null {
    const s = read<ChecklistSession>(CHECKLIST_KEY);
    return s && s.link === link && tokenAlive(s.token) ? s : null;
  },
  set: (s: ChecklistSession | null) => write(CHECKLIST_KEY, s),
};

// ---------------------------------------------------------------------------
// Apoio
// ---------------------------------------------------------------------------
/** Máscara de CPF enquanto digita. */
export function maskCpfInput(v: string) {
  const d = v.replace(/\D+/g, '').slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

/** Confere tipo e tamanho antes de enviar (o servidor confere de novo). */
export function checkFiles(files: File[]): string | null {
  for (const f of files) {
    if (!checklistUploadMime(f.name)) return `“${f.name}” não é aceito. Envie PDF, foto (JPG, PNG, HEIC) ou planilha.`;
    if (f.size > CHECKLIST_MAX_UPLOAD_BYTES) return `“${f.name}” passa de 20 MB. Envie um arquivo menor.`;
    if (!f.size) return `“${f.name}” está vazio.`;
  }
  return null;
}

