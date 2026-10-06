/**
 * Parâmetros tributários por ano-exercício.
 *
 * ATENÇÃO: valores versionados por exercício. Confira a legislação vigente antes de
 * usar um exercício novo; o sistema avisa quando o ano pedido não tem parâmetros próprios
 * e usa o mais recente disponível.
 */
export interface TaxParams {
  exercise: number;
  /** Limite do desconto simplificado (20% dos rendimentos tributáveis, limitado a este valor). */
  simplifiedDiscountCapCents: number;
  /** Dedução anual por dependente. */
  dependentDeductionCents: number;
  /** Limite anual de dedução com instrução, por pessoa. */
  educationCapCents: number;
  /** false quando o valor ainda não foi conferido com a legislação do exercício. */
  confirmed: boolean;
}

export const TAX_PARAMS: Record<number, TaxParams> = {
  2024: { exercise: 2024, simplifiedDiscountCapCents: 1_675_434, dependentDeductionCents: 227_508, educationCapCents: 356_150, confirmed: true },
  2025: { exercise: 2025, simplifiedDiscountCapCents: 1_675_434, dependentDeductionCents: 227_508, educationCapCents: 356_150, confirmed: true },
  2026: { exercise: 2026, simplifiedDiscountCapCents: 1_675_434, dependentDeductionCents: 227_508, educationCapCents: 356_150, confirmed: false },
};

export function taxParams(exercise: number): TaxParams & { fallback: boolean } {
  if (TAX_PARAMS[exercise]) return { ...TAX_PARAMS[exercise], fallback: false };
  const years = Object.keys(TAX_PARAMS).map(Number).sort((a, b) => a - b);
  const pick = years.filter((y) => y <= exercise).pop() ?? years[0];
  return { ...TAX_PARAMS[pick], fallback: true };
}

/**
 * IRPFM (tributação mínima, Lei 15.270/2025): rendimentos anuais a partir deste valor
 * entram no cálculo. Usado como sinal no dashboard e no Radar; o cálculo completo fica
 * no módulo de IRPFM.
 */
export const IRPFM_THRESHOLD_CENTS = 60_000_000;
