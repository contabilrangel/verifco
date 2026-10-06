/**
 * IRPFM — tributação mínima do IRPF para altas rendas.
 *
 * Fonte: Lei 15.270/2025, que incluiu os arts. 6º-A, 16-A e 16-B na Lei 9.250/1995
 * (https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/lei/l15270.htm).
 * Vale a partir do exercício 2027, ano-calendário 2026 (art. 16-A, caput).
 *
 * Roteiro (art. 16-A):
 *   1. sujeição: soma de TODOS os rendimentos recebidos no ano > R$ 600.000,00 (caput);
 *   2. base (§ 1º): rendimentos tributáveis, exclusivos/definitivos, isentos e o resultado da
 *      atividade rural, menos exclusivamente os itens I a XII (ganhos de capital fora de bolsa,
 *      RRA exclusivo, heranças/doações, poupança, LCI/LCA/CRI/CRA etc., indenizações,
 *      moléstia grave, títulos isentos, dividendos de lucros até 2025 aprovados até 31/12/2025);
 *   3. alíquota (§ 2º): 10% a partir de R$ 1.200.000,00; entre R$ 600 mil e R$ 1,2 milhão,
 *      Alíquota % = REND / 60.000 − 10 (REND = base do § 1º, em reais);
 *   4. imposto (§ 3º) = alíquota × base − IR devido na declaração de ajuste (I) − IR retido
 *      exclusivamente na fonte sobre rendimentos da base (II) − IR da Lei 14.754/2023 (III)
 *      − IR pago definitivamente sobre rendimentos da base (IV) − redutor do art. 16-B (V);
 *   5. negativo vira zero (§ 4º); do resultado deduz-se o IR retido sobre dividendos do
 *      art. 6º-A (§ 5º); o que sobrar (positivo ou negativo) soma-se ao saldo da declaração (§ 6º).
 *
 * Redutor (art. 16-B): se alíquota efetiva da PJ (IRPJ+CSLL ÷ lucro contábil) + alíquota efetiva
 * da tributação mínima da PF (acréscimo do IRPFM antes do redutor causado pelos dividendos ÷
 * dividendos) ultrapassar 34% (40% seguradoras e financeiras; 45% bancos), o redutor é
 * dividendos da PJ × (soma das efetivas − percentual nominal).
 *
 * Valores em centavos.
 */
import type { DeclarationItem } from '../dirpf';

export interface IrpfmParams {
  calendarYear: number;
  /** Rendimentos totais acima deste valor sujeitam à tributação mínima. */
  thresholdCents: number;
  /** A partir desta base, alíquota máxima. */
  fullRateFromCents: number;
  maxRatePercent: number;
  /** Retenção do art. 6º-A: dividendos de uma mesma PJ acima deste valor no mês. */
  dividendMonthlyThresholdCents: number;
  dividendWithholdingPercent: number;
  /** Percentuais nominais IRPJ+CSLL do art. 16-B, § 1º. */
  nominalRates: { general: number; insuranceFinancial: number; banks: number };
  source: string;
  confirmed: boolean;
}

const LAW_15270 = 'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/lei/l15270.htm';

/** Parâmetros por ano-calendário. Os valores não têm correção prevista em lei. */
export const IRPFM_PARAMS: Record<number, IrpfmParams> = {
  2026: {
    calendarYear: 2026,
    thresholdCents: 60_000_000,
    fullRateFromCents: 120_000_000,
    maxRatePercent: 10,
    dividendMonthlyThresholdCents: 5_000_000,
    dividendWithholdingPercent: 10,
    nominalRates: { general: 34, insuranceFinancial: 40, banks: 45 },
    source: LAW_15270,
    confirmed: true,
  },
  // Mesmos valores; a lei não prevê atualização, mas o Executivo deve propor política de
  // atualização em até 1 ano (art. 6º da Lei 15.270/2025). Conferir antes de usar.
  2027: {
    calendarYear: 2027,
    thresholdCents: 60_000_000,
    fullRateFromCents: 120_000_000,
    maxRatePercent: 10,
    dividendMonthlyThresholdCents: 5_000_000,
    dividendWithholdingPercent: 10,
    nominalRates: { general: 34, insuranceFinancial: 40, banks: 45 },
    source: LAW_15270,
    confirmed: false,
  },
};

/** Primeiro ano-calendário com IRPFM. */
export const IRPFM_FIRST_CALENDAR_YEAR = 2026;

export function irpfmParams(calendarYear: number): IrpfmParams & { fallback: boolean; inForce: boolean } {
  const years = Object.keys(IRPFM_PARAMS)
    .map(Number)
    .sort((a, b) => a - b);
  const pick = IRPFM_PARAMS[calendarYear] ? calendarYear : (years.filter((y) => y <= calendarYear).pop() ?? years[0]);
  return { ...IRPFM_PARAMS[pick], fallback: pick !== calendarYear, inForce: calendarYear >= IRPFM_FIRST_CALENDAR_YEAR };
}

/** Alíquota (%) do art. 16-A, § 2º, sobre a base em centavos. */
export function irpfmRatePercent(baseCents: number, params: IrpfmParams = IRPFM_PARAMS[2026]): number {
  if (baseCents <= params.thresholdCents) return 0;
  if (baseCents >= params.fullRateFromCents) return params.maxRatePercent;
  // REND/60.000 − 10, com REND em reais (base/100). Generalizado para os parâmetros do ano.
  const span = params.fullRateFromCents - params.thresholdCents;
  return ((baseCents - params.thresholdCents) / span) * params.maxRatePercent;
}

// ---------------------------------------------------------------------------
// Exclusões da base (art. 16-A, § 1º)
// ---------------------------------------------------------------------------
export const IRPFM_EXCLUSIONS = {
  capital_gain: { label: 'Ganhos de capital (exceto operações em bolsa)', ref: 'art. 16-A, § 1º, I' },
  rra_exclusive: { label: 'Rendimentos recebidos acumuladamente com tributação exclusiva', ref: 'art. 16-A, § 1º, II' },
  inheritance_donation: { label: 'Doações em adiantamento da legítima e heranças', ref: 'art. 16-A, § 1º, III' },
  exempt_investments: {
    label: 'Poupança, LCI, LCA, CRI, CRA, LIG, LCD, CPR, debêntures incentivadas e demais títulos isentos',
    ref: 'art. 16-A, § 1º, IV a VII e XI',
  },
  rural_exempt: { label: 'Parcela isenta da atividade rural', ref: 'art. 16-A, § 1º, VIII' },
  indemnity: { label: 'Indenizações por acidente de trabalho e danos materiais ou morais', ref: 'art. 16-A, § 1º, IX' },
  serious_illness: { label: 'Rendimentos isentos por moléstia grave (art. 6º, XIV e XXI, Lei 7.713/1988)', ref: 'art. 16-A, § 1º, X' },
  legacy_dividends: { label: 'Lucros e dividendos de resultados até 2025 aprovados até 31/12/2025', ref: 'art. 16-A, § 1º, XII' },
  notary_transfers: { label: 'Repasses obrigatórios sobre emolumentos (cartórios)', ref: 'art. 16-A, § 7º' },
} as const;
export type IrpfmExclusion = keyof typeof IRPFM_EXCLUSIONS;

export const IRPFM_INCOME_GROUPS = {
  taxable: 'Rendimentos tributáveis',
  rural: 'Resultado da atividade rural',
  exclusive: 'Tributação exclusiva ou definitiva',
  exempt: 'Rendimentos isentos e não tributáveis',
  variable: 'Renda variável (bolsa)',
  excluded: 'Excluídos da base',
} as const;
export type IrpfmIncomeGroup = keyof typeof IRPFM_INCOME_GROUPS;

export interface IrpfmIncomeLine {
  key: string;
  label: string;
  group: Exclude<IrpfmIncomeGroup, 'excluded'>;
  cents: number;
  /** Motivo da exclusão da base, quando houver. */
  exclusion?: IrpfmExclusion | null;
  /** Lucros e dividendos (entram no redutor e na alíquota efetiva da PF). */
  isDividend?: boolean;
  payerDoc?: string | null;
  payerName?: string | null;
}

export type NominalRateKind = 'general' | 'insuranceFinancial' | 'banks';

export interface IrpfmDividendPayer {
  payerDoc?: string | null;
  payerName?: string | null;
  /** Alíquota efetiva da PJ (IRPJ + CSLL devidos ÷ lucro contábil), em %. Sem ela, não há redutor. */
  pjEffectiveRatePercent?: number | null;
  nominalKind?: NominalRateKind;
}

export interface IrpfmInput {
  calendarYear: number;
  incomes: IrpfmIncomeLine[];
  /** I — IR devido na declaração de ajuste anual (art. 12). */
  regularTaxDueCents: number;
  /** II — IR retido exclusivamente na fonte sobre rendimentos da base. */
  exclusiveWithheldCents: number;
  /** III — IR apurado com base na Lei 14.754/2023 (aplicações no exterior e offshores). */
  law14754TaxCents?: number;
  /** IV — IR pago definitivamente sobre rendimentos da base (ex.: renda variável). */
  definitiveTaxPaidCents?: number;
  /** § 5º — IR retido sobre dividendos (art. 6º-A), antecipação do IRPFM. */
  dividendWithholdingCents?: number;
  /** Dados das PJs pagadoras para o redutor do art. 16-B. */
  dividendPayers?: IrpfmDividendPayer[];
}

export interface IrpfmPayerReducer {
  payerDoc: string | null;
  payerName: string | null;
  dividendsCents: number;
  pjEffectiveRatePercent: number | null;
  nominalRatePercent: number;
  reducerCents: number;
}

export interface IrpfmResult {
  calendarYear: number;
  exercise: number;
  /** A lei já produz efeitos para o ano (AC 2026 em diante). Antes disso, é simulação. */
  inForce: boolean;
  /** Soma de todos os rendimentos > limite (art. 16-A, caput). */
  subject: boolean;
  totalIncomeCents: number;
  exclusionsCents: number;
  baseCents: number;
  thresholdCents: number;
  excessCents: number;
  ratePercent: number;
  grossTaxCents: number;
  deductions: {
    regularTaxDueCents: number;
    exclusiveWithheldCents: number;
    law14754TaxCents: number;
    definitiveTaxPaidCents: number;
    totalCents: number;
  };
  reducer: {
    dividendsInBaseCents: number;
    pfEffectiveRatePercent: number;
    totalCents: number;
    payers: IrpfmPayerReducer[];
  };
  /** Valor devido a título de tributação mínima (§§ 3º e 4º), nunca negativo. */
  dueCents: number;
  dividendWithholdingCents: number;
  /** § 5º/§ 6º: valor que soma ao saldo da declaração (negativo = crédito a restituir). */
  complementaryCents: number;
  /** Carga total (IR já pago + IRPFM devido) ÷ base. */
  effectiveRatePercent: number;
  composition: { group: IrpfmIncomeGroup; label: string; cents: number; lines: IrpfmIncomeLine[] }[];
  exclusions: { exclusion: IrpfmExclusion; label: string; ref: string; cents: number }[];
  conclusion: string;
  warnings: string[];
  params: IrpfmParams & { fallback: boolean; inForce: boolean };
}

const sumBy = <T>(list: T[], f: (x: T) => number) => list.reduce((a, x) => a + (f(x) || 0), 0);
const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

/** Imposto mínimo antes do redutor: alíquota × base − deduções I a IV, nunca negativo. */
function dueBeforeReducer(baseCents: number, deductionsCents: number, params: IrpfmParams) {
  const rate = irpfmRatePercent(baseCents, params);
  return Math.max(0, Math.round((baseCents * rate) / 100) - deductionsCents);
}

export function computeIrpfm(input: IrpfmInput): IrpfmResult {
  const params = irpfmParams(input.calendarYear);
  const warnings: string[] = [];
  if (!params.inForce) {
    warnings.push(
      `O IRPFM vale a partir do ano-calendário ${IRPFM_FIRST_CALENDAR_YEAR} (declaração de ${IRPFM_FIRST_CALENDAR_YEAR + 1}). Para ${input.calendarYear}, o resultado é apenas uma simulação com as regras da Lei 15.270/2025.`,
    );
  }
  if (params.fallback || !params.confirmed) {
    warnings.push(`Parâmetros do IRPFM para ${input.calendarYear} não confirmados; usando os de ${params.calendarYear}.`);
  }

  const incomes = input.incomes.filter((l) => l.cents !== 0);
  const included = incomes.filter((l) => !l.exclusion);
  const excluded = incomes.filter((l) => l.exclusion);
  const exclusionsCents = sumBy(excluded, (l) => Math.max(0, l.cents));
  const baseCents = Math.max(0, sumBy(included, (l) => l.cents));
  // rendimentos do caput: tudo o que entra na base (com o resultado rural líquido) + as exclusões
  const totalIncomeCents = baseCents + exclusionsCents;
  const subject = totalIncomeCents > params.thresholdCents;
  const ratePercent = subject ? irpfmRatePercent(baseCents, params) : 0;
  const grossTaxCents = Math.round((baseCents * ratePercent) / 100);

  const deductions = {
    regularTaxDueCents: Math.max(0, input.regularTaxDueCents),
    exclusiveWithheldCents: Math.max(0, input.exclusiveWithheldCents),
    law14754TaxCents: Math.max(0, input.law14754TaxCents ?? 0),
    definitiveTaxPaidCents: Math.max(0, input.definitiveTaxPaidCents ?? 0),
    totalCents: 0,
  };
  deductions.totalCents = deductions.regularTaxDueCents + deductions.exclusiveWithheldCents + deductions.law14754TaxCents + deductions.definitiveTaxPaidCents;

  // ---- redutor (art. 16-B)
  const dividendLines = included.filter((l) => l.isDividend && l.cents > 0);
  const dividendsInBaseCents = sumBy(dividendLines, (l) => l.cents);
  let pfEffectiveRatePercent = 0;
  const payers: IrpfmPayerReducer[] = [];
  if (subject && dividendsInBaseCents > 0) {
    const withDividends = dueBeforeReducer(baseCents, deductions.totalCents, params);
    const withoutBase = baseCents - dividendsInBaseCents;
    const withoutDividends = withoutBase > params.thresholdCents ? dueBeforeReducer(withoutBase, deductions.totalCents, params) : 0;
    pfEffectiveRatePercent = ((withDividends - withoutDividends) / dividendsInBaseCents) * 100;
    const byPayer = new Map<string, { payerDoc: string | null; payerName: string | null; cents: number }>();
    for (const l of dividendLines) {
      const k = l.payerDoc || l.payerName || l.key;
      const cur = byPayer.get(k) ?? { payerDoc: l.payerDoc ?? null, payerName: l.payerName ?? null, cents: 0 };
      cur.cents += l.cents;
      byPayer.set(k, cur);
    }
    for (const p of byPayer.values()) {
      const info = (input.dividendPayers ?? []).find(
        (d) => (d.payerDoc && p.payerDoc && d.payerDoc === p.payerDoc) || (!d.payerDoc && d.payerName && d.payerName === p.payerName),
      );
      const nominal = params.nominalRates[info?.nominalKind ?? 'general'];
      const pj = info?.pjEffectiveRatePercent ?? null;
      const excess = pj === null ? 0 : pj + pfEffectiveRatePercent - nominal;
      const reducerCents = excess > 0 ? Math.round((p.cents * excess) / 100) : 0;
      payers.push({ payerDoc: p.payerDoc, payerName: p.payerName, dividendsCents: p.cents, pjEffectiveRatePercent: pj, nominalRatePercent: nominal, reducerCents });
    }
    if (payers.some((p) => p.pjEffectiveRatePercent === null)) {
      warnings.push('Informe a alíquota efetiva (IRPJ + CSLL ÷ lucro contábil) das empresas pagadoras de dividendos para calcular o redutor do art. 16-B.');
    }
  }
  const reducerTotal = sumBy(payers, (p) => p.reducerCents);

  const dueCents = subject ? Math.max(0, grossTaxCents - deductions.totalCents - reducerTotal) : 0;
  const dividendWithholdingCents = Math.max(0, input.dividendWithholdingCents ?? 0);
  const complementaryCents = dueCents - dividendWithholdingCents;
  const totalPaid = deductions.totalCents + dueCents;
  const effectiveRatePercent = baseCents > 0 ? (totalPaid / baseCents) * 100 : 0;

  const groups: Exclude<IrpfmIncomeGroup, 'excluded'>[] = ['taxable', 'rural', 'exclusive', 'exempt', 'variable'];
  const composition: IrpfmResult['composition'] = groups
    .map((g) => {
      const lines = included.filter((l) => l.group === g);
      return { group: g as IrpfmIncomeGroup, label: IRPFM_INCOME_GROUPS[g], cents: sumBy(lines, (l) => l.cents), lines };
    })
    .filter((c) => c.lines.length);
  if (excluded.length) composition.push({ group: 'excluded', label: IRPFM_INCOME_GROUPS.excluded, cents: exclusionsCents, lines: excluded });

  const exclusions = (Object.keys(IRPFM_EXCLUSIONS) as IrpfmExclusion[])
    .map((e) => ({ exclusion: e, ...IRPFM_EXCLUSIONS[e], cents: sumBy(excluded.filter((l) => l.exclusion === e), (l) => l.cents) }))
    .filter((e) => e.cents > 0);

  let conclusion: string;
  if (!subject) {
    conclusion = `Os rendimentos do ano somam ${brl(totalIncomeCents)}, sem ultrapassar ${brl(params.thresholdCents)}: não há sujeição à tributação mínima.`;
  } else if (ratePercent === 0) {
    conclusion = `Os rendimentos somam ${brl(totalIncomeCents)} (acima de ${brl(params.thresholdCents)}), mas, após as exclusões legais, a base de ${brl(baseCents)} não ultrapassa o limite: a alíquota é zero e não há IRPFM a pagar.`;
  } else if (dueCents === 0) {
    conclusion = `Sujeito à tributação mínima: base de ${brl(baseCents)} e alíquota de ${pct(ratePercent)} (imposto mínimo de ${brl(grossTaxCents)}). O imposto já pago e o redutor (${brl(deductions.totalCents + reducerTotal)}) cobrem o mínimo: não há IRPFM a pagar.`;
  } else {
    conclusion = `Sujeito à tributação mínima: base de ${brl(baseCents)} e alíquota de ${pct(ratePercent)} (imposto mínimo de ${brl(grossTaxCents)}). Descontados o imposto já pago e o redutor, o IRPFM devido é de ${brl(dueCents)}.`;
  }
  if (subject && dividendWithholdingCents > 0) {
    conclusion +=
      complementaryCents >= 0
        ? ` Com a retenção de ${brl(dividendWithholdingCents)} sobre dividendos (art. 6º-A), resta ${brl(complementaryCents)} a acrescentar ao saldo da declaração.`
        : ` A retenção de ${brl(dividendWithholdingCents)} sobre dividendos (art. 6º-A) supera o devido: ${brl(-complementaryCents)} reduzem o saldo a pagar ou aumentam a restituição.`;
  } else if (!subject && dividendWithholdingCents > 0) {
    conclusion += ` A retenção de ${brl(dividendWithholdingCents)} sobre dividendos (art. 6º-A) é compensada no ajuste anual.`;
  }

  return {
    calendarYear: input.calendarYear,
    exercise: input.calendarYear + 1,
    inForce: params.inForce,
    subject,
    totalIncomeCents,
    exclusionsCents,
    baseCents,
    thresholdCents: params.thresholdCents,
    excessCents: Math.max(0, baseCents - params.thresholdCents),
    ratePercent,
    grossTaxCents,
    deductions,
    reducer: { dividendsInBaseCents, pfEffectiveRatePercent, totalCents: reducerTotal, payers },
    dueCents,
    dividendWithholdingCents,
    complementaryCents: subject ? complementaryCents : -dividendWithholdingCents,
    effectiveRatePercent,
    composition,
    exclusions,
    conclusion,
    warnings,
    params,
  };
}

// ---------------------------------------------------------------------------
// Montagem a partir das linhas da declaração
// ---------------------------------------------------------------------------
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * Classificação das linhas da DIRPF para o IRPFM.
 *
 * Usa `kind` e a natureza (`extra.nature`, ver INCOME_NATURES). Ajustes por linha:
 * - `extra.irpfmExclusion`: força uma exclusão (chave de IRPFM_EXCLUSIONS);
 * - `extra.irpfmInclude: true`: força a inclusão na base;
 * - `extra.legacyDividends: true`: dividendos de lucros até 2025 aprovados até 31/12/2025 (XII);
 * - `extra.optedAnnualAdjustment: true`: RRA levado ao ajuste anual (entra na base);
 * - `extra.lostProfits: true`: indenização por lucros cessantes (entra na base);
 * - `extra.law14754: true` em "Imposto pago": IR da Lei 14.754/2023 (dedução III).
 */
export function irpfmFromItems(items: DeclarationItem[]) {
  const incomes: IrpfmIncomeLine[] = [];
  let exclusiveWithheldCents = 0;
  let definitiveTaxPaidCents = 0;
  let law14754TaxCents = 0;
  let dividendWithholdingCents = 0;

  const natureExclusion = (nature: string | null, extra: Record<string, unknown>): IrpfmExclusion | null => {
    if (extra.irpfmInclude === true) return null;
    const forced = str(extra.irpfmExclusion);
    if (forced && forced in IRPFM_EXCLUSIONS) return forced as IrpfmExclusion;
    switch (nature) {
      case 'capital_gain':
        return 'capital_gain';
      case 'inheritance_donation':
        return 'inheritance_donation';
      case 'financial_exempt':
        return 'exempt_investments';
      case 'indemnity':
        return extra.lostProfits === true ? null : 'indemnity';
      case 'retirement_illness':
        return 'serious_illness';
      case 'dividends':
        return extra.legacyDividends === true ? 'legacy_dividends' : null;
      default:
        return null;
    }
  };

  items.forEach((it, idx) => {
    const extra = it.extra ?? {};
    const nature = str(extra.nature);
    const value = it.valueCents ?? 0;
    const withheld = it.withheldCents ?? 0;
    const label = it.description || it.counterpartyName || 'Sem descrição';
    const base = { key: it.id ?? `${it.kind}-${idx}`, label, payerDoc: it.counterpartyDoc ?? null, payerName: it.counterpartyName ?? null };
    const isDividend = nature === 'dividends';
    switch (it.kind) {
      case 'income_pj':
      case 'income_pf':
      case 'income_suspended': {
        const exclusion = natureExclusion(nature, extra);
        incomes.push({ ...base, group: 'taxable', cents: value, exclusion, isDividend });
        break;
      }
      case 'income_exempt': {
        const exclusion = natureExclusion(nature, extra);
        incomes.push({ ...base, group: 'exempt', cents: value, exclusion, isDividend });
        if (isDividend) dividendWithholdingCents += withheld;
        break;
      }
      case 'income_exclusive': {
        const exclusion = natureExclusion(nature, extra);
        incomes.push({ ...base, group: 'exclusive', cents: value, exclusion, isDividend });
        if (isDividend) dividendWithholdingCents += withheld;
        else if (!exclusion) exclusiveWithheldCents += withheld;
        break;
      }
      case 'income_accumulated': {
        const opted = extra.optedAnnualAdjustment === true;
        const exclusion: IrpfmExclusion | null = opted ? null : (natureExclusion(nature, extra) ?? 'rra_exclusive');
        incomes.push({ ...base, group: opted ? 'taxable' : 'exclusive', cents: value, exclusion });
        if (!opted && !exclusion) exclusiveWithheldCents += withheld;
        break;
      }
      case 'capital_gain': {
        // ganho de capital fora de bolsa (alienação de bens e direitos)
        const exclusion = extra.irpfmInclude === true ? null : 'capital_gain';
        incomes.push({ ...base, group: 'exclusive', cents: value, exclusion });
        if (!exclusion) definitiveTaxPaidCents += withheld;
        break;
      }
      case 'variable_income': {
        // operações em bolsa com tributação sobre o ganho líquido: ficam na base (exceção do inciso I)
        incomes.push({ ...base, group: 'variable', cents: Math.max(0, value), exclusion: natureExclusion(null, extra) });
        definitiveTaxPaidCents += withheld + num(extra.taxPaidCents);
        break;
      }
      case 'rural_income':
        incomes.push({ ...base, label: `Receita rural: ${label}`, group: 'rural', cents: value, exclusion: natureExclusion(null, extra) });
        break;
      case 'rural_expense':
        incomes.push({ ...base, label: `Despesa rural: ${label}`, group: 'rural', cents: -value, exclusion: null });
        break;
      case 'tax_paid':
        if (extra.law14754 === true) law14754TaxCents += value;
        break;
      default:
        break;
    }
  });

  // resultado rural negativo não reduz a base (prejuízo é compensado em anos seguintes)
  const rural = incomes.filter((l) => l.group === 'rural' && !l.exclusion);
  const ruralResult = sumBy(rural, (l) => l.cents);
  if (ruralResult < 0) {
    for (const l of rural) l.cents = 0;
  }

  return { incomes, exclusiveWithheldCents, definitiveTaxPaidCents, law14754TaxCents, dividendWithholdingCents };
}

/**
 * IR devido na declaração de ajuste (dedução I) a partir dos totais gravados:
 * saldo (a pagar − a restituir) + IRRF e carnê-leão das linhas tributáveis + imposto pago
 * informado na ficha "Imposto pago/retido" (exceto o da Lei 14.754/2023).
 * Devolve null quando a declaração ainda não tem saldo apurado.
 */
export function regularTaxFromDeclaration(input: { taxDueCents?: number | null; refundCents?: number | null; items: DeclarationItem[] }): number | null {
  const taxDue = input.taxDueCents ?? 0;
  const refund = input.refundCents ?? 0;
  if (!taxDue && !refund) return null;
  const withheld = sumBy(
    input.items.filter((i) => i.kind === 'income_pj' || i.kind === 'income_pf'),
    (i) => i.withheldCents ?? 0,
  );
  const paid = sumBy(
    input.items.filter((i) => i.kind === 'tax_paid' && i.extra?.law14754 !== true),
    (i) => i.valueCents ?? 0,
  );
  return Math.max(0, taxDue - refund + withheld + paid);
}
