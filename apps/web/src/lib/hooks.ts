import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { useToast } from '../ds';

/** GET tipado com cache do React Query. */
export function useApi<T>(key: QueryKey, path: string | null, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery<T>({
    queryKey: key,
    queryFn: () => api.get<T>(path!),
    enabled: path !== null && (opts.enabled ?? true),
    refetchInterval: opts.refetchInterval,
  });
}

/**
 * Mutação com toast de sucesso/erro e invalidação de chaves.
 * `fn` recebe as variáveis e chama a API.
 */
export function useAction<V, R = unknown>(
  fn: (vars: V) => Promise<R>,
  opts: { success?: string | ((r: R) => string); invalidate?: QueryKey[]; onSuccess?: (r: R, v: V) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<R, Error, V>({
    mutationFn: fn,
    onSuccess: (r, v) => {
      for (const k of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: k });
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r, v);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível concluir. Tente novamente.'),
  });
}

/** Acompanha uma media query (ex.: '(max-width: 600px)'); false onde matchMedia não existe. */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Erros por campo vindos do 400 da API (details: [{path, message}]). */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  return Object.fromEntries((err.details as { path: string; message: string }[]).map((d) => [d.path, d.message]));
}
