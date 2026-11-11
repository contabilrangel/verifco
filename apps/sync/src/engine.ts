import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ApiError, inboxUnavailable, isAuthError, sendInbox, toApiError, upload, whoami, type InboxReason, type WhoAmI } from './api';
import { REARM_BACKOFF, STARTUP_BACKOFF, TRANSIENT_BACKOFF, WAITING_BACKOFF, backoffDelay, formatDelay, sleep, type BackoffSchedule } from './backoff';
import type { SyncConfig } from './config';
import { HEADER_BYTES, classifyFile, type Classified } from './identify';
import { log } from './log';
import { planFile, type Plan } from './routing';
import type { SyncState } from './state';

const MAX_BYTES = 25 * 1024 * 1024;

export interface Stats {
  sent: number;
  duplicate: number;
  /** Enviados à caixa de entrada do escritório (não identificados ou cliente não cadastrado). */
  inbox: number;
  known: number;
  skipped: number;
  failed: number;
}

export const emptyStats = (): Stats => ({ sent: 0, duplicate: 0, inbox: 0, known: 0, skipped: 0, failed: 0 });

/** Diferença entre dois retratos dos contadores (o que uma varredura fez). */
export function statsDelta(after: Stats, before: Stats): Stats {
  const out = emptyStats();
  for (const k of Object.keys(out) as (keyof Stats)[]) out[k] = after[k] - before[k];
  return out;
}

export const describeStats = (s: Stats) =>
  `${s.sent} enviado(s), ${s.duplicate} já existente(s), ${s.inbox} para a caixa de entrada, ${s.known} sem alteração, ${s.skipped} ignorado(s), ${s.failed} com erro`;

export const tokenRefused = (e: ApiError) => `Token recusado (${e.message}). Gere um token do tipo "Sincronizador" em Meu escritório › Robô e rode: verifco-sync config --token vfk_...`;

/** Erros que passam sozinhos: sem conexão, servidor fora do ar ou ocupado. */
const isTransient = (e: ApiError) => e.status === 0 || e.status >= 500 || e.status === 408 || e.status === 429;

/**
 * Confere o token ao iniciar, insistindo enquanto não houver conexão: 5 s, 10 s, 20 s… até
 * 5 minutos entre as tentativas, para sempre (o computador pode ligar antes da rede). Só o token
 * recusado (401/403) é definitivo e interrompe.
 */
export async function connectWithBackoff(cfg: SyncConfig, wait: (ms: number) => Promise<void> = sleep): Promise<WhoAmI> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await whoami(cfg)).body;
    } catch (err) {
      const e = toApiError(err);
      if (isAuthError(e)) throw e;
      const delay = backoffDelay(attempt, STARTUP_BACKOFF);
      log.warn(`Não foi possível conectar ao Verifco (${e.message}). Nova tentativa em ${formatDelay(delay)}.`);
      await wait(delay);
    }
  }
}

/** O que já se sabe de um arquivo enquanto tamanho e data não mudam (evita reler a cada varredura). */
interface Seen {
  size: number;
  mtimeMs: number;
  hash: string;
  info: Classified;
  plan: Plan;
}

/** Falha à espera de nova tentativa. */
interface Pending {
  hash: string;
  attempts: number;
  nextAt: number;
}

type InboxOutcome = { outcome: 'sent' | 'known' | 'off' | 'unsupported' | 'fatal' } | { outcome: 'error'; error: ApiError };

/**
 * Varredura e observação das pastas. Os envios são feitos um por vez (fila), com espera
 * (debounce) depois da última alteração de cada arquivo, porque o programa grava em etapas.
 * O que falha fica pendente e é tentado de novo com espera crescente (`retryPending`); a varredura
 * periódica (`scan`) pega o que o observador perdeu.
 */
export class Syncer {
  stats: Stats = emptyStats();
  private exts: Set<string>;
  private timers = new Map<string, NodeJS.Timeout>();
  private seen = new Map<string, Seen>();
  private pending = new Map<string, Pending>();
  /** Último aviso gravado por arquivo, para a varredura periódica não repetir a mesma linha. */
  private logged = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private watchers = new Map<string, FSWatcher>();
  private rearmTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private inboxUnsupported = false;
  private rearm: BackoffSchedule;
  private now: () => number;
  /** Erro que impede continuar (token inválido ou revogado). */
  fatal: ApiError | null = null;

  constructor(
    private cfg: SyncConfig,
    private state: SyncState,
    private onFatal: (err: ApiError) => void = () => {},
    opts: { rearm?: BackoffSchedule; now?: () => number } = {},
  ) {
    this.exts = new Set(cfg.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
    this.rearm = opts.rearm ?? REARM_BACKOFF;
    this.now = opts.now ?? Date.now;
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

  /** Varredura completa das pastas (ao iniciar, periodicamente e no comando `varrer`). */
  async scan(folders: string[], opts: { quiet?: boolean } = {}) {
    for (const folder of folders) {
      if (!opts.quiet) log.info(`Varrendo ${folder}`);
      for await (const file of this.walk(folder)) {
        await this.enqueue(file);
        if (this.fatal || this.closed) return;
      }
    }
  }

  /** Coloca o arquivo na fila de envio (um por vez). Uma falha inesperada não derruba a fila. */
  enqueue(path: string): Promise<void> {
    this.chain = this.chain
      .then(() => (this.fatal || this.closed ? undefined : this.process(path)))
      .catch((err) => log.error(`${basename(path)}: erro inesperado (${err instanceof Error ? err.message : String(err)}).`));
    return this.chain;
  }

  private once(path: string, hash: string, tag: string, emit: () => void) {
    const key = `${hash}|${tag}`;
    if (this.logged.get(path) === key) return;
    this.logged.set(path, key);
    emit();
  }

  /** Marca para nova tentativa, com espera crescente a cada falha do mesmo conteúdo. */
  private defer(path: string, hash: string, schedule: BackoffSchedule): number {
    const prev = this.pending.get(path);
    const attempts = prev && prev.hash === hash ? prev.attempts + 1 : 1;
    const delay = backoffDelay(attempts - 1, schedule);
    this.pending.set(path, { hash, attempts, nextAt: this.now() + delay });
    return delay;
  }

  private settle(path: string) {
    this.pending.delete(path);
    this.logged.delete(path);
  }

  private stop(e: ApiError) {
    if (this.fatal) return;
    this.fatal = e;
    log.error(tokenRefused(e));
    this.onFatal(e);
  }

  private async process(path: string) {
    let size: number;
    let modifiedAt: Date;
    try {
      const st = await stat(path);
      if (!st.isFile()) return;
      size = st.size;
      modifiedAt = st.mtime;
    } catch {
      // apagado ou movido antes do envio
      this.seen.delete(path);
      this.settle(path);
      return;
    }
    const name = basename(path);
    if (size === 0) return;
    if (size > MAX_BYTES) {
      this.once(path, '', 'grande', () => log.warn(`${name}: maior que 25 MB, ignorado.`));
      this.stats.skipped++;
      return;
    }

    let data: Buffer | null = null;
    let seen = this.seen.get(path);
    if (!seen || seen.size !== size || seen.mtimeMs !== modifiedAt.getTime()) {
      try {
        data = await readFile(path);
      } catch (err) {
        // comum no Windows enquanto o programa IRPF ainda está gravando o arquivo
        const delay = this.defer(path, '', TRANSIENT_BACKOFF);
        this.once(path, '', 'leitura', () => log.warn(`${name}: não foi possível ler agora (${err instanceof Error ? err.message : String(err)}). Nova tentativa em ${formatDelay(delay)}.`));
        this.stats.failed++;
        return;
      }
      const hash = createHash('sha256').update(data).digest('hex');
      const info = classifyFile(path, { prefilledFolders: this.cfg.prefilledFolders, header: data.subarray(0, HEADER_BYTES) });
      seen = { size, mtimeMs: modifiedAt.getTime(), hash, info, plan: planFile(info) };
      this.seen.set(path, seen);
    }
    const { hash, info, plan } = seen;

    const pend = this.pending.get(path);
    if (pend && pend.hash !== hash) this.pending.delete(path);
    else if (pend && this.now() < pend.nextAt) return; // ainda na espera entre tentativas

    if (plan.action === 'skip') {
      this.once(path, hash, 'ignorado', () => log.warn(`${name}: ignorado (${plan.why}).`));
      this.stats.skipped++;
      return;
    }

    // só relê o conteúdo quando há mesmo algo a enviar
    const pendingSend = plan.action === 'upload' ? !this.state.has(plan.destination, hash) : this.cfg.inbox && !this.inboxUnsupported && !this.state.has('inbox', hash);
    if (pendingSend && !data) {
      try {
        data = await readFile(path);
      } catch {
        data = null;
      }
      if (!data || createHash('sha256').update(data).digest('hex') !== hash) {
        this.seen.delete(path); // mudou no meio do caminho: a próxima passagem identifica de novo
        return;
      }
    }

    if (plan.action === 'inbox') {
      const r = await this.inbox(path, name, hash, plan, data);
      if (r.outcome === 'sent') {
        this.settle(path);
        log.warn(`${name}: ${plan.why}. Enviado à caixa de entrada do Verifco para o escritório conferir.`);
      } else if (r.outcome === 'known') {
        this.stats.known++;
        this.pending.delete(path);
      } else if (r.outcome === 'off' || r.outcome === 'unsupported') {
        this.stats.skipped++;
        this.once(path, hash, 'ignorado', () => log.warn(`${name}: ignorado (${plan.why}).`));
      } else if (r.outcome === 'error') {
        const e = r.error;
        this.stats.failed++;
        const delay = this.defer(path, hash, isTransient(e) ? TRANSIENT_BACKOFF : WAITING_BACKOFF);
        this.once(path, hash, `caixa:${e.status}`, () => log.error(`${name}: ${plan.why}. Não foi possível enviar à caixa de entrada (${e.message}). Nova tentativa em ${formatDelay(delay)}.`));
      }
      return;
    }

    if (this.state.has(plan.destination, hash)) {
      this.stats.known++;
      this.pending.delete(path);
      return;
    }
    try {
      const res = await upload(this.cfg, { destination: plan.destination, data: data!, name, path, cpf: info.cpf, year: info.year, type: info.type, modifiedAt });
      const dup = res.body.duplicate;
      this.state.mark(plan.destination, hash, { path, sentAt: new Date().toISOString(), result: dup ? 'já existia' : 'enviado', customer: res.body.customer?.name, year: res.body.year });
      this.settle(path);
      if (info.headerYear && info.yearSource === 'nome' && info.headerYear !== info.year) {
        log.warn(`${name}: o ano do nome (${info.year}) é diferente do ano do conteúdo (${info.headerYear}); valeu o do nome. Confira no Verifco.`);
      }
      if (dup) {
        this.stats.duplicate++;
        log.info(`${name}: já estava no Verifco (${res.body.customer?.name}).`);
      } else {
        this.stats.sent++;
        log.ok(`${name} → ${res.body.customer?.name}, exercício ${res.body.year}${plan.destination === 'prefilled' ? ' (pré-preenchida)' : ''}.`);
      }
    } catch (err) {
      const e = toApiError(err);
      this.stats.failed++;
      if (isAuthError(e)) {
        this.stop(e);
      } else if (e.status === 404) {
        // cliente ainda não cadastrado: o escritório vê o arquivo na caixa de entrada e o envio é tentado de novo
        this.defer(path, hash, WAITING_BACKOFF);
        const r = await this.inbox(path, name, hash, { reason: 'cliente_nao_cadastrado', cpf: info.cpf, year: info.year }, data);
        if (r.outcome === 'fatal') return;
        const where = r.outcome === 'sent' ? ' Enquanto isso, o arquivo foi para a caixa de entrada do escritório.' : '';
        this.once(path, hash, '404', () => log.warn(`${name}: ${e.message} Cadastre o cliente no Verifco; o envio será tentado de novo automaticamente.${where}`));
      } else {
        const delay = this.defer(path, hash, isTransient(e) ? TRANSIENT_BACKOFF : WAITING_BACKOFF);
        this.once(path, hash, `erro:${e.status}`, () => log.error(`${name}: ${e.message} Nova tentativa em ${formatDelay(delay)}.`));
      }
    }
  }

  /** Envia à caixa de entrada do escritório, uma vez por conteúdo (controle no destino `inbox`). */
  private async inbox(path: string, name: string, hash: string, item: { reason: InboxReason; cpf: string | null; year: number | null }, data: Buffer | null): Promise<InboxOutcome> {
    if (!this.cfg.inbox) return { outcome: 'off' };
    if (this.state.has('inbox', hash)) return { outcome: 'known' };
    if (this.inboxUnsupported || !data) return { outcome: 'unsupported' };
    try {
      await sendInbox(this.cfg, { data, name, path, reason: item.reason, cpf: item.cpf, year: item.year });
      this.state.mark('inbox', hash, { path, sentAt: new Date().toISOString(), result: 'caixa de entrada', reason: item.reason, year: item.year ?? undefined });
      this.stats.inbox++;
      return { outcome: 'sent' };
    } catch (err) {
      const e = toApiError(err);
      if (isAuthError(e)) {
        this.stop(e);
        return { outcome: 'fatal' };
      }
      if (inboxUnavailable(e)) {
        this.inboxUnsupported = true;
        log.warn(
          'Este Verifco ainda não tem a caixa de entrada do sincronizador (servidor em versão anterior): os arquivos não identificados ficam só neste log. Nova tentativa depois da próxima conferência de versão.',
        );
        return { outcome: 'unsupported' };
      }
      return { outcome: 'error', error: e };
    }
  }

  /** Depois de uma nova conferência de versão: volta a tentar a caixa de entrada. */
  resetInbox() {
    this.inboxUnsupported = false;
  }

  /** Quantos arquivos aguardam nova tentativa. */
  get pendingCount() {
    return this.pending.size;
  }

  /** Observa as pastas (recursivo) e envia o que mudar. */
  watch(folders: string[]) {
    for (const folder of folders) {
      if (this.watchers.has(folder) || this.rearmTimers.has(folder)) continue;
      if (!this.arm(folder)) this.rearmLater(folder, 0);
    }
  }

  watching(folder: string) {
    return this.watchers.has(folder);
  }

  private arm(folder: string, quiet = false): boolean {
    if (this.closed) return false;
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
        // o observador não se recupera sozinho (pasta renomeada, unidade de rede que caiu…): fecha e arma de novo
        if (this.watchers.get(folder) !== w) return;
        this.watchers.delete(folder);
        try {
          w.close();
        } catch {
          /* já fechado */
        }
        log.warn(`Observação de ${folder} interrompida: ${err.message}. Nova tentativa em ${formatDelay(backoffDelay(0, this.rearm))}.`);
        this.rearmLater(folder, 0);
      });
      this.watchers.set(folder, w);
      log.info(`Observando ${folder}`);
      return true;
    } catch (err) {
      if (!quiet) log.warn(`Não foi possível observar ${folder}: ${err instanceof Error ? err.message : String(err)}. O sincronizador segue tentando.`);
      return false;
    }
  }

  private rearmLater(folder: string, attempt: number) {
    if (this.closed || this.rearmTimers.has(folder)) return;
    const timer = setTimeout(() => {
      this.rearmTimers.delete(folder);
      if (this.closed) return;
      if (this.arm(folder, true)) {
        log.info(`Observação de ${folder} retomada.`);
        void this.scan([folder], { quiet: true }); // o que mudou enquanto a pasta ficou sem observação
      } else this.rearmLater(folder, attempt + 1);
    }, backoffDelay(attempt, this.rearm));
    this.rearmTimers.set(folder, timer);
  }

  /** Tenta de novo os arquivos pendentes cuja espera já venceu. */
  retryPending(now = this.now()) {
    for (const [path, p] of [...this.pending]) if (now >= p.nextAt) void this.enqueue(path);
  }

  close() {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.rearmTimers.values()) clearTimeout(t);
    this.watchers.clear();
    this.timers.clear();
    this.rearmTimers.clear();
  }

  /** Aguarda a fila de envios terminar. */
  idle() {
    return this.chain;
  }
}
