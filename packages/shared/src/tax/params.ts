/**
 * Parâmetros tributários avulsos.
 *
 * A tabela do IR, o desconto simplificado, a dedução por dependente e o limite de instrução
 * ficam SÓ em `irpf-annual.ts` (fonte única por exercício); use `annualIrpfTable(exercicio)`.
 */

/**
 * IRPFM (tributação mínima, Lei 15.270/2025, art. 16-A, caput): a soma dos rendimentos do ano
 * precisa ser SUPERIOR a este valor. Usado como sinal no dashboard e no Radar; o cálculo completo
 * fica no módulo de IRPFM.
 */
export const IRPFM_THRESHOLD_CENTS = 60_000_000;
