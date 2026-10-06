import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';

const stamp = () => new Date().toLocaleString('pt-BR', { hour12: false });
let file: string | null = null;

/** Log no terminal e em `sync.log` (na pasta de dados). */
export function initLog(dir = dataDir()) {
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'sync.log');
}

function write(level: string, msg: string) {
  const line = `[${stamp()}] ${level} ${msg}`;
  if (level === 'ERRO') console.error(line);
  else console.log(line);
  if (file) {
    try {
      appendFileSync(file, line + '\n');
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
