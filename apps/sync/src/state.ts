import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, writeJson } from './config';

export interface SentEntry {
  path: string;
  sentAt: string;
  result: 'enviado' | 'já existia';
  customer?: string;
  year?: number;
}

/**
 * Controle de arquivos já enviados, pelo hash SHA-256 do conteúdo (arquivo `state.json`).
 * Um arquivo alterado tem hash novo e é enviado de novo; o mesmo conteúdo em outra pasta, não.
 */
export class SyncState {
  sent: Record<string, SentEntry> = {};
  private path: string;

  constructor(dir = dataDir()) {
    this.path = join(dir, 'state.json');
    if (existsSync(this.path)) {
      try {
        this.sent = (JSON.parse(readFileSync(this.path, 'utf8')) as { sent?: Record<string, SentEntry> }).sent ?? {};
      } catch {
        this.sent = {};
      }
    }
  }

  has(hash: string) {
    return Boolean(this.sent[hash]);
  }

  mark(hash: string, entry: SentEntry) {
    this.sent[hash] = entry;
    this.save();
  }

  save() {
    writeJson(this.path, { version: 1, sent: this.sent });
  }

  get count() {
    return Object.keys(this.sent).length;
  }
}
