import type { DeclarationItem } from '../dirpf';
import { annualIrpfTable, annualIrpfTableWarning, annualTaxWithReduction, simplifiedDiscountCents } from './irpf-annual';

/**
 * Comparação entre a declaração completa e a simplificada, deduções legais e resultado da
 * atividade rural a partir das linhas da declaração.
 *
 * Os parâmetros do imposto (tabela progressiva, desconto simplificado, dedução por dependente,
 * limite de instrução e redução anual da Lei 15.270/2025) vêm SÓ de `irpf-annual.ts`.
 */

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
/** Pessoa a quem se refere uma despesa de instrução (limite anual por pessoa). */
export const educationBeneficiary = (p: DeclarationItem): string =>
  String((typeof p.extra?.beneficiaryCpf === 'string' && p.extra.beneficiaryCpf) || p.ownerCpf || 'titular');

// ---------------------------------------------------------------------------
// Atividade rural
// ---------------------------------------------------------------------------
export interface RuralResult {
  revenueCents: number;
  expensesCents: number;
  /** Receita − despesa do ano (art. 4º da Lei 8.023/1990); negativo = prejuízo. */
  grossResultCents: number;
  /** "Parcela isenta correspondente à atividade rural" lançada nos isentos (natureza 'rural'). */
  exemptPortionCents: number;
  /** Resultado pela opção de 20% da receita bruta (art. 5º da Lei 8.023/1990). */
  option20Cents: number;
  /** Resultado tributável usado nos cálculos (nunca negativo). */
  taxableCents: number;
  /**
   * De onde veio o tributável: 'informed' (informado pelo escritório, já com a opção de 20% e a
   * compensação de prejuízos do art. 14), 'exempt_portion' (resultado menos a parcela isenta
   * lançada nos isentos) ou 'gross' (receita − despesa, sem opção nem compensação).
   */
  source: 'informed' | 'exempt_portion' | 'gross';
}

/** Linha de isento com a "parcela isenta correspondente à atividade rural". */
export const isRuralExemptPortion = (i: DeclarationItem) => i.kind === 'income_exempt' && i.extra?.nature === 'rural';

/**
 * Resultado tributável da atividade rural.
 *
 * Na DIRPF, quando o resultado tributável escolhido (por exemplo, a opção de 20% da receita bruta)
 * é menor que receita − despesa, a diferença vai para os isentos como "Parcela isenta
 * correspondente à atividade rural". Por isso, sem um valor informado, o tributável é o resultado
 * menos essa parcela isenta; sem ela, é o próprio resultado (que pode estar superestimado: a
 * compensação de prejuízos e a opção de 20% não estão nas linhas).
 */
export function ruralResult(items: DeclarationItem[], informedTaxableCents?: number | null): RuralResult {
  const revenue = sum(items.filter((i) => i.kind === 'rural_income'), (i) => i.valueCents ?? 0);
  const expenses = sum(items.filter((i) => i.kind === 'rural_expense'), (i) => i.valueCents ?? 0);
  const gross = revenue - expenses;
  const exemptPortion = sum(items.filter(isRuralExemptPortion), (i) => i.valueCents ?? 0);
  const option20 = Math.round(Math.max(0, revenue) * 0.2);
  let taxable: number;
  let source: RuralResult['source'];
  if (informedTaxableCents !== undefined && informedTaxableCents !== null) {
    taxable = Math.max(0, Math.round(informedTaxableCents));
    source = 'informed';
  } else if (exemptPortion > 0) {
    taxable = Math.max(0, gross - exemptPortion);
    source = 'exempt_portion';
  } else {
    taxable = Math.max(0, gross);
    source = 'gross';
  }
  return { revenueCents: revenue, expensesCents: expenses, grossResultCents: gross, exemptPortionCents: exemptPortion, option20Cents: option20, taxableCents: taxable, source };
}

/** Rendimentos tributáveis sujeitos ao ajuste anual: PJ + PF/exterior + resultado rural tributável. */
export function taxableIncomeFromItems(items: DeclarationItem[], informedRuralTaxableCents?: number | null): number {
  const income = sum(items.filter((i) => i.kind === 'income_pj' || i.kind === 'income_pf'), (i) => i.valueCents ?? 0);
  return income + ruralResult(items, informedRuralTaxableCents).taxableCents;
}

// ---------------------------------------------------------------------------
// Deduções legais da declaração completa
// ---------------------------------------------------------------------------
export interface DeductionLine {
  key: string;
  label: string;
  cents: number;
  note?: string;
}

export interface LegalDeductions {
  lines: DeductionLine[];
  totalCents: number;
  uniqueDependents: number;
  /** Instrução antes e depois do limite por pessoa. */
  educationGrossCents: number;
  educationCents: number;
  /** PGBL antes e depois do limite de 12% dos tributáveis. */
  privatePensionGrossCents: number;
  privatePensionCents: number;
  privatePensionCapCents: number;
  /** Pagamentos sem natureza informada (não entram nas deduções). */
  paymentsWithoutNature: number;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (c: number) => brl.format(c / 100);

/**
 * Deduções legais da completa: previdência oficial, dependentes, saúde, instrução (limitada por
 * pessoa), pensão alimentícia e PGBL (até 12% dos tributáveis). Aluguel e demais pagamentos
 * ("Outros") NÃO são dedução legal.
 */
export function legalDeductions(items: DeclarationItem[], exercise: number, taxableIncomeCents: number): LegalDeductions {
  const table = annualIrpfTable(exercise);
  const by = (kind: DeclarationItem['kind']) => items.filter((i) => i.kind === kind);
  const income = [...by('income_pj'), ...by('income_pf')];
  const officialPension = sum(income, (i) => num(i.extra?.officialPensionCents));

  const dependents = by('dependent');
  const uniqueDependents = new Set(dependents.map((d, idx) => dependentCpf(d) || `sem-cpf-${idx}`)).size;
  const dependentsDeduction = uniqueDependents * table.dependentDeductionCents;

  const payments = by('payment');
  const ofNature = (n: string) => payments.filter((p) => paymentNature(p) === n);
  const health = sum(ofNature('health'), netPayment);
  const alimony = sum(ofNature('alimony'), netPayment);
  const educationByPerson = new Map<string, number>();
  for (const p of ofNature('education')) educationByPerson.set(educationBeneficiary(p), (educationByPerson.get(educationBeneficiary(p)) ?? 0) + netPayment(p));
  const educationGross = [...educationByPerson.values()].reduce((a, v) => a + v, 0);
  const education = [...educationByPerson.values()].reduce((a, v) => a + Math.min(v, table.educationCapCents), 0);
  const pensionCap = Math.round(Math.max(0, taxableIncomeCents) * 0.12);
  const privatePensionGross = sum(ofNature('private_pension'), netPayment);
  const privatePension = Math.min(privatePensionGross, pensionCap);

  const lines: DeductionLine[] = [
    { key: 'official_pension', label: 'Previdência oficial (INSS)', cents: officialPension },
    { key: 'dependents', label: `Dependentes (${uniqueDependents} × ${money(table.dependentDeductionCents)})`, cents: dependentsDeduction },
    { key: 'health', label: 'Despesas médicas', cents: health },
    {
      key: 'education',
      label: 'Instrução',
      cents: education,
      note: educationGross > education ? `${money(educationGross - education)} acima do limite de ${money(table.educationCapCents)} por pessoa` : undefined,
    },
    { key: 'alimony', label: 'Pensão alimentícia', cents: alimony },
    {
      key: 'private_pension',
      label: 'Previdência complementar (PGBL)',
      cents: privatePension,
      note: privatePensionGross > privatePension ? `${money(privatePensionGross - privatePension)} acima de 12% dos rendimentos tributáveis` : undefined,
    },
  ];
  return {
    lines,
    totalCents: lines.reduce((a, l) => a + l.cents, 0),
    uniqueDependents,
    educationGrossCents: educationGross,
    educationCents: education,
    privatePensionGrossCents: privatePensionGross,
    privatePensionCents: privatePension,
    privatePensionCapCents: pensionCap,
    paymentsWithoutNature: payments.filter((p) => !(typeof p.extra?.nature === 'string')).length,
  };
}

// ---------------------------------------------------------------------------
// Comparativo completa × simplificada
// ---------------------------------------------------------------------------
export interface TaxScenario {
  taxation: 'complete' | 'simplified';
  deductionsCents: number;
  baseCents: number;
  /** Imposto pela tabela progressiva, antes da redução do art. 11-A. */
  grossTaxCents: number;
  /** Redução anual do art. 11-A da Lei 9.250/1995 (Lei 15.270/2025). */
  reductionCents: number;
  /** Imposto devido (tabela − redução). */
  taxCents: number;
  effectiveRate: number;
  /** Positivo = imposto a pagar; negativo = imposto a restituir. */
  resultCents: number;
}

export interface TaxComparison {
  exerciseYear: number;
  taxableIncomeCents: number;
  prepaidTaxCents: number;
  /** O exercício tem a redução anual da Lei 15.270/2025. */
  annualReduction: boolean;
  deductionLines: DeductionLine[];
  rural: RuralResult;
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
  /** Resultado tributável da atividade rural, quando informado pelo escritório. */
  ruralTaxableResultCents?: number | null;
}

/**
 * Compara a declaração completa (deduções legais) com a simplificada (desconto de 20%, limitado)
 * e sugere ações para o próximo ano. Pagamentos entram nas deduções conforme `extra.nature`.
 * O imposto de cada opção já considera a redução anual do art. 11-A (a partir do exercício 2027).
 */
export function compareTaxation(input: TaxComparisonInput): TaxComparison {
  const { exerciseYear, items } = input;
  const table = annualIrpfTable(exerciseYear);
  const warnings: string[] = [];
  const tableWarning = annualIrpfTableWarning(exerciseYear);
  if (tableWarning) warnings.push(tableWarning);

  const by = (kind: DeclarationItem['kind']) => items.filter((i) => i.kind === kind);
  const pj = by('income_pj');
  const pf = by('income_pf');
  const rural = ruralResult(items, input.ruralTaxableResultCents);
  const taxable = sum(pj, (i) => i.valueCents ?? 0) + sum(pf, (i) => i.valueCents ?? 0) + rural.taxableCents;
  const prepaid = sum(pj, (i) => i.withheldCents ?? 0) + sum(pf, (i) => i.withheldCents ?? 0) + sum(by('tax_paid'), (i) => i.valueCents ?? 0);

  const legal = legalDeductions(items, exerciseYear, taxable);
  if (legal.paymentsWithoutNature) warnings.push(`${legal.paymentsWithoutNature} pagamento(s) sem natureza informada não entraram nas deduções.`);
  const completeDeductions = legal.totalCents;
  const simplifiedDiscount = simplifiedDiscountCents(taxable, exerciseYear);

  const scenario = (taxation: TaxScenario['taxation'], deductions: number): TaxScenario => {
    const base = Math.max(0, taxable - deductions);
    const t = annualTaxWithReduction(base, taxable, exerciseYear);
    return {
      taxation,
      deductionsCents: deductions,
      baseCents: base,
      grossTaxCents: t.grossTaxCents,
      reductionCents: t.reductionCents,
      taxCents: t.taxCents,
      effectiveRate: taxable > 0 ? t.taxCents / taxable : 0,
      resultCents: t.taxCents - prepaid,
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
  if (best === 'simplified' && taxable > 0 && simplified.taxCents > 0) {
    const gap = simplifiedDiscount - completeDeductions;
    if (gap > 0) suggestions.push(`As deduções legais somam ${money(completeDeductions)}. Com mais ${money(gap)} em deduções comprovadas, a completa passaria a valer a pena.`);
  }
  const pgblRoom = legal.privatePensionCapCents - legal.privatePensionCents;
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
  if (table.annualReduction && Math.max(complete.reductionCents, simplified.reductionCents) > 0) {
    suggestions.push(
      `Os rendimentos tributáveis de ${money(taxable)} dão direito à redução anual da Lei 15.270/2025 (art. 11-A da Lei 9.250/1995), já aplicada ao imposto: até R$ 60.000,00 o imposto é zero e a redução diminui até acabar em R$ 88.200,00.`,
    );
  }
  if (rural.source === 'gross' && rural.revenueCents > 0 && rural.option20Cents < rural.grossResultCents) {
    suggestions.push(
      `Na atividade rural, a opção pelo resultado de 20% da receita bruta (art. 5º da Lei 8.023/1990) tributaria ${money(rural.option20Cents)} em vez de ${money(rural.grossResultCents)} (receitas menos despesas). Confirme a forma de apuração e a compensação de prejuízos de anos anteriores.`,
    );
  }
  if (legal.educationGrossCents > legal.educationCents) suggestions.push('Parte das despesas de instrução excede o limite anual por pessoa e não reduz o imposto.');
  if (sum(pf, (i) => i.valueCents ?? 0) > 0) suggestions.push('Rendimentos recebidos de pessoas físicas ou do exterior exigem carnê-leão mensal; recolher em dia evita multa e juros.');
  if (legal.uniqueDependents > 0) {
    suggestions.push(`Cada dependente reduz a base em ${money(table.dependentDeductionCents)}, mas seus rendimentos e bens passam a compor a declaração; avalie se compensa mantê-los.`);
  }
  if (!suggestions.length) suggestions.push('Mantenha os comprovantes de despesas médicas, instrução e previdência organizados ao longo do ano.');

  return {
    exerciseYear,
    taxableIncomeCents: taxable,
    prepaidTaxCents: prepaid,
    annualReduction: table.annualReduction,
    deductionLines: legal.lines,
    rural,
    complete,
    simplified,
    best,
    savingsCents,
    suggestions,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Pensão alimentícia paga (relatório individual)
// ---------------------------------------------------------------------------
export interface AlimonyLine {
  /** Natureza do pagamento: a pensão ou uma despesa do alimentando. */
  nature: 'alimony' | 'health' | 'education';
  /** Código da ficha Pagamentos, como lançado (o sistema não presume a tabela de códigos). */
  code: string | null;
  description: string | null;
  /** Quem recebeu o pagamento (pode ser o representante do alimentando, a clínica, a escola). */
  payeeName: string | null;
  payeeDoc: string | null;
  paidCents: number;
  /** Parcela não dedutível ou reembolsada informada na linha. */
  nonDeductibleCents: number;
  /** Valor líquido da linha (antes do limite anual de instrução). */
  netCents: number;
}

export interface AlimonyRecipient {
  name: string;
  /** CPF do alimentando (só dígitos); vazio quando nenhuma linha traz. */
  cpf: string;
  /** Parentesco informado na linha da pensão (`extra.relationship`) ou na ficha de dependentes. */
  relationship: string | null;
  /** Códigos das linhas de pensão deste alimentando, sem repetição. */
  codes: string[];
  alimonyPaidCents: number;
  /** Pensão dedutível: o valor líquido, como nas deduções legais (`legalDeductions`). */
  alimonyDeductibleCents: number;
  alimonyNonDeductibleCents: number;
  healthCents: number;
  educationPaidCents: number;
  /** Instrução depois do limite anual por pessoa. */
  educationCents: number;
  totalDeductibleCents: number;
  /** O alimentando também está na ficha de dependentes desta declaração. */
  alsoDependent: boolean;
  lines: AlimonyLine[];
}

export interface AlimonySummary {
  recipients: AlimonyRecipient[];
  alimonyPaidCents: number;
  alimonyDeductibleCents: number;
  alimonyNonDeductibleCents: number;
  healthCents: number;
  educationPaidCents: number;
  educationCents: number;
  totalDeductibleCents: number;
  /** Limite anual de instrução por pessoa do exercício. */
  educationCapCents: number;
}

const personKey = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const cpfOf = (v: unknown) => {
  const d = String(v ?? '').replace(/\D+/g, '');
  return d.length === 11 ? d : '';
};

/** Pessoa a quem a linha se refere (paciente, aluno ou alimentando), quando informada. */
function paymentOwner(p: DeclarationItem): { name: string; cpf: string } | null {
  const name = String(p.ownerName ?? '').trim();
  const cpf = cpfOf((typeof p.extra?.beneficiaryCpf === 'string' && p.extra.beneficiaryCpf) || p.ownerCpf);
  return name || cpf ? { name, cpf } : null;
}

/**
 * Pensão alimentícia paga no ano, por alimentando, a partir das linhas de Pagamentos.
 *
 * Segue as deduções legais já usadas no planejamento (`legalDeductions`), sem regra nova:
 * - a pensão (natureza `alimony`) é dedutível pelo valor líquido da linha; a parte não dedutível
 *   (ex.: paga por acordo informal) é a "Parcela não dedutível / reembolsada" (`extra.reimbursedCents`);
 * - despesas médicas e de instrução entram quando a linha indica um alimentando (campo "Paciente,
 *   aluno ou alimentando" ou o CPF dele); a instrução respeita o limite anual por pessoa da tabela
 *   do exercício (`irpf-annual.ts`).
 *
 * O alimentando é a pessoa indicada na linha da pensão; sem ela, quem recebeu o pagamento.
 * Linhas da mesma pessoa se juntam pelo CPF ou, sem CPF, pelo nome.
 */
export function alimonySummary(items: DeclarationItem[], exercise: number): AlimonySummary {
  const table = annualIrpfTable(exercise);
  const payments = items.filter((i) => i.kind === 'payment');
  const alimony = payments.filter((p) => paymentNature(p) === 'alimony');

  const recipientOf = (p: DeclarationItem) => {
    const owner = paymentOwner(p);
    const payee = { name: String(p.counterpartyName ?? '').trim(), cpf: cpfOf(p.counterpartyDoc) };
    if (!owner) return payee;
    // alimentando informado só pelo nome e igual a quem recebeu: o CPF é o da contraparte
    return { name: owner.name || payee.name, cpf: owner.cpf || (payee.name && personKey(payee.name) === personKey(owner.name) ? payee.cpf : '') };
  };

  // o mesmo alimentando pode vir com CPF numa linha e só com o nome em outra
  const cpfByName = new Map<string, string>();
  for (const p of alimony) {
    const r = recipientOf(p);
    if (r.cpf && r.name && !cpfByName.has(personKey(r.name))) cpfByName.set(personKey(r.name), r.cpf);
  }
  const keyOf = (person: { name: string; cpf: string }) => person.cpf || cpfByName.get(personKey(person.name)) || (person.name ? `nome:${personKey(person.name)}` : 'sem-identificacao');

  const dependents = items.filter((i) => i.kind === 'dependent');
  const groups = new Map<string, AlimonyRecipient>();
  const line = (p: DeclarationItem, nature: AlimonyLine['nature']): AlimonyLine => {
    const paid = p.valueCents ?? 0;
    const net = netPayment(p);
    return {
      nature,
      code: p.code ? String(p.code) : null,
      description: p.description ?? null,
      payeeName: p.counterpartyName ?? null,
      payeeDoc: p.counterpartyDoc ?? null,
      paidCents: paid,
      nonDeductibleCents: Math.max(0, paid - net),
      netCents: net,
    };
  };

  for (const p of alimony) {
    const person = recipientOf(p);
    const key = keyOf(person);
    const g =
      groups.get(key) ??
      ({
        name: person.name,
        cpf: person.cpf || cpfByName.get(personKey(person.name)) || '',
        relationship: null,
        codes: [],
        alimonyPaidCents: 0,
        alimonyDeductibleCents: 0,
        alimonyNonDeductibleCents: 0,
        healthCents: 0,
        educationPaidCents: 0,
        educationCents: 0,
        totalDeductibleCents: 0,
        alsoDependent: false,
        lines: [],
      } satisfies AlimonyRecipient);
    const l = line(p, 'alimony');
    if (!g.name && person.name) g.name = person.name;
    if (!g.relationship && typeof p.extra?.relationship === 'string' && p.extra.relationship) g.relationship = p.extra.relationship;
    if (l.code && !g.codes.includes(l.code)) g.codes.push(l.code);
    g.alimonyPaidCents += l.paidCents;
    g.alimonyDeductibleCents += l.netCents;
    g.alimonyNonDeductibleCents += l.nonDeductibleCents;
    g.lines.push(l);
    groups.set(key, g);
  }

  // despesas médicas e de instrução lançadas em nome de um alimentando
  for (const p of payments) {
    const nature = paymentNature(p);
    if (nature !== 'health' && nature !== 'education') continue;
    const owner = paymentOwner(p);
    if (!owner) continue;
    const g = groups.get(keyOf(owner));
    if (!g) continue;
    const l = line(p, nature);
    if (nature === 'health') g.healthCents += l.netCents;
    else g.educationPaidCents += l.netCents;
    g.lines.push(l);
  }

  const recipients = [...groups.values()];
  for (const g of recipients) {
    g.educationCents = Math.min(g.educationPaidCents, table.educationCapCents);
    g.totalDeductibleCents = g.alimonyDeductibleCents + g.healthCents + g.educationCents;
    // pelo CPF quando os dois lados têm; senão, pelo nome
    const dependent = dependents.find((d) => {
      const cpf = dependentCpf(d);
      return g.cpf && cpf ? cpf === g.cpf : Boolean(g.name) && personKey(dependentName(d)) === personKey(g.name);
    });
    g.alsoDependent = Boolean(dependent);
    if (!g.relationship && typeof dependent?.extra?.relationship === 'string' && dependent.extra.relationship) g.relationship = dependent.extra.relationship;
  }
  const total = (f: (g: AlimonyRecipient) => number) => recipients.reduce((a, g) => a + f(g), 0);
  return {
    recipients,
    alimonyPaidCents: total((g) => g.alimonyPaidCents),
    alimonyDeductibleCents: total((g) => g.alimonyDeductibleCents),
    alimonyNonDeductibleCents: total((g) => g.alimonyNonDeductibleCents),
    healthCents: total((g) => g.healthCents),
    educationPaidCents: total((g) => g.educationPaidCents),
    educationCents: total((g) => g.educationCents),
    totalDeductibleCents: total((g) => g.totalDeductibleCents),
    educationCapCents: table.educationCapCents,
  };
}
