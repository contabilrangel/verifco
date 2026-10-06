import type { DeclarationItem } from '../dirpf';
import { taxParams } from './params';

/**
 * Tabela progressiva anual do IRPF e comparação entre a declaração completa e a simplificada.
 *
 * ATENÇÃO: as faixas são versionadas por ano-exercício. Os valores de 2026 (ano-calendário 2025)
 * combinam as tabelas mensais vigentes até abril e a partir de maio de 2025 e ficam marcados como
 * não confirmados até a conferência com a publicação oficial.
 */
export interface IrpfBracket {
  /** Limite superior da faixa (inclusive); null = sem limite. */
  upToCents: number | null;
  rate: number;
  deductionCents: number;
}

export interface IrpfTable {
  exercise: number;
  brackets: IrpfBracket[];
  confirmed: boolean;
}

const makeTable = (exercise: number, limits: [number, number, number, number], deductions: [number, number, number, number], confirmed = true): IrpfTable => ({
  exercise,
  confirmed,
  brackets: [
    { upToCents: limits[0], rate: 0, deductionCents: 0 },
    { upToCents: limits[1], rate: 0.075, deductionCents: deductions[0] },
    { upToCents: limits[2], rate: 0.15, deductionCents: deductions[1] },
    { upToCents: limits[3], rate: 0.225, deductionCents: deductions[2] },
    { upToCents: null, rate: 0.275, deductionCents: deductions[3] },
  ],
});

export const IRPF_TABLES: Record<number, IrpfTable> = {
  // exercícios 2016 a 2023 usaram a mesma tabela
  2023: makeTable(2023, [2_284_776, 3_391_980, 4_501_260, 5_597_616], [171_358, 425_757, 763_351, 1_043_232]),
  2024: makeTable(2024, [2_451_192, 3_391_980, 4_501_260, 5_597_616], [183_839, 438_238, 775_832, 1_055_713]),
  2025: makeTable(2025, [2_696_320, 3_391_980, 4_501_260, 5_597_616], [202_224, 456_623, 794_217, 1_074_098]),
  2026: makeTable(2026, [2_846_720, 3_391_980, 4_501_260, 5_597_616], [213_504, 467_903, 805_497, 1_085_378], false),
};

export function irpfTable(exercise: number): IrpfTable & { fallback: boolean } {
  if (IRPF_TABLES[exercise]) return { ...IRPF_TABLES[exercise], fallback: false };
  const years = Object.keys(IRPF_TABLES)
    .map(Number)
    .sort((a, b) => a - b);
  const pick = years.filter((y) => y <= exercise).pop() ?? years[0];
  return { ...IRPF_TABLES[pick], fallback: true };
}

/** Imposto anual sobre a base de cálculo (centavos). */
export function annualTax(baseCents: number, exercise: number): { taxCents: number; rate: number } {
  const t = irpfTable(exercise);
  const base = Math.max(0, baseCents);
  const bracket = t.brackets.find((b) => b.upToCents === null || base <= b.upToCents) ?? t.brackets[t.brackets.length - 1];
  return { taxCents: Math.max(0, Math.round(base * bracket.rate - bracket.deductionCents)), rate: bracket.rate };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sum = (list: DeclarationItem[], f: (i: DeclarationItem) => number) => list.reduce((a, i) => a + (f(i) || 0), 0);

/** Natureza de um pagamento (extra.nature), como cadastrada nas linhas da declaração. */
export const paymentNature = (i: DeclarationItem): string => (typeof i.extra?.nature === 'string' ? i.extra.nature : 'other');
/** Valor líquido de reembolso de um pagamento. */
export const netPayment = (i: DeclarationItem) => Math.max(0, (i.valueCents ?? 0) - num(i.extra?.reimbursedCents));

/** Documento de um dependente: extra.cpf, contraparte ou titular da linha. */
export const dependentCpf = (i: DeclarationItem): string =>
  String((typeof i.extra?.cpf === 'string' && i.extra.cpf) || i.counterpartyDoc || i.ownerCpf || '').replace(/\D+/g, '');
export const dependentName = (i: DeclarationItem): string =>
  String((typeof i.extra?.name === 'string' && i.extra.name) || i.counterpartyName || i.ownerName || i.description || 'Dependente');
/** Cônjuge/companheiro: extra.relationship = 'spouse' ou códigos 11/12 da ficha de dependentes. */
export const isSpouseDependent = (i: DeclarationItem) => i.kind === 'dependent' && (i.extra?.relationship === 'spouse' || ['11', '12'].includes(String(i.code ?? '')));

export interface TaxScenario {
  taxation: 'complete' | 'simplified';
  deductionsCents: number;
  baseCents: number;
  taxCents: number;
  effectiveRate: number;
  /** Positivo = imposto a pagar; negativo = imposto a restituir. */
  resultCents: number;
}

export interface TaxComparison {
  exerciseYear: number;
  taxableIncomeCents: number;
  prepaidTaxCents: number;
  deductionLines: { key: string; label: string; cents: number; note?: string }[];
  complete: TaxScenario;
  simplified: TaxScenario;
  best: 'complete' | 'simplified';
  savingsCents: number;
  suggestions: string[];
  warnings: string[];
}

export interface TaxComparisonInput {
  exerciseYear: number;
  items: DeclarationItem[];
  currentTaxation?: 'complete' | 'simplified' | null;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (c: number) => brl.format(c / 100);

/**
 * Compara a declaração completa (deduções legais) com a simplificada (desconto de 20%, limitado)
 * e sugere ações para o próximo ano. Pagamentos entram nas deduções conforme `extra.nature`.
 */
export function compareTaxation(input: TaxComparisonInput): TaxComparison {
  const { exerciseYear, items } = input;
  const params = taxParams(exerciseYear);
  const table = irpfTable(exerciseYear);
  const warnings: string[] = [];
  if (table.fallback) warnings.push(`O exercício ${exerciseYear} não tem tabela própria; usando a de ${table.exercise}.`);
  else if (!table.confirmed) warnings.push(`Tabela progressiva do exercício ${exerciseYear} ainda não conferida com a publicação oficial.`);

  const by = (kind: DeclarationItem['kind']) => items.filter((i) => i.kind === kind);
  const pj = by('income_pj');
  const pf = by('income_pf');
  const ruralNet = sum(by('rural_income'), (i) => i.valueCents ?? 0) - sum(by('rural_expense'), (i) => i.valueCents ?? 0);
  const taxable = sum(pj, (i) => i.valueCents ?? 0) + sum(pf, (i) => i.valueCents ?? 0) + Math.max(0, ruralNet);
  const officialPension = sum(pj, (i) => num(i.extra?.officialPensionCents)) + sum(pf, (i) => num(i.extra?.officialPensionCents));
  const prepaid = sum(pj, (i) => i.withheldCents ?? 0) + sum(pf, (i) => i.withheldCents ?? 0) + sum(by('tax_paid'), (i) => i.valueCents ?? 0);

  const dependents = by('dependent');
  const uniqueDependents = new Set(dependents.map((d, idx) => dependentCpf(d) || `sem-cpf-${idx}`)).size;
  const dependentsDeduction = uniqueDependents * params.dependentDeductionCents;

  const payments = by('payment');
  const ofNature = (n: string) => payments.filter((p) => paymentNature(p) === n);
  const health = sum(ofNature('health'), netPayment);
  const alimony = sum(ofNature('alimony'), netPayment);
  // instrução: limite anual por pessoa (titular e cada dependente)
  const educationByPerson = new Map<string, number>();
  for (const p of ofNature('education')) {
    const who = String((typeof p.extra?.beneficiaryCpf === 'string' && p.extra.beneficiaryCpf) || p.ownerCpf || 'titular');
    educationByPerson.set(who, (educationByPerson.get(who) ?? 0) + netPayment(p));
  }
  const educationGross = [...educationByPerson.values()].reduce((a, v) => a + v, 0);
  const education = [...educationByPerson.values()].reduce((a, v) => a + Math.min(v, params.educationCapCents), 0);
  const pensionCap = Math.round(taxable * 0.12);
  const privatePensionGross = sum(ofNature('private_pension'), netPayment);
  const privatePension = Math.min(privatePensionGross, pensionCap);
  const withoutNature = payments.filter((p) => !(typeof p.extra?.nature === 'string')).length;
  if (withoutNature) warnings.push(`${withoutNature} pagamento(s) sem natureza informada não entraram nas deduções.`);

  const deductionLines = [
    { key: 'official_pension', label: 'Previdência oficial (INSS)', cents: officialPension },
    { key: 'dependents', label: `Dependentes (${uniqueDependents} × ${money(params.dependentDeductionCents)})`, cents: dependentsDeduction },
    { key: 'health', label: 'Despesas médicas', cents: health },
    {
      key: 'education',
      label: 'Instrução',
      cents: education,
      note: educationGross > education ? `${money(educationGross - education)} acima do limite de ${money(params.educationCapCents)} por pessoa` : undefined,
    },
    { key: 'alimony', label: 'Pensão alimentícia', cents: alimony },
    {
      key: 'private_pension',
      label: 'Previdência complementar (PGBL)',
      cents: privatePension,
      note: privatePensionGross > privatePension ? `${money(privatePensionGross - privatePension)} acima de 12% dos rendimentos tributáveis` : undefined,
    },
  ];
  const completeDeductions = deductionLines.reduce((a, l) => a + l.cents, 0);
  const simplifiedDiscount = Math.min(Math.round(taxable * 0.2), params.simplifiedDiscountCapCents);

  const scenario = (taxation: TaxScenario['taxation'], deductions: number): TaxScenario => {
    const base = Math.max(0, taxable - deductions);
    const { taxCents } = annualTax(base, exerciseYear);
    return {
      taxation,
      deductionsCents: deductions,
      baseCents: base,
      taxCents,
      effectiveRate: taxable > 0 ? taxCents / taxable : 0,
      resultCents: taxCents - prepaid,
    };
  };
  const complete = scenario('complete', completeDeductions);
  const simplified = scenario('simplified', simplifiedDiscount);
  const best = complete.taxCents < simplified.taxCents ? 'complete' : simplified.taxCents < complete.taxCents ? 'simplified' : (input.currentTaxation ?? 'simplified');
  const savingsCents = Math.abs(complete.taxCents - simplified.taxCents);

  const suggestions: string[] = [];
  if (input.currentTaxation && input.currentTaxation !== best && savingsCents > 0) {
    suggestions.push(`A declaração foi feita na ${input.currentTaxation === 'complete' ? 'completa' : 'simplificada'}, mas a ${best === 'complete' ? 'completa' : 'simplificada'} reduziria o imposto em ${money(savingsCents)}.`);
  }
  if (best === 'simplified' && taxable > 0) {
    const gap = simplifiedDiscount - completeDeductions;
    if (gap > 0) suggestions.push(`As deduções legais somam ${money(completeDeductions)}. Com mais ${money(gap)} em deduções comprovadas, a completa passaria a valer a pena.`);
  }
  const pgblRoom = pensionCap - privatePension;
  if (pgblRoom > 0 && taxable > 0) {
    const withPgbl = scenario('complete', completeDeductions + pgblRoom);
    const bestTax = Math.min(complete.taxCents, simplified.taxCents);
    const gain = bestTax - withPgbl.taxCents;
    if (gain > 0) {
      suggestions.push(`Contribuir com ${money(pgblRoom)} em PGBL (até 12% dos rendimentos tributáveis) e optar pela completa reduziria o imposto em cerca de ${money(gain)}.`);
    }
  }
  if (best === 'complete' && complete.taxCents > 0) {
    suggestions.push(`Na completa, doações a fundos da criança, do adolescente e do idoso podem abater até ${money(Math.round(complete.taxCents * 0.06))} (6% do imposto devido).`);
  }
  if (educationGross > education) suggestions.push('Parte das despesas de instrução excede o limite anual por pessoa e não reduz o imposto.');
  if (sum(pf, (i) => i.valueCents ?? 0) > 0) suggestions.push('Rendimentos recebidos de pessoas físicas ou do exterior exigem carnê-leão mensal; recolher em dia evita multa e juros.');
  if (uniqueDependents > 0) {
    suggestions.push(`Cada dependente reduz a base em ${money(params.dependentDeductionCents)}, mas seus rendimentos e bens passam a compor a declaração; avalie se compensa mantê-los.`);
  }
  if (!suggestions.length) suggestions.push('Mantenha os comprovantes de despesas médicas, instrução e previdência organizados ao longo do ano.');

  return {
    exerciseYear,
    taxableIncomeCents: taxable,
    prepaidTaxCents: prepaid,
    deductionLines,
    complete,
    simplified,
    best,
    savingsCents,
    suggestions,
    warnings,
  };
}
