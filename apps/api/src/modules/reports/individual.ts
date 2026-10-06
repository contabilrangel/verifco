import {
  ASSET_GROUPS,
  INCOME_NATURES,
  ITEM_KINDS,
  PAYMENT_NATURES,
  TAXATION_TYPES,
  cashAnalysis,
  compareTaxation,
  dependentName,
  fineMeshCheck,
  formatCpfCnpj,
  getIndividualReport,
  netPayment,
  paymentNature,
  type CashAnalysisResult,
  type DeclarationItem,
  type IndividualReportKey,
} from '@verifco/shared';
import type { OfficeSettings } from '../../db/schema';
import type { CustomerRow } from '../../services/customers';
import type { DeclarationRow } from '../../services/declarations';
import type { HistoryYear } from './data';
import type { Block, Cell, Section } from './document';

export interface PersonContext {
  customer: CustomerRow;
  declaration: DeclarationRow;
  items: DeclarationItem[];
  history: HistoryYear[];
}

const m = (cents: number): Cell => ({ money: cents });
const by = (items: DeclarationItem[], ...kinds: DeclarationItem['kind'][]) => items.filter((i) => kinds.includes(i.kind));
const sum = (list: DeclarationItem[], f: (i: DeclarationItem) => number) => list.reduce((a, i) => a + (f(i) || 0), 0);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const personSubtitle = (p: PersonContext) =>
  `${p.customer.name} · CPF ${formatCpfCnpj(p.customer.cpfCnpj)} · Exercício ${p.declaration.exerciseYear} (ano-calendário ${p.declaration.exerciseYear - 1})`;

export const taxationOf = (d: DeclarationRow) => (d.taxation === 'complete' || d.taxation === 'simplified' ? d.taxation : null);
export const taxationLabel = (d: DeclarationRow) => {
  const t = taxationOf(d);
  return t ? TAXATION_TYPES[t] : 'Não informada';
};

const groupLabel = (code: string | null | undefined) => {
  const g = String(code ?? '99').padStart(2, '0') as keyof typeof ASSET_GROUPS;
  return ASSET_GROUPS[g] ?? `Grupo ${code}`;
};
const payer = (i: DeclarationItem) => i.counterpartyName || i.description || (i.counterpartyDoc ? formatCpfCnpj(i.counterpartyDoc) : '—');
const natureLabel = (i: DeclarationItem) => {
  const n = typeof i.extra?.nature === 'string' ? i.extra.nature : null;
  if (!n) return ITEM_KINDS[i.kind]?.label ?? i.kind;
  return (PAYMENT_NATURES as Record<string, string>)[n] ?? (INCOME_NATURES as Record<string, string>)[n] ?? n;
};

export function runCash(p: PersonContext, settings: Required<OfficeSettings>): CashAnalysisResult {
  return cashAnalysis({
    exerciseYear: p.declaration.exerciseYear,
    taxation: taxationOf(p.declaration),
    items: p.items,
    otherExpenses: p.declaration.otherExpenses,
    simplifiedDiscountMode: settings.cashAnalysisSimplifiedDiscount,
  });
}

const cashVerdict = (c: CashAnalysisResult) =>
  c.status === 'negative'
    ? 'Saldo negativo: os gastos e aquisições do ano superam os recursos declarados. Revise rendimentos, bens e dívidas antes de transmitir.'
    : c.status === 'positive'
      ? 'Saldo positivo: os recursos declarados cobrem os gastos e as aquisições do ano.'
      : 'Saldo zerado: recursos e aplicações se equilibram.';

function cashBlocks(c: CashAnalysisResult, year: number): Block[] {
  const ac = year - 1;
  return [
    {
      type: 'stats',
      items: [
        { label: 'Recursos do ano', value: m(c.totalSourcesCents) },
        { label: 'Aplicações do ano', value: m(c.totalUsesCents) },
        { label: 'Saldo de caixa', value: m(c.balanceCents), tone: c.balanceCents < 0 ? 'negative' : 'positive' },
      ],
    },
    {
      type: 'table',
      title: 'Recursos (origens)',
      columns: [{ label: 'Descrição', width: 3 }, { label: 'Valor', width: 1, align: 'right' }],
      rows: c.sources.map((l) => [l.label, m(l.cents)]),
      totals: ['Total de recursos', m(c.totalSourcesCents)],
    },
    {
      type: 'table',
      title: 'Aplicações (usos)',
      columns: [{ label: 'Descrição', width: 3 }, { label: 'Valor', width: 1, align: 'right' }],
      rows: c.uses.map((l) => [l.label, m(l.cents)]),
      totals: ['Total de aplicações', m(c.totalUsesCents)],
    },
    {
      type: 'kv',
      title: 'Patrimônio',
      pairs: [
        [`Bens e direitos em 31/12/${ac - 1}`, m(c.assetsPrevCents)],
        [`Bens e direitos em 31/12/${ac}`, m(c.assetsCents)],
        [`Dívidas em 31/12/${ac - 1}`, m(c.debtsPrevCents)],
        [`Dívidas em 31/12/${ac}`, m(c.debtsCents)],
        ['Variação do patrimônio líquido', m(c.netWorthVariationCents)],
      ],
    },
    { type: 'text', text: cashVerdict(c) },
    ...c.warnings.map((w): Block => ({ type: 'text', text: w, muted: true })),
  ];
}

function cashAnalysisSection(p: PersonContext, settings: Required<OfficeSettings>, title: string): Section {
  const c = runCash(p, settings);
  const other = p.declaration.otherExpenses ?? {};
  const blocks = cashBlocks(c, p.declaration.exerciseYear);
  const otherPairs: [string, Cell][] = (
    [
      ['Pagamento anual total', other.annualPaymentCents],
      ['Pagamento anual — principal', other.principalCents],
      ['Pagamento anual — juros', other.interestCents],
      ['Despesas com cartão de crédito', other.creditCardCents],
      ['Perdas de capital', other.capitalLossCents],
    ] as [string, number | undefined][]
  )
    .filter(([, v]) => num(v) > 0)
    .map(([k, v]) => [k, m(num(v))]);
  if (otherPairs.length) blocks.splice(3, 0, { type: 'kv', title: 'Outros gastos informados', pairs: otherPairs });
  blocks.push({ type: 'text', text: `Tributação: ${taxationLabel(p.declaration)}.`, muted: true });
  return { key: 'cash_analysis', title, subtitle: personSubtitle(p), blocks };
}

function cashDetailsSection(p: PersonContext, title: string): Section {
  const { items } = p;
  const ac = p.declaration.exerciseYear - 1;
  const income = by(items, 'income_pj', 'income_pf');
  const otherIncome = by(items, 'income_exempt', 'income_exclusive', 'income_suspended', 'income_accumulated', 'capital_gain', 'variable_income', 'rural_income', 'rural_expense');
  const payments = by(items, 'payment');
  const assets = by(items, 'asset', 'rural_asset');
  const debts = by(items, 'debt', 'rural_debt');
  const taxPaid = by(items, 'tax_paid');
  const donations = by(items, 'donation');
  const delta = (i: DeclarationItem) => (i.valueCents ?? 0) - (i.prevValueCents ?? 0);
  const blocks: Block[] = [
    {
      type: 'table',
      title: 'Rendimentos tributáveis',
      columns: [
        { label: 'Fonte pagadora', width: 3 },
        { label: 'Tipo', width: 1.6 },
        { label: 'Rendimento', width: 1.3, align: 'right' },
        { label: 'Prev. oficial', width: 1.2, align: 'right' },
        { label: 'Imposto retido', width: 1.3, align: 'right' },
      ],
      rows: income.map((i) => [payer(i), i.kind === 'income_pj' ? 'Pessoa jurídica' : 'PF / exterior', m(i.valueCents ?? 0), m(num(i.extra?.officialPensionCents)), m(i.withheldCents ?? 0)]),
      totals: ['Total', '', m(sum(income, (i) => i.valueCents ?? 0)), m(sum(income, (i) => num(i.extra?.officialPensionCents))), m(sum(income, (i) => i.withheldCents ?? 0))],
      empty: 'Nenhum rendimento tributável informado.',
    },
    {
      type: 'table',
      title: 'Outros rendimentos e resultados',
      columns: [{ label: 'Descrição', width: 3 }, { label: 'Ficha', width: 2.2 }, { label: 'Valor', width: 1.3, align: 'right' }, { label: 'Imposto', width: 1.2, align: 'right' }],
      rows: otherIncome.map((i) => [payer(i), natureLabel(i), m(i.kind === 'rural_expense' ? -(i.valueCents ?? 0) : (i.valueCents ?? 0)), m(i.withheldCents ?? 0)]),
      empty: 'Nenhum outro rendimento informado.',
    },
    {
      type: 'table',
      title: 'Pagamentos efetuados',
      columns: [{ label: 'Beneficiário', width: 3 }, { label: 'Natureza', width: 2 }, { label: 'Pago', width: 1.2, align: 'right' }, { label: 'Reembolsado', width: 1.2, align: 'right' }, { label: 'Líquido', width: 1.2, align: 'right' }],
      rows: payments.map((i) => [payer(i), natureLabel(i), m(i.valueCents ?? 0), m(num(i.extra?.reimbursedCents)), m(netPayment(i))]),
      totals: ['Total', '', m(sum(payments, (i) => i.valueCents ?? 0)), m(sum(payments, (i) => num(i.extra?.reimbursedCents))), m(sum(payments, netPayment))],
      empty: 'Nenhum pagamento informado.',
    },
    {
      type: 'table',
      title: 'Bens e direitos (variação no ano)',
      columns: [{ label: 'Bem', width: 3.2 }, { label: `31/12/${ac - 1}`, width: 1.3, align: 'right' }, { label: `31/12/${ac}`, width: 1.3, align: 'right' }, { label: 'Variação', width: 1.3, align: 'right' }],
      rows: assets.map((i) => [i.description || groupLabel(i.groupCode), m(i.prevValueCents ?? 0), m(i.valueCents ?? 0), m(delta(i))]),
      totals: ['Total', m(sum(assets, (i) => i.prevValueCents ?? 0)), m(sum(assets, (i) => i.valueCents ?? 0)), m(sum(assets, delta))],
      empty: 'Nenhum bem informado.',
    },
    {
      type: 'table',
      title: 'Dívidas e ônus reais (variação no ano)',
      columns: [{ label: 'Dívida', width: 3.2 }, { label: `31/12/${ac - 1}`, width: 1.3, align: 'right' }, { label: `31/12/${ac}`, width: 1.3, align: 'right' }, { label: 'Variação', width: 1.3, align: 'right' }],
      rows: debts.map((i) => [i.description || payer(i), m(i.prevValueCents ?? 0), m(i.valueCents ?? 0), m(delta(i))]),
      totals: ['Total', m(sum(debts, (i) => i.prevValueCents ?? 0)), m(sum(debts, (i) => i.valueCents ?? 0)), m(sum(debts, delta))],
      empty: 'Nenhuma dívida informada.',
    },
  ];
  if (donations.length || taxPaid.length) {
    blocks.push({
      type: 'table',
      title: 'Doações e impostos pagos',
      columns: [{ label: 'Descrição', width: 3 }, { label: 'Ficha', width: 2 }, { label: 'Valor', width: 1.2, align: 'right' }],
      rows: [...donations, ...taxPaid].map((i) => [i.description || payer(i), ITEM_KINDS[i.kind].label, m(i.valueCents ?? 0)]),
    });
  }
  return { key: 'cash_details', title, subtitle: personSubtitle(p), blocks };
}

function patrimonyHistorySection(p: PersonContext, title: string): Section {
  const h = p.history;
  const groups = [...new Set(h.flatMap((y) => Object.keys(y.assetsByGroup)))].sort();
  const blocks: Block[] = [
    { type: 'bars', title: 'Patrimônio líquido por exercício', items: h.map((y) => ({ label: String(y.exerciseYear), cents: y.netWorthCents })) },
    {
      type: 'table',
      title: 'Evolução do patrimônio',
      columns: [
        { label: 'Exercício', width: 1 },
        { label: 'Bens e direitos', width: 1.5, align: 'right' },
        { label: 'Dívidas', width: 1.3, align: 'right' },
        { label: 'Patrimônio líquido', width: 1.5, align: 'right' },
        { label: 'Variação', width: 1.3, align: 'right' },
      ],
      rows: h.map((y, i) => [
        `${y.exerciseYear}${y.hasItems || y.declarationId ? '' : ' (sem declaração)'}`,
        m(y.assetsCents),
        m(y.debtsCents),
        m(y.netWorthCents),
        i === 0 ? '—' : m(y.netWorthCents - h[i - 1].netWorthCents),
      ]),
    },
  ];
  if (groups.length) {
    blocks.push({
      type: 'table',
      title: 'Bens por grupo em 31/12 de cada ano-calendário',
      columns: [{ label: 'Grupo', width: 2.2 }, ...h.map((y) => ({ label: String(y.exerciseYear), width: 1, align: 'right' as const }))],
      rows: groups.map((g) => [g === 'rural' ? 'Atividade rural' : groupLabel(g), ...h.map((y) => (y.hasItems ? m(y.assetsByGroup[g] ?? 0) : '—'))]),
    });
  }
  if (h.some((y) => !y.hasItems)) blocks.push({ type: 'text', text: 'Exercícios sem linhas cadastradas usam os totais gravados na declaração; o detalhamento por grupo fica indisponível.', muted: true });
  return { key: 'patrimony_history', title, subtitle: personSubtitle(p), blocks };
}

function cashHistorySection(p: PersonContext, title: string): Section {
  const h = p.history;
  const withCash = h.filter((y) => y.cash);
  return {
    key: 'cash_history',
    title,
    subtitle: personSubtitle(p),
    blocks: [
      { type: 'bars', title: 'Saldo de caixa por exercício', items: withCash.map((y) => ({ label: String(y.exerciseYear), cents: y.cash!.balanceCents })) },
      {
        type: 'table',
        title: 'Caixa dos últimos exercícios',
        columns: [
          { label: 'Exercício', width: 1 },
          { label: 'Rendimentos', width: 1.4, align: 'right' },
          { label: 'Recursos', width: 1.4, align: 'right' },
          { label: 'Aplicações', width: 1.4, align: 'right' },
          { label: 'Saldo', width: 1.4, align: 'right' },
        ],
        rows: h.map((y) =>
          y.cash
            ? [String(y.exerciseYear), m(y.totalIncomeCents), m(y.cash.totalSourcesCents), m(y.cash.totalUsesCents), m(y.cash.balanceCents)]
            : [String(y.exerciseYear), y.declarationId ? m(y.totalIncomeCents) : '—', 'sem linhas', '—', '—'],
        ),
      },
      {
        type: 'text',
        text: withCash.some((y) => y.cash!.balanceCents < 0)
          ? `Saldo negativo em: ${withCash
              .filter((y) => y.cash!.balanceCents < 0)
              .map((y) => y.exerciseYear)
              .join(', ')}. Saldos negativos recorrentes indicam renda não declarada ou bens com valores incorretos.`
          : 'Nenhum exercício com saldo de caixa negativo.',
      },
    ],
  };
}

function fineMeshSection(p: PersonContext, settings: Required<OfficeSettings>, title: string): Section {
  const points = fineMeshCheck({
    exerciseYear: p.declaration.exerciseYear,
    taxation: taxationOf(p.declaration),
    items: p.items,
    otherExpenses: p.declaration.otherExpenses,
    simplifiedDiscountMode: settings.cashAnalysisSimplifiedDiscount,
    holderCpf: p.customer.cpfCnpj,
  });
  const count = (s: string) => points.filter((x) => x.severity === s).length;
  return {
    key: 'fine_mesh',
    title,
    subtitle: personSubtitle(p),
    blocks: [
      {
        type: 'stats',
        items: [
          { label: 'Pontos de atenção', value: String(points.length) },
          { label: 'Gravidade alta', value: String(count('high')), tone: count('high') ? 'negative' : 'neutral' },
          { label: 'Gravidade média', value: String(count('medium')) },
          { label: 'Gravidade baixa', value: String(count('low')) },
        ],
      },
      { type: 'points', points, empty: 'Nenhum ponto de atenção encontrado nas linhas cadastradas.' },
      { type: 'text', text: 'Verificação automática baseada nas linhas cadastradas. Não substitui a conferência do contador nem os cruzamentos feitos pela Receita Federal.', muted: true },
    ],
  };
}

function taxPlanningSection(p: PersonContext, title: string): Section {
  const r = compareTaxation({ exerciseYear: p.declaration.exerciseYear, items: p.items, currentTaxation: taxationOf(p.declaration) });
  const result = (c: number): Cell => (c > 0 ? `A pagar ${fmt(c)}` : c < 0 ? `A restituir ${fmt(-c)}` : 'Sem saldo');
  return {
    key: 'tax_planning',
    title,
    subtitle: personSubtitle(p),
    blocks: [
      {
        type: 'stats',
        items: [
          { label: 'Melhor opção', value: r.best === 'complete' ? 'Completa' : 'Simplificada' },
          { label: 'Economia', value: m(r.savingsCents), tone: 'positive' },
          { label: 'Declarada como', value: taxationOf(p.declaration) === 'complete' ? 'Completa' : taxationOf(p.declaration) === 'simplified' ? 'Simplificada' : 'Não informada' },
        ],
      },
      {
        type: 'table',
        title: 'Comparativo',
        columns: [{ label: 'Item', width: 2.4 }, { label: 'Completa', width: 1.4, align: 'right' }, { label: 'Simplificada', width: 1.4, align: 'right' }],
        rows: [
          ['Rendimentos tributáveis', m(r.taxableIncomeCents), m(r.taxableIncomeCents)],
          ['Deduções / desconto simplificado', m(r.complete.deductionsCents), m(r.simplified.deductionsCents)],
          ['Base de cálculo', m(r.complete.baseCents), m(r.simplified.baseCents)],
          ...(r.annualReduction
            ? ([
                ['Imposto pela tabela progressiva', m(r.complete.grossTaxCents), m(r.simplified.grossTaxCents)],
                ['Redução anual (Lei 15.270/2025)', m(r.complete.reductionCents), m(r.simplified.reductionCents)],
              ] as Cell[][])
            : []),
          ['Imposto devido', m(r.complete.taxCents), m(r.simplified.taxCents)],
          ['Alíquota efetiva', { pct: r.complete.effectiveRate }, { pct: r.simplified.effectiveRate }],
          ['Imposto pago / retido', m(r.prepaidTaxCents), m(r.prepaidTaxCents)],
          ['Resultado', result(r.complete.resultCents), result(r.simplified.resultCents)],
        ],
      },
      {
        type: 'table',
        title: 'Deduções consideradas na completa',
        columns: [{ label: 'Dedução', width: 3 }, { label: 'Valor', width: 1.2, align: 'right' }, { label: 'Observação', width: 2.4 }],
        rows: r.deductionLines.map((l) => [l.label, m(l.cents), l.note ?? '']),
        totals: ['Total', m(r.complete.deductionsCents), ''],
      },
      { type: 'bullets', title: 'Sugestões', items: r.suggestions },
      ...r.warnings.map((w): Block => ({ type: 'text', text: w, muted: true })),
    ],
  };
}

const fmt = (c: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(c / 100);

function assetsSection(p: PersonContext, title: string): Section {
  const ac = p.declaration.exerciseYear - 1;
  const assets = by(p.items, 'asset', 'rural_asset').sort((a, b) => String(a.groupCode ?? '').localeCompare(String(b.groupCode ?? '')));
  const debts = by(p.items, 'debt', 'rural_debt');
  const groups = new Map<string, { prev: number; now: number }>();
  for (const a of assets) {
    const g = a.kind === 'rural_asset' ? 'Atividade rural' : groupLabel(a.groupCode);
    const cur = groups.get(g) ?? { prev: 0, now: 0 };
    groups.set(g, { prev: cur.prev + (a.prevValueCents ?? 0), now: cur.now + (a.valueCents ?? 0) });
  }
  const totalPrev = sum(assets, (i) => i.prevValueCents ?? 0);
  const totalNow = sum(assets, (i) => i.valueCents ?? 0);
  const debtPrev = sum(debts, (i) => i.prevValueCents ?? 0);
  const debtNow = sum(debts, (i) => i.valueCents ?? 0);
  return {
    key: 'assets',
    title,
    subtitle: personSubtitle(p),
    blocks: [
      {
        type: 'stats',
        items: [
          { label: `Bens em 31/12/${ac}`, value: m(totalNow) },
          { label: `Dívidas em 31/12/${ac}`, value: m(debtNow) },
          { label: 'Patrimônio líquido', value: m(totalNow - debtNow), tone: totalNow - debtNow < 0 ? 'negative' : 'neutral' },
        ],
      },
      {
        type: 'table',
        title: 'Resumo por grupo',
        columns: [{ label: 'Grupo', width: 2.6 }, { label: `31/12/${ac - 1}`, width: 1.3, align: 'right' }, { label: `31/12/${ac}`, width: 1.3, align: 'right' }],
        rows: [...groups.entries()].map(([g, v]) => [g, m(v.prev), m(v.now)]),
        totals: ['Total', m(totalPrev), m(totalNow)],
        empty: 'Nenhum bem informado.',
      },
      {
        type: 'table',
        title: 'Bens e direitos',
        columns: [{ label: 'Grupo/código', width: 1.1 }, { label: 'Discriminação', width: 3.4 }, { label: `31/12/${ac - 1}`, width: 1.3, align: 'right' }, { label: `31/12/${ac}`, width: 1.3, align: 'right' }],
        rows: assets.map((a) => [[a.groupCode, a.code].filter(Boolean).join(' / ') || '—', a.description || groupLabel(a.groupCode), m(a.prevValueCents ?? 0), m(a.valueCents ?? 0)]),
        totals: ['', 'Total', m(totalPrev), m(totalNow)],
        empty: 'Nenhum bem informado.',
      },
      {
        type: 'table',
        title: 'Dívidas e ônus reais',
        columns: [{ label: 'Código', width: 1.1 }, { label: 'Discriminação', width: 3.4 }, { label: `31/12/${ac - 1}`, width: 1.3, align: 'right' }, { label: `31/12/${ac}`, width: 1.3, align: 'right' }],
        rows: debts.map((d) => [d.code ?? '—', d.description || payer(d), m(d.prevValueCents ?? 0), m(d.valueCents ?? 0)]),
        totals: ['', 'Total', m(debtPrev), m(debtNow)],
        empty: 'Nenhuma dívida informada.',
      },
    ],
  };
}

/** Nomes curtos das abas do Excel (limite de 31 caracteres). */
const SHEET: Record<IndividualReportKey, string> = {
  cash_analysis: 'Análise de caixa',
  cash_details: 'Detalhes do caixa',
  patrimony_history: 'Hist. patrimonial',
  cash_history: 'Hist. do caixa',
  fine_mesh: 'Malha fina',
  tax_planning: 'Planejamento',
  assets: 'Bens e direitos',
};

function buildOne(key: IndividualReportKey, p: PersonContext, settings: Required<OfficeSettings>, spouse = false): Section {
  const title = `${getIndividualReport(key)!.label}${spouse ? ' · cônjuge' : ''}`;
  const section = (() => {
    switch (key) {
      case 'cash_analysis':
        return cashAnalysisSection(p, settings, title);
      case 'cash_details':
        return cashDetailsSection(p, title);
      case 'patrimony_history':
        return patrimonyHistorySection(p, title);
      case 'cash_history':
        return cashHistorySection(p, title);
      case 'fine_mesh':
        return fineMeshSection(p, settings, title);
      case 'tax_planning':
        return taxPlanningSection(p, title);
      case 'assets':
        return assetsSection(p, title);
    }
  })();
  return { ...section, sheet: spouse ? `${SHEET[key]} (cônjuge)` : getIndividualReport(key)!.label };
}

/** Seções dos relatórios escolhidos, na ordem do catálogo; com o cônjuge, inclui as dele e o consolidado. */
export function buildIndividualSections(keys: IndividualReportKey[], holder: PersonContext, spouse: PersonContext | null, settings: Required<OfficeSettings>): Section[] {
  const out: Section[] = [];
  for (const key of keys) {
    out.push(buildOne(key, holder, settings));
    if (!spouse) continue;
    out.push(buildOne(key, spouse, settings, true));
    if (key === 'cash_analysis') {
      const a = runCash(holder, settings);
      const b = runCash(spouse, settings);
      const merge = (x: typeof a.sources, y: typeof a.sources) => x.map((l) => ({ ...l, cents: l.cents + (y.find((k) => k.key === l.key)?.cents ?? 0) }));
      const combined: CashAnalysisResult = {
        ...a,
        sources: merge(a.sources, b.sources),
        uses: merge(a.uses, b.uses),
        totalSourcesCents: a.totalSourcesCents + b.totalSourcesCents,
        totalUsesCents: a.totalUsesCents + b.totalUsesCents,
        balanceCents: a.balanceCents + b.balanceCents,
        netWorthVariationCents: a.netWorthVariationCents + b.netWorthVariationCents,
        assetsPrevCents: a.assetsPrevCents + b.assetsPrevCents,
        assetsCents: a.assetsCents + b.assetsCents,
        debtsPrevCents: a.debtsPrevCents + b.debtsPrevCents,
        debtsCents: a.debtsCents + b.debtsCents,
        status: a.balanceCents + b.balanceCents < 0 ? 'negative' : a.balanceCents + b.balanceCents > 0 ? 'positive' : 'zero',
        warnings: [],
      };
      out.push({
        key: 'cash_analysis_couple',
        title: 'Análise de caixa · consolidado do casal',
        sheet: 'Caixa do casal',
        subtitle: `${holder.customer.name} e ${spouse.customer.name} · Exercício ${holder.declaration.exerciseYear}`,
        blocks: cashBlocks(combined, holder.declaration.exerciseYear),
      });
    }
    if (key === 'patrimony_history') {
      out.push({
        key: 'patrimony_couple',
        title: 'Histórico patrimonial · consolidado do casal',
        sheet: 'Patrimônio do casal',
        subtitle: `${holder.customer.name} e ${spouse.customer.name}`,
        blocks: [
          {
            type: 'table',
            columns: [{ label: 'Exercício', width: 1 }, { label: 'Titular', width: 1.5, align: 'right' }, { label: 'Cônjuge', width: 1.5, align: 'right' }, { label: 'Casal', width: 1.5, align: 'right' }],
            rows: holder.history.map((y, i) => {
              const s = spouse.history[i]?.netWorthCents ?? 0;
              return [String(y.exerciseYear), m(y.netWorthCents), m(s), m(y.netWorthCents + s)];
            }),
          },
        ],
      });
    }
  }
  return out;
}

/** Lista de dependentes para mensagens (ex.: kit). */
export const dependentsOf = (items: DeclarationItem[]) => by(items, 'dependent').map(dependentName);
export const paymentsByNature = (items: DeclarationItem[]) => {
  const map = new Map<string, number>();
  for (const pmt of by(items, 'payment')) {
    const n = paymentNature(pmt);
    const label = (PAYMENT_NATURES as Record<string, string>)[n] ?? 'Outros pagamentos';
    map.set(label, (map.get(label) ?? 0) + netPayment(pmt));
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};
