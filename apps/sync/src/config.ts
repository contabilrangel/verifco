import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Configuração do sincronizador (arquivo JSON na pasta de dados do usuário). */
export interface SyncConfig {
  /** Endereço do Verifco/API, sem `/api` (ex.: https://app.seuescritorio.com.br). */
  apiUrl: string;
  /** Token de máquina do escopo "sync" (vfk_...). */
  token: string;
  /** Observar também as pastas padrão do programa IRPF (ano atual e anterior). */
  useDefaultFolders: boolean;
  /** Pastas extras observadas. */
  folders: string[];
  /** Pastas cujos arquivos vão para as pré-preenchidas (POST /api/sync/prefilled). */
  prefilledFolders: string[];
  /** Extensões enviadas. */
  extensions: string[];
  /** Espera depois da última alteração antes de enviar (o programa grava em etapas). */
  debounceMs: number;
  /** Intervalo, em minutos, da varredura periódica das pastas (0 desliga). */
  rescanMinutes: number;
  /** Enviar à caixa de entrada do Verifco os arquivos não identificados ou de cliente não cadastrado. */
  inbox: boolean;
}

export const DEFAULT_CONFIG: SyncConfig = {
  apiUrl: '',
  token: '',
  useDefaultFolders: true,
  folders: [],
  prefilledFolders: [],
  extensions: ['.dec', '.rec', '.dbk', '.xml', '.pdf'],
  debounceMs: 2000,
  rescanMinutes: 15,
  inbox: true,
};

/** Endereço sem barra final e sem `/api`; erro quando não começa com http:// ou https://. */
export function normalizeUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, '').replace(/\/api$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error('Use um endereço começando com http:// ou https://');
  return url;
}

export function checkToken(value: string): string {
  const token = value.trim();
  if (!/^vfk_[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('O token deve começar com vfk_ (crie em Meu escritório › Robô, escopo Sincronizador).');
  return token;
}

/** Minutos da varredura periódica: 0 desliga; senão, de 1 minuto a 1 dia. */
export function checkRescanMinutes(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Informe a varredura em minutos (ex.: --varredura 15; 0 desliga).');
  return n === 0 ? 0 : Math.min(24 * 60, Math.max(1, Math.round(n)));
}

/**
 * Pasta de dados: `VERIFCO_SYNC_HOME`, ou `%APPDATA%\VerifcoSync` no Windows, ou
 * `~/.verifco-sync` no macOS/Linux. Guarda `config.json`, `state.json` e `sync.log`.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VERIFCO_SYNC_HOME) return resolve(env.VERIFCO_SYNC_HOME);
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'VerifcoSync');
  return join(homedir(), '.verifco-sync');
}

export function configPath(dir = dataDir()) {
  return join(dir, 'config.json');
}

export function loadConfig(dir = dataDir()): SyncConfig {
  const path = configPath(dir);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<SyncConfig>) };
  } catch {
    throw new Error(`Não foi possível ler ${path}. Corrija o JSON ou apague o arquivo e configure de novo.`);
  }
}

/** Grava de forma atômica (arquivo temporário + renomear). */
export function writeJson(path: string, data: unknown) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function saveConfig(cfg: SyncConfig, dir = dataDir()) {
  writeJson(configPath(dir), cfg);
}

export const maskToken = (t: string) => (t ? `${t.slice(0, 8)}…${t.slice(-4)}` : '(não configurado)');
