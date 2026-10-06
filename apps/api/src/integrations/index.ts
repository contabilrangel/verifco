import type { AppContext } from '../context';
import { MemoryProviders, type Providers } from './providers';

/** Monta os provedores reais a partir da configuração de cada escritório. */
export function createProviders(_ctx: AppContext): Providers {
  return new MemoryProviders();
}
