import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, writeJson } from './config';

/**
 * Para onde o conteúdo foi: os documentos do cliente (`files`), as pré-preenchidas (`prefilled`)
 * ou a caixa de entrada do escritório (`inbox`: não identificado ou cliente não cadastrado).
 */
export type Destination = 'files' | 'prefilled' | 'inbox';

export interface SentEntry {
  destination: Destination;
  path: string;
  sentAt: string;
  result: 'enviado' | 'já existia' | 'caixa de entrada';
  customer?: string;
  year?: number;
  /** Só na caixa de entrada: `sem_cpf` ou `cliente_nao_cadastrado`. */
  reason?: string;
}

/** Entrada do formato anterior (versão 1), que não guardava o destino. */
type LegacyEntry = Omit<SentEntry, 'destination'> & { destination?: Destination };

const DESTINATIONS: Destination[] = ['files', 'prefilled', 'inbox'];
export const stateKey = (destination: Destination, hash: string) => `${destination}:${hash}`;

/**
 * Converte o conteúdo do `state.json` para o formato atual (versão 2, chave `destino:hash`).
 * No formato anterior (versão 1) a chave era só o hash e o destino não era guardado: ele é
 * deduzido do caminho por `legacyDestination` (pasta de pré-preenchidas ou não). Um palpite errado
 * só causa um reenvio, que a API reconhece como conteúdo repetido.
 */
export function migrateState(raw: unknown, legacyDestination: (path: string) => 'files' | 'prefilled' = () => 'files'): { sent: Record<string, SentEntry>; migrated: boolean } {
  const data = (raw && typeof raw === 'object' ? raw : {}) as { version?: number; sent?: Record<string, LegacyEntry> };
  const entries = data.sent && typeof data.sent === 'object' ? data.sent : {};
  const sent: Record<string, SentEntry> = {};
  let migrated = false;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== 'object') continue;
    const sep = key.indexOf(':');
    const prefix = sep > 0 ? (key.slice(0, sep) as Destination) : null;
    if (prefix && DESTINATIONS.includes(prefix)) {
      sent[key] = { ...entry, destination: prefix };
    } else {
      const destination = entry.destination ?? legacyDestination(entry.path ?? '');
      sent[stateKey(destination, key)] = { ...entry, destination };
      migrated = true;
    }
  }
  return { sent, migrated: migrated || (data.version ?? 2) < 2 };
}

/**
 * Controle do que já foi enviado (arquivo `state.json`), pelo hash SHA-256 do conteúdo MAIS o
 * destino. Um arquivo alterado tem hash novo e é enviado de novo; o mesmo conteúdo em outra pasta
 * do mesmo destino, não; o mesmo conteúdo copiado para a pasta das pré-preenchidas vai também
 * para as pré-preenchidas.
 */
export class SyncState {
  sent: Record<string, SentEntry> = {};
  private path: string;

  constructor(dir = dataDir(), legacyDestination?: (path: string) => 'files' | 'prefilled') {
    this.path = join(dir, 'state.json');
    if (!existsSync(this.path)) return;
    let migrated = false;
    try {
      ({ sent: this.sent, migrated } = migrateState(JSON.parse(readFileSync(this.path, 'utf8')), legacyDestination));
    } catch {
      this.sent = {};
    }
    if (!migrated) return;
    try {
      // grava já no formato novo, para a dedução do destino não depender de mudanças futuras nas pastas
      this.save();
    } catch {
      /* sem permissão de escrita agora: a conversão se repete na próxima leitura */
    }
  }

  has(destination: Destination, hash: string) {
    return Boolean(this.sent[stateKey(destination, hash)]);
  }

  mark(destination: Destination, hash: string, entry: Omit<SentEntry, 'destination'>) {
    this.sent[stateKey(destination, hash)] = { ...entry, destination };
    this.save();
  }

  save() {
    writeJson(this.path, { version: 2, sent: this.sent });
  }

  get count() {
    return Object.keys(this.sent).length;
  }

  countOf(destination: Destination) {
    return Object.values(this.sent).filter((e) => e.destination === destination).length;
  }
}
