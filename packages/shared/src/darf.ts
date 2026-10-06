/**
 * Quotas do imposto apurado na declaração (DARF do IRPF).
 *
 * Regras (P&R IRPF 2026, perguntas 063 e 064:
 * https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/perguntas-e-respostas/dirpf/p-r-irpf-2026-v1-00-2026-04-23.pdf):
 * - Saldo abaixo de R$ 10,00 não é pago: soma-se ao imposto do exercício seguinte (não gera DARF).
 * - Até 8 quotas mensais e sucessivas.
 * - Nenhuma quota pode ser menor que R$ 50,00; imposto abaixo de R$ 100,00 só em quota única.
 *   Se o número pedido não respeitar o mínimo, ele é reduzido (e o resultado avisa).
 * - O principal é dividido igualmente; os centavos que sobram da divisão vão para a 1ª quota.
 * - A 1ª quota (ou a quota única) vence na data informada, normalmente o último dia do prazo
 *   de entrega. As demais vencem no último dia útil (com expediente bancário) de cada mês seguinte.
 * - Dia útil: segunda a sexta, exceto feriados nacionais fixos, a Sexta-feira Santa e 31/12
 *   (sem expediente bancário: a 8ª quota de 2026 vence em 30/12/2026). Feriados
 *   estaduais/municipais e pontos facultativos não entram: confira e edite o vencimento.
 * - Juros: da 2ª quota em diante, o valor é o principal + Selic acumulada desde o mês seguinte
 *   ao do vencimento da 1ª até o mês anterior ao do pagamento + 1% no mês do pagamento (a 2ª
 *   quota tem só +1%). As quotas geradas guardam o PRINCIPAL; `darfQuotaAmount` calcula o valor
 *   a pagar quando a Selic dos meses envolvidos já foi publicada (SELIC_MONTHLY_PERCENT) e, sem
 *   ela, devolve o principal com o aviso dos juros. Vale sempre o valor da guia da Receita.
 */
export const DARF_MAX_QUOTAS = 8;
export const DARF_MIN_QUOTA_CENTS = 5_000;
export const DARF_SINGLE_QUOTA_BELOW_CENTS = 10_000;
/** Saldo abaixo deste valor não gera DARF (vai para o imposto do exercício seguinte). */
export const DARF_MIN_PAYABLE_CENTS = 1_000;
export const DARF_BELOW_MINIMUM_MESSAGE = 'Saldo de imposto abaixo de R$ 10,00 não gera DARF: some-o ao imposto do próximo exercício.';

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

/**
 * Dias sem expediente bancário para o público que não são feriado nacional: 31/12. A Receita
 * fixa a 8ª quota no último dia com expediente bancário (30/12/2026 e 30/12/2025, P&R IRPF,
 * pergunta 064), por isso 31/12 não conta como dia útil para vencimentos.
 */
export const BANK_CLOSED_DAYS = ['12-31'] as const;

/** Dia útil com expediente bancário: segunda a sexta, sem feriado nacional nem 31/12. */
export function isBusinessDay(date: string): boolean {
  const dow = toUtc(date).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if ((BANK_CLOSED_DAYS as readonly string[]).includes(date.slice(5, 10))) return false;
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
  if (totalCents < DARF_MIN_PAYABLE_CENTS) return { quotas: [], count: 0, warning: DARF_BELOW_MINIMUM_MESSAGE };
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

// ---------------------------------------------------------------------------
// Juros das quotas (Selic acumulada + 1%)
// ---------------------------------------------------------------------------

/**
 * Taxa Selic mensal (% ao mês), a "Selic acumulada no mês" da série 4390 do Banco Central, a
 * mesma que a Receita soma nos juros das quotas e dos débitos em atraso. Fonte:
 * https://api.bcb.gov.br/dados/serie/bcdata.sgs.4390/dados?formato=json (conferida em 06/10/2026;
 * janeiro a maio de 2026 conferidos também na tabela de acréscimos legais da Receita).
 * Acrescente cada mês fechado; sem a taxa do mês, o valor da quota fica só com o principal.
 */
export const SELIC_MONTHLY_PERCENT: Readonly<Record<string, number>> = {
  '2024-01': 0.97, '2024-02': 0.8, '2024-03': 0.83, '2024-04': 0.89, '2024-05': 0.83, '2024-06': 0.79,
  '2024-07': 0.91, '2024-08': 0.87, '2024-09': 0.84, '2024-10': 0.93, '2024-11': 0.79, '2024-12': 0.93,
  '2025-01': 1.01, '2025-02': 0.99, '2025-03': 0.96, '2025-04': 1.06, '2025-05': 1.14, '2025-06': 1.1,
  '2025-07': 1.28, '2025-08': 1.16, '2025-09': 1.22, '2025-10': 1.28, '2025-11': 1.05, '2025-12': 1.22,
  '2026-01': 1.16, '2026-02': 1.0, '2026-03': 1.21, '2026-04': 1.09, '2026-05': 1.07, '2026-06': 1.12,
  '2026-07': 1.22, '2026-08': 1.09, '2026-09': 1.08,
};

export interface DarfQuotaAmount {
  quotaNumber: number;
  principalCents: number;
  /** Meses (AAAA-MM) cuja Selic entra nos juros da quota. */
  selicMonths: string[];
  /** Meses sem taxa publicada em SELIC_MONTHLY_PERCENT. */
  missingSelicMonths: string[];
  /** Juros em %: Selic acumulada + 1% (0 na 1ª quota). null quando falta a Selic de algum mês. */
  interestPercent: number | null;
  interestCents: number | null;
  /** Valor a pagar até o vencimento (principal + juros). null quando falta a Selic. */
  totalCents: number | null;
  /** Explicação curta para o cliente; null na 1ª quota. */
  note: string | null;
}

const monthKey = (y: number, m: number) => `${y}-${pad(m)}`;

/**
 * Valor a pagar de uma quota até o vencimento (P&R IRPF, pergunta 064): da 2ª em diante,
 * principal + Selic de cada mês entre o vencimento da 1ª quota e o da quota (exclusive) + 1%.
 * O mês de referência é o do vencimento da 1ª quota: `dueDate` menos (quota − 1) meses.
 */
export function darfQuotaAmount(input: { quotaNumber: number; principalCents: number; dueDate: string; selic?: Readonly<Record<string, number>> }): DarfQuotaAmount {
  const { quotaNumber, principalCents, dueDate } = input;
  const base = { quotaNumber, principalCents };
  if (quotaNumber <= 1) return { ...base, selicMonths: [], missingSelicMonths: [], interestPercent: 0, interestCents: 0, totalCents: principalCents, note: null };
  const selic = input.selic ?? SELIC_MONTHLY_PERCENT;
  const [y, m] = dueDate.split('-').map(Number);
  const months: string[] = [];
  // meses do vencimento da 1ª + 1 até o mês anterior ao da quota: quota − 2 meses
  for (let k = quotaNumber - 2; k >= 1; k--) {
    const idx = y * 12 + (m - 1) - k;
    months.push(monthKey(Math.floor(idx / 12), (idx % 12) + 1));
  }
  const missing = months.filter((mk) => selic[mk] === undefined);
  if (missing.length) {
    return {
      ...base,
      selicMonths: months,
      missingSelicMonths: missing,
      interestPercent: null,
      interestCents: null,
      totalCents: null,
      note: `Valor principal. A guia soma juros: Selic acumulada de ${listPt(months.map(monthLabel))} + 1%; ${missing.length > 1 ? `as taxas de ${listPt(missing.map(monthLabel))} ainda não foram publicadas` : `a taxa de ${monthLabel(missing[0])} ainda não foi publicada`}. Vale o valor da guia.`,
    };
  }
  const percent = Math.round((months.reduce((a, mk) => a + selic[mk], 0) + 1) * 100) / 100;
  const interest = Math.round((principalCents * percent) / 100);
  return {
    ...base,
    selicMonths: months,
    missingSelicMonths: [],
    interestPercent: percent,
    interestCents: interest,
    totalCents: principalCents + interest,
    note: months.length
      ? `Principal + juros de ${formatPercent(percent)} (Selic acumulada de ${listPt(months.map(monthLabel))} + 1%), se paga até o vencimento.`
      : `Principal + juros de 1,00%, se paga até o vencimento.`,
  };
}

/** Quota gerada pelo Verifco (guarda o principal; da 2ª em diante a guia soma juros). */
export const isDarfPrincipalOnly = (d: { source?: string | null; quotaNumber: number }) => d.source === 'generated' && d.quotaNumber >= 2;

export interface DarfPayable {
  principalCents: number;
  interestPercent: number | null;
  /** Valor a pagar até o vencimento; null quando a Selic do período ainda não foi publicada. */
  totalCents: number | null;
  note: string | null;
}

/**
 * Valor a pagar de uma quota cadastrada. Quotas editadas, manuais ou vindas do eCAC já têm o
 * valor da guia (devolve null); as geradas a partir da 2ª têm só o principal.
 */
export function darfPayable(d: { source?: string | null; quotaNumber: number; valueCents: number; dueDate: string }): DarfPayable | null {
  if (!isDarfPrincipalOnly(d)) return null;
  const a = darfQuotaAmount({ quotaNumber: d.quotaNumber, principalCents: d.valueCents, dueDate: d.dueDate });
  return { principalCents: a.principalCents, interestPercent: a.interestPercent, totalCents: a.totalCents, note: a.note };
}

/** Valor da quota em texto para o cliente (e-mail, WhatsApp, PDF), explícito sobre os juros. */
export function darfValueText(d: { source?: string | null; quotaNumber: number; valueCents: number; dueDate: string }): string {
  const a = darfPayable(d);
  if (!a) return money(d.valueCents);
  if (a.totalCents !== null && a.interestPercent !== null) {
    return `${money(a.totalCents)} (principal de ${money(a.principalCents)} + juros de ${formatPercent(a.interestPercent)}: Selic acumulada + 1%)`;
  }
  return `${money(a.principalCents)} mais juros (Selic acumulada + 1%; o valor total está na guia)`;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (cents: number) => brl.format(cents / 100);

const listPt = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (mk: string) => `${MONTHS[Number(mk.slice(5, 7)) - 1]}/${mk.slice(0, 4)}`;
const formatPercent = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

export type DarfComputedStatus = 'open' | 'paid' | 'overdue';

/** Situação da quota: paga, vencida (vencimento anterior a hoje) ou em aberto. */
export function darfStatus(darf: { status?: string | null; paidAt?: string | null; dueDate: string }, today: string): DarfComputedStatus {
  if (darf.status === 'paid' || darf.paidAt) return 'paid';
  return darf.dueDate < today ? 'overdue' : 'open';
}

// "hoje" no fuso de Brasília: `brazilToday`/`todayIso` ficam em `dates.ts` (fonte única).
