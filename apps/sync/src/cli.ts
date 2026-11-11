/**
 * Sincronizador Verifco — linha de comando.
 *
 * No Windows use `verifco-sync <comando>` (arquivo verifco-sync.cmd); no Linux/macOS,
 * `sh verifco-sync.sh <comando>`. Os atalhos `npm run <comando> -- <opções>` continuam valendo.
 *
 *   verifco-sync configurar     perguntas e respostas: endereço, token, pastas e teste de conexão
 *   verifco-sync config --url https://app.seuescritorio.com.br --token vfk_...
 *   verifco-sync config --pasta "D:\Declaracoes"        (repita para várias)
 *   verifco-sync config --remover-pasta "D:\Declaracoes"
 *   verifco-sync config --pasta-pre "D:\PrePreenchidas"  (arquivos de pré-preenchidas)
 *   verifco-sync config --sem-pastas-padrao | --com-pastas-padrao
 *   verifco-sync config --varredura 15                   (minutos entre as varreduras; 0 desliga)
 *   verifco-sync config --sem-caixa-de-entrada | --com-caixa-de-entrada
 *   verifco-sync pastas         lista as pastas consideradas
 *   verifco-sync testar         confere endereço, token e versão
 *   verifco-sync varrer         envia o que houver de novo e termina
 *   verifco-sync iniciar        varre e continua observando as pastas
 *   verifco-sync status         resumo do que já foi enviado
 *   verifco-sync instalar       inicia junto com o Windows (tarefa agendada, sem janela)
 *   verifco-sync desinstalar    desfaz o `instalar`
 *   verifco-sync versao
 */
import { resolve } from 'node:path';
import { ApiError, isAuthError, isConfigured, toApiError, whoami, type WhoAmI } from './api';
import { checkRescanMinutes, checkToken, configPath, dataDir, loadConfig, maskToken, normalizeUrl, saveConfig, type SyncConfig } from './config';
import { Syncer, connectWithBackoff, describeStats, statsDelta, tokenRefused } from './engine';
import { folderStatus, watchedFolders } from './folders';
import { classifyFile } from './identify';
import { install, uninstall } from './install';
import { initLog, log } from './log';
import { SyncState } from './state';
import { VERSION, updateNotice, type UpdateNotice } from './version';
import { expandHome, terminalPrompter, wizard } from './wizard';

type Args = { _: string[]; flags: Map<string, string[]> };

/** Opções sem valor: o argumento seguinte não é consumido por elas. */
const SWITCHES = new Set(['sem-pastas-padrao', 'com-pastas-padrao', 'sem-caixa-de-entrada', 'com-caixa-de-entrada', 'versao', 'version', 'ajuda', 'help']);

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      const next = argv[i + 1];
      const value = inline ?? (!SWITCHES.has(k) && next !== undefined && !next.startsWith('--') ? (i++, next) : 'true');
      args.flags.set(k, [...(args.flags.get(k) ?? []), value]);
    } else args._.push(a);
  }
  return args;
}

const HELP = `Sincronizador Verifco ${VERSION}
Comandos: configurar, config, pastas, testar, varrer, iniciar, status, instalar, desinstalar, versao.
Comece por "verifco-sync configurar". Veja o README.md.`;

/** Varredura periódica e caixa de entrada: valem no `config` (gravadas) e no `iniciar`/`varrer` (só na execução). */
function applyRunFlags(cfg: SyncConfig, args: Args) {
  const rescan = args.flags.get('varredura')?.at(-1);
  if (rescan !== undefined) cfg.rescanMinutes = checkRescanMinutes(rescan);
  if (args.flags.has('sem-caixa-de-entrada')) cfg.inbox = false;
  if (args.flags.has('com-caixa-de-entrada')) cfg.inbox = true;
  return cfg;
}

function configure(args: Args) {
  const cfg = loadConfig();
  const one = (k: string) => args.flags.get(k)?.at(-1);
  const many = (k: string) => (args.flags.get(k) ?? []).map((p) => resolve(expandHome(p)));
  if (one('url')) cfg.apiUrl = normalizeUrl(one('url')!);
  if (one('token')) cfg.token = checkToken(one('token')!);
  for (const p of many('pasta')) if (!cfg.folders.includes(p)) cfg.folders.push(p);
  for (const p of many('pasta-pre')) if (!cfg.prefilledFolders.includes(p)) cfg.prefilledFolders.push(p);
  const remove = new Set(many('remover-pasta'));
  cfg.folders = cfg.folders.filter((p) => !remove.has(p));
  cfg.prefilledFolders = cfg.prefilledFolders.filter((p) => !remove.has(p));
  if (args.flags.has('sem-pastas-padrao')) cfg.useDefaultFolders = false;
  if (args.flags.has('com-pastas-padrao')) cfg.useDefaultFolders = true;
  if (one('espera')) cfg.debounceMs = Math.max(200, Number(one('espera')) || cfg.debounceMs);
  applyRunFlags(cfg, args);
  saveConfig(cfg);
  printConfig(cfg);
}

function printConfig(cfg: SyncConfig) {
  console.log(`Sincronizador Verifco ${VERSION}`);
  console.log(`Configuração: ${configPath()}`);
  console.log(`  Endereço:            ${cfg.apiUrl || '(não configurado)'}`);
  console.log(`  Token:               ${maskToken(cfg.token)}`);
  console.log(`  Pastas padrão IRPF:  ${cfg.useDefaultFolders ? 'sim' : 'não'}`);
  console.log(`  Pastas extras:       ${cfg.folders.join(' | ') || '—'}`);
  console.log(`  Pré-preenchidas:     ${cfg.prefilledFolders.join(' | ') || '—'}`);
  console.log(`  Extensões:           ${cfg.extensions.join(', ')}`);
  console.log(`  Varredura periódica: ${cfg.rescanMinutes > 0 ? `a cada ${cfg.rescanMinutes} min` : 'desligada'}`);
  console.log(`  Caixa de entrada:    ${cfg.inbox ? 'sim (não identificados e clientes não cadastrados vão para o escritório conferir)' : 'não'}`);
}

function printFolders(cfg: SyncConfig) {
  const list = folderStatus(cfg);
  if (!list.length) console.log('Nenhuma pasta configurada.');
  for (const f of list) console.log(`  ${f.exists ? '[ok]     ' : '[ausente]'} ${f.path}  (${f.origin})`);
  if (!list.some((f) => f.exists)) console.log('\nNenhuma pasta existe neste computador. Inclua a pasta onde o programa IRPF grava: verifco-sync config --pasta "<caminho>"');
}

const SCOPE_WARNING = 'Atenção: este token não é do escopo "Sincronizador"; o envio de arquivos será recusado.';
const connectedLine = (who: WhoAmI) => `Conectado a "${who.office.name}" com o token "${who.token.name}" (${who.token.scope}).`;

function printNotice(notice: UpdateNotice | null) {
  if (!notice) return;
  console.log('');
  console.log(notice.text);
}

async function test(cfg: SyncConfig) {
  const who = (await whoami(cfg)).body;
  console.log(connectedLine(who));
  if (who.token.scope !== 'sync') console.log(SCOPE_WARNING);
  console.log(`Versão do sincronizador: ${VERSION}${who.client?.latest ? ` (mais recente: ${who.client.latest})` : ''}.`);
  printNotice(updateNotice(who.client));
}

const HOUR = 60 * 60_000;
/** A cada 6 horas o sincronizador confere a versão de novo; o aviso de atualização vai ao log uma vez por dia. */
const VERSION_CHECK_MS = 6 * HOUR;
const NOTICE_EVERY_MS = 24 * HOUR - 60_000;

async function run(cfg: SyncConfig, keepWatching: boolean) {
  initLog();
  if (!isConfigured(cfg)) {
    log.error('Configure o endereço e o token primeiro: verifco-sync configurar');
    process.exitCode = 1;
    return;
  }
  const folders = watchedFolders(cfg);
  if (!folders.length) {
    printFolders(cfg);
    if (!keepWatching) {
      process.exitCode = 1;
      return;
    }
    log.warn('Nenhuma pasta para observar existe ainda; o sincronizador segue procurando a cada 10 minutos.');
  }
  log.info(`Sincronizador Verifco ${VERSION} iniciado (dados em ${dataDir()}).`);

  let who: WhoAmI;
  try {
    // `iniciar` insiste enquanto não houver conexão (o computador liga antes da rede); `varrer` falha na hora
    who = keepWatching ? await connectWithBackoff(cfg) : (await whoami(cfg)).body;
  } catch (err) {
    const e = toApiError(err);
    log.error(isAuthError(e) ? tokenRefused(e) : e.message);
    process.exitCode = 1;
    return;
  }
  log.info(connectedLine(who));
  if (who.token.scope !== 'sync') log.warn(SCOPE_WARNING);
  let lastNoticeAt = 0;
  const announce = (notice: UpdateNotice | null) => {
    if (!notice || Date.now() - lastNoticeAt < NOTICE_EVERY_MS) return;
    lastNoticeAt = Date.now();
    if (notice.level === 'unsupported') log.error(notice.text);
    else log.warn(notice.text);
  };
  announce(updateNotice(who.client));

  // o destino dos envios antigos (state.json da versão 0.2) é deduzido pela pasta
  const state = new SyncState(dataDir(), (path) => classifyFile(path, { prefilledFolders: cfg.prefilledFolders }).destination);
  const syncer = new Syncer(cfg, state, () => {
    if (keepWatching) {
      syncer.close();
      process.exit(1);
    }
  });
  await syncer.scan(folders);
  await syncer.idle();
  log.info(`Varredura concluída: ${describeStats(syncer.stats)}.`);
  if (syncer.fatal) {
    process.exitCode = 1;
    return;
  }
  if (!keepWatching) return;
  syncer.watch(folders);

  // novas tentativas do que falhou (cada arquivo com a sua espera)
  setInterval(() => syncer.retryPending(), 60_000);

  // novas pastas (ex.: programa do ano instalado depois)
  setInterval(() => {
    const fresh = watchedFolders(cfg).filter((f) => !folders.includes(f));
    if (!fresh.length) return;
    folders.push(...fresh);
    void syncer.scan(fresh).then(() => syncer.watch(fresh));
  }, 10 * 60_000);

  // varredura periódica: pega o que o observador perdeu e o que passou a poder ser enviado
  if (cfg.rescanMinutes > 0) {
    let scanning = false;
    setInterval(async () => {
      if (scanning) return;
      scanning = true;
      try {
        const before = { ...syncer.stats };
        await syncer.scan(folders, { quiet: true });
        await syncer.idle();
        const d = statsDelta(syncer.stats, before);
        if (d.sent || d.duplicate || d.inbox || d.failed) log.info(`Varredura periódica: ${describeStats(d)}.`);
        syncer.watch(folders); // rearma o que por acaso tenha ficado sem observação
      } catch (err) {
        log.error(`Varredura periódica interrompida: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        scanning = false;
      }
    }, cfg.rescanMinutes * 60_000);
  }

  // conferência de versão: repete o aviso de atualização uma vez por dia e volta a tentar a caixa de entrada
  setInterval(async () => {
    try {
      const again = (await whoami(cfg)).body;
      syncer.resetInbox();
      announce(updateNotice(again.client));
    } catch (err) {
      const e = toApiError(err);
      if (!isAuthError(e)) return; // sem conexão agora: a próxima conferência resolve
      log.error(tokenRefused(e));
      syncer.close();
      process.exit(1);
    }
  }, VERSION_CHECK_MS);

  const stop = () => {
    log.info('Sincronizador encerrado.');
    syncer.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log.info(`Observando alterações${cfg.rescanMinutes > 0 ? ` (varredura completa a cada ${cfg.rescanMinutes} min)` : ''}. Pressione Ctrl+C para encerrar.`);
}

const DESTINATION_LABEL = { files: 'cliente', prefilled: 'pré-preench.', inbox: 'cx. entrada' } as const;

async function status(cfg: SyncConfig) {
  printConfig(cfg);
  const state = new SyncState(dataDir(), (path) => classifyFile(path, { prefilledFolders: cfg.prefilledFolders }).destination);
  console.log(`\nEnvios registrados (por conteúdo e destino): ${state.count}`);
  console.log(`  documentos do cliente: ${state.countOf('files')}   pré-preenchidas: ${state.countOf('prefilled')}   caixa de entrada: ${state.countOf('inbox')}`);
  const last = Object.values(state.sent)
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, 10);
  for (const e of last) console.log(`  ${new Date(e.sentAt).toLocaleString('pt-BR')}  ${DESTINATION_LABEL[e.destination].padEnd(12)}  ${e.result.padEnd(16)}  ${e.customer ?? ''}  ${e.path}`);
  if (!isConfigured(cfg)) return;
  try {
    const who = (await whoami(cfg, { timeoutMs: 8_000 })).body;
    const notice = updateNotice(who.client);
    if (notice) printNotice(notice);
    else if (who.client?.latest) console.log(`\nVersão em dia (mais recente: ${who.client.latest}).`);
  } catch (err) {
    console.log(`\nNão foi possível conferir a versão mais recente agora (${toApiError(err).message}).`);
  }
}

/** Perguntas e respostas; grava e testa a conexão no fim. */
async function setup() {
  const io = terminalPrompter();
  let cfg: SyncConfig;
  try {
    cfg = await wizard(loadConfig(), io);
  } finally {
    io.close();
  }
  saveConfig(cfg);
  console.log(`\nConfiguração gravada em ${configPath()}.\n`);
  printFolders(cfg);
  console.log('\nTestando a conexão...');
  try {
    await test(cfg);
  } catch (err) {
    console.log(`A conexão falhou: ${toApiError(err).message}`);
    console.log('Confira o endereço e o token e rode de novo: verifco-sync configurar (ou verifco-sync testar).');
    process.exitCode = 1;
    return;
  }
  console.log('\nPronto. Próximos passos:');
  console.log('  verifco-sync varrer      envia agora o que já existe nas pastas');
  console.log(`  verifco-sync instalar    ${process.platform === 'win32' ? 'inicia junto com o Windows, sem janela' : 'mostra como iniciar junto com a sessão'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('versao') || args.flags.has('version')) return console.log(VERSION);
  if (args.flags.has('ajuda') || args.flags.has('help')) return console.log(HELP);
  const cmd = args._[0] ?? 'iniciar';
  switch (cmd) {
    case 'configurar':
      return setup();
    case 'config':
      return configure(args);
    case 'pastas':
      return printFolders(loadConfig());
    case 'testar':
      return test(loadConfig());
    case 'varrer':
      return run(applyRunFlags(loadConfig(), args), false);
    case 'iniciar':
      return run(applyRunFlags(loadConfig(), args), true);
    case 'status':
      return status(loadConfig());
    case 'instalar':
      return install();
    case 'desinstalar':
      return uninstall();
    case 'versao':
      return console.log(VERSION);
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
  console.error(`Erro: ${msg}`);
  process.exitCode = 1;
});
