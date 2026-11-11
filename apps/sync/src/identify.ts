/**
 * Identificação de CPF, ano e tipo pelo NOME e pela PASTA do arquivo e, só como apoio, por uma
 * leitura conservadora do início do conteúdo (`sniffHeader`, mais abaixo).
 *
 * Mesma regra de `packages/shared/src/ecac.ts` (`parseIrpfFileName`), copiada aqui para o
 * sincronizador funcionar sozinho, fora do monorepo. A API repete a identificação ao receber.
 *
 * Padrão aceito:
 *   <CPF de 11 dígitos>-IRPF-[letra-]<ano-exercício>[-<ano-calendário>][-ORIGI|-RETIF].<ext>
 *   ex.: 52998224725-IRPF-A-2026-2025-ORIGI.DEC
 * Também vale um nome que COMECE com o CPF (com ou sem pontuação) seguido de separador,
 *   ex.: "529.982.247-25 informe 2026.pdf". O CPF precisa ter dígitos verificadores válidos.
 * Sem ano no nome, usa o cabeçalho do conteúdo (quando reconhecido) e, por fim, a pasta do
 * programa (`.../IRPF2026/...`).
 */
import { basename, extname, resolve, sep } from 'node:path';

export type FileType = 'dec' | 'rec' | 'dbk' | 'xml' | 'pdf' | 'other';

export const onlyDigits = (v: string | null | undefined) => (v ?? '').replace(/\D+/g, '');

export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

export function fileTypeOf(name: string): FileType {
  const ext = extname(name).slice(1).toLowerCase();
  return ext === 'dec' || ext === 'rec' || ext === 'dbk' || ext === 'xml' || ext === 'pdf' ? ext : 'other';
}

export interface NameInfo {
  cpf: string | null;
  exerciseYear: number | null;
  calendarYear: number | null;
  type: FileType;
  rectification: boolean | null;
  pattern: 'irpf' | 'cpf_prefix' | null;
}

const isYear = (n: number) => n >= 2000 && n <= 2100;
const IRPF_NAME =
  /^(\d{11})[-_ ]IRPF(?:[-_ ]([A-Z]))?[-_ ](\d{4})(?:[-_ ](\d{4}))?(?:[-_ ](ORIGI|RETIF)[A-Z]*)?(?:[-_ .][^.]*)?\.[a-z0-9]+$/i;
const CPF_PREFIX = /^(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?=$|[^\d])/;

export function parseFileName(fileName: string): NameInfo {
  const base = fileName.split(/[\\/]/).pop()!.trim();
  const type = fileTypeOf(base);
  const m = IRPF_NAME.exec(base);
  if (m && isValidCpf(m[1])) {
    const exercise = Number(m[3]);
    const calendar = m[4] ? Number(m[4]) : null;
    return {
      cpf: m[1],
      exerciseYear: isYear(exercise) ? exercise : null,
      calendarYear: calendar !== null && isYear(calendar) ? calendar : null,
      type,
      rectification: m[5] ? m[5].toUpperCase() === 'RETIF' : null,
      pattern: 'irpf',
    };
  }
  const p = CPF_PREFIX.exec(base);
  const cpf = p ? onlyDigits(p[1]) : null;
  if (p && cpf && isValidCpf(cpf)) {
    const y = /(?:^|[^\d])(20\d{2})(?=$|[^\d])/.exec(base.slice(p[0].length));
    const year = y ? Number(y[1]) : null;
    return { cpf, exerciseYear: year && isYear(year) ? year : null, calendarYear: null, type, rectification: null, pattern: 'cpf_prefix' };
  }
  return { cpf: null, exerciseYear: null, calendarYear: null, type, rectification: null, pattern: null };
}

/** Ano-exercício pela pasta do programa (`IRPF2026`), do mais próximo ao arquivo para cima. */
export function exerciseYearFromPath(path: string): number | null {
  for (const part of path.split(/[\\/]/).reverse()) {
    const m = /^IRPF[-_ ]?(20\d{2})$/i.exec(part.trim());
    if (m && isYear(Number(m[1]))) return Number(m[1]);
  }
  return null;
}

/** Quantos bytes do início do arquivo são examinados. */
export const HEADER_BYTES = 300;

export interface HeaderInfo {
  exerciseYear: number;
  calendarYear: number;
  /** CPF válido na posição em que se espera o CPF do contribuinte, se houver. */
  cpfAtExpectedPlace: string | null;
  /** Todas as sequências de 11 dígitos da primeira linha com dígitos verificadores válidos. */
  cpfCandidates: string[];
}

const IRPF_HEADER = /^IRPF\s{4}(20\d{2})(20\d{2})/;
/** Depois de `IRPF␣␣␣␣` + exercício (4) + ano-calendário (4) + código (4) + indicador (1). */
const EXPECTED_CPF_AT = 21;

/**
 * Leitura CONSERVADORA do início do conteúdo de um arquivo do programa IRPF.
 *
 * ATENÇÃO: o layout dos arquivos do programa (.DEC, .DBK, .REC) NÃO é publicado oficialmente pela
 * Receita Federal. O que se usa aqui é só o que se observa no começo da primeira linha — a marca
 * `IRPF`, quatro espaços, o ano-exercício e o ano-calendário — e a posição em que o CPF do
 * contribuinte costuma vir em seguida. Por isso a leitura é propositalmente tímida:
 *   - só vale quando a marca aparece E o ano-calendário é o exercício menos 1; qualquer outra
 *     coisa (PDF, XML, arquivo truncado, layout diferente) devolve `null` e nada muda;
 *   - nenhum CPF sai daqui sem dígitos verificadores válidos, e quem decide usá-lo é
 *     `classifyFile`, que só o aceita para CONFIRMAR o CPF do nome ou, quando o nome não tem CPF,
 *     se ele estiver na posição esperada e for o único candidato de toda a primeira linha;
 *   - na dúvida, o arquivo não é vinculado a ninguém: vai para a caixa de entrada do escritório.
 * Nunca é a única fonte quando o nome do arquivo já identifica o cliente.
 */
export function sniffHeader(head: Uint8Array | string | null | undefined): HeaderInfo | null {
  if (!head || !head.length) return null;
  const text = typeof head === 'string' ? head.slice(0, HEADER_BYTES) : Buffer.from(head.buffer, head.byteOffset, Math.min(head.byteLength, HEADER_BYTES)).toString('latin1');
  const line = text.split(/[\r\n]/, 1)[0];
  const m = IRPF_HEADER.exec(line);
  if (!m) return null;
  const exerciseYear = Number(m[1]);
  const calendarYear = Number(m[2]);
  if (!isYear(exerciseYear) || calendarYear !== exerciseYear - 1) return null;
  const candidates = new Set<string>();
  // janelas de 11 dígitos em cada sequência numérica depois dos anos (campos de largura fixa vêm colados)
  for (const run of line.slice(m[0].length).matchAll(/\d{11,}/g)) {
    for (let i = 0; i + 11 <= run[0].length; i++) {
      const cpf = run[0].slice(i, i + 11);
      if (isValidCpf(cpf)) candidates.add(cpf);
    }
  }
  const expected = line.slice(EXPECTED_CPF_AT, EXPECTED_CPF_AT + 11);
  const cpfAtExpectedPlace = /^\d{11}$/.test(expected) && isValidCpf(expected) ? expected : null;
  return { exerciseYear, calendarYear, cpfAtExpectedPlace, cpfCandidates: [...candidates] };
}

export interface Classified extends NameInfo {
  path: string;
  name: string;
  year: number | null;
  /** De onde veio o CPF usado: do nome do arquivo ou do cabeçalho do conteúdo. */
  cpfSource: 'nome' | 'conteúdo' | null;
  /** De onde veio o ano usado. */
  yearSource: 'nome' | 'conteúdo' | 'pasta' | null;
  /** CPF válido lido do cabeçalho na posição esperada (informativo). */
  headerCpf: string | null;
  /** Ano-exercício lido do cabeçalho (informativo; o do nome tem prioridade). */
  headerYear: number | null;
  /** O CPF do nome e o do cabeçalho discordam: o arquivo não é vinculado a nenhum cliente. */
  cpfMismatch: boolean;
  /** `prefilled` quando o arquivo está numa pasta de pré-preenchidas configurada. */
  destination: 'files' | 'prefilled';
  /** Motivo para não enviar ao cliente (CPF ou ano não identificados, ou CPFs divergentes). */
  skipReason: string | null;
}

const inside = (file: string, folder: string) => {
  const f = resolve(file).toLowerCase();
  const d = resolve(folder).toLowerCase();
  return f === d || f.startsWith(d.endsWith(sep) ? d : d + sep);
};

/**
 * Decide para onde e com quais dados o arquivo vai, ou por que não é enviado ao cliente.
 * `header` são os primeiros bytes do conteúdo (opcional): servem de apoio e de conferência, nunca
 * passam por cima do nome do arquivo (veja `sniffHeader`).
 */
export function classifyFile(path: string, opts: { prefilledFolders?: string[]; header?: Uint8Array | string | null } = {}): Classified {
  const name = basename(path);
  const info = parseFileName(name);
  const head = sniffHeader(opts.header);
  let cpf = info.cpf;
  let cpfSource: Classified['cpfSource'] = cpf ? 'nome' : null;
  let cpfMismatch = false;
  if (head) {
    if (info.cpf) {
      // diverge só quando há um CPF válido no lugar esperado e o CPF do nome não aparece em parte alguma da linha
      cpfMismatch = Boolean(head.cpfAtExpectedPlace) && head.cpfAtExpectedPlace !== info.cpf && !head.cpfCandidates.includes(info.cpf);
    } else if (head.cpfCandidates.length === 1 && head.cpfCandidates[0] === head.cpfAtExpectedPlace) {
      // sem CPF no nome: só vale o do lugar esperado, e só se for o único candidato de toda a linha
      // (uma janela qualquer de 11 dígitos tem ~1% de chance de passar nos dígitos verificadores)
      cpf = head.cpfAtExpectedPlace;
      cpfSource = 'conteúdo';
    }
  }
  const folderYear = exerciseYearFromPath(path);
  const year = info.exerciseYear ?? head?.exerciseYear ?? folderYear;
  const yearSource: Classified['yearSource'] = info.exerciseYear ? 'nome' : head ? 'conteúdo' : folderYear ? 'pasta' : null;
  const destination = (opts.prefilledFolders ?? []).some((f) => inside(path, f)) ? 'prefilled' : 'files';
  const skipReason = cpfMismatch
    ? `o CPF do nome (${info.cpf}) é diferente do CPF do conteúdo (${head?.cpfAtExpectedPlace})`
    : !cpf
      ? 'CPF não identificado no nome do arquivo'
      : !year
        ? 'ano não identificado no nome nem na pasta (IRPF<ano>)'
        : null;
  return {
    ...info,
    cpf,
    path,
    name,
    year,
    cpfSource,
    yearSource,
    headerCpf: head?.cpfAtExpectedPlace ?? null,
    headerYear: head?.exerciseYear ?? null,
    cpfMismatch,
    destination,
    skipReason,
  };
}
