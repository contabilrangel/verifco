import { describe, expect, it, vi } from 'vitest';
import { CHUNK_RELOAD_KEY, ChunkLoadError, isChunkLoadError, loadWithRecovery } from './lazy';

/** Páginas carregadas sob demanda depois de um deploy: tenta de novo, recarrega uma vez, depois erro. */
const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const failed = () => new TypeError('Failed to fetch dynamically imported module: /assets/Pagina-abc.js');

describe('loadWithRecovery', () => {
  it('carrega normalmente sem tocar na sessão', async () => {
    const storage = memory();
    const reload = vi.fn();
    expect(await loadWithRecovery(async () => 'ok', { reload, storage })).toBe('ok');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });

  it('falha passageira: a segunda tentativa resolve, sem recarregar', async () => {
    const load = vi.fn().mockRejectedValueOnce(failed()).mockResolvedValueOnce('ok');
    const reload = vi.fn();
    expect(await loadWithRecovery(load, { reload, storage: memory() })).toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('arquivo sumiu (deploy): recarrega a página uma vez por sessão e depois mostra o erro', async () => {
    const storage = memory();
    const reload = vi.fn();
    const load = vi.fn().mockRejectedValue(failed());

    // 1ª vez: marca a sessão, recarrega e fica pendente (a página está saindo)
    const first = loadWithRecovery(load, { reload, storage });
    const settled = await Promise.race([first.then(() => 'resolved', () => 'rejected'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(settled).toBe('pending');
    expect(load).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBe('1');

    // depois de recarregar, se continuar falhando: erro para a tela de erro, sem novo reload
    const err = await loadWithRecovery(load, { reload, storage }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkLoadError);
    expect(isChunkLoadError(err)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('sem sessionStorage não recarrega (não há como garantir uma vez só)', async () => {
    const reload = vi.fn();
    await expect(loadWithRecovery(() => Promise.reject(failed()), { reload, storage: null })).rejects.toBeInstanceOf(ChunkLoadError);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reconhece o erro de import dinâmico do navegador', () => {
    expect(isChunkLoadError(failed())).toBe(true);
    expect(isChunkLoadError(new Error('x is not a function'))).toBe(false);
  });
});
