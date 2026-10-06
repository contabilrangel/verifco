/**
 * Identificação de CPF, ano e tipo pelo NOME e pela PASTA do arquivo — sem abrir o conteúdo,
 * porque o layout dos arquivos do programa IRPF não é público.
 *
 * Mesma regra de `packages/shared/src/ecac.ts` (`parseIrpfFileName`), copiada aqui para o
 * sincronizador funcionar sozinho, fora do monorepo. A API repete a identificação ao receber.
 *
 * Padrão aceito:
 *   <CPF de 11 dígitos>-IRPF-[letra-]<ano-exercício>[-<ano-calendário>][-ORIGI|-RETIF].<ext>
 *   ex.: 52998224725-IRPF-A-2026-2025-ORIGI.DEC
 * Também vale um nome que COMECE com o CPF (com ou sem pontuação) seguido de separador,
 *   ex.: "529.982.247-25 informe 2026.pdf". O CPF precisa ter dígitos verificadores válidos.
 * Sem ano no nome, usa a pasta do programa (`.../IRPF2026/...`).
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

export interface Classified extends NameInfo {
  path: string;
  name: string;
  year: number | null;
  /** `prefilled` quando o arquivo está numa pasta de pré-preenchidas configurada. */
  destination: 'files' | 'prefilled';
  /** Motivo para não enviar (CPF ou ano não identificados). */
  skipReason: string | null;
}

const inside = (file: string, folder: string) => {
  const f = resolve(file).toLowerCase();
  const d = resolve(folder).toLowerCase();
  return f === d || f.startsWith(d.endsWith(sep) ? d : d + sep);
};

/** Decide para onde e com quais dados o arquivo vai, ou por que é ignorado. */
export function classifyFile(path: string, opts: { prefilledFolders?: string[] } = {}): Classified {
  const name = basename(path);
  const info = parseFileName(name);
  const year = info.exerciseYear ?? exerciseYearFromPath(path);
  const destination = (opts.prefilledFolders ?? []).some((f) => inside(path, f)) ? 'prefilled' : 'files';
  const skipReason = !info.cpf
    ? 'CPF não identificado no nome do arquivo'
    : !year
      ? 'ano não identificado no nome nem na pasta (IRPF<ano>)'
      : null;
  return { ...info, path, name, year, destination, skipReason };
}
