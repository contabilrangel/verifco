/**
 * Sincronizador Verifco — linha de comando.
 *
 *   npm run config -- --url https://app.seuescritorio.com.br --token vfk_...
 *   npm run config -- --pasta "D:\Declaracoes"        (repita para várias)
 *   npm run config -- --remover-pasta "D:\Declaracoes"
 *   npm run config -- --pasta-pre "D:\PrePreenchidas"  (arquivos de pré-preenchidas)
 *   npm run config -- --sem-pastas-padrao | --com-pastas-padrao
 *   npm run pastas      lista as pastas consideradas
 *   npm run testar      confere endereço e token
 *   npm run varrer      envia o que houver de novo e termina
 *   npm start           varre e continua observando as pastas
 *   npm run status      resumo do que já foi enviado
 */
import { resolve } from 'node:path';
import { ApiError, whoami } from './api';
import { configPath, dataDir, loadConfig, maskToken, saveConfig, type SyncConfig } from './config';
import { folderStatus, watchedFolders } from './folders';
import { initLog, log } from './log';
import { SyncState } from './state';
import { Syncer } from './engine';

type Args = { _: string[]; flags: Map<string, string[]> };

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      const next = argv[i + 1];
      const value = inline ?? (next !== undefined && !next.startsWith('--') ? (i++, next) : 'true');
      args.flags.set(k, [...(args.flags.get(k) ?? []), value]);
    } else args._.push(a);
  }
  return args;
}

const expandHome = (p: string) => (p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? '~') : p);

function configure(args: Args) {
  const cfg = loadConfig();
  const one = (k: string) => args.flags.get(k)?.at(-1);
  const many = (k: string) => (args.flags.get(k) ?? []).map((p) => resolve(expandHome(p)));
  if (one('url')) {
    const url = one('url')!.trim().replace(/\/+$/, '').replace(/\/api$/, '');
    if (!/^https?:\/\//.test(url)) throw new Error('Use um endereço começando com http:// ou https://');
    cfg.apiUrl = url;
  }
  if (one('token')) {
    const token = one('token')!.trim();
    if (!/^vfk_[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('O token deve começar com vfk_ (crie em Administração › Robô, escopo Sincronizador).');
    cfg.token = token;
  }
  for (const p of many('pasta')) if (!cfg.folders.includes(p)) cfg.folders.push(p);
  for (const p of many('pasta-pre')) if (!cfg.prefilledFolders.includes(p)) cfg.prefilledFolders.push(p);
  const remove = new Set(many('remover-pasta'));
  cfg.folders = cfg.folders.filter((p) => !remove.has(p));
  cfg.prefilledFolders = cfg.prefilledFolders.filter((p) => !remove.has(p));
  if (args.flags.has('sem-pastas-padrao')) cfg.useDefaultFolders = false;
  if (args.flags.has('com-pastas-padrao')) cfg.useDefaultFolders = true;
  if (one('espera')) cfg.debounceMs = Math.max(200, Number(one('espera')) || cfg.debounceMs);
  saveConfig(cfg);
  printConfig(cfg);
}

function printConfig(cfg: SyncConfig) {
  console.log(`Configuração: ${configPath()}`);
  console.log(`  Endereço:            ${cfg.apiUrl || '(não configurado)'}`);
  console.log(`  Token:               ${maskToken(cfg.token)}`);
  console.log(`  Pastas padrão IRPF:  ${cfg.useDefaultFolders ? 'sim' : 'não'}`);
  console.log(`  Pastas extras:       ${cfg.folders.join(' | ') || '—'}`);
  console.log(`  Pré-preenchidas:     ${cfg.prefilledFolders.join(' | ') || '—'}`);
  console.log(`  Extensões:           ${cfg.extensions.join(', ')}`);
}

function printFolders(cfg: SyncConfig) {
  const list = folderStatus(cfg);
  if (!list.length) console.log('Nenhuma pasta configurada.');
  for (const f of list) console.log(`  ${f.exists ? '[ok]     ' : '[ausente]'} ${f.path}  (${f.origin})`);
  if (!list.some((f) => f.exists)) console.log('\nNenhuma pasta existe neste computador. Inclua a pasta onde o programa IRPF grava: npm run config -- --pasta "<caminho>"');
}

async function test(cfg: SyncConfig) {
  const res = await whoami(cfg);
  console.log(`Conectado a "${res.body.office.name}" com o token "${res.body.token.name}" (${res.body.token.scope}).`);
  if (res.body.token.scope !== 'sync') console.log('Atenção: este token não é do escopo "Sincronizador"; o envio de arquivos será recusado.');
}

async function run(cfg: SyncConfig, keepWatching: boolean) {
  initLog();
  const folders = watchedFolders(cfg);
  if (!folders.length) {
    printFolders(cfg);
    process.exitCode = 1;
    return;
  }
  await test(cfg);
  const state = new SyncState();
  const syncer = new Syncer(cfg, state, () => {
    if (keepWatching) {
      syncer.close();
      process.exit(1);
    }
  });
  log.info(`Sincronizador Verifco iniciado (dados em ${dataDir()}).`);
  await syncer.scan(folders);
  await syncer.idle();
  const s = syncer.stats;
  log.info(`Varredura concluída: ${s.sent} enviado(s), ${s.duplicate} já existente(s), ${s.known} sem alteração, ${s.skipped} ignorado(s), ${s.failed} com erro.`);
  if (syncer.fatal) {
    process.exitCode = 1;
    return;
  }
  if (!keepWatching) return;
  syncer.watch(folders);
  // novas pastas (ex.: programa do ano instalado depois) e reenvio do que falhou
  setInterval(() => syncer.retryFailed(), 60_000);
  setInterval(() => {
    const now = watchedFolders(cfg);
    const fresh = now.filter((f) => !folders.includes(f));
    if (!fresh.length) return;
    folders.push(...fresh);
    void syncer.scan(fresh).then(() => syncer.watch(fresh));
  }, 10 * 60_000);
  const stop = () => {
    log.info('Sincronizador encerrado.');
    syncer.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log.info('Observando alterações. Pressione Ctrl+C para encerrar.');
}

function status(cfg: SyncConfig) {
  printConfig(cfg);
  const state = new SyncState();
  console.log(`\nArquivos enviados (por conteúdo): ${state.count}`);
  const last = Object.values(state.sent)
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, 10);
  for (const e of last) console.log(`  ${new Date(e.sentAt).toLocaleString('pt-BR')}  ${e.result.padEnd(10)}  ${e.customer ?? ''}  ${e.path}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'iniciar';
  switch (cmd) {
    case 'config':
      return configure(args);
    case 'pastas':
      return printFolders(loadConfig());
    case 'testar':
      return test(loadConfig());
    case 'varrer':
      return run(loadConfig(), false);
    case 'iniciar':
      return run(loadConfig(), true);
    case 'status':
      return status(loadConfig());
    default:
      console.log('Comandos: config, pastas, testar, varrer, iniciar, status. Veja o README.md.');
  }
}

main().catch((err) => {
  const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
  console.error(`Erro: ${msg}`);
  process.exitCode = 1;
});
