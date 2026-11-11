/**
 * Iniciar o sincronizador junto com o computador.
 *
 * Windows: `instalar` cria uma tarefa agendada "Ao fazer logon" (schtasks) que roda um pequeno
 * .vbs gerado na pasta de dados; o .vbs chama o `verifco-sync.cmd` sem abrir janela. Se a tarefa
 * não puder ser criada (o Agendador exige permissão de administrador para o disparador de logon em
 * algumas instalações), o mesmo .vbs é copiado para a pasta "Inicializar" do usuário.
 * Linux e macOS: nada é gravado no sistema; `instalar` só mostra o serviço de usuário do systemd
 * ou o LaunchAgent a criar.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config';

export const TASK_NAME = 'Verifco Sincronizador';
export const VBS_NAME = 'verifco-sync-oculto.vbs';
export const STARTUP_NAME = 'Verifco Sincronizador.vbs';

/** Pasta do pacote (onde ficam `verifco-sync.cmd`, `verifco-sync.sh` e `src/`). */
export const packageDir = () => fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

/**
 * Conteúdo do .vbs que inicia o sincronizador sem janela (estilo 0) e sem esperar o término:
 * `cmd.exe /c ""<pasta>\verifco-sync.cmd" iniciar"`. No VBScript as aspas dentro do texto são dobradas.
 */
export function vbsWrapper(cmdPath: string): string {
  const command = `cmd.exe /c ""${cmdPath}" iniciar"`;
  return [
    `' Sincronizador Verifco: inicia sem janela. Gerado por "verifco-sync instalar"; não edite.`,
    `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n');
}

/** Argumentos do `schtasks` que criam (ou recriam, com /F) a tarefa de logon. */
export const schtasksCreateArgs = (vbsPath: string) => ['/Create', '/SC', 'ONLOGON', '/TN', TASK_NAME, '/TR', `wscript.exe "${vbsPath}"`, '/F'];
export const schtasksDeleteArgs = () => ['/Delete', '/TN', TASK_NAME, '/F'];

/**
 * Tarefas criadas pelo schtasks nascem com "iniciar somente na rede elétrica" e limite de 3 dias;
 * este comando do PowerShell tira as duas restrições (é uma tentativa: se falhar, a tarefa continua valendo).
 */
export const taskSettingsScript = () =>
  `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero); Set-ScheduledTask -TaskName '${TASK_NAME}' -Settings $s | Out-Null`;

/** Pasta "Inicializar" do usuário (o que estiver nela roda ao fazer logon). */
export const startupFolder = (env: NodeJS.ProcessEnv = process.env) => (env.APPDATA ? win32.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null);

/** Serviço de usuário do systemd (Linux). */
export function systemdUnit(dir: string): string {
  return [
    '[Unit]',
    'Description=Sincronizador Verifco',
    '',
    '[Service]',
    `ExecStart=/bin/sh "${posix.join(dir, 'verifco-sync.sh')}" iniciar`,
    'Restart=on-failure',
    'RestartSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** LaunchAgent (macOS). */
export function launchdPlist(dir: string, logDir = dataDir()): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key><string>br.com.verifco.sync</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    `    <string>${xml(posix.join(dir, 'verifco-sync.sh'))}</string>`,
    '    <string>iniciar</string>',
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    `  <key>StandardErrorPath</key><string>${xml(posix.join(logDir, 'launchd.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const failure = (err: unknown) => {
  const e = err as { stderr?: Buffer | string; message?: string };
  return String(e.stderr ?? '').trim() || e.message || String(err);
};

function installWindows(say: (line: string) => void) {
  const dir = packageDir();
  const cmd = win32.join(dir, 'verifco-sync.cmd');
  if (!existsSync(cmd)) throw new Error(`Não encontrei ${cmd}. Descompacte o pacote do sincronizador de novo.`);
  const data = dataDir();
  mkdirSync(data, { recursive: true });
  const vbs = win32.join(data, VBS_NAME);
  // UTF-16 com BOM: o Windows Script Host lê certo os caminhos com acento
  writeFileSync(vbs, `﻿${vbsWrapper(cmd)}`, 'utf16le');
  const startup = startupFolder();
  let how: string;
  try {
    execFileSync('schtasks', schtasksCreateArgs(vbs), { stdio: 'pipe', windowsHide: true });
    how = `Tarefa agendada "${TASK_NAME}" criada (Agendador de Tarefas, disparador "Ao fazer logon").`;
    if (startup) rmSync(win32.join(startup, STARTUP_NAME), { force: true });
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', taskSettingsScript()], { stdio: 'pipe', windowsHide: true });
    } catch {
      say('Aviso: não foi possível ajustar as condições da tarefa. Em notebooks, abra o Agendador de Tarefas › Verifco Sincronizador › Condições e desmarque "Iniciar a tarefa somente se o computador estiver ligado à rede elétrica".');
    }
  } catch (err) {
    if (!startup) throw new Error(`Não foi possível criar a tarefa agendada: ${failure(err)}`);
    mkdirSync(startup, { recursive: true });
    copyFileSync(vbs, win32.join(startup, STARTUP_NAME));
    how = `Não foi possível criar a tarefa agendada (${failure(err)}).\nNo lugar dela, o atalho "${STARTUP_NAME}" foi colocado na pasta Inicializar deste usuário (${startup}).`;
  }
  say(how);
  say('O sincronizador passa a iniciar sozinho, sem janela, sempre que este usuário entrar no Windows.');
  const startNow = 'Para iniciar agora sem sair do Windows, rode: verifco-sync iniciar';
  try {
    const child = spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => say(startNow));
    child.unref();
    say('Ele já foi iniciado agora, em segundo plano.');
  } catch {
    say(startNow);
  }
  say(`Acompanhe pelo arquivo ${win32.join(data, 'sync.log')} ou com: verifco-sync status`);
  say('Para desfazer: verifco-sync desinstalar');
}

function uninstallWindows(say: (line: string) => void) {
  let removed = false;
  try {
    execFileSync('schtasks', schtasksDeleteArgs(), { stdio: 'pipe', windowsHide: true });
    say(`Tarefa agendada "${TASK_NAME}" removida.`);
    removed = true;
  } catch {
    /* a tarefa não existia (ou foi criada só o atalho da pasta Inicializar) */
  }
  const startup = startupFolder();
  const shortcut = startup ? win32.join(startup, STARTUP_NAME) : null;
  if (shortcut && existsSync(shortcut)) {
    rmSync(shortcut, { force: true });
    say('Atalho removido da pasta Inicializar.');
    removed = true;
  }
  rmSync(win32.join(dataDir(), VBS_NAME), { force: true });
  if (!removed) say('O sincronizador não estava instalado para iniciar com o Windows.');
  else say('Se o sincronizador estiver rodando agora, ele segue até você sair do Windows (ou encerre "Node.js" no Gerenciador de Tarefas).');
  say('A configuração e o controle de envios continuam na pasta de dados.');
}

/** `verifco-sync instalar`. */
export function install(say: (line: string) => void = console.log, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return installWindows(say);
  const dir = packageDir();
  if (platform === 'darwin') {
    say('No macOS o sincronizador não grava nada no sistema. Para iniciar junto com a sua sessão, crie o arquivo');
    say('  ~/Library/LaunchAgents/br.com.verifco.sync.plist');
    say('com o conteúdo abaixo e ative com: launchctl load ~/Library/LaunchAgents/br.com.verifco.sync.plist\n');
    say(launchdPlist(dir));
    return;
  }
  say('No Linux o sincronizador não grava nada no sistema. Para iniciar junto com a sua sessão, crie o arquivo');
  say('  ~/.config/systemd/user/verifco-sync.service');
  say('com o conteúdo abaixo e ative com: systemctl --user daemon-reload && systemctl --user enable --now verifco-sync\n');
  say(systemdUnit(dir));
}

/** `verifco-sync desinstalar`. */
export function uninstall(say: (line: string) => void = console.log, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return uninstallWindows(say);
  if (platform === 'darwin') {
    say('Para deixar de iniciar com a sessão (macOS):');
    say('  launchctl unload ~/Library/LaunchAgents/br.com.verifco.sync.plist && rm ~/Library/LaunchAgents/br.com.verifco.sync.plist');
    return;
  }
  say('Para deixar de iniciar com a sessão (Linux):');
  say('  systemctl --user disable --now verifco-sync && rm ~/.config/systemd/user/verifco-sync.service');
}
