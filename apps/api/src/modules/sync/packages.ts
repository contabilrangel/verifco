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

// ---------------------------------------------------------------------------
// Versões
// ---------------------------------------------------------------------------
export type ClientKind = 'sync' | 'extension';

/** Versão mais antiga de cada programa que a API ainda atende sem perder funções. */
export const MIN_SUPPORTED_CLIENT: Record<ClientKind, string> = { sync: '0.2.0', extension: '0.1.0' };

const VERSION_FILES: Record<ClientKind, { dir: string; file: string }> = {
  sync: { dir: 'sync', file: 'package.json' },
  extension: { dir: 'extension', file: 'manifest.json' },
};
let versionCache: { at: number; value: Record<ClientKind, string | null> } | null = null;

/** Versão de cada pacote distribuído por este servidor (lida do próprio pacote; cache de 1 minuto). */
export async function distributedVersions(): Promise<Record<ClientKind, string | null>> {
  if (versionCache && Date.now() - versionCache.at < 60_000) return versionCache.value;
  const value: Record<ClientKind, string | null> = { sync: null, extension: null };
  for (const kind of Object.keys(VERSION_FILES) as ClientKind[]) {
    try {
      const raw = JSON.parse(await readFile(join(APPS_DIR, VERSION_FILES[kind].dir, VERSION_FILES[kind].file), 'utf8')) as { version?: unknown };
      value[kind] = typeof raw.version === 'string' && /^\d+\.\d+\.\d+$/.test(raw.version) ? raw.version : null;
    } catch {
      value[kind] = null;
    }
  }
  versionCache = { at: Date.now(), value };
  return value;
}

/** Compara versões `a.b.c`: negativo quando `a` é mais antiga que `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Cabeçalho `X-Verifco-Client: sync/0.3.0 (win32)`; qualquer outra forma é ignorada. */
export function parseClientHeader(raw: unknown): { kind: ClientKind; version: string; platform: string | null } | null {
  if (typeof raw !== 'string') return null;
  const m = /^(sync|extension)\/(\d{1,4}\.\d{1,4}\.\d{1,4})(?:\s+\(([\w .:-]{1,40})\))?$/.exec(raw.trim());
  return m ? { kind: m[1] as ClientKind, version: m[2], platform: m[3] ?? null } : null;
}

/** O que o programa precisa saber sobre a própria versão (aviso de atualização). */
export async function clientVersionInfo(kind: ClientKind, version: string | null) {
  const latest = (await distributedVersions())[kind];
  const minSupported = MIN_SUPPORTED_CLIENT[kind];
  return {
    kind,
    version,
    latest,
    minSupported,
    updateAvailable: Boolean(version && latest && compareVersions(version, latest) < 0),
    unsupported: Boolean(version && compareVersions(version, minSupported) < 0),
  };
}
