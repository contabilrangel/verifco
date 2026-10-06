/**
 * Datas no fuso de Brasília: a única fonte de "hoje" do sistema (API, web e robô).
 *
 * Prazos (vencimento de DARF, pendências, procurações, contratos) seguem o horário de Brasília.
 * `new Date().toISOString().slice(0, 10)` dá a data em UTC: das 21h à meia-noite o dia já virou e
 * o que vence hoje aparece como vencido. Use sempre `todayIso()` / `isoDateInBrazil()` e
 * `addDaysIso()` para "daqui a N dias".
 */

export const BRAZIL_TIME_ZONE = 'America/Sao_Paulo';

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const dayFormatter = (timeZone: string) => {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timeZone, f);
  }
  return f;
};

/** Data (AAAA-MM-DD) de um instante no fuso informado; por padrão, horário de Brasília. */
export function isoDateInBrazil(instant: Date | string | number, timeZone = BRAZIL_TIME_ZONE): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = dayFormatter(timeZone).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Data de hoje (AAAA-MM-DD) no horário de Brasília (ou no fuso informado). */
export function todayIso(now: Date = new Date(), timeZone = BRAZIL_TIME_ZONE): string {
  return isoDateInBrazil(now, timeZone);
}

/** O mesmo que `todayIso()`: data de hoje no fuso de Brasília, usada para vencimentos. */
export const brazilToday = (now: Date = new Date()): string => todayIso(now);

/** Ano corrente no horário de Brasília. */
export const currentYearInBrazil = (now: Date = new Date()): number => Number(todayIso(now).slice(0, 4));

/** Mês corrente (1 a 12) no horário de Brasília. */
export const currentMonthInBrazil = (now: Date = new Date()): number => Number(todayIso(now).slice(5, 7));

/** Soma dias a uma data AAAA-MM-DD (sem hora, sem fuso): `addDaysIso('2026-01-31', 1)` → `'2026-02-01'`. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** "06/10/2026 14:03" no horário de Brasília (rodapés de PDF, "gerado em"). */
export function formatDateTimeBr(instant: Date | string | number = new Date()): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  return d.toLocaleString('pt-BR', { timeZone: BRAZIL_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
