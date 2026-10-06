/**
 * Tabela progressiva anual do IRPF por exercício e redução anual da Lei 15.270/2025.
 *
 * Usada nas simulações (holding, estimativa do IR devido no IRPFM, projeção do copiloto).
 * Não substitui o cálculo do programa da Receita: deduções legais (dependentes, saúde,
 * instrução, previdência) entram como um único valor informado pelo chamador.
 *
 * Valores em centavos. Cada tabela traz a fonte e `confirmed: false` quando ainda não
 * foi publicada oficialmente para o exercício.
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
  /** Redução anual do art. 11-A da Lei 9.250/1995 (incluído pela Lei 15.270/2025). */
  annualReduction: boolean;
  source: string;
  confirmed: boolean;
}

export const ANNUAL_IRPF_TABLES: Record<number, AnnualIrpfTable> = {
  // Exercício 2025 (AC 2024): janeiro com isenção de R$ 2.112,00 e fevereiro a dezembro com
  // R$ 2.259,20 (Lei 14.848/2024). Fonte: https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas (tabela anual do exercício 2025)
  2025: {
    exercise: 2025,
    calendarYear: 2024,
    brackets: [
      { upToCents: 2_696_320, ratePercent: 0, deductionCents: 0 },
      { upToCents: 3_391_980, ratePercent: 7.5, deductionCents: 202_224 },
      { upToCents: 4_501_260, ratePercent: 15, deductionCents: 456_623 },
      { upToCents: 5_597_616, ratePercent: 22.5, deductionCents: 794_217 },
      { upToCents: null, ratePercent: 27.5, deductionCents: 1_074_098 },
    ],
    simplifiedDiscountCapCents: 1_675_434,
    annualReduction: false,
    source: 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas (tabela anual do exercício 2025)',
    confirmed: true,
  },
  // Exercício 2026 (AC 2025): janeiro a abril com R$ 2.259,20 e maio a dezembro com R$ 2.428,80
  // (Lei 15.191/2025). Fonte: https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas (tabela anual do exercício 2026)
  2026: {
    exercise: 2026,
    calendarYear: 2025,
    brackets: [
      { upToCents: 2_846_720, ratePercent: 0, deductionCents: 0 },
      { upToCents: 3_391_980, ratePercent: 7.5, deductionCents: 213_504 },
      { upToCents: 4_501_260, ratePercent: 15, deductionCents: 467_903 },
      { upToCents: 5_597_616, ratePercent: 22.5, deductionCents: 805_497 },
      { upToCents: null, ratePercent: 27.5, deductionCents: 1_085_378 },
    ],
    simplifiedDiscountCapCents: 1_675_434,
    annualReduction: false,
    source: 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas (tabela anual do exercício 2026)',
    confirmed: true,
  },
  // Exercício 2027 (AC 2026): tabela mensal de maio/2025 (isenção R$ 2.428,80) multiplicada por 12,
  // desconto simplificado de R$ 17.640,00 (art. 10, X, da Lei 9.250/1995) e redução anual do
  // art. 11-A (Lei 15.270/2025: https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/lei/l15270.htm).
  // A tabela anual oficial do exercício 2027 ainda não foi conferida.
  2027: {
    exercise: 2027,
    calendarYear: 2026,
    brackets: [
      { upToCents: 2_914_560, ratePercent: 0, deductionCents: 0 },
      { upToCents: 3_391_980, ratePercent: 7.5, deductionCents: 218_592 },
      { upToCents: 4_501_260, ratePercent: 15, deductionCents: 472_992 },
      { upToCents: 5_597_616, ratePercent: 22.5, deductionCents: 810_588 },
      { upToCents: null, ratePercent: 27.5, deductionCents: 1_090_476 },
    ],
    simplifiedDiscountCapCents: 1_764_000,
    annualReduction: true,
    source: 'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/lei/l15270.htm',
    confirmed: false,
  },
};

/** Tabela do exercício; sem tabela própria, usa a mais próxima anterior (ou a primeira) e avisa. */
export function annualIrpfTable(exercise: number): AnnualIrpfTable & { fallback: boolean } {
  if (ANNUAL_IRPF_TABLES[exercise]) return { ...ANNUAL_IRPF_TABLES[exercise], fallback: false };
  const years = Object.keys(ANNUAL_IRPF_TABLES)
    .map(Number)
    .sort((a, b) => a - b);
  const pick = years.filter((y) => y <= exercise).pop() ?? years[0];
  return { ...ANNUAL_IRPF_TABLES[pick], fallback: true };
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
    const deduction =
      model === 'simplified' ? Math.min(Math.round(taxable * 0.2), table.simplifiedDiscountCapCents) : Math.max(0, input.legalDeductionsCents ?? 0);
    const base = Math.max(0, taxable - deduction);
    const gross = annualProgressiveTax(base, input.exercise);
    const reduction = annualTaxReduction(taxable, gross, input.exercise);
    return { model, baseCents: base, grossTaxCents: gross, reductionCents: reduction, taxDueCents: gross - reduction, fallback: table.fallback, confirmed: table.confirmed && !table.fallback };
  };
  const model = input.model ?? 'best';
  if (model !== 'best') return calc(model);
  const complete = calc('complete');
  const simplified = calc('simplified');
  return simplified.taxDueCents < complete.taxDueCents ? simplified : complete;
}
