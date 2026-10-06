import type { DeclarationItem } from '../dirpf';
import { annualIrpfTableWarning, simplifiedDiscountCents } from './irpf-annual';
import { ruralResult } from './irpf';

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
 *                (juros de financiamentos, cartão de crédito, perdas de capital)
 *              + prejuízo da atividade rural (despesas acima das receitas no ano)
 *   saldo      = recursos – aplicações
 *
 * Atividade rural: entra o resultado do ano (receita − despesa). Quando positivo, a parte tributável
 * fica nos tributáveis e a "parcela isenta correspondente à atividade rural" já está nos isentos;
 * quando negativo, a diferença saiu do caixa e vira aplicação. Despesas rurais marcadas como
 * investimento (`extra.investment: true`) não são contadas de novo no aumento dos bens da atividade.
 *
 * Os parâmetros do imposto (desconto simplificado) vêm de `irpf-annual.ts`.
 */
export interface CashAnalysisInput {
  exerciseYear: number;
  taxation?: 'complete' | 'simplified' | null;
  items: DeclarationItem[];
  /**
   * "Outros gastos" informados pelo escritório. Os pagamentos de financiamentos no ano
   * (total = principal + juros) só entram pelos juros: o principal já aparece como redução
   * das dívidas declaradas.
   */
  otherExpenses?: { annualPaymentCents?: number; principalCents?: number; interestCents?: number; creditCardCents?: number; capitalLossCents?: number };
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
  const tableWarning = annualIrpfTableWarning(input.exerciseYear);
  // a tabela só pesa aqui pelo limite do desconto simplificado
  if (tableWarning && input.taxation === 'simplified') warnings.push(tableWarning);

  const pj = by('income_pj');
  const taxablePj = sum(pj, (i) => i.valueCents ?? 0);
  const irrfPj = sum(pj, (i) => i.withheldCents ?? 0);
  const officialPension = sum(pj, (i) => num(i.extra?.officialPensionCents));
  const taxablePf = sum(by('income_pf'), (i) => i.valueCents ?? 0);
  const carneLeao = sum(by('income_pf'), (i) => i.withheldCents ?? 0);
  const rural = ruralResult(input.items);
  const exempt = sum(by('income_exempt'), (i) => i.valueCents ?? 0);
  const exclusiveNet = sum(by('income_exclusive'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));
  const suspended = sum(by('income_suspended'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));
  const accumulated = sum(by('income_accumulated'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));
  const capitalGainNet = sum(by('capital_gain'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));
  // renda variável: ganho líquido menos o IR retido e o DARF pago (extra.taxPaidCents)
  const variableNet = sum(by('variable_income'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0) - num(i.extra?.taxPaidCents));

  const assets = [...by('asset'), ...by('rural_asset')];
  const debts = [...by('debt'), ...by('rural_debt')];
  const assetsPrev = sum(assets, (i) => i.prevValueCents ?? 0);
  const assetsNow = sum(assets, (i) => i.valueCents ?? 0);
  const debtsPrev = sum(debts, (i) => i.prevValueCents ?? 0);
  const debtsNow = sum(debts, (i) => i.valueCents ?? 0);
  const assetsDelta = assetsNow - assetsPrev;
  const debtsDelta = debtsNow - debtsPrev;
  // investimentos rurais lançados como despesa e que também aumentaram os bens da atividade
  const ruralInvestment = sum(by('rural_expense').filter((i) => i.extra?.investment === true), (i) => i.valueCents ?? 0);
  const ruralAssetsDelta = sum(by('rural_asset'), (i) => (i.valueCents ?? 0) - (i.prevValueCents ?? 0));
  const ruralOverlap = Math.min(ruralInvestment, Math.max(0, ruralAssetsDelta));
  const cashAssetsDelta = assetsDelta - ruralOverlap;

  const payments = by('payment');
  const itemizedPayments = sum(payments, (i) => (i.valueCents ?? 0) - num(i.extra?.reimbursedCents));
  const donations = sum(by('donation'), (i) => i.valueCents ?? 0);
  const taxPaid = sum(by('tax_paid'), (i) => i.valueCents ?? 0);
  const other = input.otherExpenses ?? {};
  // juros informados; sem eles, a diferença entre o total pago e o principal
  const interest = other.interestCents != null ? num(other.interestCents) : Math.max(0, num(other.annualPaymentCents) - num(other.principalCents));
  const otherSpending = interest + num(other.creditCardCents) + num(other.capitalLossCents);

  let livingExpenses = itemizedPayments;
  let livingLabel = 'Pagamentos efetuados';
  if (input.taxation === 'simplified') {
    const taxable = taxablePj + taxablePf + rural.taxableCents;
    const discount = simplifiedDiscountCents(taxable, input.exerciseYear);
    if ((input.simplifiedDiscountMode ?? 'standard') === 'standard') {
      livingExpenses = Math.max(itemizedPayments, discount);
      livingLabel = 'Despesas estimadas (desconto simplificado)';
    } else {
      livingLabel = 'Pagamentos informados (simplificada)';
    }
  }

  const sources: CashAnalysisLine[] = [
    { key: 'taxable_net', label: 'Rendimentos tributáveis líquidos', cents: taxablePj + taxablePf - irrfPj - officialPension + rural.taxableCents },
    { key: 'exempt', label: 'Rendimentos isentos e não tributáveis', cents: exempt },
    { key: 'exclusive', label: 'Rendimentos de tributação exclusiva (líquidos)', cents: exclusiveNet },
    { key: 'suspended_rra', label: 'Exigibilidade suspensa e RRA (líquidos)', cents: suspended + accumulated },
    { key: 'gains', label: 'Ganhos de capital e renda variável (líquidos)', cents: capitalGainNet + variableNet },
    { key: 'debts_increase', label: 'Aumento de dívidas', cents: Math.max(0, debtsDelta) },
    { key: 'assets_decrease', label: 'Redução de bens (alienações e resgates)', cents: Math.max(0, -cashAssetsDelta) },
  ];
  const uses: CashAnalysisLine[] = [
    { key: 'assets_increase', label: 'Aumento de bens', cents: Math.max(0, cashAssetsDelta) },
    { key: 'debts_decrease', label: 'Pagamento de dívidas', cents: Math.max(0, -debtsDelta) },
    { key: 'living', label: livingLabel, cents: livingExpenses },
    { key: 'donations', label: 'Doações efetuadas', cents: donations },
    { key: 'tax_paid', label: 'Imposto pago no ano (carnê-leão, quotas)', cents: taxPaid + carneLeao },
    { key: 'other', label: 'Outros gastos (juros de financiamentos, cartão, perdas)', cents: otherSpending },
    // só aparece quando há prejuízo no ano
    ...(rural.grossResultCents < 0 ? [{ key: 'rural_loss', label: 'Prejuízo da atividade rural (despesas acima das receitas)', cents: -rural.grossResultCents }] : []),
  ];
  if (rural.grossResultCents < 0) warnings.push('Atividade rural com resultado negativo no ano: o prejuízo entrou nas aplicações.');
  if (rural.expensesCents > 0 && ruralAssetsDelta > 0 && ruralInvestment === 0) {
    warnings.push(
      'Os bens da atividade rural aumentaram no ano. Se as despesas rurais incluem esses investimentos, o valor aparece duas vezes nas aplicações (despesa e aumento de bens); confira antes de concluir.',
    );
  }

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

/**
 * Totais que ficam gravados na declaração para filtros, dashboard e Kanban.
 *
 * - `totalIncomeCents`: soma dos rendimentos do ano (tributáveis, isentos, exclusivos, suspensos,
 *   RRA, ganhos e o RESULTADO tributável da atividade rural, não a receita bruta). É o sinal de
 *   sujeição ao IRPFM no dashboard.
 * - `deductionsCents`: soma dos PAGAMENTOS efetuados (líquidos de reembolso), inclusive aluguel e
 *   outros não dedutíveis. Não é a dedução legal da completa: para isso use `legalDeductions`.
 */
export function declarationTotals(items: DeclarationItem[]) {
  const s = (kinds: DeclarationItem['kind'][], f: (i: DeclarationItem) => number) => sum(items.filter((i) => kinds.includes(i.kind)), f);
  const taxable = s(['income_pj', 'income_pf'], (i) => i.valueCents ?? 0);
  const exempt = s(['income_exempt'], (i) => i.valueCents ?? 0);
  const exclusive = s(['income_exclusive'], (i) => i.valueCents ?? 0);
  // a "parcela isenta" rural já está nos isentos; aqui entra só a parte tributável do resultado
  const other = s(['income_suspended', 'income_accumulated', 'capital_gain', 'variable_income'], (i) => i.valueCents ?? 0) + ruralResult(items).taxableCents;
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
