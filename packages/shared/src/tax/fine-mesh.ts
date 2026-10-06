import type { DeclarationItem } from '../dirpf';
import { cashAnalysis, type CashAnalysisInput } from './cash-analysis';
import { dependentCpf, dependentName, irpfTable, netPayment, paymentNature } from './irpf';
import { taxParams } from './params';

/**
 * Planilha de aviso de malha fina: pontos de atenção derivados das linhas da declaração.
 *
 * Não reproduz os cruzamentos da Receita; aponta inconsistências comuns que costumam
 * levar a declaração para a malha (despesas médicas altas, saldo de caixa negativo,
 * dependentes repetidos, rendimentos de PF sem carnê-leão etc.).
 */
export type AttentionSeverity = 'high' | 'medium' | 'low';

export const ATTENTION_SEVERITY: Record<AttentionSeverity, string> = {
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
};

export interface AttentionPoint {
  key: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  recommendation: string;
  valueCents?: number;
}

export interface FineMeshInput extends CashAnalysisInput {
  /** CPF do titular, para detectar o titular repetido como dependente. */
  holderCpf?: string | null;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (c: number) => brl.format(c / 100);
const pct = (v: number) => `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const digits = (v: unknown) => String(v ?? '').replace(/\D+/g, '');
const sum = (list: DeclarationItem[], f: (i: DeclarationItem) => number) => list.reduce((a, i) => a + (f(i) || 0), 0);
const SEVERITY_ORDER: AttentionSeverity[] = ['high', 'medium', 'low'];

export function fineMeshCheck(input: FineMeshInput): AttentionPoint[] {
  const { items } = input;
  const by = (kind: DeclarationItem['kind']) => items.filter((i) => i.kind === kind);
  const points: AttentionPoint[] = [];
  if (!items.length) return points;

  const cash = cashAnalysis(input);
  const taxable = sum([...by('income_pj'), ...by('income_pf')], (i) => i.valueCents ?? 0);
  const allIncome =
    taxable +
    sum([...by('income_exempt'), ...by('income_suspended'), ...by('income_accumulated'), ...by('capital_gain'), ...by('variable_income'), ...by('rural_income')], (i) => i.valueCents ?? 0) +
    sum(by('income_exclusive'), (i) => (i.valueCents ?? 0) - (i.withheldCents ?? 0));

  // 1. saldo de caixa negativo
  if (cash.balanceCents < 0) {
    points.push({
      key: 'negative_cash',
      severity: 'high',
      title: 'Saldo de caixa negativo',
      detail: `Os gastos e aquisições do ano superam os recursos declarados em ${money(-cash.balanceCents)}.`,
      recommendation: 'Confira rendimentos isentos, de dependentes, empréstimos recebidos e os valores de bens e dívidas.',
      valueCents: cash.balanceCents,
    });
  }

  // 2. variação patrimonial maior que a renda do ano
  if (cash.netWorthVariationCents > 0 && cash.netWorthVariationCents > allIncome) {
    points.push({
      key: 'patrimony_incompatible',
      severity: 'high',
      title: 'Variação patrimonial incompatível com a renda',
      detail: `O patrimônio líquido cresceu ${money(cash.netWorthVariationCents)}, acima de toda a renda declarada (${money(allIncome)}).`,
      recommendation: 'Documente a origem dos recursos (heranças, doações, empréstimos, venda de bens) e informe-os na declaração.',
      valueCents: cash.netWorthVariationCents,
    });
  }

  // 3. despesas médicas altas em relação à renda
  const healthItems = by('payment').filter((p) => paymentNature(p) === 'health');
  const health = sum(healthItems, netPayment);
  if (health > 0 && taxable > 0) {
    const ratio = health / taxable;
    if (ratio >= 0.2) {
      points.push({
        key: 'high_medical',
        severity: ratio >= 0.4 ? 'high' : 'medium',
        title: 'Despesas médicas altas em relação à renda',
        detail: `Despesas médicas de ${money(health)} equivalem a ${pct(ratio)} dos rendimentos tributáveis.`,
        recommendation: 'Guarde notas fiscais e recibos com CPF/CNPJ do profissional; a Receita cruza esses valores com a DMED e o Receita Saúde.',
        valueCents: health,
      });
    }
  }

  // 4. pagamentos sem CPF/CNPJ do beneficiário
  const deductible = by('payment').filter((p) => ['health', 'education', 'alimony', 'private_pension'].includes(paymentNature(p)));
  const noDoc = deductible.filter((p) => digits(p.counterpartyDoc).length < 11);
  if (noDoc.length) {
    const healthNoDoc = noDoc.some((p) => paymentNature(p) === 'health');
    points.push({
      key: 'payment_without_doc',
      severity: healthNoDoc ? 'high' : 'medium',
      title: 'Pagamentos sem CPF/CNPJ do beneficiário',
      detail: `${noDoc.length} pagamento(s) dedutível(is) sem documento do prestador, somando ${money(sum(noDoc, netPayment))}.`,
      recommendation: 'Informe o CPF ou CNPJ de quem recebeu cada pagamento.',
      valueCents: sum(noDoc, netPayment),
    });
  }

  // 5. reembolso maior que o pagamento
  const overReimbursed = by('payment').filter((p) => Number(p.extra?.reimbursedCents ?? 0) > (p.valueCents ?? 0));
  if (overReimbursed.length) {
    points.push({
      key: 'reimbursement_exceeds',
      severity: 'high',
      title: 'Reembolso maior que o valor pago',
      detail: `${overReimbursed.length} pagamento(s) com parcela reembolsada acima do valor pago.`,
      recommendation: 'Revise os valores pagos e reembolsados informados pelo plano de saúde.',
    });
  }

  // 6. rendimentos de PF/exterior sem carnê-leão
  const pf = by('income_pf');
  const pfTotal = sum(pf, (i) => i.valueCents ?? 0);
  const pfPaid = sum(pf, (i) => i.withheldCents ?? 0) + sum(by('tax_paid'), (i) => i.valueCents ?? 0);
  if (pfTotal > 0 && pfPaid === 0) {
    // acima da faixa anual de isenção, certamente houve mês com imposto devido
    const exemptLimit = irpfTable(input.exerciseYear).brackets[0].upToCents ?? 0;
    points.push({
      key: 'pf_income_without_carne_leao',
      severity: pfTotal > exemptLimit ? 'high' : 'medium',
      title: 'Rendimentos de PF sem carnê-leão',
      detail: `${money(pfTotal)} recebidos de pessoas físicas ou do exterior sem recolhimento mensal informado.`,
      recommendation: 'Confira se houve meses acima do limite de isenção e emita os DARFs do carnê-leão em atraso.',
      valueCents: pfTotal,
    });
  }

  // 7. dependentes repetidos, sem CPF ou iguais ao titular
  const dependents = by('dependent');
  const seen = new Map<string, number>();
  for (const d of dependents) {
    const cpf = dependentCpf(d);
    if (cpf) seen.set(cpf, (seen.get(cpf) ?? 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, n]) => n > 1);
  const holder = digits(input.holderCpf);
  const holderAsDependent = holder && seen.has(holder);
  if (repeated.length || holderAsDependent) {
    const names = dependents.filter((d) => repeated.some(([cpf]) => cpf === dependentCpf(d))).map(dependentName);
    points.push({
      key: 'duplicate_dependents',
      severity: 'high',
      title: 'Dependentes repetidos',
      detail: holderAsDependent ? 'O CPF do titular aparece também como dependente.' : `Dependente informado mais de uma vez: ${[...new Set(names)].join(', ')}.`,
      recommendation: 'Cada dependente deve aparecer uma única vez e em uma única declaração.',
    });
  }
  const noCpf = dependents.filter((d) => !dependentCpf(d));
  if (noCpf.length) {
    points.push({
      key: 'dependent_without_cpf',
      severity: 'medium',
      title: 'Dependente sem CPF',
      detail: `${noCpf.length} dependente(s) sem CPF informado.`,
      recommendation: 'O CPF é obrigatório para todos os dependentes, inclusive recém-nascidos.',
    });
  }

  // 8. IRRF incoerente com o rendimento
  const badIrrf = by('income_pj').filter((i) => (i.withheldCents ?? 0) > Math.round((i.valueCents ?? 0) * 0.275));
  if (badIrrf.length) {
    points.push({
      key: 'irrf_inconsistent',
      severity: 'medium',
      title: 'Imposto retido acima do esperado',
      detail: `${badIrrf.length} fonte(s) pagadora(s) com IRRF maior que 27,5% do rendimento.`,
      recommendation: 'Confira o informe de rendimentos: valores de 13º salário e rendimento tributável podem estar trocados.',
    });
  }

  // 9. fonte pagadora repetida para o mesmo beneficiário
  const payerKey = (i: DeclarationItem) => `${digits(i.counterpartyDoc)}|${digits(i.ownerCpf)}`;
  const payers = new Map<string, number>();
  for (const i of by('income_pj')) if (digits(i.counterpartyDoc)) payers.set(payerKey(i), (payers.get(payerKey(i)) ?? 0) + 1);
  const dupPayers = [...payers.values()].filter((n) => n > 1).length;
  if (dupPayers) {
    points.push({
      key: 'duplicate_payer',
      severity: 'low',
      title: 'Fonte pagadora repetida',
      detail: `${dupPayers} fonte(s) pagadora(s) aparecem mais de uma vez para o mesmo beneficiário.`,
      recommendation: 'Verifique se o mesmo informe de rendimentos não foi lançado em duplicidade.',
    });
  }

  // 10. bem baixado sem ganho de capital
  const sold = by('asset').filter((a) => (a.prevValueCents ?? 0) > 0 && (a.valueCents ?? 0) === 0 && ['01', '02', '03'].includes(String(a.groupCode ?? '')));
  if (sold.length && !by('capital_gain').length) {
    points.push({
      key: 'asset_sold_without_gain',
      severity: 'medium',
      title: 'Bem baixado sem ganho de capital',
      detail: `${sold.length} bem(ns) (imóveis, veículos ou participações) zerado(s) no ano sem apuração de ganho de capital.`,
      recommendation: 'Se houve venda com lucro, apure o ganho de capital (GCAP) e confira o DARF do imposto.',
      valueCents: sum(sold, (a) => a.prevValueCents ?? 0),
    });
  }

  // 11. previdência complementar acima de 12%
  const pgbl = sum(by('payment').filter((p) => paymentNature(p) === 'private_pension'), netPayment);
  if (taxable > 0 && pgbl > Math.round(taxable * 0.12)) {
    points.push({
      key: 'pgbl_over_limit',
      severity: 'low',
      title: 'Previdência complementar acima de 12%',
      detail: `${money(pgbl - Math.round(taxable * 0.12))} de PGBL excedem o limite dedutível.`,
      recommendation: 'O excedente não reduz o imposto; informe-o normalmente, mas não espere dedução.',
    });
  }

  // 12. instrução acima do limite
  const params = taxParams(input.exerciseYear);
  const edu = new Map<string, number>();
  for (const p of by('payment').filter((x) => paymentNature(x) === 'education')) {
    const who = String(p.extra?.beneficiaryCpf ?? p.ownerCpf ?? 'titular');
    edu.set(who, (edu.get(who) ?? 0) + netPayment(p));
  }
  const overEdu = [...edu.values()].filter((v) => v > params.educationCapCents).length;
  if (overEdu) {
    points.push({
      key: 'education_over_cap',
      severity: 'low',
      title: 'Instrução acima do limite',
      detail: `${overEdu} pessoa(s) com despesas de instrução acima de ${money(params.educationCapCents)}.`,
      recommendation: 'O excedente não é dedutível; não há risco de malha, apenas sem efeito no imposto.',
    });
  }

  return points.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}
