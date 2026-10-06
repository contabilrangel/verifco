import PDFDocument from 'pdfkit';
import { eq } from 'drizzle-orm';
import { formatMoney } from '@verifco/shared';
import type { AppContext } from '../context';
import { offices } from '../db/schema';
import { DEFAULT_SETTINGS } from './settings';

/**
 * Gerador de PDFs dos relatórios, recibos, kit pós-declaração etc.
 * Usa o logo e as cores configuradas nas preferências do escritório.
 */
export interface PdfBranding {
  officeName: string;
  officeDoc?: string | null;
  logo?: Buffer | null;
  titleColor: string;
  subtitleColor: string;
  lineColor: string;
}

export async function loadBranding(ctx: AppContext, officeId: string): Promise<PdfBranding> {
  const office = await ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId) });
  const s = { ...DEFAULT_SETTINGS, ...(office?.settings ?? {}) };
  let logo: Buffer | null = null;
  if (office?.logoFileId) {
    try {
      const f = await ctx.files.get(officeId, office.logoFileId);
      if (/png|jpe?g/.test(f.row.mimeType)) logo = f.data;
    } catch {
      logo = null;
    }
  }
  return {
    officeName: office?.name ?? 'Verifco',
    officeDoc: office?.cpfCnpj,
    logo,
    titleColor: s.reportTitleColor,
    subtitleColor: s.reportSubtitleColor,
    lineColor: s.reportLineColor,
  };
}

export class PdfBuilder {
  doc: PDFKit.PDFDocument;
  private chunks: Buffer[] = [];
  private done: Promise<Buffer>;
  readonly margin = 48;

  constructor(
    private brand: PdfBranding,
    private title: string,
    private subtitle?: string,
  ) {
    this.doc = new PDFDocument({ size: 'A4', margin: this.margin, bufferPages: true, info: { Title: title, Author: brand.officeName } });
    this.doc.on('data', (c: Buffer) => this.chunks.push(c));
    this.done = new Promise((resolve) => this.doc.on('end', () => resolve(Buffer.concat(this.chunks))));
    this.header();
  }

  get width() {
    return this.doc.page.width - this.margin * 2;
  }

  private header() {
    const { doc } = this;
    const top = this.margin;
    let x = this.margin;
    if (this.brand.logo) {
      try {
        doc.image(this.brand.logo, x, top, { fit: [110, 40] });
        x += 124;
      } catch {
        /* logo inválido: segue sem */
      }
    }
    doc.fillColor(this.brand.titleColor).font('Helvetica-Bold').fontSize(16).text(this.title, x, top, { width: this.width - (x - this.margin) });
    if (this.subtitle) doc.fillColor(this.brand.subtitleColor).font('Helvetica').fontSize(10).text(this.subtitle, x);
    doc.fillColor('#636e7c').fontSize(8).text(this.brand.officeName, x);
    doc.moveDown(0.8);
    this.rule();
  }

  rule() {
    const y = this.doc.y;
    this.doc.moveTo(this.margin, y).lineTo(this.margin + this.width, y).lineWidth(1).strokeColor(this.brand.lineColor).stroke();
    this.doc.moveDown(0.6);
    return this;
  }

  heading(text: string) {
    this.ensureSpace(40);
    this.doc.moveDown(0.4).fillColor(this.brand.titleColor).font('Helvetica-Bold').fontSize(12).text(text, this.margin);
    this.doc.moveDown(0.3);
    return this;
  }

  paragraph(text: string, opts: { muted?: boolean; size?: number } = {}) {
    this.doc
      .fillColor(opts.muted ? '#636e7c' : '#212429')
      .font('Helvetica')
      .fontSize(opts.size ?? 10)
      .text(text, this.margin, undefined, { width: this.width, align: 'left' });
    this.doc.moveDown(0.4);
    return this;
  }

  /** Pares rótulo/valor em duas colunas. */
  keyValues(pairs: [string, string][]) {
    const colW = this.width / 2;
    for (const [k, v] of pairs) {
      this.ensureSpace(18);
      const y = this.doc.y;
      this.doc.fillColor('#636e7c').font('Helvetica').fontSize(9).text(k, this.margin, y, { width: colW - 8 });
      this.doc.fillColor('#212429').font('Helvetica-Bold').fontSize(10).text(v, this.margin + colW, y, { width: colW, align: 'right' });
      this.doc.moveDown(0.25);
    }
    return this;
  }

  /** Tabela simples com cabeçalho; `align` por coluna. */
  table(columns: { label: string; width: number; align?: 'left' | 'right' }[], rows: string[][], opts: { totals?: string[] } = {}) {
    const total = columns.reduce((a, c) => a + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * this.width);
    const drawRow = (cells: string[], bold = false, fill?: string) => {
      const heights = cells.map((c, i) => this.doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).heightOfString(c ?? '', { width: widths[i] - 8 }));
      const h = Math.max(...heights, 12) + 8;
      this.ensureSpace(h + 4);
      const y = this.doc.y;
      if (fill) this.doc.rect(this.margin, y, this.width, h).fill(fill);
      let x = this.margin;
      cells.forEach((c, i) => {
        this.doc
          .fillColor(bold ? this.brand.titleColor : '#212429')
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(9)
          .text(c ?? '', x + 4, y + 4, { width: widths[i] - 8, align: columns[i].align ?? 'left' });
        x += widths[i];
      });
      this.doc.y = y + h;
      this.doc.moveTo(this.margin, this.doc.y).lineTo(this.margin + this.width, this.doc.y).lineWidth(0.5).strokeColor(this.brand.lineColor).stroke();
    };
    drawRow(columns.map((c) => c.label), true, '#f1f3f5');
    rows.forEach((r) => drawRow(r));
    if (opts.totals) drawRow(opts.totals, true, '#f8f9fa');
    this.doc.x = this.margin;
    this.doc.moveDown(0.6);
    return this;
  }

  /** Tabela de duas colunas com valores monetários. */
  moneyLines(lines: { label: string; cents: number }[], totalLabel?: string) {
    const rows = lines.map((l) => [l.label, formatMoney(l.cents)]);
    const totals = totalLabel ? [totalLabel, formatMoney(lines.reduce((a, l) => a + l.cents, 0))] : undefined;
    return this.table([{ label: 'Descrição', width: 3 }, { label: 'Valor', width: 1, align: 'right' }], rows, { totals });
  }

  ensureSpace(h: number) {
    if (this.doc.y + h > this.doc.page.height - this.margin - 20) {
      this.doc.addPage();
      this.doc.y = this.margin;
    }
  }

  pageBreak() {
    this.doc.addPage();
    return this;
  }

  async finish(): Promise<Buffer> {
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i);
      const bottom = this.doc.page.height - this.margin + 16;
      this.doc
        .fillColor('#97a1ac')
        .font('Helvetica')
        .fontSize(7)
        .text(`${this.brand.officeName} · gerado em ${new Date().toLocaleString('pt-BR')} · página ${i + 1} de ${range.count}`, this.margin, bottom, {
          width: this.width,
          align: 'center',
          lineBreak: false,
        });
    }
    this.doc.end();
    return this.done;
  }
}
