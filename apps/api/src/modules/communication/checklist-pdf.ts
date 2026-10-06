import { ASSET_GROUPS, PAYMENT_NATURES, dependentName, formatCpfCnpj, type DeclarationItem } from '@verifco/shared';
import type { AppContext } from '../../context';
import type { CustomerRow } from '../../services/customers';
import { PdfBuilder, loadBranding } from '../../services/pdf';
import { finishPdf } from '../reports/document';
import { previousYearItems, slug } from '../reports/kit';

interface Group {
  title: string;
  items: { label: string; hint?: string }[];
}

const uniq = <T>(list: T[], key: (t: T) => string) => {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Itens do checklist a partir da declaração do ano anterior (quando houver). */
export function checklistGroups(items: DeclarationItem[], year: number): Group[] {
  const ac = year - 1;
  const by = (...kinds: DeclarationItem['kind'][]) => items.filter((i) => kinds.includes(i.kind));
  const name = (i: DeclarationItem) => i.counterpartyName || i.description || 'Fonte não identificada';
  const groups: Group[] = [
    {
      title: 'Documentos pessoais',
      items: [
        { label: 'Documento de identidade com CPF', hint: 'Do titular e de cada dependente' },
        { label: 'Comprovante de endereço atualizado' },
        { label: 'Recibo e cópia da última declaração entregue', hint: 'Se ela não foi feita por este escritório' },
        { label: 'Dados bancários para restituição ou débito automático' },
      ],
    },
  ];
  const deps = by('dependent');
  if (deps.length) groups.push({ title: 'Dependentes', items: deps.map((d) => ({ label: `CPF e informes de rendimentos de ${dependentName(d)}` })) });

  const incomes = uniq(by('income_pj', 'income_pf', 'income_exclusive', 'income_exempt'), (i) => `${i.kind}|${i.counterpartyDoc ?? name(i)}`);
  groups.push({
    title: 'Rendimentos',
    items: [
      ...incomes.map((i) => ({
        label: i.kind === 'income_pf' ? `Recibos e carnê-leão de ${name(i)}` : `Informe de rendimentos ${ac} — ${name(i)}`,
        hint: i.counterpartyDoc ? formatCpfCnpj(i.counterpartyDoc) : undefined,
      })),
      { label: `Informes de bancos, corretoras e previdência privada de ${ac}` },
      { label: 'Rendimentos de aluguel, pensão ou do exterior recebidos no ano', hint: 'Se houver' },
    ],
  });

  const payments = uniq(by('payment'), (p) => `${String(p.extra?.nature ?? '')}|${p.counterpartyDoc ?? name(p)}`);
  groups.push({
    title: 'Pagamentos e deduções',
    items: [
      ...payments.map((p) => ({
        label: `Recibos/notas de ${name(p)}`,
        hint: (PAYMENT_NATURES as Record<string, string>)[String(p.extra?.nature ?? '')] ?? undefined,
      })),
      { label: 'Recibos de despesas médicas, odontológicas e de planos de saúde', hint: 'Com CPF/CNPJ do prestador' },
      { label: 'Comprovantes de instrução (escola, faculdade, pós)' },
      { label: 'Informe de previdência privada (PGBL)' },
    ],
  });

  const assets = by('asset', 'rural_asset');
  if (assets.length) {
    groups.push({
      title: 'Bens e direitos',
      items: assets.map((a) => ({
        label: a.description ? a.description.slice(0, 110) : (ASSET_GROUPS[String(a.groupCode ?? '99').padStart(2, '0') as keyof typeof ASSET_GROUPS] ?? 'Bem'),
        hint: `Saldo ou documento em 31/12/${ac}`,
      })),
    });
  }
  const debts = by('debt', 'rural_debt');
  if (debts.length) groups.push({ title: 'Dívidas e financiamentos', items: debts.map((d) => ({ label: d.description || name(d), hint: `Saldo devedor em 31/12/${ac}` })) });

  groups.push({
    title: `Novidades de ${ac}`,
    items: [
      { label: 'Compra ou venda de imóveis, veículos e participações', hint: 'Contratos, escrituras e notas' },
      { label: 'Heranças, doações e empréstimos recebidos ou concedidos' },
      { label: 'Operações em bolsa e criptoativos', hint: 'Notas de corretagem e extratos' },
      { label: 'Nascimento, casamento, separação ou outras mudanças na família' },
    ],
  });
  return groups;
}

/** PDF do checklist de documentos do exercício para um cliente. */
export async function buildChecklistPdf(ctx: AppContext, customer: CustomerRow, year: number): Promise<{ buffer: Buffer; filename: string }> {
  const brand = await loadBranding(ctx, customer.officeId);
  const items = await previousYearItems(ctx, customer.id, year);
  const groups = checklistGroups(items, year);
  const pdf = new PdfBuilder(brand, `Checklist de documentos · IRPF ${year}`, `${customer.name} · ano-calendário ${year - 1}`);
  const { doc } = pdf;
  pdf.paragraph(
    items.length
      ? `Lista montada a partir da sua declaração de ${year - 1}. Marque o que já separou e envie ao escritório; itens que não se aplicam mais podem ser ignorados.`
      : 'Marque o que já separou e envie ao escritório. Itens que não se aplicam ao seu caso podem ser ignorados.',
    { muted: true, size: 9.5 },
  );
  for (const g of groups) {
    pdf.heading(g.title);
    for (const it of g.items) {
      doc.font('Helvetica').fontSize(10);
      const h = doc.heightOfString(it.label, { width: pdf.width - 24 }) + (it.hint ? 12 : 0) + 8;
      pdf.ensureSpace(h + 4);
      const y = doc.y;
      doc.roundedRect(pdf.margin, y + 1, 10, 10, 2).lineWidth(0.8).strokeColor(brand.subtitleColor).stroke();
      doc.fillColor('#212429').font('Helvetica').fontSize(10).text(it.label, pdf.margin + 20, y, { width: pdf.width - 24 });
      if (it.hint) doc.fillColor('#636e7c').fontSize(8.5).text(it.hint, pdf.margin + 20, undefined, { width: pdf.width - 24 });
      doc.x = pdf.margin;
      doc.y = y + h;
    }
  }
  return { buffer: await finishPdf(pdf), filename: `checklist-irpf-${year}-${slug(customer.name)}.pdf` };
}
