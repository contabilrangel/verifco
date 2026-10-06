/**
 * Quotas do imposto apurado na declaração (DARF do IRPF).
 *
 * Regras aplicadas pelo Verifco ao gerar as quotas:
 * - Até 8 quotas mensais e sucessivas.
 * - Nenhuma quota pode ser menor que R$ 50,00; imposto abaixo de R$ 100,00 só em quota única.
 *   Se o número pedido não respeitar o mínimo, ele é reduzido (e o resultado avisa).
 * - O principal é dividido igualmente; os centavos que sobram da divisão vão para a 1ª quota.
 * - A 1ª quota (ou a quota única) vence na data informada, normalmente o último dia do prazo
 *   de entrega. As demais vencem no último dia útil de cada mês seguinte.
 * - Dia útil: segunda a sexta, exceto feriados nacionais fixos e a Sexta-feira Santa.
 *   Feriados estaduais/municipais e pontos facultativos não entram: confira e edite o
 *   vencimento quando necessário.
 * - Os juros (Selic) das quotas 2 em diante NÃO são calculados aqui. Vale o valor da guia
 *   emitida pelo programa da Receita: o valor e o vencimento de cada quota são editáveis.
 */
export const DARF_MAX_QUOTAS = 8;
export const DARF_MIN_QUOTA_CENTS = 5_000;
export const DARF_SINGLE_QUOTA_BELOW_CENTS = 10_000;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

const toUtc = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUtc = (dt: Date) => ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
const addDays = (date: string, days: number) => {
  const dt = toUtc(date);
  dt.setUTCDate(dt.getUTCDate() + days);
  return fromUtc(dt);
};

/** Feriados nacionais (fixos + Sexta-feira Santa) do ano, no formato AAAA-MM-DD. */
export function nationalHolidays(year: number): Set<string> {
  const fixed = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];
  // Dia Nacional de Zumbi e da Consciência Negra é feriado nacional desde 2024 (Lei 14.759/2023).
  if (year >= 2024) fixed.push('11-20');
  const set = new Set(fixed.map((md) => `${year}-${md}`));
  set.add(addDays(easterSunday(year), -2));
  return set;
}

export function isBusinessDay(date: string): boolean {
  const dow = toUtc(date).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !nationalHolidays(Number(date.slice(0, 4))).has(date);
}

/** Último dia útil do mês (mês de 1 a 12). */
export function lastBusinessDayOfMonth(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let date = ymd(year, month, last);
  while (!isBusinessDay(date)) date = addDays(date, -1);
  return date;
}

export interface DarfQuotaPlanItem {
  quotaNumber: number;
  valueCents: number;
  dueDate: string;
}

export interface DarfQuotaPlan {
  quotas: DarfQuotaPlanItem[];
  /** Número de quotas efetivamente usado (pode ser menor que o pedido). */
  count: number;
  /** Explica por que o número de quotas foi reduzido, quando for o caso. */
  warning: string | null;
}

/** Maior número de quotas permitido para o valor (respeita o mínimo por quota). */
export function maxDarfQuotas(totalCents: number): number {
  if (totalCents < DARF_SINGLE_QUOTA_BELOW_CENTS) return 1;
  return Math.max(1, Math.min(DARF_MAX_QUOTAS, Math.floor(totalCents / DARF_MIN_QUOTA_CENTS)));
}

/** Monta as quotas do imposto a pagar conforme as regras descritas no topo do arquivo. */
export function planDarfQuotas(totalCents: number, requestedQuotas: number, firstDueDate: string): DarfQuotaPlan {
  if (!Number.isInteger(totalCents) || totalCents <= 0) return { quotas: [], count: 0, warning: 'Informe um imposto a pagar maior que zero.' };
  const requested = Math.max(1, Math.min(DARF_MAX_QUOTAS, Math.floor(requestedQuotas) || 1));
  const max = maxDarfQuotas(totalCents);
  const count = Math.min(requested, max);
  let warning: string | null = null;
  if (count < requested) {
    warning =
      totalCents < DARF_SINGLE_QUOTA_BELOW_CENTS
        ? 'Imposto abaixo de R$ 100,00 é pago em quota única.'
        : `Com quotas de no mínimo R$ 50,00, o valor permite até ${max} quota(s).`;
  }
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  const [y, m] = firstDueDate.split('-').map(Number);
  const quotas: DarfQuotaPlanItem[] = [];
  for (let k = 1; k <= count; k++) {
    const monthIndex = m - 1 + (k - 1);
    const dueDate = k === 1 ? firstDueDate : lastBusinessDayOfMonth(y + Math.floor(monthIndex / 12), (monthIndex % 12) + 1);
    quotas.push({ quotaNumber: k, valueCents: base + (k === 1 ? remainder : 0), dueDate });
  }
  return { quotas, count, warning };
}

export type DarfComputedStatus = 'open' | 'paid' | 'overdue';

/** Situação da quota: paga, vencida (vencimento anterior a hoje) ou em aberto. */
export function darfStatus(darf: { status?: string | null; paidAt?: string | null; dueDate: string }, today: string): DarfComputedStatus {
  if (darf.status === 'paid' || darf.paidAt) return 'paid';
  return darf.dueDate < today ? 'overdue' : 'open';
}

/** Data de hoje no fuso de Brasília (AAAA-MM-DD), usada para vencimentos. */
export function brazilToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
