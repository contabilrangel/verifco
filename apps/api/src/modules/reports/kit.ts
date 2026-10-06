import {
  ASSET_GROUPS,
  DARF_STATUS,
  DECLARATION_SUBSTATUS,
  ITEM_KINDS,
  declarationTotals,
  fineMeshCheck,
  formatCpfCnpj,
  formatDate,
  formatMoney,
  type DeclarationItem,
  type DeclarationSubstatus,
} from '@verifco/shared';
import type { AppContext } from '../../context';
import type { CustomerRow } from '../../services/customers';
import type { DeclarationRow } from '../../services/declarations';
import { PdfBuilder, loadBranding } from '../../services/pdf';
import { loadDarfs, loadItems, officeSettings } from './data';
import { finishPdf, renderPdf, type Block, type Cell, type Section } from './document';
import { paymentsByNature, runCash, taxationLabel, taxationOf } from './individual';

const m = (cents: number): Cell => ({ money: cents });

export const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

export const kitFilename = (customer: CustomerRow, year: number) => `kit-pos-declaracao-${year}-${slug(customer.name)}.pdf`;

const groupLabel = (code: string | null | undefined) => ASSET_GROUPS[String(code ?? '99').padStart(2, '0') as keyof typeof ASSET_GROUPS] ?? 'Outros bens e direitos';

/**
 * Kit pós-declaração: resumo da declaração transmitida, DARFs, caixa, evolução patrimonial,
 * principais rendimentos e deduções e lembretes para o próximo ano.
 */
export async function buildKitPdf(ctx: AppContext, declaration: DeclarationRow, customer: CustomerRow): Promise<{ buffer: Buffer; filename: string }> {
  const officeId = declaration.officeId;
  const year = declaration.exerciseYear;
  const ac = year - 1;
  const [items, darfs, settings, brand] = await Promise.all([loadItems(ctx, declaration.id), loadDarfs(ctx, declaration), officeSettings(ctx, officeId), loadBranding(ctx, officeId)]);
  const hasItems = items.length > 0;
  const t = hasItems
    ? declarationTotals(items)
    : {
        taxableIncomeCents: declaration.taxableIncomeCents,
        exemptIncomeCents: declaration.exemptIncomeCents,
        exclusiveIncomeCents: declaration.exclusiveIncomeCents,
        totalIncomeCents: declaration.totalIncomeCents,
        deductionsCents: declaration.deductionsCents,
        withheldTaxCents: declaration.withheldTaxCents,
        assetsTotalCents: declaration.assetsTotalCents,
        assetsPrevTotalCents: declaration.assetsPrevTotalCents,
        debtsTotalCents: declaration.debtsTotalCents,
        debtsPrevTotalCents: declaration.debtsPrevTotalCents,
      };
  const due = declaration.taxDueCents;
  const refund = declaration.refundCents;
  const resultLabel = due > 0 ? 'Imposto a pagar' : refund > 0 ? 'Imposto a restituir' : 'Resultado';
  const resultValue: Cell = due > 0 ? m(due) : refund > 0 ? m(refund) : 'Sem saldo';
  const netWorth = t.assetsTotalCents - t.debtsTotalCents;

  const sections: Section[] = [];
  sections.push({
    key: 'summary',
    title: 'Resumo da declaração',
    subtitle: `${customer.name} · CPF ${formatCpfCnpj(customer.cpfCnpj)} · Exercício ${year} (ano-calendário ${ac})`,
    blocks: [
      {
        type: 'stats',
        items: [
          { label: resultLabel, value: resultValue, tone: due > 0 ? 'negative' : refund > 0 ? 'positive' : 'neutral' },
          { label: 'Rendimentos no ano', value: m(t.totalIncomeCents) },
          { label: 'Patrimônio líquido', value: m(netWorth) },
        ],
      },
      {
        type: 'kv',
        pairs: [
          ['Situação', DECLARATION_SUBSTATUS[declaration.substatus as DeclarationSubstatus] ?? declaration.substatus],
          ['Forma de tributação', taxationLabel(declaration)],
          ...(declaration.receiptNumber ? ([['Número do recibo', declaration.receiptNumber]] as [string, Cell][]) : []),
          ...(declaration.transmittedAt ? ([['Transmitida em', formatDate(declaration.transmittedAt)]] as [string, Cell][]) : []),
          ...(declaration.isRectification ? ([['Tipo', 'Retificadora']] as [string, Cell][]) : []),
          ['Rendimentos tributáveis', m(t.taxableIncomeCents)],
          ['Rendimentos isentos e não tributáveis', m(t.exemptIncomeCents)],
          ['Rendimentos de tributação exclusiva', m(t.exclusiveIncomeCents)],
          ['Pagamentos e deduções informados', m(t.deductionsCents)],
          ['Imposto retido na fonte', m(t.withheldTaxCents)],
        ],
      },
    ],
  });

  // imposto a pagar (DARF) ou restituição
  const payBlocks: Block[] = [];
  if (darfs.length) {
    payBlocks.push({
      type: 'table',
      title: 'Quotas do DARF (código 0211)',
      columns: [{ label: 'Quota', width: 0.8 }, { label: 'Vencimento', width: 1.3 }, { label: 'Valor', width: 1.3, align: 'right' }, { label: 'Situação', width: 1.4 }],
      rows: darfs.map((d) => [d.quotaNumber === 1 && darfs.length === 1 ? 'Única' : `${d.quotaNumber}ª`, { date: d.dueDate }, m(d.valueCents), d.paidAt ? `Paga em ${formatDate(d.paidAt)}` : (DARF_STATUS[d.status as keyof typeof DARF_STATUS] ?? d.status)]),
      totals: ['Total', '', m(darfs.reduce((a, d) => a + d.valueCents, 0)), ''],
    });
    payBlocks.push({ type: 'text', text: 'Pague cada quota até o vencimento. Quotas pagas com atraso têm multa de 0,33% ao dia (limitada a 20%) e juros Selic.', muted: true });
  } else if (due > 0) {
    payBlocks.push({
      type: 'text',
      text: `Há ${formatMoney(due)} de imposto a pagar. O escritório enviará as guias DARF; o pagamento pode ser feito em quota única ou em até 8 quotas mensais (mínimo de R$ 50,00 cada), com juros Selic a partir da 2ª.`,
    });
  }
  if (refund > 0) {
    payBlocks.push({
      type: 'kv',
      title: 'Restituição',
      pairs: [
        ['Valor a restituir', m(refund)],
        ['Lote', declaration.refundPaidAt ? `Paga em ${formatDate(declaration.refundPaidAt)}` : declaration.refundLotDate ? `Previsto para ${formatDate(declaration.refundLotDate)}` : 'Aguardando liberação de lote'],
      ],
    });
    payBlocks.push({ type: 'text', text: 'A restituição é depositada na conta informada na declaração, corrigida pela Selic. Acompanhe também pelo aplicativo Meu Imposto de Renda.', muted: true });
  }
  if (payBlocks.length) sections.push({ key: 'payment', title: refund > 0 && !darfs.length ? 'Restituição' : 'Pagamento do imposto', blocks: payBlocks });

  if (hasItems) {
    const cash = runCash({ customer, declaration, items, history: [] }, settings);
    sections.push({
      key: 'cash',
      title: 'Análise de caixa resumida',
      blocks: [
        {
          type: 'stats',
          items: [
            { label: 'Recursos do ano', value: m(cash.totalSourcesCents) },
            { label: 'Aplicações do ano', value: m(cash.totalUsesCents) },
            { label: 'Saldo de caixa', value: m(cash.balanceCents), tone: cash.balanceCents < 0 ? 'negative' : 'positive' },
          ],
        },
        {
          type: 'text',
          text:
            cash.balanceCents < 0
              ? 'Os gastos e aquisições do ano superaram os recursos declarados. Converse com o escritório sobre a origem desses recursos.'
              : 'Os recursos declarados cobrem os gastos e as aquisições do ano, o que reduz o risco de questionamentos sobre a evolução do patrimônio.',
        },
      ],
    });

    // evolução patrimonial por grupo
    const groups = new Map<string, { prev: number; now: number }>();
    for (const a of items.filter((i) => i.kind === 'asset' || i.kind === 'rural_asset')) {
      const g = a.kind === 'rural_asset' ? 'Atividade rural' : groupLabel(a.groupCode);
      const cur = groups.get(g) ?? { prev: 0, now: 0 };
      groups.set(g, { prev: cur.prev + (a.prevValueCents ?? 0), now: cur.now + (a.valueCents ?? 0) });
    }
    const rows: Cell[][] = [...groups.entries()].map(([g, v]) => [g, m(v.prev), m(v.now), m(v.now - v.prev)]);
    rows.push(['Dívidas e ônus reais', m(-t.debtsPrevTotalCents), m(-t.debtsTotalCents), m(-(t.debtsTotalCents - t.debtsPrevTotalCents))]);
    const prevNet = t.assetsPrevTotalCents - t.debtsPrevTotalCents;
    sections.push({
      key: 'patrimony',
      title: 'Evolução patrimonial',
      blocks: [
        {
          type: 'table',
          columns: [{ label: 'Grupo', width: 2.6 }, { label: `31/12/${ac - 1}`, width: 1.3, align: 'right' }, { label: `31/12/${ac}`, width: 1.3, align: 'right' }, { label: 'Variação', width: 1.3, align: 'right' }],
          rows,
          totals: ['Patrimônio líquido', m(prevNet), m(netWorth), m(netWorth - prevNet)],
        },
      ],
    });

    const incomes = items
      .filter((i) => ['income_pj', 'income_pf', 'income_exempt', 'income_exclusive', 'capital_gain', 'variable_income', 'rural_income', 'income_accumulated'].includes(i.kind))
      .sort((a, b) => (b.valueCents ?? 0) - (a.valueCents ?? 0))
      .slice(0, 6);
    if (incomes.length) {
      sections.push({
        key: 'incomes',
        title: 'Principais rendimentos',
        blocks: [
          {
            type: 'table',
            columns: [{ label: 'Fonte', width: 3 }, { label: 'Tipo', width: 2.2 }, { label: 'Valor', width: 1.3, align: 'right' }],
            rows: incomes.map((i) => [i.counterpartyName || i.description || '—', ITEM_KINDS[i.kind].label, m(i.valueCents ?? 0)]),
          },
        ],
      });
    }
    const pension = items.filter((i) => i.kind === 'income_pj').reduce((a, i) => a + Number(i.extra?.officialPensionCents ?? 0), 0);
    const deductions: [string, number][] = [...paymentsByNature(items), ...(pension > 0 ? ([['Previdência oficial (INSS)', pension]] as [string, number][]) : [])].sort((a, b) => b[1] - a[1]);
    const dependents = items.filter((i) => i.kind === 'dependent').length;
    if (deductions.length || dependents) {
      sections.push({
        key: 'deductions',
        title: 'Principais deduções',
        blocks: [
          {
            type: 'table',
            columns: [{ label: 'Natureza', width: 3 }, { label: 'Valor', width: 1.3, align: 'right' }],
            rows: deductions.slice(0, 6).map(([k, v]) => [k, m(v)]),
            empty: 'Nenhum pagamento dedutível informado.',
          },
          ...(dependents ? ([{ type: 'text', text: `${dependents} dependente(s) informado(s) na declaração.`, muted: true }] as Block[]) : []),
        ],
      });
    }

    const points = fineMeshCheck({
      exerciseYear: year,
      taxation: taxationOf(declaration),
      items,
      otherExpenses: declaration.otherExpenses,
      simplifiedDiscountMode: settings.cashAnalysisSimplifiedDiscount,
      holderCpf: customer.cpfCnpj,
    }).filter((p) => p.severity !== 'low');
    if (points.length) sections.push({ key: 'attention', title: 'Pontos de atenção', blocks: [{ type: 'points', points: points.slice(0, 5), empty: '' }] });
  }

  // recomendações para o próximo ano
  const next = year + 1;
  const tips: string[] = [];
  if (due > 0) tips.push('Para reduzir o imposto do próximo ano, guarde todos os comprovantes dedutíveis (saúde, instrução, previdência) e avalie contribuições ao PGBL até 12% da renda tributável.');
  if (refund > 0) tips.push('Restituição alta indica imposto retido acima do devido: avalie com o escritório ajustes de dependentes e deduções na fonte.');
  if (items.some((i) => i.kind === 'income_pf')) tips.push('Você recebe de pessoas físicas ou do exterior: recolha o carnê-leão todo mês até o último dia útil do mês seguinte ao recebimento.');
  if (items.some((i) => i.kind === 'payment' && i.extra?.nature === 'health')) tips.push('Peça nota fiscal ou recibo com CPF/CNPJ em todas as despesas médicas e odontológicas.');
  if (items.some((i) => i.kind === 'asset' && String(i.groupCode ?? '') === '08')) tips.push('Operações com criptoativos fora de corretoras brasileiras podem exigir informação mensal à Receita; avise o escritório sobre compras e vendas.');
  tips.push('Informe o escritório sobre compra ou venda de imóveis, veículos e participações, heranças, doações e empréstimos assim que acontecerem.');
  tips.push(`Guarde os informes de rendimentos de ${year} (bancos, empregadores, corretoras) que chegam até o fim de fevereiro de ${next}.`);
  tips.push(`A declaração de ${next} (ano-calendário ${year}) costuma ter prazo de entrega até o fim de maio; quem entrega cedo recebe a restituição antes.`);
  tips.push('Mantenha esta declaração e os comprovantes guardados por pelo menos 5 anos.');
  sections.push({ key: 'tips', title: `Recomendações e lembretes para ${next}`, blocks: [{ type: 'bullets', items: tips }] });

  const pdf = new PdfBuilder(brand, `Kit pós-declaração · IRPF ${year}`, `${customer.name} · ano-calendário ${ac}`);
  if (!hasItems) pdf.paragraph('Esta declaração ainda não tem linhas cadastradas; o kit mostra apenas os totais gravados.', { muted: true, size: 9 });
  renderPdf(pdf, brand, sections);
  return { buffer: await finishPdf(pdf), filename: kitFilename(customer, year) };
}

/** Itens da declaração do ano anterior, usados no checklist de documentos. */
export async function previousYearItems(ctx: AppContext, customerId: string, year: number): Promise<DeclarationItem[]> {
  const prev = await ctx.db.query.declarations.findFirst({
    where: (d, { and, eq }) => and(eq(d.customerId, customerId), eq(d.exerciseYear, year - 1)),
  });
  return prev ? loadItems(ctx, prev.id) : [];
}
