import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, checkRescanMinutes, checkToken, normalizeUrl } from '../src/config';
import { TASK_NAME, launchdPlist, packageDir, schtasksCreateArgs, schtasksDeleteArgs, startupFolder, systemdUnit, vbsWrapper } from '../src/install';
import { wizard, type Prompter } from '../src/wizard';

test('o pacote traz os atalhos na raiz', () => {
  const dir = packageDir();
  assert.ok(existsSync(join(dir, 'package.json')));
  const cmd = readFileSync(join(dir, 'verifco-sync.cmd'), 'utf8');
  assert.match(cmd, /npm install --omit=dev/);
  assert.match(cmd, /src\\cli\.ts" %\*/);
  assert.doesNotMatch(cmd, /^\s*(goto|:\w)/im);
  const sh = readFileSync(join(dir, 'verifco-sync.sh'), 'utf8');
  assert.match(sh, /npm install --omit=dev/);
  assert.match(sh, /src\/cli\.ts" "\$@"/);
});

test('tarefa de logon do Windows: schtasks e .vbs sem janela', () => {
  const vbs = 'C:\\Users\\Ana Paula\\AppData\\Roaming\\VerifcoSync\\verifco-sync-oculto.vbs';
  assert.deepEqual(schtasksCreateArgs(vbs), ['/Create', '/SC', 'ONLOGON', '/TN', 'Verifco Sincronizador', '/TR', `wscript.exe "${vbs}"`, '/F']);
  assert.deepEqual(schtasksDeleteArgs(), ['/Delete', '/TN', TASK_NAME, '/F']);
  const script = vbsWrapper('C:\\Verifco Sync\\verifco-sync.cmd');
  const run = script.split('\r\n').find((l) => l.startsWith('CreateObject'));
  // aspas dobradas dentro do texto do VBScript; estilo de janela 0 (oculta), sem esperar o término
  assert.equal(run, 'CreateObject("WScript.Shell").Run "cmd.exe /c """"C:\\Verifco Sync\\verifco-sync.cmd"" iniciar""", 0, False');
  assert.equal(startupFolder({ APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' }), 'C:\\Users\\Ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
  assert.equal(startupFolder({}), null);
});

test('Linux e macOS: só o texto do serviço', () => {
  assert.match(systemdUnit('/home/ana/verifco-sincronizador'), /^ExecStart=\/bin\/sh "\/home\/ana\/verifco-sincronizador\/verifco-sync\.sh" iniciar$/m);
  assert.match(systemdUnit('/x'), /WantedBy=default\.target/);
  const plist = launchdPlist('/Users/ana/verifco & cia', '/Users/ana/.verifco-sync');
  assert.match(plist, /<string>\/Users\/ana\/verifco &amp; cia\/verifco-sync\.sh<\/string>/);
  assert.match(plist, /<string>iniciar<\/string>/);
});

test('validação de endereço, token e varredura', () => {
  assert.equal(normalizeUrl(' https://app.escritorio.com.br/api/ '), 'https://app.escritorio.com.br');
  assert.throws(() => normalizeUrl('app.escritorio.com.br'), /http:\/\/ ou https:\/\//);
  assert.equal(checkToken(' vfk_abcdefghijklmnopqrstuvwx '), 'vfk_abcdefghijklmnopqrstuvwx');
  assert.throws(() => checkToken('abc'), /vfk_/);
  assert.equal(checkRescanMinutes('15'), 15);
  assert.equal(checkRescanMinutes('0'), 0);
  assert.equal(checkRescanMinutes('0.2'), 1);
  assert.equal(checkRescanMinutes('99999'), 1440);
  assert.throws(() => checkRescanMinutes('x'), /minutos/);
  assert.equal(DEFAULT_CONFIG.rescanMinutes, 15);
  assert.equal(DEFAULT_CONFIG.inbox, true);
});

/** Respostas prontas, na ordem das perguntas. */
function scripted(answers: string[]) {
  const asked: { question: string; secret: boolean }[] = [];
  const said: string[] = [];
  const next = (question: string, secret: boolean) => {
    asked.push({ question, secret });
    if (!answers.length) throw new Error('Configuração cancelada.');
    return Promise.resolve(answers.shift()!);
  };
  const io: Prompter = { ask: (q) => next(q, false), secret: (q) => next(q, true), say: (l) => void said.push(l), close: () => {} };
  return { io, asked, said };
}

test('configurar: pergunta endereço, token (sem eco) e pastas, repetindo o que for inválido', async () => {
  const token = 'vfk_abcdefghijklmnopqrstuvwx';
  const { io, asked, said } = scripted(['escritorio.com.br', 'https://app.escritorio.com.br/', 'errado', token, 'n', '/dados/declaracoes', '', '/dados/pre', '']);
  const cfg = await wizard({ ...DEFAULT_CONFIG }, io);
  assert.equal(cfg.apiUrl, 'https://app.escritorio.com.br');
  assert.equal(cfg.token, token);
  assert.equal(cfg.useDefaultFolders, false);
  assert.deepEqual(cfg.folders, ['/dados/declaracoes']);
  assert.deepEqual(cfg.prefilledFolders, ['/dados/pre']);
  assert.deepEqual(
    asked.filter((a) => a.secret).map((a) => a.question.trim()),
    ['Token:', 'Token:'],
  );
  assert.ok(said.some((l) => /http:\/\/ ou https:\/\//.test(l)));
  assert.ok(said.some((l) => /vfk_/.test(l)));
});

test('configurar: Enter mantém a configuração atual', async () => {
  const current = { ...DEFAULT_CONFIG, apiUrl: 'https://app.escritorio.com.br', token: 'vfk_abcdefghijklmnopqrstuvwx', folders: ['/a'] };
  const { io, asked } = scripted(['', '', '', '', '']);
  const cfg = await wizard(current, io);
  assert.deepEqual(cfg, current);
  assert.notEqual(cfg.folders, current.folders); // cópia: nada é alterado antes de gravar
  assert.match(asked[1].question, /manter vfk_abcd…uvwx/);
  await assert.rejects(wizard({ ...DEFAULT_CONFIG }, scripted([]).io), /cancelada/);
});
