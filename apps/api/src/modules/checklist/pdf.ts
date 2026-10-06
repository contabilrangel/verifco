import { and, eq } from 'drizzle-orm';
import { CHECKLIST_FILLABLE_SECTIONS, CHECKLIST_SECTIONS, buildChecklistDrafts, formatCpfCnpj, type ChecklistSection } from '@verifco/shared';
import type { AppContext } from '../../context';
import { checklistItems, checklists, declarations } from '../../db/schema';
import { PdfBuilder, loadBranding } from '../../services/pdf';
import { slug } from '../reports/kit';
import { previousYearItems, type CustomerRow, type DeclarationRow } from './service';

interface PdfItem {
  section: string;
  title: string;
  description: string | null;
  ownerName: string | null;
}

/**
 * Itens do checklist em PDF: os do checklist digital (sem os removidos neste ano) ou,
 * se ainda não houver checklist digital, a mesma lista montada a partir do ano anterior.
 */
export async function pdfItems(ctx: AppContext, customer: CustomerRow, declaration: DeclarationRow | null, exerciseYear: number): Promise<PdfItem[]> {
  const digital = declaration ? await ctx.db.query.checklists.findFirst({ where: eq(checklists.declarationId, declaration.id) }) : null;
  if (digital) {
    const rows = await ctx.db.select().from(checklistItems).where(eq(checklistItems.checklistId, digital.id));
    return rows
      .filter((r) => r.status !== 'removed')
      .sort((a, b) => CHECKLIST_FILLABLE_SECTIONS.indexOf(a.section as ChecklistSection) - CHECKLIST_FILLABLE_SECTIONS.indexOf(b.section as ChecklistSection) || a.sortOrder - b.sortOrder)
      .map((r) => ({ section: r.section, title: r.title, description: r.description, ownerName: r.ownerName }));
  }
  const prev = await previousYearItems(ctx.db, customer.id, exerciseYear);
  return buildChecklistDrafts(prev.items, { customerCpf: customer.cpfCnpj, hasPreviousDeclaration: Boolean(prev.declaration) });
}

/** PDF para o cliente separar os documentos, seção por seção, com caixas para marcar. */
export async function buildChecklistPdf(ctx: AppContext, customer: CustomerRow, exerciseYear: number, items: PdfItem[]): Promise<Buffer> {
  const pdf = new PdfBuilder(
    await loadBranding(ctx, customer.officeId),
    `Checklist de documentos — IRPF ${exerciseYear}`,
    `${customer.name} · CPF ${formatCpfCnpj(customer.cpfCnpj)} · ano-calendário ${exerciseYear - 1}`,
  );
  const { doc } = pdf;
  pdf.paragraph(
    'Separe os documentos abaixo e entregue ao escritório. Marque cada item conforme for reunindo. Se algum item não se aplica mais a você, risque e avise o escritório.',
    { muted: true },
  );
  for (const section of CHECKLIST_FILLABLE_SECTIONS) {
    const list = items.filter((i) => i.section === section);
    if (!list.length) continue;
    pdf.heading(CHECKLIST_SECTIONS[section]);
    for (const item of list) {
      const textX = pdf.margin + 20;
      const width = pdf.width - 20;
      doc.font('Helvetica-Bold').fontSize(10);
      const titleH = doc.heightOfString(item.title, { width });
      doc.font('Helvetica').fontSize(8.5);
      const descH = item.description ? doc.heightOfString(item.description, { width }) : 0;
      pdf.ensureSpace(titleH + descH + (item.ownerName ? 12 : 0) + 10);
      const y = doc.y;
      doc.rect(pdf.margin + 2, y + 1, 10, 10).lineWidth(0.8).strokeColor('#97a1ac').stroke();
      doc.fillColor('#212429').font('Helvetica-Bold').fontSize(10).text(item.title, textX, y, { width });
      if (item.ownerName) doc.fillColor('#3468e6').font('Helvetica').fontSize(8).text(`Em nome de: ${item.ownerName}`, textX, undefined, { width });
      if (item.description) doc.fillColor('#636e7c').font('Helvetica').fontSize(8.5).text(item.description, textX, undefined, { width });
      doc.moveDown(0.5);
    }
  }
  pdf.ensureSpace(90);
  pdf.heading('Observações');
  const startY = doc.y;
  for (let n = 1; n <= 3; n++) {
    doc.moveTo(pdf.margin, startY + n * 22).lineTo(pdf.margin + pdf.width, startY + n * 22).lineWidth(0.5).strokeColor('#cfd3d8').stroke();
  }
  doc.y = startY + 3 * 22 + 8;
  return pdf.finish();
}

/** Nome do arquivo do checklist em PDF (download, envio individual e mala direta). */
export const checklistPdfFilename = (customer: Pick<CustomerRow, 'name'>, exerciseYear: number) => `checklist-irpf-${exerciseYear}-${slug(customer.name) || 'cliente'}.pdf`;

/**
 * O checklist em PDF do cliente no exercício. É o único gerador: a etapa Documentação, o envio
 * individual, a mala direta e a prévia do anexo usam este, com os itens do checklist digital (sem
 * os removidos e com os acrescentados pelo escritório) ou, sem checklist, os do ano anterior.
 */
export async function checklistPdfFor(ctx: AppContext, customer: CustomerRow, exerciseYear: number, declaration?: DeclarationRow | null) {
  const decl =
    declaration !== undefined
      ? declaration
      : ((await ctx.db.query.declarations.findFirst({ where: and(eq(declarations.customerId, customer.id), eq(declarations.exerciseYear, exerciseYear)) })) ?? null);
  const buffer = await buildChecklistPdf(ctx, customer, exerciseYear, await pdfItems(ctx, customer, decl, exerciseYear));
  return { buffer, filename: checklistPdfFilename(customer, exerciseYear) };
}
