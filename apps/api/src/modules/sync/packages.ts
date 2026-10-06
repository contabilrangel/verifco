import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

/**
 * Pacotes distribuídos pela Central de downloads, montados a partir das pastas do monorepo
 * (`apps/sync` e `apps/extension`). Em uma instalação sem essas pastas, o download fica indisponível.
 */
const APPS_DIR = fileURLToPath(new URL('../../../../', import.meta.url));

export const PACKAGES = {
  sync: { dir: 'sync', folder: 'verifco-sincronizador', filename: 'verifco-sincronizador.zip' },
  extension: { dir: 'extension', folder: 'verifco-extensao', filename: 'verifco-extensao.zip' },
} as const;
export type PackageName = keyof typeof PACKAGES;

const SKIP = new Set(['node_modules', '.git', '.data', 'dist', '.DS_Store', '.verifco-sync']);

async function addDir(zip: JSZip, abs: string, rel: string) {
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const childAbs = join(abs, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await addDir(zip, childAbs, childRel);
    else if (entry.isFile()) zip.file(childRel, await readFile(childAbs));
  }
}

/** .zip do pacote, ou `null` quando a pasta não existe neste servidor. */
export async function buildPackageZip(name: PackageName): Promise<Buffer | null> {
  const pkg = PACKAGES[name];
  const root = join(APPS_DIR, pkg.dir);
  if (!existsSync(root)) return null;
  const zip = new JSZip();
  await addDir(zip, root, pkg.folder);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
