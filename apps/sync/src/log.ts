import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';

/** O `sync.log` é trocado ao passar de ~5 MB; ficam os 3 anteriores (`sync.log.1` a `sync.log.3`). */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

const stamp = () => new Date().toLocaleString('pt-BR', { hour12: false });
let file: string | null = null;
let bytes = 0;

/** Rotação: `sync.log` → `sync.log.1` → … → `sync.log.<keep>`; o mais antigo é apagado. */
export function rotateLog(path: string, keep = LOG_KEEP) {
  rmSync(`${path}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  if (existsSync(path)) renameSync(path, `${path}.1`);
}

/** Rotaciona quando o arquivo chegou a `maxBytes`; devolve se rotacionou. */
export function rotateIfNeeded(path: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false; // ainda não existe
  }
  if (size < maxBytes) return false;
  rotateLog(path, keep);
  return true;
}

/** Log no terminal e em `sync.log` (na pasta de dados). */
export function initLog(dir = dataDir()) {
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'sync.log');
  try {
    rotateIfNeeded(file);
    bytes = existsSync(file) ? statSync(file).size : 0;
  } catch {
    bytes = 0;
  }
}

function write(level: string, msg: string) {
  const line = `[${stamp()}] ${level} ${msg}`;
  if (level === 'ERRO') console.error(line);
  else console.log(line);
  if (file) {
    try {
      appendFileSync(file, line + '\n');
      bytes += Buffer.byteLength(line) + 1;
      if (bytes >= LOG_MAX_BYTES) {
        rotateLog(file);
        bytes = 0;
      }
    } catch {
      /* log em arquivo é opcional */
    }
  }
}

export const log = {
  info: (m: string) => write('INFO', m),
  ok: (m: string) => write('OK  ', m),
  warn: (m: string) => write('AVISO', m),
  error: (m: string) => write('ERRO', m),
};
