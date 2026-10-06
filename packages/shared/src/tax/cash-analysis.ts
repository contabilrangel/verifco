import type { DeclarationItem } from '../dirpf';
import { taxParams } from './params';

/**
 * Análise de caixa (fluxo financeiro do ano-calendário).
 *
 * Compara os recursos que o contribuinte teve no ano com o que ele aplicou.
 * Saldo negativo indica variação patrimonial sem origem comprovada, um dos
 * principais motivos de malha fina.
 *
 *   recursos   = rendimentos tributáveis líquidos (– IRRF – previdência oficial)
 *              + rendimentos isentos + exclusivos líquidos + suspensos + RRA
 *              + aumento de dívidas + redução de bens (alienações)
 *   aplicações = aumento de bens + redução de dívidas
 *              + pagamentos efetuados (ou desconto simplificado como despesa estimada)
 *              + doações + imposto pago no ano + outros gastos informados
 *   saldo      = recursos – aplicações
 */
export interface CashAnalysisInput {
  exerciseYear: number;
  taxation?: 'complete' | 'simplified' | null;
  items: DeclarationItem[];
  otherExpenses?: { annualPaymentCents?: number; interestCents?: number; creditCardCents?: number; capitalLossCents?: number };
  /** Como tratar despesas na declaração simplificada: desconto padrão como gasto estimado ou nada. */
  simplifiedDiscountMode?: 'standard' | 'proportional';
}

export interface CashAnalysisLine {
  key: string;
  label: string;
  cents: number;
}

export interface CashAnalysisResult {
  sources: CashAnalysisLine[];
  uses: CashAnalysisLine[];
  totalSourcesCents: number;
  totalUsesCents: number;
  balanceCents: number;
  /** Variação patrimonial líquida (bens – dívidas) no ano. */
  netWorthVariationCents: number;
  assetsPrevCents: number;
  assetsCents: number;
  debtsPrevCents: number;
  debtsCents: number;
  status: 'positive' | 'negative' | 'zero';
  warnings: string[];
}

const sum = (list: DeclarationItem[], f: (i: DeclarationItem) => number) => list.reduce((a, i) => a + (f(i) || 0), 0);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function cashAnalysis(input: CashAnalysisInput): CashAnalysisResult {
  const by = (kind: DeclarationItem['kind']) => input.items.filter((i) => i.kind === kind);
  const warnings: string[] = [];
  const params = taxParams(input.exerciseYear);
  if (params.fallback) {
    warnings.push(`Não há parâmetros do exercício ${input.exerciseYear}; foram usados os de ${params.exercise}. Confira com a legislação vigente.`);
  } else if (!params.confirmed) {
    warnings.push(`Os parâmetros do exercício ${input.exerciseYear} (como o limite do desconto simplificado) ainda não foram conferidos com a legislação.`);
  }

  const pj = by('income_pj');
  const taxablePj = sum(pj, (i) => i.valueCents ?? 0);
  const irrfPj = sum(pj, (i) => i.withheldCents ?? 0);
  const officialPension = sum(pj, (i) => num(i.extra?.officialPensionCents));
  const taxablePf = sum(by('income_pf'), (i) => i.valueCents ?? 0);
  const carneLeao = sum(by('income_pf'), (i) => i.withheldCents ?? 0);
  const ruralNet = sum(by('rural_income'), (i) => i.valueCents ?? 0) - sum(by('rural_expense'), (i) => i.valueCents ?? 0);
  const exempt = sum(by('income_exempt'), (i) => i.valueCents ?? 0);
  const exclusiveNet = sum(by('income_exclusive'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));
  const suspended = sum(by('income_suspended'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));
  const accumulated = sum(by('income_accumulated'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));
  const capitalGainNet = sum(by('capital_gain'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));
  const variableNet = sum(by('variable_income'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));

  const assets = [...by('asset'), ...by('rural_asset')];
  const debts = [...by('debt'), ...by('rural_debt')];
  const assetsPrev = sum(assets, (i) => i.prevValueCents ?? 0);
  const assetsNow = sum(assets, (i) => i.valueCents ?? 0);
  const debtsPrev = sum(debts, (i) => i.prevValueCents ?? 0);
  const debtsNow = sum(debts, (i) => i.valueCents ?? 0);
  const assetsDelta = assetsNow - assetsPrev;
  const debtsDelta = debtsNow - debtsPrev;

  const payments = by('payment');
  const itemizedPayments = sum(payments, (i) => (i.valueCents ?? 0) - num(i.extra?.reimbursedCents));
  const donations = sum(by('donation'), (i) => i.valueCents ?? 0);
  const taxPaid = sum(by('tax_paid'), (i) => i.valueCents ?? 0) + num(input.otherExpenses?.annualPaymentCents);
  const other = input.otherExpenses ?? {};
  const otherSpending = num(other.interestCents) + num(other.creditCardCents) + num(other.capitalLossCents);

  let livingExpenses = itemizedPayments;
  let livingLabel = 'Pagamentos efetuados';
  if (input.taxation === 'simplified') {
    const taxable = taxablePj + taxablePf + Math.max(0, ruralNet);
    const discount = Math.min(Math.round(taxable * 0.2), params.simplifiedDiscountCapCents);
    if ((input.simplifiedDiscountMode ?? 'standard') === 'standard') {
      livingExpenses = Math.max(itemizedPayments, discount);
      livingLabel = 'Despesas estimadas (desconto simplificado)';
    } else {
      livingLabel = 'Pagamentos informados (simplificada)';
    }
  }

  const sources: CashAnalysisLine[] = [
    { key: 'taxable_net', label: 'Rendimentos tributáveis líquidos', cents: taxablePj + taxablePf - irrfPj - officialPension + Math.max(0, ruralNet) },
    { key: 'exempt', label: 'Rendimentos isentos e não tributáveis', cents: exempt },
    { key: 'exclusive', label: 'Rendimentos de tributação exclusiva (líquidos)', cents: exclusiveNet },
    { key: 'suspended_rra', label: 'Exigibilidade suspensa e RRA (líquidos)', cents: suspended + accumulated },
    { key: 'gains', label: 'Ganhos de capital e renda variável (líquidos)', cents: capitalGainNet + variableNet },
    { key: 'debts_increase', label: 'Aumento de dívidas', cents: Math.max(0, debtsDelta) },
    { key: 'assets_decrease', label: 'Redução de bens (alienações e resgates)', cents: Math.max(0, -assetsDelta) },
  ];
  const uses: CashAnalysisLine[] = [
    { key: 'assets_increase', label: 'Aumento de bens', cents: Math.max(0, assetsDelta) },
    { key: 'debts_decrease', label: 'Pagamento de dívidas', cents: Math.max(0, -debtsDelta) },
    { key: 'living', label: livingLabel, cents: livingExpenses },
    { key: 'donations', label: 'Doações efetuadas', cents: donations },
    { key: 'tax_paid', label: 'Imposto pago no ano (carnê-leão, quotas)', cents: taxPaid + carneLeao },
    { key: 'other', label: 'Outros gastos (juros, cartão, perdas)', cents: otherSpending },
  ];
  if (ruralNet < 0) warnings.push('Atividade rural com resultado negativo no ano.');

  const totalSourcesCents = sources.reduce((a, l) => a + l.cents, 0);
  const totalUsesCents = uses.reduce((a, l) => a + l.cents, 0);
  const balanceCents = totalSourcesCents - totalUsesCents;
  return {
    sources,
    uses,
    totalSourcesCents,
    totalUsesCents,
    balanceCents,
    netWorthVariationCents: assetsDelta - debtsDelta,
    assetsPrevCents: assetsPrev,
    assetsCents: assetsNow,
    debtsPrevCents: debtsPrev,
    debtsCents: debtsNow,
    status: balanceCents < 0 ? 'negative' : balanceCents > 0 ? 'positive' : 'zero',
    warnings,
  };
}

/** Totais que ficam gravados na declaração para filtros, dashboard e Kanban. */
export function declarationTotals(items: DeclarationItem[]) {
  const s = (kinds: DeclarationItem['kind'][], f: (i: DeclarationItem) => number) => sum(items.filter((i) => kinds.includes(i.kind)), f);
  const taxable = s(['income_pj', 'income_pf'], (i) => i.valueCents ?? 0);
  const exempt = s(['income_exempt'], (i) => i.valueCents ?? 0);
  const exclusive = s(['income_exclusive'], (i) => i.valueCents ?? 0);
  const other = s(['income_suspended', 'income_accumulated', 'capital_gain', 'variable_income', 'rural_income'], (i) => i.valueCents ?? 0);
  return {
    taxableIncomeCents: taxable,
    exemptIncomeCents: exempt,
    exclusiveIncomeCents: exclusive,
    totalIncomeCents: taxable + exempt + exclusive + other,
    deductionsCents: s(['payment'], (i) => (i.valueCents ?? 0) - num(i.extra?.reimbursedCents)),
    withheldTaxCents: s(['income_pj', 'income_pf', 'income_exclusive'], (i) => i.withheldCents ?? 0),
    assetsTotalCents: s(['asset', 'rural_asset'], (i) => i.valueCents ?? 0),
    assetsPrevTotalCents: s(['asset', 'rural_asset'], (i) => i.prevValueCents ?? 0),
    debtsTotalCents: s(['debt', 'rural_debt'], (i) => i.valueCents ?? 0),
    debtsPrevTotalCents: s(['debt', 'rural_debt'], (i) => i.prevValueCents ?? 0),
  };
}
