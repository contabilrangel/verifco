/**
 * Copiloto financeiro: lançamentos mensais do cliente (receitas, despesas, orçamento,
 * vencimentos, seguros e bens no exterior), visão geral e projeção do IRPFM do ano.
 */
import { annualIrpfDue } from './tax/irpf-annual';
import { computeIrpfm, irpfmParams, type IrpfmIncomeLine, type IrpfmResult } from './tax/irpfm';

export const COPILOT_ENTRY_KINDS = {
  income: 'Receita',
  expense: 'Despesa',
  budget: 'Orçamento',
  bill: 'Vencimento',
  insurance: 'Seguro',
  foreign: 'Exterior',
} as const;
export type CopilotEntryKind = keyof typeof COPILOT_ENTRY_KINDS;

export const COPILOT_INCOME_CATEGORIES = {
  salary: 'Salário / pró-labore',
  self_employed: 'Trabalho autônomo',
  dividends: 'Lucros e dividendos',
  rent: 'Aluguéis',
  financial_taxed: 'Aplicações tributadas',
  financial_exempt: 'Aplicações isentas (poupança, LCI, LCA...)',
  retirement: 'Aposentadoria / pensão',
  other: 'Outras receitas',
} as const;
export type CopilotIncomeCategory = keyof typeof COPILOT_INCOME_CATEGORIES;

export const COPILOT_EXPENSE_CATEGORIES = {
  housing: 'Moradia',
  food: 'Alimentação',
  transport: 'Transporte',
  health: 'Saúde',
  education: 'Educação',
  leisure: 'Lazer',
  insurance: 'Seguros',
  taxes: 'Impostos',
  investments: 'Investimentos',
  other: 'Outras despesas',
} as const;
export type CopilotExpenseCategory = keyof typeof COPILOT_EXPENSE_CATEGORIES;

/** Clientes habilitados por plano de contrato do escritório (decisão comercial do Verifco). */
export const COPILOT_PLAN_LIMITS: Record<string, number> = { basic: 5, pro: 25, premium: 100, enterprise: 500 };
/** Limite sem contrato ativo (degustação). */
export const COPILOT_DEFAULT_LIMIT = 5;

/** Maior limite entre os contratos ativos e vigentes; sem contrato, o limite padrão. */
export function copilotLimit(contracts: { plan: string; status: string; startsAt: string; expiresAt: string }[], today = new Date().toISOString().slice(0, 10)): number {
  const active = contracts.filter((c) => c.status === 'active' && c.startsAt <= today && c.expiresAt >= today);
  if (!active.length) return COPILOT_DEFAULT_LIMIT;
  return Math.max(...active.map((c) => COPILOT_PLAN_LIMITS[c.plan] ?? COPILOT_DEFAULT_LIMIT));
}

export interface CopilotEntryLike {
  kind: string;
  year: number;
  month: number | null;
  category: string | null;
  amountCents: number;
  description?: string;
  dueDate?: string | null;
  data?: Record<string, unknown>;
}

export interface CopilotMonth {
  month: number;
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
  /** (receitas − despesas) ÷ receitas, em %; null sem receitas. */
  savingsRatePercent: number | null;
}

export function copilotOverview(entries: CopilotEntryLike[]) {
  const months: CopilotMonth[] = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, incomeCents: 0, expenseCents: 0, balanceCents: 0, savingsRatePercent: null }));
  for (const e of entries) {
    if (!e.month || e.month < 1 || e.month > 12) continue;
    const m = months[e.month - 1];
    if (e.kind === 'income') m.incomeCents += e.amountCents;
    if (e.kind === 'expense') m.expenseCents += e.amountCents;
  }
  for (const m of months) {
    m.balanceCents = m.incomeCents - m.expenseCents;
    m.savingsRatePercent = m.incomeCents > 0 ? (m.balanceCents / m.incomeCents) * 100 : null;
  }
  const income = months.reduce((a, m) => a + m.incomeCents, 0);
  const expense = months.reduce((a, m) => a + m.expenseCents, 0);
  return {
    months,
    totals: { incomeCents: income, expenseCents: expense, balanceCents: income - expense, savingsRatePercent: income > 0 ? ((income - expense) / income) * 100 : null },
  };
}

/** Orçamento por categoria: limite mensal (lançamentos "budget") × gasto no mês. */
export function copilotBudget(entries: CopilotEntryLike[], month: number) {
  const limits = new Map<string, number>();
  for (const e of entries) if (e.kind === 'budget' && e.category) limits.set(e.category, (limits.get(e.category) ?? 0) + e.amountCents);
  const spent = new Map<string, number>();
  for (const e of entries) if (e.kind === 'expense' && e.month === month) spent.set(e.category ?? 'other', (spent.get(e.category ?? 'other') ?? 0) + e.amountCents);
  const categories = [...new Set([...limits.keys(), ...spent.keys()])];
  return categories
    .map((c) => {
      const limit = limits.get(c) ?? 0;
      const used = spent.get(c) ?? 0;
      return {
        category: c,
        label: COPILOT_EXPENSE_CATEGORIES[c as CopilotExpenseCategory] ?? c,
        limitCents: limit,
        spentCents: used,
        usedPercent: limit > 0 ? (used / limit) * 100 : null,
      };
    })
    .sort((a, b) => b.spentCents - a.spentCents);
}

export interface CopilotIrpfmProjection {
  calendarYear: number;
  declarationYear: number;
  monthsWithData: number;
  projectedByCategory: { category: string; label: string; cents: number }[];
  regularTaxDueCents: number;
  exclusiveWithheldCents: number;
  dividendWithholdingCents: number;
  result: IrpfmResult;
  assumptions: string[];
}

/**
 * Projeção do IRPFM do ano (declarado no ano seguinte) a partir das receitas lançadas:
 * cada categoria é anualizada pela média dos meses com lançamentos (soma × 12 ÷ meses).
 * - salário, autônomo, aluguel, aposentadoria e outras: tributáveis (IR pela tabela anual,
 *   desconto simplificado ou nenhuma dedução, o que for menor);
 * - aplicações tributadas: tributação exclusiva com retenção estimada de 15%;
 * - aplicações isentas: excluídas da base (art. 16-A, § 1º, IV a VII e XI);
 * - dividendos: entram na base; retenção de 10% nos meses acima de R$ 50 mil (art. 6º-A),
 *   supondo uma única empresa pagadora.
 */
export function projectCopilotIrpfm(entries: CopilotEntryLike[], calendarYear: number): CopilotIrpfmProjection {
  const incomes = entries.filter((e) => e.kind === 'income' && e.month && e.year === calendarYear);
  const months = new Set(incomes.map((e) => e.month!));
  const monthsWithData = months.size;
  const factor = monthsWithData ? 12 / monthsWithData : 0;
  const byCat = new Map<string, number>();
  for (const e of incomes) byCat.set(e.category ?? 'other', (byCat.get(e.category ?? 'other') ?? 0) + e.amountCents);
  const projected = [...byCat.entries()].map(([category, cents]) => ({
    category,
    label: COPILOT_INCOME_CATEGORIES[category as CopilotIncomeCategory] ?? category,
    cents: Math.round(cents * factor),
  }));

  const params = irpfmParams(calendarYear);
  const dividendsByMonth = new Map<number, number>();
  for (const e of incomes.filter((x) => x.category === 'dividends')) dividendsByMonth.set(e.month!, (dividendsByMonth.get(e.month!) ?? 0) + e.amountCents);
  let withheld = 0;
  for (const v of dividendsByMonth.values()) if (v > params.dividendMonthlyThresholdCents) withheld += Math.round((v * params.dividendWithholdingPercent) / 100);
  const dividendWithholdingCents = Math.round(withheld * factor);

  const lines: IrpfmIncomeLine[] = projected.map((p) => {
    const line: IrpfmIncomeLine = { key: p.category, label: p.label, group: 'taxable', cents: p.cents };
    if (p.category === 'dividends') return { ...line, group: 'exempt', isDividend: true };
    if (p.category === 'financial_taxed') return { ...line, group: 'exclusive' };
    if (p.category === 'financial_exempt') return { ...line, group: 'exempt', exclusion: 'exempt_investments' };
    return line;
  });
  const taxable = lines.filter((l) => l.group === 'taxable').reduce((a, l) => a + l.cents, 0);
  const regular = annualIrpfDue({ exercise: calendarYear + 1, taxableIncomeCents: taxable, legalDeductionsCents: 0 }).taxDueCents;
  const exclusive = Math.round((lines.filter((l) => l.group === 'exclusive').reduce((a, l) => a + l.cents, 0) * 15) / 100);
  const result = computeIrpfm({
    calendarYear,
    incomes: lines,
    regularTaxDueCents: regular,
    exclusiveWithheldCents: exclusive,
    dividendWithholdingCents,
  });
  return {
    calendarYear,
    declarationYear: calendarYear + 1,
    monthsWithData,
    projectedByCategory: projected,
    regularTaxDueCents: regular,
    exclusiveWithheldCents: exclusive,
    dividendWithholdingCents,
    result,
    assumptions: [
      monthsWithData
        ? `Receitas anualizadas pela média de ${monthsWithData} mês(es) com lançamentos.`
        : 'Sem receitas lançadas no ano: a projeção fica zerada.',
      'IR da declaração estimado pela tabela anual sobre os rendimentos tributáveis, sem deduções legais além do desconto simplificado.',
      'Aplicações tributadas com retenção estimada de 15%; dividendos de uma única empresa pagadora.',
      'Projeção — confira com a legislação vigente e com os informes de rendimentos.',
    ],
  };
}
