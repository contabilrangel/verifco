/**
 * `verifco-sync configurar`: perguntas e respostas no terminal (endereço, token e pastas).
 * As perguntas ficam separadas do terminal (`Prompter`) para poderem ser testadas com respostas prontas.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { checkToken, maskToken, normalizeUrl, type SyncConfig } from './config';
import { defaultIrpfFolders } from './folders';

export interface Prompter {
  /** Pergunta com resposta visível; devolve o texto digitado (sem espaços nas pontas). */
  ask(question: string): Promise<string>;
  /** Pergunta sem mostrar o que é digitado (token). */
  secret(question: string): Promise<string>;
  say(line: string): void;
  close(): void;
}

export const expandHome = (p: string) => (p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? '~') : p);

/** Perguntas no terminal. A digitação do token não aparece quando a entrada é um terminal de verdade. */
export function terminalPrompter(input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompter {
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output: out, terminal: Boolean(input.isTTY) });
  // fila própria de linhas: com a entrada redirecionada, as respostas chegam antes das perguntas
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let closed = false;
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });
  const nextLine = () =>
    new Promise<string | null>((done) => {
      if (lines.length) done(lines.shift()!);
      else if (closed) done(null);
      else waiting.push(done);
    });
  const read = async (question: string, hidden: boolean) => {
    if (hidden && rl.terminal) {
      output.write(question);
      muted = true;
    } else {
      rl.setPrompt(question);
      rl.prompt();
    }
    const line = await nextLine();
    if (muted) {
      muted = false;
      output.write('\n');
    }
    if (line === null) throw new Error('Configuração cancelada.');
    return line.trim();
  };
  return {
    ask: (q) => read(q, false),
    secret: (q) => read(q, true),
    say: (line) => void output.write(`${line}\n`),
    close: () => rl.close(),
  };
}

const yes = (answer: string, fallback: boolean) => (answer ? /^(s|sim|y|yes)$/i.test(answer) : fallback);

/** Pergunta até a resposta passar na validação (o erro é mostrado e a pergunta se repete). */
async function until<T>(io: Prompter, question: () => Promise<string>, parse: (answer: string) => T): Promise<T> {
  for (;;) {
    const answer = await question();
    try {
      return parse(answer);
    } catch (err) {
      io.say(`  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function askFolders(io: Prompter, question: string, list: string[]) {
  for (;;) {
    const answer = await io.ask(question);
    if (!answer) return;
    const path = resolve(expandHome(answer.replace(/^"(.*)"$/, '$1')));
    if (!list.includes(path)) list.push(path);
    io.say(existsSync(path) ? `  Incluída: ${path}` : `  Incluída: ${path} (a pasta ainda não existe; passa a ser observada quando existir)`);
  }
}

/**
 * Pergunta endereço, token e pastas, partindo da configuração atual (Enter mantém o valor entre
 * colchetes), e devolve a configuração nova. Não grava nem testa: isso fica com quem chama.
 */
export async function wizard(current: SyncConfig, io: Prompter): Promise<SyncConfig> {
  const cfg: SyncConfig = { ...current, folders: [...current.folders], prefilledFolders: [...current.prefilledFolders] };
  io.say('Configuração do Sincronizador Verifco');
  io.say('Responda e tecle Enter. Enter sozinho mantém o valor entre colchetes.\n');

  io.say('1. Endereço do Verifco: o mesmo que você abre no navegador (ex.: https://app.seuescritorio.com.br).');
  cfg.apiUrl = await until(io, () => io.ask(`   Endereço${cfg.apiUrl ? ` [${cfg.apiUrl}]` : ''}: `), (a) => {
    if (!a && cfg.apiUrl) return cfg.apiUrl;
    return normalizeUrl(a);
  });

  io.say('\n2. Token do tipo "Sincronizador": crie no Verifco em Meu escritório › Robô e cole aqui (o que você digitar não aparece).');
  cfg.token = await until(io, () => io.secret(`   Token${cfg.token ? ` [manter ${maskToken(cfg.token)}]` : ''}: `), (a) => {
    if (!a && cfg.token) return cfg.token;
    return checkToken(a);
  });

  io.say('\n3. Pastas. O sincronizador procura sozinho as pastas padrão do programa IRPF (ano atual e anterior):');
  for (const p of defaultIrpfFolders()) io.say(`   ${existsSync(p) ? '[ok]     ' : '[ausente]'} ${p}`);
  cfg.useDefaultFolders = yes(await io.ask(`   Observar as pastas padrão? (s/n) [${cfg.useDefaultFolders ? 's' : 'n'}]: `), cfg.useDefaultFolders);
  if (cfg.folders.length) io.say(`   Pastas extras já configuradas: ${cfg.folders.join(' | ')}`);
  io.say('   Se o programa IRPF grava as declarações ou as cópias de segurança em outro lugar, informe a pasta.');
  await askFolders(io, '   Outra pasta (Enter para continuar): ', cfg.folders);
  if (cfg.prefilledFolders.length) io.say(`   Pastas de pré-preenchidas já configuradas: ${cfg.prefilledFolders.join(' | ')}`);
  io.say('   Se você baixa os arquivos das pré-preenchidas para uma pasta, informe-a (eles vão para as pré-preenchidas do cliente).');
  await askFolders(io, '   Pasta das pré-preenchidas (Enter para continuar): ', cfg.prefilledFolders);
  return cfg;
}
