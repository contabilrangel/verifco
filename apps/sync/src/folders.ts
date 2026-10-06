import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, resolve, sep, win32 } from 'node:path';
import type { SyncConfig } from './config';

/**
 * Pastas candidatas do programa IRPF, por sistema, para o ano atual e o anterior (o programa de
 * cada exercício se chama IRPF<ano> e grava as declarações dentro da própria pasta).
 * São só pontos de partida comuns: apenas as que EXISTEM neste computador são observadas.
 * Confira no programa onde ele grava (o caminho aparece ao gravar ou transmitir) e inclua
 * outras pastas com `npm run config -- --pasta "<caminho>"`.
 */
export function defaultIrpfFolders(opts: { now?: Date; platform?: NodeJS.Platform; home?: string } = {}): string[] {
  const now = opts.now ?? new Date();
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const years = [now.getFullYear(), now.getFullYear() - 1];
  const out: string[] = [];
  for (const y of years) {
    if (platform === 'win32') {
      out.push(win32.join('C:\\Arquivos de Programas RFB', `IRPF${y}`));
      out.push(win32.join(home, 'ProgramasRFB', `IRPF${y}`));
    } else {
      out.push(posix.join(home, 'ProgramasRFB', `IRPF${y}`));
    }
  }
  return out;
}

const isDir = (p: string) => {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export interface FolderStatus {
  path: string;
  origin: 'padrão' | 'configurada' | 'pré-preenchidas';
  exists: boolean;
}

/** Todas as pastas consideradas, com a indicação de existência. */
export function folderStatus(cfg: SyncConfig): FolderStatus[] {
  const list: FolderStatus[] = [];
  const seen = new Set<string>();
  const add = (path: string, origin: FolderStatus['origin']) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ path, origin, exists: isDir(path) });
  };
  if (cfg.useDefaultFolders) for (const p of defaultIrpfFolders()) add(p, 'padrão');
  for (const p of cfg.folders) add(p, 'configurada');
  for (const p of cfg.prefilledFolders) add(p, 'pré-preenchidas');
  return list;
}

const within = (child: string, parent: string) => {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c !== p && c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/** Pastas existentes a observar (uma pasta dentro de outra já observada não entra de novo). */
export function watchedFolders(cfg: SyncConfig): string[] {
  const existing = folderStatus(cfg)
    .filter((f) => f.exists)
    .map((f) => f.path);
  return existing.filter((f) => !existing.some((other) => within(f, other)));
}
