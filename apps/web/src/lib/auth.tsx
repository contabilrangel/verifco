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
  register: (data: { officeName: string; name: string; email: string; password: string; officeDocument?: string }) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  can: (...permissions: string[]) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const qc = useQueryClient();

  const logout = useCallback(() => {
    setToken(null);
    setMe(null);
    qc.clear();
  }, [qc]);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    try {
      setMe(await api.get<Me>('/auth/me'));
    } catch {
      logout();
    } finally {
      setLoading(false);
    }
  }, [logout]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    void refresh();
  }, [logout, refresh]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      logout,
      refresh,
      login: async (email, password) => {
        const res = await api.post<Me & { token: string }>('/auth/login', { email, password });
        setToken(res.token);
        setMe(res);
      },
      register: async (data) => {
        const res = await api.post<Me & { token: string }>('/auth/register', data);
        setToken(res.token);
        setMe(res);
      },
      can: (...permissions) => Boolean(me && (me.user.isOwner || permissions.some((p) => me.permissions.includes(p)))),
    }),
    [me, loading, logout, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth fora do AuthProvider');
  return v;
}
