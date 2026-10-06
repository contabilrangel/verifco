import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ApiError, upload } from './api';
import type { SyncConfig } from './config';
import { classifyFile } from './identify';
import { log } from './log';
import type { SyncState } from './state';

const MAX_BYTES = 25 * 1024 * 1024;

export interface Stats {
  sent: number;
  duplicate: number;
  known: number;
  skipped: number;
  failed: number;
}

/**
 * Varredura e observação das pastas. Os envios são feitos um por vez (fila), com espera
 * (debounce) depois da última alteração de cada arquivo, porque o programa grava em etapas.
 */
export class Syncer {
  stats: Stats = { sent: 0, duplicate: 0, known: 0, skipped: 0, failed: 0 };
  private exts: Set<string>;
  private timers = new Map<string, NodeJS.Timeout>();
  private retry = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private watchers = new Map<string, FSWatcher>();
  /** Erro que impede continuar (token inválido ou revogado). */
  fatal: ApiError | null = null;

  constructor(
    private cfg: SyncConfig,
    private state: SyncState,
    private onFatal: (err: ApiError) => void = () => {},
  ) {
    this.exts = new Set(cfg.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
  }

  /** Arquivo que interessa: extensão configurada e não temporário/oculto. */
  wanted(path: string) {
    const name = basename(path);
    if (name.startsWith('.') || name.startsWith('~$') || /\.(tmp|part|crdownload)$/i.test(name)) return false;
    return this.exts.has(extname(name).toLowerCase());
  }

  private async *walk(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn(`Não foi possível ler a pasta ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) yield* this.walk(full);
      else if (e.isFile() && this.wanted(full)) yield full;
    }
  }

  /** Varredura completa das pastas (usada ao iniciar e no comando `varrer`). */
  async scan(folders: string[]) {
    for (const folder of folders) {
      log.info(`Varrendo ${folder}`);
      for await (const file of this.walk(folder)) {
        await this.enqueue(file);
        if (this.fatal) return;
      }
    }
  }

  /** Coloca o arquivo na fila de envio (um por vez). */
  enqueue(path: string): Promise<void> {
    this.chain = this.chain.then(() => (this.fatal ? undefined : this.process(path)));
    return this.chain;
  }

  private async process(path: string) {
    let size: number;
    try {
      const st = await stat(path);
      if (!st.isFile()) return;
      size = st.size;
    } catch {
      return; // apagado ou movido antes do envio
    }
    const name = basename(path);
    if (size === 0) return;
    if (size > MAX_BYTES) {
      log.warn(`${name}: maior que 25 MB, ignorado.`);
      this.stats.skipped++;
      return;
    }
    const data = await readFile(path);
    const hash = createHash('sha256').update(data).digest('hex');
    if (this.state.has(hash)) {
      this.stats.known++;
      return;
    }
    const c = classifyFile(path, { prefilledFolders: this.cfg.prefilledFolders });
    if (c.skipReason) {
      log.warn(`${name}: ignorado (${c.skipReason}).`);
      this.stats.skipped++;
      return;
    }
    try {
      const res = await upload(this.cfg, { destination: c.destination, data, name, path, cpf: c.cpf, year: c.year, type: c.type });
      const dup = res.body.duplicate;
      this.state.mark(hash, { path, sentAt: new Date().toISOString(), result: dup ? 'já existia' : 'enviado', customer: res.body.customer?.name, year: res.body.year });
      this.retry.delete(path);
      if (dup) {
        this.stats.duplicate++;
        log.info(`${name}: já estava no Verifco (${res.body.customer?.name}).`);
      } else {
        this.stats.sent++;
        log.ok(`${name} → ${res.body.customer?.name}, exercício ${res.body.year}${c.destination === 'prefilled' ? ' (pré-preenchida)' : ''}.`);
      }
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, String(err));
      this.stats.failed++;
      if (e.status === 401 || e.status === 403) {
        this.fatal = e;
        log.error(`Token recusado (${e.message}). Gere um token do tipo "Sincronizador" em Administração › Robô e rode: npm run config -- --token vfk_...`);
        this.onFatal(e);
      } else if (e.status === 404) {
        log.warn(`${name}: ${e.message} Cadastre o cliente no Verifco; o arquivo será tentado de novo na próxima varredura.`);
      } else if (e.status === 0 || e.status >= 500) {
        this.retry.add(path);
        log.error(`${name}: ${e.message} Nova tentativa em 1 minuto.`);
      } else {
        log.error(`${name}: ${e.message}`);
      }
    }
  }

  /** Observa as pastas (recursivo) e envia o que mudar. */
  watch(folders: string[]) {
    for (const folder of folders) {
      if (this.watchers.has(folder)) continue;
      try {
        const w = watch(folder, { recursive: true }, (_evt, filename) => {
          if (!filename) return;
          const full = join(folder, filename.toString());
          if (!this.wanted(full)) return;
          clearTimeout(this.timers.get(full));
          this.timers.set(
            full,
            setTimeout(() => {
              this.timers.delete(full);
              void this.enqueue(full);
            }, this.cfg.debounceMs),
          );
        });
        w.on('error', (err) => {
          log.warn(`Observação de ${folder} interrompida: ${err.message}`);
          this.watchers.delete(folder);
        });
        this.watchers.set(folder, w);
        log.info(`Observando ${folder}`);
      } catch (err) {
        log.warn(`Não foi possível observar ${folder}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Reenvia os arquivos que falharam por conexão ou erro do servidor. */
  retryFailed() {
    for (const p of [...this.retry]) void this.enqueue(p);
  }

  close() {
    for (const w of this.watchers.values()) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.watchers.clear();
    this.timers.clear();
  }

  /** Aguarda a fila de envios terminar. */
  idle() {
    return this.chain;
  }
}
