import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDaysIso,
  brazilToday,
  copilotLimit,
  currentExerciseYear,
  daysBetweenIso,
  formatDate,
  formatDateTimeBr,
  sampleTemplateValues,
  todayIso,
  utcDateIso,
} from '../src';

/** 22h de 06/10/2026 em Brasília: em UTC já é 01h de 07/10. */
const LATE_EVENING = new Date('2026-10-07T01:00:00Z');

describe('hoje em Brasília (CON-7, DAD-13)', () => {
  afterEach(() => vi.useRealTimers());

  it('às 22h de Brasília devolve o dia de Brasília, não o de UTC', () => {
    expect(utcDateIso(LATE_EVENING)).toBe('2026-10-07');
    expect(todayIso(LATE_EVENING)).toBe('2026-10-06');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATE_EVENING);
    expect(todayIso()).toBe('2026-10-06');
    expect(brazilToday()).toBe('2026-10-06');
    expect(todayIso(new Date(), 'UTC')).toBe('2026-10-07');
  });

  it('brazilToday é o mesmo todayIso', () => {
    expect(brazilToday).toBe(todayIso);
  });

  it('ano-exercício corrente vira com o ano de Brasília', () => {
    expect(currentExerciseYear(new Date('2027-01-01T02:00:00Z'))).toBe(2026);
    expect(currentExerciseYear(new Date('2027-01-01T03:00:00Z'))).toBe(2027);
  });

  it('soma dias corridos a uma data, virando mês e ano', () => {
    expect(addDaysIso('2026-10-06', 30)).toBe('2026-11-05');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDaysIso('2026-10-06', 0)).toBe('2026-10-06');
  });

  it('conta dias corridos entre duas datas, virando mês e em ano bissexto', () => {
    expect(daysBetweenIso('2026-10-06', '2026-11-05')).toBe(30);
    expect(daysBetweenIso('2026-10-06', '2026-10-06')).toBe(0);
    expect(daysBetweenIso('2026-10-06', '2026-10-05')).toBe(-1);
    expect(daysBetweenIso('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('formata datas e horas no horário de Brasília', () => {
    expect(formatDateTimeBr(LATE_EVENING)).toBe('06/10/2026, 22:00');
    expect(formatDateTimeBr('2026-10-07T01:00:00.000Z')).toBe('06/10/2026, 22:00');
    expect(formatDate(LATE_EVENING)).toBe('06/10/2026');
    expect(formatDate('2026-10-07T01:00:00.000Z')).toBe('06/10/2026');
    // data sem hora não passa por fuso
    expect(formatDate('2026-10-06')).toBe('06/10/2026');
    expect(formatDate(null)).toBe('');
  });

  it('contrato do Copiloto que vence hoje ainda vale às 22h', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATE_EVENING);
    expect(copilotLimit([{ plan: 'pro', status: 'active', startsAt: '2026-01-01', expiresAt: '2026-10-06' }])).toBe(25);
    expect(sampleTemplateValues(2026).DATA).toBe('06/10/2026');
  });
});

// ------------------------------------------------------------------------------------------
// Regra simples de "lint": o código não volta a calcular "hoje" em UTC.
// A shared não tem os tipos do Node: os módulos entram por import dinâmico com o especificador numa
// variável (como em web/src/styles.test.ts), com tipos mínimos.
const load = async <T>(specifier: string): Promise<T> => (await import(/* @vite-ignore */ specifier)) as T;
const fs = await load<{
  readdirSync: (path: string, opts: { withFileTypes: true }) => { name: string; isDirectory: () => boolean }[];
  readFileSync: (path: string, encoding: 'utf8') => string;
}>('node:fs');
const { dirname, join } = await load<{ dirname: (p: string) => string; join: (...p: string[]) => string }>('node:path');
const { fileURLToPath } = await load<{ fileURLToPath: (url: string) => string }>('node:url');

/** Raiz do monorepo (este arquivo está em packages/shared/test). */
const ROOT = join(dirname(fileURLToPath((import.meta as unknown as { url: string }).url)), '..', '..', '..');
const DIRS = ['apps/api/src/', 'apps/api/test/', 'apps/web/src/', 'apps/sync/src/', 'packages/shared/src/', 'packages/shared/test/'];
/** Onde o padrão é legítimo: a própria biblioteca de datas e este teste. */
const ALLOWED = new Set(['packages/shared/src/dates.ts', 'packages/shared/test/dates.test.ts']);
const FORBIDDEN: { re: RegExp; hint: string }[] = [
  { re: /\.toISOString\(\)\s*\.\s*(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)/, hint: 'use todayIso() (ou todayIso(instante)); para célula de data do Excel, utcDateIso()' },
  { re: /\.toISOString\(\)\s*\.split\(\s*['"]T['"]\s*\)/, hint: 'use todayIso() (ou todayIso(instante))' },
  { re: /new Date\(\)\.toLocale(?:Date)?String\(\s*['"]pt-BR['"]\s*\)/, hint: 'use formatDate(todayIso()) ou formatDateTimeBr() (com o fuso de Brasília)' },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(`${path}/`));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('datas: padrão proibido no código', () => {
  it('ninguém calcula "hoje" em UTC nem formata "agora" sem o fuso de Brasília', () => {
    const files = DIRS.flatMap(sourceFiles).filter((f) => !ALLOWED.has(f));
    expect(files.length).toBeGreaterThan(100);
    const problems: string[] = [];
    for (const file of files) {
      fs.readFileSync(join(ROOT, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const rule of FORBIDDEN) if (rule.re.test(line)) problems.push(`${file}:${i + 1}: ${rule.hint}`);
        });
    }
    expect(problems).toEqual([]);
  });
});
