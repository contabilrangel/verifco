/**
 * Cálculos do financeiro: valor do orçamento a partir da tabela de cobrança,
 * desconto, divisão em parcelas e vencimentos mensais.
 *
 * Tudo em centavos (inteiros) e datas `AAAA-MM-DD`. As multiplicações usam BigInt
 * para arredondar sem erro de ponto flutuante (meio centavo arredonda para cima).
 */
import { todayIso } from './dates';
import type { PriceTableType } from './enums';

export const PRICING_BASES = {
  refund: 'Restituição',
  tax_due: 'Imposto a pagar',
  assets_total: 'Total de bens e direitos',
  total_income: 'Total de rendimentos',
} as const;
export type PricingBase = keyof typeof PRICING_BASES;

export interface PriceTableItem {
  code: string;
  label: string;
  unitPriceCents: number;
}

/** Configuração por tipo de tabela (só os campos do tipo são usados). */
export interface PriceTableConfigShape {
  /** fixa */
  amountCents?: number;
  /** variável por hora */
  hourRateCents?: number;
  minHours?: number;
  /** variável por itens */
  items?: PriceTableItem[];
  /** percentual */
  percent?: number;
  base?: PricingBase;
  minCents?: number;
  maxCents?: number;
}

export interface PriceTableLike {
  type: PriceTableType | string;
  active?: boolean;
  validFrom: string;
  validUntil?: string | null;
  config: PriceTableConfigShape;
}

/** Dados informados no orçamento: horas trabalhadas ou quantidade de cada item. */
export interface PricingInputs {
  hours?: number;
  items?: Record<string, number>;
}

/** Totais da declaração do exercício usados como base da tabela percentual. */
export interface DeclarationTotalsForPricing {
  refundCents?: number | null;
  taxDueCents?: number | null;
  assetsTotalCents?: number | null;
  totalIncomeCents?: number | null;
}

export interface PricingLine {
  label: string;
  quantity?: number;
  unitCents?: number;
  totalCents: number;
}

export type BudgetAmountResult =
  | {
      ok: true;
      amountCents: number;
      lines: PricingLine[];
      /** Quando o valor calculado foi elevado ao mínimo ou limitado ao máximo da tabela. */
      adjustment: 'min' | 'max' | null;
      /** Valor da base (tabela percentual). */
      baseCents?: number;
    }
  | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Divide com arredondamento "meio para cima" em valores não negativos (e simétrico para negativos). */
function roundDiv(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  const q = (2n * a + b) / (2n * b);
  return neg ? -q : q;
}

/** Multiplica centavos por um fator decimal (até `decimals` casas) e arredonda para centavos. */
export function multiplyCents(cents: number, factor: number, decimals = 4): number {
  const scale = 10 ** decimals;
  const f = BigInt(Math.round(factor * scale));
  return Number(roundDiv(BigInt(Math.round(cents)) * f, BigInt(scale)));
}

/** Percentual de um valor em centavos (ex.: 10% de 12.345 = 1.235). */
export function percentOf(cents: number, percent: number): number {
  return multiplyCents(cents, percent / 100, 6);
}

/** Tabela ativa e dentro da validade na data (`validUntil` inclusivo). */
export function isPriceTableValidOn(table: Pick<PriceTableLike, 'active' | 'validFrom' | 'validUntil'>, date: string): boolean {
  if (table.active === false) return false;
  if (table.validFrom && date < table.validFrom) return false;
  if (table.validUntil && date > table.validUntil) return false;
  return true;
}

const fmtDate = (iso: string) => (ISO_DATE.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);

/**
 * Calcula o valor do orçamento pela tabela de cobrança.
 *
 * - fixa: valor da tabela;
 * - por hora: valor/hora × horas (respeitando o mínimo de horas);
 * - por itens: soma de preço unitário × quantidade de cada item;
 * - percentual: % sobre a base da declaração, limitado ao mínimo e ao máximo.
 *
 * Só aceita tabela ativa e vigente na data (`date`, padrão hoje).
 */
export function computeBudgetAmount(
  table: PriceTableLike,
  inputs: PricingInputs | null | undefined,
  declarationTotals: DeclarationTotalsForPricing | null | undefined,
  date: string = todayIso(),
): BudgetAmountResult {
  if (table.active === false) return { ok: false, error: 'A tabela de cobrança está inativa.' };
  if (!isPriceTableValidOn(table, date)) {
    return {
      ok: false,
      error: table.validUntil && date > table.validUntil
        ? `A tabela de cobrança venceu em ${fmtDate(table.validUntil)}.`
        : `A tabela de cobrança só vale a partir de ${fmtDate(table.validFrom)}.`,
    };
  }
  const c = table.config ?? {};
  const inp = inputs ?? {};
  switch (table.type) {
    case 'fixed': {
      if (c.amountCents === undefined || c.amountCents === null || c.amountCents < 0) return { ok: false, error: 'A tabela fixa não tem valor configurado.' };
      const amount = Math.round(c.amountCents);
      return { ok: true, amountCents: amount, lines: [{ label: 'Valor fixo', totalCents: amount }], adjustment: null };
    }
    case 'hourly': {
      if (!c.hourRateCents || c.hourRateCents <= 0) return { ok: false, error: 'A tabela por hora não tem valor/hora configurado.' };
      const informed = Number(inp.hours ?? 0);
      if (!Number.isFinite(informed) || informed < 0) return { ok: false, error: 'Informe uma quantidade de horas válida.' };
      const min = Math.max(0, c.minHours ?? 0);
      if (informed <= 0 && min <= 0) return { ok: false, error: 'Informe a quantidade de horas.' };
      const hours = Math.max(informed, min);
      const amount = multiplyCents(c.hourRateCents, hours, 2);
      return {
        ok: true,
        amountCents: amount,
        lines: [{ label: hours > informed ? `Horas (mínimo de ${min}h)` : 'Horas', quantity: hours, unitCents: c.hourRateCents, totalCents: amount }],
        adjustment: hours > informed ? 'min' : null,
      };
    }
    case 'items': {
      const items = c.items ?? [];
      if (!items.length) return { ok: false, error: 'A tabela por itens não tem itens cadastrados.' };
      const qty = inp.items ?? {};
      for (const [code, q] of Object.entries(qty)) {
        if (!Number.isFinite(q) || q < 0) return { ok: false, error: `Quantidade inválida para o item ${code}.` };
      }
      const lines: PricingLine[] = items
        .filter((it) => (qty[it.code] ?? 0) > 0)
        .map((it) => {
          const q = qty[it.code] ?? 0;
          return { label: it.label || it.code, quantity: q, unitCents: it.unitPriceCents, totalCents: multiplyCents(it.unitPriceCents, q, 2) };
        });
      if (!lines.length) return { ok: false, error: 'Informe a quantidade de ao menos um item.' };
      return { ok: true, amountCents: lines.reduce((a, l) => a + l.totalCents, 0), lines, adjustment: null };
    }
    case 'percentage': {
      if (!c.percent || c.percent <= 0) return { ok: false, error: 'A tabela percentual não tem percentual configurado.' };
      if (!c.base || !(c.base in PRICING_BASES)) return { ok: false, error: 'A tabela percentual não tem base configurada.' };
      const t = declarationTotals ?? {};
      const raw =
        c.base === 'refund' ? t.refundCents : c.base === 'tax_due' ? t.taxDueCents : c.base === 'assets_total' ? t.assetsTotalCents : t.totalIncomeCents;
      const baseCents = Math.max(0, Math.round(raw ?? 0));
      const computed = percentOf(baseCents, c.percent);
      let amount = computed;
      let adjustment: 'min' | 'max' | null = null;
      if (c.minCents !== undefined && c.minCents !== null && amount < c.minCents) {
        amount = c.minCents;
        adjustment = 'min';
      }
      if (c.maxCents !== undefined && c.maxCents !== null && c.maxCents > 0 && amount > c.maxCents) {
        amount = c.maxCents;
        adjustment = 'max';
      }
      const lines: PricingLine[] = [{ label: `${c.percent}% sobre ${PRICING_BASES[c.base].toLowerCase()}`, unitCents: baseCents, totalCents: computed }];
      if (adjustment === 'min') lines.push({ label: 'Ajuste ao valor mínimo da tabela', totalCents: amount - computed });
      if (adjustment === 'max') lines.push({ label: 'Ajuste ao valor máximo da tabela', totalCents: amount - computed });
      return { ok: true, amountCents: amount, lines, adjustment, baseCents };
    }
    default:
      return { ok: false, error: 'Tipo de tabela de cobrança desconhecido.' };
  }
}

/** Aplica o desconto percentual (0 a 100) e devolve o total em centavos. */
export function applyDiscount(amountCents: number, discountPercent: number | null | undefined): number {
  const pct = Math.min(100, Math.max(0, Number(discountPercent ?? 0)));
  return amountCents - percentOf(amountCents, pct);
}

/** Divide o total em `n` parcelas; os centavos que sobram vão para as primeiras. */
export function splitInstallments(totalCents: number, n: number): number[] {
  const count = Math.max(1, Math.floor(n));
  const base = Math.floor(totalCents / count);
  const rest = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < rest ? 1 : 0));
}

/** Soma `months` meses a uma data, mantendo o dia (ou o último dia do mês, se não existir). */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Vencimentos mensais a partir da data inicial da cobrança. */
export function installmentDueDates(startDate: string, n: number): string[] {
  return Array.from({ length: Math.max(1, Math.floor(n)) }, (_, i) => addMonthsIso(startDate, i));
}

/** Plano de parcelas (número, vencimento e valor). */
export function buildInstallmentPlan(totalCents: number, n: number, startDate: string) {
  const amounts = splitInstallments(totalCents, n);
  const dates = installmentDueDates(startDate, amounts.length);
  return amounts.map((amountCents, i) => ({ number: i + 1, dueDate: dates[i], amountCents }));
}

/** Situação da parcela na leitura: em aberto com vencimento passado conta como vencida. */
export function effectiveInstallmentStatus(status: string, dueDate: string, today: string = todayIso()): string {
  if (status === 'open' && dueDate < today) return 'overdue';
  return status;
}
