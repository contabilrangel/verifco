import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';

export interface Me {
  user: { id: string; name: string; email: string; isOwner: boolean; notificationPrefs: { enabled?: boolean; devices?: string[] } };
  office: { id: string; name: string; logoFileId: string | null; settings: Record<string, unknown> } | null;
  role: { id: string; name: string } | null;
  permissions: string[];
  favorites: { path: string; label: string }[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { officeName: string; name: string; email: string; password: string; officeDocument?: string; acceptTerms?: boolean }) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  can: (...permissions: string[]) => boolean;
  /** A sessão caiu por um 401 da API (token vencido ou revogado), não por "Sair": o login avisa. */
  sessionExpired: boolean;
}

/**
 * Para onde voltar depois do login: o `from` que o `RequireAuth` guarda no estado da navegação.
 * Só caminhos internos desta origem ("/clientes?busca=ana"); nunca outro site ("//x", "/\\x",
 * "https:") nem as próprias telas de acesso.
 */
export function returnPath(state: unknown): string | null {
  const from = state && typeof state === 'object' ? (state as { from?: unknown }).from : null;
  if (typeof from !== 'string' || !/^\/(?![/\\])/.test(from) || /[\u0000-\u001f\\]/.test(from)) return null;
  try {
    if (new URL(from, window.location.origin).origin !== window.location.origin) return null;
  } catch {
    return null;
  }
  if (/^\/(entrar|cadastro|esqueci-senha|redefinir-senha)(?=[/?#]|$)/.test(from)) return null;
  return from;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const qc = useQueryClient();

  const [sessionExpired, setSessionExpired] = useState(false);

  /** Encerra a sessão neste navegador, sem mexer no aviso de sessão expirada. */
  const dropSession = useCallback(() => {
    setToken(null);
    setMe(null);
    qc.clear();
  }, [qc]);

  /** "Sair": o usuário quis sair, não há o que avisar no login. */
  const logout = useCallback(() => {
    setSessionExpired(false);
    dropSession();
  }, [dropSession]);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    try {
      setMe(await api.get<Me>('/auth/me'));
    } catch {
      // um 401 já passou pelo aviso de sessão expirada (abaixo); aqui só encerra
      dropSession();
    } finally {
      setLoading(false);
    }
  }, [dropSession]);

  useEffect(() => {
    // 401 com o token da sessão: sai e deixa o aviso para a tela de login
    setUnauthorizedHandler(() => {
      setSessionExpired(true);
      dropSession();
    });
    void refresh();
    return () => setUnauthorizedHandler(null);
  }, [dropSession, refresh]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      logout,
      refresh,
      sessionExpired,
      login: async (email, password) => {
        const res = await api.post<Me & { token: string }>('/auth/login', { email, password });
        setToken(res.token);
        setSessionExpired(false);
        setMe(res);
      },
      register: async (data) => {
        const res = await api.post<Me & { token: string }>('/auth/register', data);
        setToken(res.token);
        setSessionExpired(false);
        setMe(res);
      },
      can: (...permissions) => Boolean(me && (me.user.isOwner || permissions.some((p) => me.permissions.includes(p)))),
    }),
    [me, loading, logout, refresh, sessionExpired],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth fora do AuthProvider');
  return v;
}
