import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformRequest, savePlatformToken } from './client';
afterEach(() => { savePlatformToken(null); localStorage.clear(); vi.restoreAllMocks(); });
describe('sessões separadas no navegador', () => {
  it('a administração não usa o token do contador nem substitui essa sessão', async () => {
    localStorage.setItem('verifco.token', 'token-contador');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    await platformRequest('/login', 'POST', { email: 'a@b.com', password: 'senha' });
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
    savePlatformToken('token-sistema');
    await platformRequest('/me');
    expect(fetch.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer token-sistema' });
    expect(localStorage.getItem('verifco.token')).toBe('token-contador');
  });
  it('uma sessão global revogada fecha somente o painel global', async () => {
    localStorage.setItem('verifco.token', 'token-contador'); savePlatformToken('token-sistema');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"Sessão encerrada"}', { status: 401 }));
    const expire = vi.fn(); window.addEventListener('verifco.platform.expired', expire);
    await expect(platformRequest('/me')).rejects.toThrow('Sessão encerrada');
    expect(expire).toHaveBeenCalledOnce();
    expect(localStorage.getItem('verifco.platform.token')).toBeNull();
    expect(localStorage.getItem('verifco.token')).toBe('token-contador');
    window.removeEventListener('verifco.platform.expired', expire);
  });
});
