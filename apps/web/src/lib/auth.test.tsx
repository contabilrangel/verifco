import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, SESSION_EXPIRED_MESSAGE, api, getToken, setToken } from './api';
import { AuthProvider, returnPath, useAuth } from './auth';

/** Sessão expirada (401 da API) avisa no login; "Sair" não. E o endereço de volta só aceita caminhos internos. */
describe('returnPath', () => {
  it('aceita caminhos internos, com busca e âncora', () => {
    expect(returnPath({ from: '/clientes?busca=ana&pagina=2' })).toBe('/clientes?busca=ana&pagina=2');
    expect(returnPath({ from: '/clientes/123/irpf/darf#quotas' })).toBe('/clientes/123/irpf/darf#quotas');
    expect(returnPath({ from: '/' })).toBe('/');
  });

  it('recusa outro site, esquemas, barras duplas ou invertidas e valores que não são texto', () => {
    for (const from of ['https://exemplo.com', '//exemplo.com/x', '/\\exemplo.com', 'javascript:alert(1)', 'clientes', '', '/a\\b', '/a\nb', 42, null, { pathname: '/x' }]) {
      expect(returnPath({ from }), String(from)).toBeNull();
    }
    expect(returnPath(null)).toBeNull();
    expect(returnPath(undefined)).toBeNull();
    expect(returnPath('/clientes')).toBeNull();
  });

  it('não volta para as próprias telas de acesso', () => {
    for (const from of ['/entrar', '/entrar?x=1', '/cadastro', '/esqueci-senha', '/redefinir-senha?token=abc']) expect(returnPath({ from }), from).toBeNull();
    // um caminho que só começa igual é uma página normal
    expect(returnPath({ from: '/entradas' })).toBe('/entradas');
  });
});

function Probe() {
  const { me, loading, sessionExpired, logout, login } = useAuth();
  return (
    <div>
      <p data-testid="state">{loading ? 'carregando' : me ? `dentro:${me.user.name}` : 'fora'}</p>
      <p data-testid="expired">{String(sessionExpired)}</p>
      <button type="button" onClick={logout}>
        Sair
      </button>
      <button type="button" onClick={() => void login('ana@exemplo.com.br', 'senha-forte').catch(() => {})}>
        Entrar
      </button>
      <button type="button" onClick={() => void api.get('/customers').catch(() => {})}>
        Listar
      </button>
    </div>
  );
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { user: { id: 'u1', name: 'Ana', email: 'ana@exemplo.com.br', isOwner: true, notificationPrefs: {} }, office: null, role: null, permissions: [], favorites: [] };

describe('AuthProvider: sessão expirada', () => {
  let respond: (url: string, init?: RequestInit) => Response;
  beforeEach(() => {
    setToken('token-valido');
    respond = () => json(ME);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => respond(String(url), init)));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setToken(null);
  });

  const renderAuth = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    );
  const text = (id: string) => screen.getByTestId(id).textContent;

  it('401 numa requisição: sai, apaga o token e marca a sessão como expirada; o erro tem a mensagem em português', async () => {
    renderAuth();
    await waitFor(() => expect(text('state')).toBe('dentro:Ana'));
    expect(text('expired')).toBe('false');

    respond = () => json({ error: 'Não autenticado' }, 401);
    const err = await act(() => api.get('/customers').catch((e: unknown) => e));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe(SESSION_EXPIRED_MESSAGE);
    await waitFor(() => expect(text('state')).toBe('fora'));
    expect(text('expired')).toBe('true');
    expect(getToken()).toBeNull();
  });

  it('token vencido ao abrir o aplicativo (401 em /auth/me) também avisa', async () => {
    respond = () => json({ error: 'Não autenticado' }, 401);
    renderAuth();
    await waitFor(() => expect(text('state')).toBe('fora'));
    expect(text('expired')).toBe('true');
  });

  it('"Sair" não é sessão expirada, e entrar de novo limpa o aviso', async () => {
    renderAuth();
    await waitFor(() => expect(text('state')).toBe('dentro:Ana'));
    act(() => screen.getByRole('button', { name: 'Sair' }).click());
    expect(text('state')).toBe('fora');
    expect(text('expired')).toBe('false');

    // cai por 401...
    setToken('token-vencido');
    respond = () => json({ error: 'Não autenticado' }, 401);
    act(() => screen.getByRole('button', { name: 'Listar' }).click());
    await waitFor(() => expect(text('expired')).toBe('true'));

    // ...senha errada no login não é sessão expirada: vale a mensagem da API
    respond = () => json({ error: 'E-mail ou senha incorretos.' }, 401);
    await expect(api.post('/auth/login', { email: 'a', password: 'b' })).rejects.toMatchObject({ message: 'E-mail ou senha incorretos.' });

    // ...e entrar de novo limpa o aviso
    respond = () => json({ ...ME, token: 'token-novo' });
    act(() => screen.getByRole('button', { name: 'Entrar' }).click());
    await waitFor(() => expect(text('state')).toBe('dentro:Ana'));
    expect(text('expired')).toBe('false');
    expect(getToken()).toBe('token-novo');
  });

  it('403 e 500 não derrubam a sessão', async () => {
    renderAuth();
    await waitFor(() => expect(text('state')).toBe('dentro:Ana'));
    respond = () => json({ error: 'O contrato do escritório venceu.' }, 403);
    await expect(api.post('/customers', {})).rejects.toMatchObject({ status: 403, message: 'O contrato do escritório venceu.' });
    expect(text('state')).toBe('dentro:Ana');
    expect(text('expired')).toBe('false');
    expect(getToken()).toBe('token-valido');
  });
});
