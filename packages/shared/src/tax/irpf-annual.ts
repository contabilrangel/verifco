/**
 * Tabela do IRPF por exercício: FONTE ÚNICA dos parâmetros anuais do imposto no Verifco.
 *
 * Usada pelo comparativo completa × simplificada (relatório de planejamento), pela análise de
 * caixa e pela malha fina, pela estimativa do IR devido no IRPFM, pela holding e pelo copiloto.
 * Não acrescente tabelas em outros arquivos: derive daqui.
 *
 * Cada exercício traz a tabela progressiva anual, o limite do desconto simplificado, a dedução
 * por dependente, o limite de instrução por pessoa, a redução anual do art. 11-A da Lei 9.250/1995
 * (incluído pela Lei 15.270/2025) e o teto mensal sem imposto do carnê-leão. Valores em centavos,
 * conferidos nas páginas oficiais da Receita Federal citadas em `source` (consulta em 06/10/2026).
 */

export interface ProgressiveBracket {
  /** Limite superior da faixa (inclusive), em centavos; null na última faixa. */
  upToCents: number | null;
  ratePercent: number;
  /** Parcela a deduzir, em centavos. */
  deductionCents: number;
}

export interface AnnualIrpfTable {
  exercise: number;
  calendarYear: number;
  brackets: ProgressiveBracket[];
  /** Limite do desconto simplificado (20% dos rendimentos tributáveis). */
  simplifiedDiscountCapCents: number;
  /** Dedução anual por dependente. */
  dependentDeductionCents: number;
  /** Limite anual de dedução com instrução, por pessoa (titular e cada dependente). */
  educationCapCents: number;
  /** Redução anual do art. 11-A da Lei 9.250/1995 (incluído pela Lei 15.270/2025). */
  annualReduction: boolean;
  /**
   * Carnê-leão: maior rendimento mensal sem imposto em algum mês do ano-calendário
   * (limite de isenção + desconto simplificado mensal ou, a partir de 2026, o limite da redução
   * mensal do art. 3º-A da Lei 9.250/1995). Acima de 12 × este valor no ano, houve com certeza
   * algum mês com imposto devido.
   */
  monthlyTaxFreeUpToCents: number;
  source: string;
  confirmed: boolean;
}

const RFB = 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas';
const LAW_15270 = 'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/lei/l15270.htm';

/** Dedução por dependente, limite de instrução e desconto simplificado sem alteração desde o exercício 2016. */
const DEPENDENT_2016 = 227_508;
const EDUCATION_2016 = 356_150;
const SIMPLIFIED_2016 = 1_675_434;

const brackets = (limits: [number, number, number, number], deductions: [number, number, number, number]): ProgressiveBracket[] => [
  { upToCents: limits[0], ratePercent: 0, deductionCents: 0 },
  { upToCents: limits[1], ratePercent: 7.5, deductionCents: deductions[0] },
  { upToCents: limits[2], ratePercent: 15, deductionCents: deductions[1] },
  { upToCents: limits[3], ratePercent: 22.5, deductionCents: deductions[2] },
  { upToCents: null, ratePercent: 27.5, deductionCents: deductions[3] },
];

const tables: Record<number, AnnualIrpfTable> = {};

// Exercícios 2017 a 2023 (AC 2016 a 2022): mesma tabela (Lei 13.149/2015). Carnê-leão sem desconto
// simplificado mensal: isenção de R$ 1.903,98. Fonte: tabelas/2016 ("Do exercício 2017 até exercício 2023").
for (let exercise = 2017; exercise <= 2023; exercise++) {
  tables[exercise] = {
    exercise,
    calendarYear: exercise - 1,
    brackets: brackets([2_284_776, 3_391_980, 4_501_260, 5_597_616], [171_358, 425_757, 763_351, 1_043_232]),
    simplifiedDiscountCapCents: SIMPLIFIED_2016,
    dependentDeductionCents: DEPENDENT_2016,
    educationCapCents: EDUCATION_2016,
    annualReduction: false,
    monthlyTaxFreeUpToCents: 190_398,
    source: `${RFB}/2016 (incidência anual do exercício 2017 até o exercício 2023)`,
    confirmed: true,
  };
}

Object.assign(tables, {
  // Exercício 2024 (AC 2023): Lei 14.663/2023. Carnê-leão de maio a dezembro de 2023: isenção de
  // R$ 2.112,00 + desconto simplificado mensal de R$ 528,00. Fonte: tabelas/2023.
  2024: {
    exercise: 2024,
    calendarYear: 2023,
    brackets: brackets([2_451_192, 3_391_980, 4_501_260, 5_597_616], [183_839, 438_238, 775_832, 1_055_713]),
    simplifiedDiscountCapCents: SIMPLIFIED_2016,
    dependentDeductionCents: DEPENDENT_2016,
    educationCapCents: EDUCATION_2016,
    annualReduction: false,
    monthlyTaxFreeUpToCents: 264_000,
    source: `${RFB}/2023 (incidência anual a partir do exercício 2024)`,
    confirmed: true,
  },
  // Exercício 2025 (AC 2024): Lei 14.848/2024. Carnê-leão de fevereiro a dezembro de 2024: isenção de
  // R$ 2.259,20 + desconto simplificado mensal de R$ 564,80. Fonte: tabelas/copy_of_2024.
  2025: {
    exercise: 2025,
    calendarYear: 2024,
    brackets: brackets([2_696_320, 3_391_980, 4_501_260, 5_597_616], [202_224, 456_623, 794_217, 1_074_098]),
    simplifiedDiscountCapCents: SIMPLIFIED_2016,
    dependentDeductionCents: DEPENDENT_2016,
    educationCapCents: EDUCATION_2016,
    annualReduction: false,
    monthlyTaxFreeUpToCents: 282_400,
    source: `${RFB}/copy_of_2024 (incidência anual no exercício de 2025)`,
    confirmed: true,
  },
  // Exercício 2026 (AC 2025): Lei 15.191/2025. Carnê-leão de maio a dezembro de 2025: isenção de
  // R$ 2.428,80 + desconto simplificado mensal de R$ 607,20. Fonte: tabelas/2025.
  2026: {
    exercise: 2026,
    calendarYear: 2025,
    brackets: brackets([2_846_720, 3_391_980, 4_501_260, 5_597_616], [213_504, 467_903, 805_497, 1_085_378]),
    simplifiedDiscountCapCents: SIMPLIFIED_2016,
    dependentDeductionCents: DEPENDENT_2016,
    educationCapCents: EDUCATION_2016,
    annualReduction: false,
    monthlyTaxFreeUpToCents: 303_600,
    source: `${RFB}/2025 (incidência anual a partir do exercício 2026)`,
    confirmed: true,
  },
  // Exercício 2027 (AC 2026): tabela anual oficial, desconto simplificado de R$ 17.640,00 (art. 10, X,
  // da Lei 9.250/1995) e redução anual do art. 11-A (Lei 15.270/2025). Carnê-leão: a redução mensal
  // do art. 3º-A zera o imposto até R$ 5.000,00 por mês. Fonte: tabelas/2026 e a Lei 15.270/2025.
  2027: {
    exercise: 2027,
    calendarYear: 2026,
    brackets: brackets([2_914_560, 3_391_980, 4_501_260, 5_597_616], [218_592, 472_991, 810_585, 1_090_466]),
    simplifiedDiscountCapCents: 1_764_000,
    dependentDeductionCents: DEPENDENT_2016,
    educationCapCents: EDUCATION_2016,
    annualReduction: true,
    monthlyTaxFreeUpToCents: 500_000,
    source: `${RFB}/2026 (incidência e redução anuais a partir do exercício 2027) e ${LAW_15270}`,
    confirmed: true,
  },
} satisfies Record<number, AnnualIrpfTable>);

export const ANNUAL_IRPF_TABLES: Readonly<Record<number, AnnualIrpfTable>> = tables;

/** Tabela do exercício; sem tabela própria, usa a mais próxima anterior (ou a primeira) e avisa. */
export function annualIrpfTable(exercise: number): AnnualIrpfTable & { fallback: boolean } {
  if (ANNUAL_IRPF_TABLES[exercise]) return { ...ANNUAL_IRPF_TABLES[exercise], fallback: false };
  const years = Object.keys(ANNUAL_IRPF_TABLES)
    .map(Number)
    .sort((a, b) => a - b);
  const pick = years.filter((y) => y <= exercise).pop() ?? years[0];
  return { ...ANNUAL_IRPF_TABLES[pick], fallback: true };
}

/**
 * Aviso padronizado sobre a tabela usada no exercício (null quando a tabela é própria e conferida).
 * Inclui a menção à redução do art. 11-A quando a tabela emprestada não a aplica.
 */
export function annualIrpfTableWarning(exercise: number): string | null {
  const t = annualIrpfTable(exercise);
  if (t.fallback) {
    const reduction = exercise >= 2027 && !t.annualReduction ? ' A redução anual da Lei 15.270/2025 não foi aplicada.' : '';
    return `O exercício ${exercise} não tem tabela do IR própria; foram usados os valores do exercício ${t.exercise}. Confira com a legislação vigente.${reduction}`;
  }
  if (!t.confirmed) return `A tabela do IR do exercício ${exercise} ainda não foi conferida com a publicação oficial.`;
  return null;
}

/** Imposto pela tabela progressiva anual (sem a redução do art. 11-A). */
export function annualProgressiveTax(baseCents: number, exercise: number): number {
  const base = Math.max(0, Math.round(baseCents));
  const table = annualIrpfTable(exercise);
  const bracket = table.brackets.find((b) => b.upToCents === null || base <= b.upToCents) ?? table.brackets[table.brackets.length - 1];
  return Math.max(0, Math.round((base * bracket.ratePercent) / 100) - bracket.deductionCents);
}

/** Alíquota marginal (%) da faixa em que a base se encontra. */
export function marginalRatePercent(baseCents: number, exercise: number): number {
  const table = annualIrpfTable(exercise);
  const bracket = table.brackets.find((b) => b.upToCents === null || baseCents <= b.upToCents) ?? table.brackets[table.brackets.length - 1];
  return bracket.ratePercent;
}

/**
 * Redução anual do art. 11-A da Lei 9.250/1995 (a partir do exercício 2027):
 * - rendimentos tributáveis até R$ 60.000,00: até R$ 2.694,15 (imposto zero);
 * - de R$ 60.000,01 a R$ 88.200,00: R$ 8.429,73 − 0,095575 × rendimentos tributáveis;
 * - acima de R$ 88.200,00: sem redução.
 * A redução fica limitada ao imposto calculado pela tabela.
 */
export function annualTaxReduction(taxableIncomeCents: number, taxCents: number, exercise: number): number {
  if (!annualIrpfTable(exercise).annualReduction) return 0;
  let reduction = 0;
  if (taxableIncomeCents <= 6_000_000) reduction = 269_415;
  else if (taxableIncomeCents <= 8_820_000) reduction = Math.round(842_973 - 0.095575 * taxableIncomeCents);
  return Math.max(0, Math.min(taxCents, reduction));
}

/**
 * Imposto anual devido sobre a base, já com a redução do art. 11-A.
 * `taxableIncomeCents` são os rendimentos tributáveis sujeitos ao ajuste (a redução é calculada
 * sobre eles, e não sobre a base).
 */
export function annualTaxWithReduction(baseCents: number, taxableIncomeCents: number, exercise: number) {
  const grossTaxCents = annualProgressiveTax(baseCents, exercise);
  const reductionCents = annualTaxReduction(taxableIncomeCents, grossTaxCents, exercise);
  return { grossTaxCents, reductionCents, taxCents: grossTaxCents - reductionCents };
}

/** Desconto simplificado: 20% dos rendimentos tributáveis, limitado ao teto do exercício. */
export function simplifiedDiscountCents(taxableIncomeCents: number, exercise: number): number {
  return Math.min(Math.round(Math.max(0, taxableIncomeCents) * 0.2), annualIrpfTable(exercise).simplifiedDiscountCapCents);
}

export interface AnnualIrpfInput {
  exercise: number;
  /** Rendimentos tributáveis sujeitos ao ajuste anual (PJ, PF/exterior, resultado rural tributável). */
  taxableIncomeCents: number;
  /** Deduções legais da declaração completa (previdência, dependentes, saúde, instrução...). */
  legalDeductionsCents?: number;
  /** 'best' escolhe a opção de menor imposto entre completa e simplificada. */
  model?: 'complete' | 'simplified' | 'best';
}

export interface AnnualIrpfResult {
  model: 'complete' | 'simplified';
  baseCents: number;
  grossTaxCents: number;
  reductionCents: number;
  taxDueCents: number;
  fallback: boolean;
  confirmed: boolean;
}

/** IR devido estimado na declaração de ajuste anual. */
export function annualIrpfDue(input: AnnualIrpfInput): AnnualIrpfResult {
  const table = annualIrpfTable(input.exercise);
  const taxable = Math.max(0, input.taxableIncomeCents);
  const calc = (model: 'complete' | 'simplified'): AnnualIrpfResult => {
    const deduction = model === 'simplified' ? simplifiedDiscountCents(taxable, input.exercise) : Math.max(0, input.legalDeductionsCents ?? 0);
    const base = Math.max(0, taxable - deduction);
    const t = annualTaxWithReduction(base, taxable, input.exercise);
    return { model, baseCents: base, grossTaxCents: t.grossTaxCents, reductionCents: t.reductionCents, taxDueCents: t.taxCents, fallback: table.fallback, confirmed: table.confirmed && !table.fallback };
  };
  const model = input.model ?? 'best';
  if (model !== 'best') return calc(model);
  const complete = calc('complete');
  const simplified = calc('simplified');
  return simplified.taxDueCents < complete.taxDueCents ? simplified : complete;
}
