/**
 * Datas do Verifco. "Hoje" é sempre o dia no horário de Brasília: entre 21h e 24h o dia em UTC
 * já virou, e um vencimento de hoje apareceria vencido. Datas sem hora trafegam em AAAA-MM-DD.
 *
 * Não use `new Date().toISOString().slice(0, 10)` como "hoje" nem some dias em milissegundos
 * para chegar a uma data: use `todayIso()` e `addDaysIso()` (packages/shared/test/dates.test.ts
 * recusa o padrão no código).
 */

/** Fuso de referência dos prazos (Receita Federal, vencimentos, relatórios). */
export const BRAZIL_TIME_ZONE = 'America/Sao_Paulo';

/**
 * Data (AAAA-MM-DD) do instante `now` no fuso informado; por padrão, o dia de hoje em Brasília.
 * Com um instante gravado (ex.: `createdAt`), dá o dia em que ele aconteceu em Brasília.
 */
export function todayIso(now: Date = new Date(), timeZone: string = BRAZIL_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Soma (ou subtrai) dias corridos a uma data AAAA-MM-DD, sem passar por fuso horário. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Dias corridos de `from` até `to` (AAAA-MM-DD), sem passar por fuso horário; negativo se `to` vem antes. */
export function daysBetweenIso(from: string, to: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/**
 * Data AAAA-MM-DD de um instante em UTC. Só para datas que já vêm sem fuso, como as células de
 * data do Excel (meia-noite UTC); para "hoje" ou para a data de um registro, use `todayIso`.
 */
export function utcDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Data e hora (dd/mm/aaaa, hh:mm) no horário de Brasília, para textos gerados no servidor. */
export function formatDateTimeBr(value: Date | string | number = new Date()): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleString('pt-BR', { timeZone: BRAZIL_TIME_ZONE, dateStyle: 'short', timeStyle: 'short' });
}
