import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

/** Pastas de módulos em ordem alfabética (cada uma pode ter routes.ts e jobs.ts). */
export function moduleDirs(): string[] {
  return readdirSync(HERE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export async function importModuleFile<T>(dir: string, file: string): Promise<T | null> {
  const path = join(HERE, dir, `${file}${EXT}`);
  if (!existsSync(path)) return null;
  return (await import(pathToFileURL(path).href)) as T;
}

/**
 * Registra as rotas de todos os módulos sob /api.
 * Cada `modules/<nome>/routes.ts` exporta por padrão (ou como `<nome>Routes`) um plugin Fastify.
 */
export async function registerModules(app: FastifyInstance) {
  await app.register(
    async (api) => {
      for (const dir of moduleDirs()) {
        const mod = await importModuleFile<Record<string, unknown>>(dir, 'routes');
        if (!mod) continue;
        const plugin = (mod.default ?? Object.values(mod).find((v) => typeof v === 'function' && /Routes$/.test((v as { name: string }).name))) as
          | ((app: FastifyInstance) => Promise<void>)
          | undefined;
        if (!plugin) throw new Error(`modules/${dir}/routes não exporta um plugin de rotas.`);
        await api.register(plugin);
      }
    },
    { prefix: '/api' },
  );
}
