import { ApiError, OFFLINE_MESSAGE } from '../../lib/api';
const KEY = 'verifco.platform.token';
let memoryToken: string | null = null;
export function platformToken() { try { return localStorage.getItem(KEY) ?? memoryToken; } catch { return memoryToken; } }
export function savePlatformToken(token: string | null) {
  memoryToken = token;
  try { if (token) localStorage.setItem(KEY, token); else localStorage.removeItem(KEY); } catch { /* memória */ }
}
export async function platformRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = platformToken();
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/platform${path}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new ApiError(0, OFFLINE_MESSAGE); }
  if (res.status === 401 && token && path !== '/login') {
    savePlatformToken(null); window.dispatchEvent(new Event('verifco.platform.expired'));
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? 'Não foi possível concluir esta ação.');
  }
  return res.status === 204 ? undefined as T : res.json() as Promise<T>;
}
