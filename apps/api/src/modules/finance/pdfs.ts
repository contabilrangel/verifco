/**
 * Recibo de honorários e documento de autorização em PDF.
 * Os textos vêm dos templates `receipt` e `authorization` (personalizáveis pelo escritório).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { amountInWords, formatCpfCnpj, formatMoney, formatPhone, renderTemplate, todayIso } from '@verifco/shared';
import type { AppContext } from '../../context';
import { budgets, customers, installments, offices, paymentMethods } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { baseTemplateValues, resolveTemplate } from '../../services/delivery';
import { PdfBuilder, loadBranding } from '../../services/pdf';
import { getOfficeSettings } from '../../services/settings';
import { assignReceiptNumber, type BillingRow, type BudgetRow, type InstallmentRow } from './service';
import { brDate, budgetStatusLabel, categoryLabel, formatAddress, htmlToPlain, longDate } from './text';

type CustomerRow = typeof customers.$inferSelect;

/**
 * Finaliza o PDF sem a página extra: o rodapé do PdfBuilder é escrito abaixo da margem
 * inferior e o pdfkit abriria uma nova página só para ele.
 */
async function finishPdf(pdf: PdfBuilder) {
  const range = pdf.doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.doc.switchToPage(i);
    pdf.doc.page.margins.bottom = 0;
  }
  return pdf.finish();
}

function renderCopy(pdf: PdfBuilder, text: string, details: [string, string][] | null, label: string | null, signer: string) {
  const { doc } = pdf;
  if (label) {
    doc.fillColor('#636e7c').font('Helvetica-Bold').fontSize(8).text(label.toUpperCase(), pdf.margin, undefined, { width: pdf.width, align: 'right' });
    doc.moveDown(0.3);
  }
  for (const para of text.split(/\n{2,}/)) pdf.paragraph(para.trim(), { size: 11 });
  if (details?.length) {
    doc.moveDown(0.3);
    pdf.keyValues(details);
  }
  pdf.ensureSpace(70);
  doc.moveDown(2);
  const lineW = 240;
  const x = pdf.margin + (pdf.width - lineW) / 2;
  doc.moveTo(x, doc.y).lineTo(x + lineW, doc.y).lineWidth(0.6).strokeColor('#97a1ac').stroke();
  doc.moveDown(0.3);
  doc.fillColor('#212429').font('Helvetica').fontSize(9).text(signer, pdf.margin, undefined, { width: pdf.width, align: 'center' });
  doc.x = pdf.margin;
}

function cutLine(pdf: PdfBuilder) {
  const { doc } = pdf;
  pdf.ensureSpace(60);
  doc.moveDown(1.5);
  const y = doc.y;
  doc.moveTo(pdf.margin, y).lineTo(pdf.margin + pdf.width, y).dash(4, { space: 4 }).lineWidth(0.6).strokeColor('#97a1ac').stroke().undash();
  doc.fillColor('#97a1ac').font('Helvetica').fontSize(7).text('corte aqui', pdf.margin, y + 3, { width: pdf.width, align: 'center' });
  doc.moveDown(1.5);
  doc.x = pdf.margin;
}

/** Variáveis do template `receipt` para uma parcela. */
export function receiptValues(customer: CustomerRow, budget: BudgetRow, inst: InstallmentRow) {
  const paid = inst.paidAmountCents ?? inst.amountCents;
  return {
    CPF_CLIENTE: formatCpfCnpj(customer.cpfCnpj),
    EMAIL_CLIENTE: customer.email ?? '',
    ENDERECO_CLIENTE: formatAddress(customer.address),
    TELEFONE_CLIENTE: formatPhone(customer.mobile || customer.phone),
    VALOR: formatMoney(paid),
    VALOR_EXTENSO: amountInWords(paid),
    ANO_REFERENCIA: budget.exerciseYear,
    VENCIMENTO: brDate(inst.dueDate),
    DATA: brDate(inst.paidAt ?? todayIso()),
  };
}

/** Gera o PDF do recibo da parcela paga, grava como arquivo e devolve número e arquivo. */
export async function generateReceipt(
  ctx: AppContext,
  data: { inst: InstallmentRow; billing: BillingRow; budget: BudgetRow; customer: CustomerRow },
  userId: string | null,
) {
  const { db } = ctx;
  const { billing, budget, customer } = data;
  if (data.inst.status !== 'paid') throw badRequest('Registre o recebimento antes de gerar o recibo.');
  const officeId = billing.officeId;
  const number = await assignReceiptNumber(ctx, officeId, data.inst.id);
  const inst = (await db.query.installments.findFirst({ where: eq(installments.id, data.inst.id) }))!;
  const settings = await getOfficeSettings(db, officeId);
  const office = await db.query.offices.findFirst({ where: eq(offices.id, officeId) });
  const method = budget.paymentMethodId ? await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, budget.paymentMethodId) }) : null;
  const count = (await db.select({ id: installments.id }).from(installments).where(eq(installments.billingId, billing.id))).length;
  const paid = inst.paidAmountCents ?? inst.amountCents;
  const paidAt = inst.paidAt ?? todayIso();

  const tpl = await resolveTemplate(ctx, officeId, 'receipt');
  const values = { ...(await baseTemplateValues(ctx, officeId, customer.id, budget.exerciseYear)), ...receiptValues(customer, budget, inst) };
  const text = htmlToPlain(renderTemplate(tpl.body, values));
  const details: [string, string][] | null = settings.receiptShowDetails
    ? [
        ['Serviço', categoryLabel(budget.category)],
        ...(budget.description ? ([['Descrição', budget.description]] as [string, string][]) : []),
        ['Parcela', `${inst.number} de ${count}`],
        ['Vencimento', brDate(inst.dueDate)],
        ['Data do pagamento', brDate(paidAt)],
        ...(method ? ([['Forma de pagamento', method.name]] as [string, string][]) : []),
        ['Valor recebido', formatMoney(paid)],
      ]
    : null;

  const pdf = new PdfBuilder(await loadBranding(ctx, officeId), `Recibo nº ${String(number).padStart(4, '0')}`, `${formatMoney(paid)} · Imposto de Renda ${budget.exerciseYear}`);
  const signer = [office?.name, office?.cpfCnpj ? formatCpfCnpj(office.cpfCnpj) : null].filter(Boolean).join(' · ');
  if (settings.receiptTwoCopies) {
    renderCopy(pdf, text, details, '1ª via — cliente', signer);
    cutLine(pdf);
    renderCopy(pdf, text, details, '2ª via — escritório', signer);
  } else {
    renderCopy(pdf, text, details, null, signer);
  }
  const buf = await finishPdf(pdf);
  const file = await ctx.files.save({ officeId, data: buf, filename: `recibo-${number}.pdf`, mimeType: 'application/pdf', userId });
  await db.update(installments).set({ receiptFileId: file.id }).where(eq(installments.id, inst.id));
  return { receiptNumber: number, fileId: file.id, filename: file.filename };
}

/**
 * Documento de autorização para elaborar e transmitir a declaração.
 * Sem orçamento ativo no exercício, só é gerado se o escritório permitir.
 */
export async function buildAuthorizationPdf(ctx: AppContext, officeId: string, customer: CustomerRow, year: number) {
  const { db } = ctx;
  const settings = await getOfficeSettings(db, officeId);
  const list = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.officeId, officeId), eq(budgets.customerId, customer.id), eq(budgets.exerciseYear, year), inArray(budgets.status, ['draft', 'sent', 'approved'])))
    .orderBy(desc(budgets.createdAt));
  const budget = list.find((b) => b.status === 'approved') ?? list[0] ?? null;
  if (!budget && !settings.allowAuthorizationWithoutBudget) {
    throw badRequest('Cadastre um orçamento para este exercício antes de gerar a autorização (ou permita a autorização sem orçamento nas preferências).');
  }
  const office = await db.query.offices.findFirst({ where: eq(offices.id, officeId) });
  if (!office) throw notFound('Escritório');
  const tpl = await resolveTemplate(ctx, officeId, 'authorization');
  const today = todayIso();
  const values = {
    ...(await baseTemplateValues(ctx, officeId, customer.id, year)),
    CPF_CLIENTE: formatCpfCnpj(customer.cpfCnpj),
    CPF_CONTADOR: office.cpfCnpj ? formatCpfCnpj(office.cpfCnpj) : '',
    CIDADE_CLIENTE: customer.address?.city ?? office.city ?? '',
    DATA: longDate(today),
  };
  // sem cidade cadastrada, a linha "{{CIDADE_CLIENTE}}, {{DATA}}" começaria com vírgula
  const text = htmlToPlain(renderTemplate(tpl.body, values)).replace(/(^|\n)[ \t]*,[ \t]*/g, '$1');
  const subject = renderTemplate(tpl.subject, values, { html: false });

  const pdf = new PdfBuilder(await loadBranding(ctx, officeId), 'Autorização', `Imposto de Renda ${year} · ano-calendário ${year - 1}`);
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  // o detalhamento entra logo após o texto da autorização, antes de local, data e assinatura
  pdf.paragraph(paragraphs[0] ?? '', { size: 11 });
  if (budget && settings.authorizationShowDetails) {
    const method = budget.paymentMethodId ? await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, budget.paymentMethodId) }) : null;
    pdf.heading('Serviço contratado');
    const pairs: [string, string][] = [
      ['Serviço', categoryLabel(budget.category)],
      ...(budget.description ? ([['Descrição', budget.description]] as [string, string][]) : []),
      ['Valor', formatMoney(budget.amountCents)],
      ...(Number(budget.discountPercent) > 0 ? ([['Desconto', `${Number(budget.discountPercent).toLocaleString('pt-BR')}%`]] as [string, string][]) : []),
      ['Total', formatMoney(budget.totalCents)],
      ['Parcelas', String(budget.installments)],
      ...(method ? ([['Forma de pagamento', method.name]] as [string, string][]) : []),
      ...(budget.billingStartDate ? ([['Início da cobrança', brDate(budget.billingStartDate)]] as [string, string][]) : []),
      ['Situação do orçamento', budgetStatusLabel(budget.status)],
    ];
    pdf.keyValues(pairs);
    pdf.doc.moveDown(0.8);
  }
  for (const para of paragraphs.slice(1)) pdf.paragraph(para, { size: 11 });
  return { pdf: await finishPdf(pdf), subject, filename: `autorizacao-${year}.pdf` };
}
