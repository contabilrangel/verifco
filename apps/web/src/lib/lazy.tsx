import { Suspense, lazy, type ComponentProps, type ComponentType } from 'react';
import { Loading } from '../ds';

/**
 * Página carregada só quando é aberta (o código fica num arquivo à parte do pacote inicial).
 * `name` é o export nomeado do módulo; enquanto o arquivo baixa, mostra o carregando.
 */
export function lazyPage<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(load: () => Promise<M>, name: K) {
  const Lazy = lazy(async () => ({ default: (await load())[name] }));
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
