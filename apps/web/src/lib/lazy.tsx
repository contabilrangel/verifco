import { Suspense, lazy, type ComponentProps, type ComponentType } from 'react';
import { Loading } from '../ds';

/** Marca, na sessão do navegador, que a página já foi recarregada por causa de um arquivo que não baixou. */
export const CHUNK_RELOAD_KEY = 'verifco.chunkReload';

/** Um arquivo do aplicativo (página carregada sob demanda) não pôde ser baixado. */
export class ChunkLoadError extends Error {
  constructor(public readonly original?: unknown) {
    super('Não foi possível carregar uma parte do Verifco.');
    this.name = 'ChunkLoadError';
  }
}

/** O erro veio do carregamento de um arquivo do aplicativo (e não da página em si)? */
export const isChunkLoadError = (e: unknown) =>
  e instanceof ChunkLoadError || (e instanceof Error && /dynamically imported module|importing a module script failed|error loading dynamically imported/i.test(e.message));

interface Recovery {
  /** Recarrega a página (o HTML novo aponta para os arquivos da versão publicada). */
  reload: () => void;
  /** Guarda a marca de "já recarreguei" enquanto a aba estiver aberta. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
}

const sessionStore = (): Recovery['storage'] => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/**
 * Carrega um arquivo do aplicativo tolerando uma publicação nova: depois de um deploy, os arquivos
 * da versão antiga somem do servidor e a página aberta não consegue mais baixá-los.
 * 1. tenta de novo uma vez (falha passageira de rede);
 * 2. recarrega a página, uma única vez por sessão do navegador (busca a versão nova);
 * 3. se ainda falhar, lança `ChunkLoadError` e a tela de erro oferece "Recarregar".
 */
export async function loadWithRecovery<M>(load: () => Promise<M>, recovery: Recovery = { reload: () => window.location.reload(), storage: sessionStore() }): Promise<M> {
  try {
    return await load();
  } catch {
    /* segunda tentativa abaixo */
  }
  try {
    return await load();
  } catch (e) {
    const { storage } = recovery;
    let reloaded = true; // sem armazenamento não dá para garantir uma vez só: não recarrega
    try {
      if (storage) {
        reloaded = storage.getItem(CHUNK_RELOAD_KEY) === '1';
        if (!reloaded) storage.setItem(CHUNK_RELOAD_KEY, '1');
      }
    } catch {
      reloaded = true;
    }
    if (reloaded) throw new ChunkLoadError(e);
    recovery.reload();
    // a página está recarregando: mantém o "carregando" na tela
    return new Promise<M>(() => {});
  }
}

/**
 * Página carregada só quando é aberta (o código fica num arquivo à parte do pacote inicial).
 * `name` é o export nomeado do módulo; enquanto o arquivo baixa, mostra o carregando.
 * Se o arquivo não baixa (versão nova publicada), {@link loadWithRecovery} tenta de novo e recarrega.
 */
export function lazyPage<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(load: () => Promise<M>, name: K) {
  const Lazy = lazy(async () => ({ default: (await loadWithRecovery(load))[name] }));
  function LazyPage(props: ComponentProps<M[K]>) {
    return (
      <Suspense fallback={<Loading />}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  LazyPage.displayName = `Lazy(${name})`;
  return LazyPage;
}
