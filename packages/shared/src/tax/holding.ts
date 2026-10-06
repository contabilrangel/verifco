/**
 * Simulação de holding patrimonial (imóveis) × manutenção dos imóveis na pessoa física.
 *
 * É uma SIMULAÇÃO para apoiar a conversa com o cliente: alíquotas de ITBI (municipal) e ITCMD
 * (estadual) e custos de cartório e honorários são parâmetros do escritório; os tributos federais
 * ficam versionados por ano em HOLDING_TAX_PARAMS, com a fonte de cada valor.
 *
 * Premissas:
 * - Integralização dos imóveis pelo valor declarado na DIRPF (Lei 9.249/1995, art. 23): sem ganho
 *   de capital na transferência.
 * - ITBI sobre o valor de mercado, salvo se marcada a imunidade (CF, art. 156, § 2º, I). A imunidade
 *   não alcança, em regra, empresas cuja atividade preponderante é a compra, venda ou locação de
 *   imóveis, nem o valor que excede o capital integralizado (STF, Tema 796).
 * - Aluguel na PF: tabela progressiva anual (carnê-leão + ajuste), calculado como o acréscimo de
 *   imposto sobre os demais rendimentos tributáveis do cliente, sem deduções do aluguel, já com a
 *   redução anual do art. 11-A da Lei 9.250/1995 (Lei 15.270/2025) a partir do exercício 2027.
 *   Cada ano da projeção usa a tabela do seu exercício (ou a mais recente disponível).
 * - Aluguel na holding (lucro presumido): presunção de 32% para IRPJ e CSLL, IRPJ 15% + adicional
 *   de 10% sobre o lucro presumido acima de R$ 60 mil por trimestre (R$ 240 mil/ano, distribuição
 *   uniforme), CSLL 9%, PIS/COFINS cumulativos 3,65%.
 * - Venda hipotética de todos os imóveis pelo valor de mercado: na PF, ganho de capital com
 *   alíquotas progressivas por imóvel (Lei 13.259/2016), sem fatores de redução nem isenções; na
 *   holding com os imóveis no estoque, presunção de 8% (IRPJ) e 12% (CSLL) sobre a receita da venda
 *   em um único trimestre, mais PIS/COFINS de 3,65%.
 * - Inventário na PF: ITCMD + honorários e custas sobre o valor de mercado. Na holding: ITCMD
 *   sobre a doação das quotas (valor de mercado, conforme a LC 227/2026, ou valor declarado
 *   onde a lei estadual ainda permitir), sem inventário dos imóveis.
 * - Projeção de N anos sem correção da tabela do IR além da última publicada; aluguel com reajuste
 *   anual opcional.
 *
 * Valores em centavos; percentuais como número (3 = 3%).
 */
import { ANNUAL_IRPF_TABLES, annualIrpfTable, annualTaxWithReduction } from './irpf-annual';

export interface HoldingTaxParams {
  calendarYear: number;
  /** Presunção do lucro sobre aluguéis (IRPJ e CSLL). */
  rentPresumptionPercent: number;
  /** Presunção sobre a receita de venda de imóveis do estoque: IRPJ e CSLL. */
  salePresumptionIrpjPercent: number;
  salePresumptionCsllPercent: number;
  irpjPercent: number;
  irpjSurchargePercent: number;
  irpjSurchargeQuarterlyThresholdCents: number;
  csllPercent: number;
  /** PIS (0,65%) + COFINS (3%) cumulativos. */
  pisCofinsPercent: number;
  /** LC 224/2025: acréscimo de 10% nos percentuais de presunção sobre a receita anual acima de R$ 5 milhões. */
  presumptionIncrease: { overAnnualRevenueCents: number; percent: number } | null;
  /** Ganho de capital da PF: alíquotas progressivas por parcela (Lei 13.259/2016, art. 21). */
  capitalGainBrackets: { upToCents: number | null; ratePercent: number }[];
  sources: string[];
  confirmed: boolean;
}

const CAPITAL_GAIN_BRACKETS = [
  { upToCents: 500_000_000, ratePercent: 15 },
  { upToCents: 1_000_000_000, ratePercent: 17.5 },
  { upToCents: 3_000_000_000, ratePercent: 20 },
  { upToCents: null, ratePercent: 22.5 },
];

const BASE_SOURCES = [
  'Lei 9.249/1995, arts. 15, 20 e 23 (presunção de 32% e 8%/12%; integralização pelo valor declarado): https://www.planalto.gov.br/ccivil_03/leis/l9249.htm',
  'Lei 9.430/1996, art. 3º (adicional de 10% acima de R$ 60 mil por trimestre): https://www.planalto.gov.br/ccivil_03/leis/l9430.htm',
  'Lei 13.259/2016, art. 21 (ganho de capital de 15% a 22,5%): https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2016/lei/l13259.htm',
  'Lei 9.715/1998 e Lei 9.718/1998, art. 8º (regime cumulativo: PIS 0,65% e COFINS 3%): https://www.planalto.gov.br/ccivil_03/leis/l9718.htm',
];

const base = (calendarYear: number): Omit<HoldingTaxParams, 'presumptionIncrease' | 'sources' | 'confirmed'> => ({
  calendarYear,
  rentPresumptionPercent: 32,
  salePresumptionIrpjPercent: 8,
  salePresumptionCsllPercent: 12,
  irpjPercent: 15,
  irpjSurchargePercent: 10,
  irpjSurchargeQuarterlyThresholdCents: 6_000_000,
  csllPercent: 9,
  pisCofinsPercent: 3.65,
  capitalGainBrackets: CAPITAL_GAIN_BRACKETS,
});

/** Parâmetros federais por ano-calendário. */
export const HOLDING_TAX_PARAMS: Record<number, HoldingTaxParams> = {
  2024: { ...base(2024), presumptionIncrease: null, sources: BASE_SOURCES, confirmed: true },
  2025: { ...base(2025), presumptionIncrease: null, sources: BASE_SOURCES, confirmed: true },
  // LC 224/2025: +10% nos percentuais de presunção sobre a parcela da receita bruta anual acima de
  // R$ 5 milhões, a partir de 2026 (há decisões judiciais suspendendo a cobrança).
  // https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp224.htm
  2026: {
    ...base(2026),
    presumptionIncrease: { overAnnualRevenueCents: 500_000_000, percent: 10 },
    sources: [...BASE_SOURCES, 'LC 224/2025 (acréscimo de 10% na presunção): https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp224.htm'],
    confirmed: false,
  },
  // A partir de 2027 a CBS substitui PIS/COFINS (LC 214/2025), com redução de 70% das alíquotas na
  // locação de imóveis; a simulação mantém 3,65% como aproximação até a alíquota de referência.
  2027: {
    ...base(2027),
    presumptionIncrease: { overAnnualRevenueCents: 500_000_000, percent: 10 },
    sources: [
      ...BASE_SOURCES,
      'LC 224/2025: https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp224.htm',
      'LC 214/2025 (CBS/IBS substituem PIS/COFINS a partir de 2027): https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214.htm',
    ],
    confirmed: false,
  },
};

export function holdingTaxParams(calendarYear: number): HoldingTaxParams & { fallback: boolean } {
  if (HOLDING_TAX_PARAMS[calendarYear]) return { ...HOLDING_TAX_PARAMS[calendarYear], fallback: false };
  const years = Object.keys(HOLDING_TAX_PARAMS)
    .map(Number)
    .sort((a, b) => a - b);
  const pick = years.filter((y) => y <= calendarYear).pop() ?? years[0];
  return { ...HOLDING_TAX_PARAMS[pick], fallback: true };
}

/** Parâmetros que o escritório ajusta na tela (percentuais e valores em centavos). */
export interface HoldingSimulationParams {
  itbiPercent: number;
  itbiImmune: boolean;
  registryPercent: number;
  itcmdPercent: number;
  inventoryFeesPercent: number;
  holdingItcmdBase: 'market' | 'declared';
  holdingSetupCents: number;
  holdingAnnualCostCents: number;
  rentGrowthPercent: number;
  years: number;
}

export const DEFAULT_HOLDING_PARAMS: HoldingSimulationParams = {
  itbiPercent: 3,
  itbiImmune: false,
  registryPercent: 1,
  itcmdPercent: 4,
  inventoryFeesPercent: 6,
  holdingItcmdBase: 'market',
  holdingSetupCents: 500_000,
  holdingAnnualCostCents: 600_000,
  rentGrowthPercent: 0,
  years: 10,
};

export interface HoldingProperty {
  id: string;
  description: string;
  /** Valor declarado na DIRPF (custo de aquisição). */
  declaredValueCents: number;
  /** Valor de mercado estimado (base do ITBI, do ITCMD e da venda hipotética). */
  marketValueCents: number;
  monthlyRentCents: number;
}

export interface HoldingSimulationInput {
  calendarYear: number;
  properties: HoldingProperty[];
  /** Demais rendimentos tributáveis anuais da PF (sem os aluguéis simulados). */
  otherTaxableIncomeCents: number;
  params?: Partial<HoldingSimulationParams>;
}

export interface HoldingRow {
  key: 'itbi' | 'registry' | 'setup' | 'capital_gain' | 'annual_tax' | 'ten_years' | 'inventory';
  label: string;
  pfLabel: string;
  holdingLabel: string;
  pfCents: number;
  holdingCents: number;
  savingCents: number;
}

export interface HoldingYear {
  year: number;
  annualRentCents: number;
  pfTaxCents: number;
  holdingTaxCents: number;
  holdingCostCents: number;
}

export interface HoldingRentTax {
  presumedProfitCents: number;
  irpjCents: number;
  surchargeCents: number;
  csllCents: number;
  pisCofinsCents: number;
  totalCents: number;
}

export interface HoldingSimulationResult {
  calendarYear: number;
  params: HoldingSimulationParams;
  taxParams: HoldingTaxParams & { fallback: boolean };
  totals: { properties: number; declaredValueCents: number; marketValueCents: number; monthlyRentCents: number; annualRentCents: number };
  rows: HoldingRow[];
  holdingRentTax: HoldingRentTax;
  pfRentTaxCents: number;
  pfRentEffectiveRatePercent: number;
  yearly: HoldingYear[];
  pfTotalCents: number;
  holdingTotalCents: number;
  totalSavingCents: number;
  observations: string[];
  warnings: string[];
}

const pctOf = (cents: number, percent: number) => Math.round((cents * percent) / 100);

/** Ganho de capital da PF por parcela (Lei 13.259/2016, art. 21). */
export function capitalGainTax(gainCents: number, brackets = CAPITAL_GAIN_BRACKETS): number {
  let remaining = Math.max(0, gainCents);
  let lower = 0;
  let tax = 0;
  for (const b of brackets) {
    if (remaining <= 0) break;
    const width = b.upToCents === null ? remaining : Math.max(0, b.upToCents - lower);
    const slice = Math.min(remaining, width);
    tax += (slice * b.ratePercent) / 100;
    remaining -= slice;
    if (b.upToCents !== null) lower = b.upToCents;
  }
  return Math.round(tax);
}

/** Base presumida com o acréscimo da LC 224/2025 sobre a receita anual acima do limite. */
function presumedBase(revenueCents: number, percent: number, tp: HoldingTaxParams) {
  const inc = tp.presumptionIncrease;
  if (!inc || revenueCents <= inc.overAnnualRevenueCents) return pctOf(revenueCents, percent);
  const normal = pctOf(inc.overAnnualRevenueCents, percent);
  const excess = revenueCents - inc.overAnnualRevenueCents;
  return normal + pctOf(excess, percent * (1 + inc.percent / 100));
}

/** Tributos anuais da holding (lucro presumido) sobre a receita de aluguéis. */
export function holdingRentTax(annualRentCents: number, tp: HoldingTaxParams): HoldingRentTax {
  const presumed = presumedBase(annualRentCents, tp.rentPresumptionPercent, tp);
  const irpj = pctOf(presumed, tp.irpjPercent);
  const surcharge = pctOf(Math.max(0, presumed - tp.irpjSurchargeQuarterlyThresholdCents * 4), tp.irpjSurchargePercent);
  const csll = pctOf(presumed, tp.csllPercent);
  const pisCofins = pctOf(annualRentCents, tp.pisCofinsPercent);
  return { presumedProfitCents: presumed, irpjCents: irpj, surchargeCents: surcharge, csllCents: csll, pisCofinsCents: pisCofins, totalCents: irpj + surcharge + csll + pisCofins };
}

/** Tributos da holding na venda de imóveis do estoque, num único trimestre. */
export function holdingSaleTax(saleCents: number, tp: HoldingTaxParams): number {
  const irpjBase = presumedBase(saleCents, tp.salePresumptionIrpjPercent, tp);
  const csllBase = presumedBase(saleCents, tp.salePresumptionCsllPercent, tp);
  const irpj = pctOf(irpjBase, tp.irpjPercent);
  const surcharge = pctOf(Math.max(0, irpjBase - tp.irpjSurchargeQuarterlyThresholdCents), tp.irpjSurchargePercent);
  const csll = pctOf(csllBase, tp.csllPercent);
  return irpj + surcharge + csll + pctOf(saleCents, tp.pisCofinsPercent);
}

export function simulateHolding(input: HoldingSimulationInput): HoldingSimulationResult {
  const params: HoldingSimulationParams = { ...DEFAULT_HOLDING_PARAMS, ...(input.params ?? {}) };
  params.years = Math.max(1, Math.min(30, Math.round(params.years)));
  const tp = holdingTaxParams(input.calendarYear);
  const exercise = input.calendarYear + 1;
  const table = annualIrpfTable(exercise);
  const warnings: string[] = [];
  if (tp.fallback || !tp.confirmed) warnings.push(`Parâmetros federais de ${input.calendarYear} não confirmados; usando os de ${tp.calendarYear}.`);
  if (table.fallback || !table.confirmed) warnings.push(`Tabela do IR do exercício ${exercise} não confirmada; usando a do exercício ${table.exercise}.`);

  const props = input.properties;
  const declared = props.reduce((a, p) => a + p.declaredValueCents, 0);
  const market = props.reduce((a, p) => a + (p.marketValueCents || p.declaredValueCents), 0);
  const monthlyRent = props.reduce((a, p) => a + p.monthlyRentCents, 0);
  const annualRent = monthlyRent * 12;
  const other = Math.max(0, input.otherTaxableIncomeCents);

  // IR da PF com a redução do art. 11-A: acréscimo de imposto que o aluguel causa sobre os demais
  // rendimentos (a redução que os demais rendimentos teriam sozinhos pode sumir com o aluguel)
  const taxOf = (taxable: number, ex: number) => annualTaxWithReduction(taxable, taxable, ex).taxCents;
  const pfRentTaxFor = (rent: number, ex: number) => taxOf(other + rent, ex) - taxOf(other, ex);
  const pfRentTax = pfRentTaxFor(annualRent, exercise);
  const holdingTax = holdingRentTax(annualRent, tp);

  // ---- custos únicos da holding
  const itbi = params.itbiImmune ? 0 : pctOf(market, params.itbiPercent);
  const registry = pctOf(market, params.registryPercent);
  const setup = Math.max(0, params.holdingSetupCents);

  // ---- venda hipotética
  const pfGain = props.reduce((a, p) => a + capitalGainTax((p.marketValueCents || p.declaredValueCents) - p.declaredValueCents, tp.capitalGainBrackets), 0);
  const holdingGain = market > 0 ? holdingSaleTax(market, tp) : 0;

  // ---- projeção
  const yearly: HoldingYear[] = [];
  let pf10 = 0;
  let holding10 = itbi + registry + setup;
  for (let y = 1; y <= params.years; y++) {
    const rent = Math.round(annualRent * Math.pow(1 + params.rentGrowthPercent / 100, y - 1));
    // ano y da projeção: ano-calendário calendarYear + y − 1, declarado no exercício seguinte
    const pfTax = pfRentTaxFor(rent, exercise + y - 1);
    const hTax = holdingRentTax(rent, tp).totalCents;
    const cost = Math.max(0, params.holdingAnnualCostCents);
    yearly.push({ year: y, annualRentCents: rent, pfTaxCents: pfTax, holdingTaxCents: hTax, holdingCostCents: cost });
    pf10 += pfTax;
    holding10 += hTax + cost;
  }

  // ---- sucessão
  const pfInventory = pctOf(market, params.itcmdPercent) + pctOf(market, params.inventoryFeesPercent);
  const holdingSuccession = pctOf(params.holdingItcmdBase === 'declared' ? declared : market, params.itcmdPercent);

  const row = (key: HoldingRow['key'], label: string, pfLabel: string, holdingLabel: string, pf: number, h: number): HoldingRow => ({
    key,
    label,
    pfLabel,
    holdingLabel,
    pfCents: pf,
    holdingCents: h,
    savingCents: pf - h,
  });
  const n = params.years;
  const rows: HoldingRow[] = [
    row('itbi', 'ITBI', 'Sem transferência', params.itbiImmune ? 'Imunidade na integralização' : `${params.itbiPercent}% sobre o valor de mercado`, 0, itbi),
    row('registry', 'Cartório e registro', 'Sem transferência', `${params.registryPercent}% sobre o valor de mercado`, 0, registry),
    row('setup', 'Constituição da holding', 'Não se aplica', 'Honorários, contrato social e Junta', 0, setup),
    row('capital_gain', 'Ganho de capital (venda hipotética)', 'Alíquotas de 15% a 22,5% sobre o ganho', 'Lucro presumido sobre a receita da venda', pfGain, holdingGain),
    row('annual_tax', 'IR anual sobre aluguéis', 'Tabela progressiva (carnê-leão)', 'IRPJ, CSLL, PIS e COFINS (lucro presumido)', pfRentTax, holdingTax.totalCents),
    row('ten_years', `Estimativa em ${n} anos`, `IR sobre aluguéis em ${n} anos`, `Custos iniciais + tributos e manutenção em ${n} anos`, pf10, holding10),
    row(
      'inventory',
      'Inventário',
      `ITCMD ${params.itcmdPercent}% + honorários/custas ${params.inventoryFeesPercent}%`,
      `ITCMD ${params.itcmdPercent}% na doação das quotas (${params.holdingItcmdBase === 'declared' ? 'valor declarado' : 'valor de mercado'})`,
      pfInventory,
      holdingSuccession,
    ),
  ];

  const pfTotal = pf10 + pfInventory;
  const holdingTotal = holding10 + holdingSuccession;

  const observations = [
    'Simulação — confira com a legislação vigente e com as alíquotas do município (ITBI) e do estado (ITCMD) antes de recomendar.',
    'A integralização pelo valor declarado evita ganho de capital na transferência (Lei 9.249/1995, art. 23), mas a holding herda o custo baixo: na venda, a tributação incide sobre a receita (lucro presumido) e não sobre o ganho.',
    'A imunidade de ITBI na integralização (CF, art. 156, § 2º, I) não se aplica, em regra, quando a atividade preponderante é compra, venda ou locação de imóveis, nem ao valor que excede o capital (STF, Tema 796).',
    'A partir de 2026, lucros e dividendos acima de R$ 50 mil por mês de uma mesma empresa têm retenção de 10% (antecipação do IRPFM, compensável no ajuste) e entram na base do IRPFM se a renda total do sócio passar de R$ 600 mil (Lei 15.270/2025).',
    'A LC 227/2026 prevê ITCMD sobre quotas pelo valor de mercado (no mínimo o patrimônio líquido ajustado), reduzindo a vantagem sucessória da holding; confira a lei do estado.',
    'O ganho de capital na PF não considera fatores de redução (Lei 11.196/2005, art. 40; Lei 7.713/1988, art. 18) nem isenções (imóvel único até R$ 440 mil, reinvestimento em 180 dias): o imposto da PF pode ser menor.',
    'A partir de 2027, CBS e IBS substituem PIS/COFINS gradualmente (LC 214/2025), com regras próprias para locação de imóveis inclusive para pessoas físicas; a projeção mantém PIS/COFINS de 3,65% como aproximação.',
  ];
  const latestExercise = Math.max(...Object.keys(ANNUAL_IRPF_TABLES).map(Number));
  if (exercise + params.years - 1 > latestExercise) {
    observations.push(`Os anos da projeção a partir do exercício ${Math.max(exercise, latestExercise + 1)} usam a tabela do IR do exercício ${latestExercise} (a mais recente publicada), sem correção.`);
  }
  if (annualRent > 0 && holdingTax.surchargeCents > 0) {
    observations.push('O lucro presumido dos aluguéis supera R$ 240 mil por ano: incide o adicional de 10% do IRPJ.');
  }

  return {
    calendarYear: input.calendarYear,
    params,
    taxParams: tp,
    totals: { properties: props.length, declaredValueCents: declared, marketValueCents: market, monthlyRentCents: monthlyRent, annualRentCents: annualRent },
    rows,
    holdingRentTax: holdingTax,
    pfRentTaxCents: pfRentTax,
    pfRentEffectiveRatePercent: annualRent > 0 ? (pfRentTax / annualRent) * 100 : 0,
    yearly,
    pfTotalCents: pfTotal,
    holdingTotalCents: holdingTotal,
    totalSavingCents: pfTotal - holdingTotal,
    observations,
    warnings,
  };
}
