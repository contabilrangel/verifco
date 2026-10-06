import ExcelJS from 'exceljs';
import { ATTENTION_SEVERITY, formatDate, formatMoney, type AttentionPoint } from '@verifco/shared';
import { PdfBuilder, type PdfBranding } from '../../services/pdf';

/**
 * Modelo neutro dos relatórios: cada relatório gera seções com blocos e o mesmo conteúdo
 * é desenhado em PDF (PdfBuilder com as cores do escritório) ou em Excel (uma aba por seção).
 */
export type Cell = string | { money: number } | { pct: number } | { date: string | null };

export type Block =
  | { type: 'stats'; items: { label: string; value: Cell; tone?: 'positive' | 'negative' | 'neutral' }[] }
  | { type: 'kv'; title?: string; pairs: [string, Cell][] }
  | { type: 'table'; title?: string; columns: { label: string; width: number; align?: 'left' | 'right' }[]; rows: Cell[][]; totals?: Cell[]; empty?: string }
  | { type: 'text'; text: string; muted?: boolean }
  | { type: 'bullets'; title?: string; items: string[] }
  | { type: 'bars'; title: string; items: { label: string; cents: number }[] }
  | { type: 'points'; points: AttentionPoint[]; empty: string };

export interface Section {
  key: string;
  title: string;
  /** Nome da aba no Excel (até 31 caracteres); padrão: o título. */
  sheet?: string;
  subtitle?: string;
  blocks: Block[];
}

export const fmtCell = (c: Cell): string => {
  if (typeof c === 'string') return c;
  if ('money' in c) return formatMoney(c.money);
  if ('pct' in c) return `${(c.pct * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  return c.date ? formatDate(c.date) : '—';
};

const TEXT = '#212429';
const MUTED = '#636e7c';
const SOFT = '#f4f6fb';
const TONE = { positive: '#1a7f37', negative: '#c62828', neutral: '' };
const SEVERITY_COLOR = { high: '#c62828', medium: '#b26a00', low: '#3468e6' };

/** Desenha as seções num PdfBuilder já criado. */
export function renderPdf(pdf: PdfBuilder, brand: PdfBranding, sections: Section[], opts: { pageBreakBetween?: boolean } = {}) {
  const { doc } = pdf;
  sections.forEach((s, idx) => {
    if (idx > 0 && opts.pageBreakBetween) {
      doc.addPage();
      doc.y = pdf.margin;
    }
    pdf.ensureSpace(150);
    doc.moveDown(idx === 0 || opts.pageBreakBetween ? 0 : 0.8);
    // faixa do título da seção
    const y = doc.y;
    doc.rect(pdf.margin, y, 4, 18).fill(brand.subtitleColor);
    doc.fillColor(brand.titleColor).font('Helvetica-Bold').fontSize(13).text(s.title, pdf.margin + 12, y + 2, { width: pdf.width - 12 });
    if (s.subtitle) doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(s.subtitle, pdf.margin + 12, undefined, { width: pdf.width - 12 });
    doc.x = pdf.margin;
    doc.moveDown(0.8);
    for (const b of s.blocks) renderBlock(pdf, brand, b);
  });
}

function blockTitle(pdf: PdfBuilder, brand: PdfBranding, title?: string) {
  if (!title) return;
  pdf.ensureSpace(48);
  pdf.doc.fillColor(brand.subtitleColor).font('Helvetica-Bold').fontSize(10).text(title, pdf.margin, undefined, { width: pdf.width });
  pdf.doc.moveDown(0.3);
}

function renderBlock(pdf: PdfBuilder, brand: PdfBranding, b: Block) {
  const { doc } = pdf;
  switch (b.type) {
    case 'stats': {
      const gap = 10;
      const n = b.items.length;
      const w = (pdf.width - gap * (n - 1)) / n;
      const h = 54;
      pdf.ensureSpace(h + 12);
      const y = doc.y;
      b.items.forEach((it, i) => {
        const x = pdf.margin + i * (w + gap);
        doc.roundedRect(x, y, w, h, 6).fillAndStroke(SOFT, brand.lineColor);
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(it.label.toUpperCase(), x + 10, y + 10, { width: w - 20, characterSpacing: 0.3 });
        doc
          .fillColor((it.tone && TONE[it.tone]) || brand.titleColor)
          .font('Helvetica-Bold')
          .fontSize(n > 3 ? 12 : 14)
          .text(fmtCell(it.value), x + 10, y + 26, { width: w - 20 });
      });
      doc.x = pdf.margin;
      doc.y = y + h + 12;
      return;
    }
    case 'kv':
      blockTitle(pdf, brand, b.title);
      pdf.keyValues(b.pairs.map(([k, v]) => [k, fmtCell(v)]));
      doc.moveDown(0.4);
      return;
    case 'table':
      // tabelas curtas não se dividem entre páginas
      pdf.ensureSpace(Math.min((b.rows.length + 1 + (b.totals ? 1 : 0)) * 21 + (b.title ? 22 : 0), 320));
      blockTitle(pdf, brand, b.title);
      if (!b.rows.length) {
        pdf.paragraph(b.empty ?? 'Nenhum registro.', { muted: true, size: 9 });
        return;
      }
      pdf.table(
        b.columns,
        b.rows.map((r) => r.map(fmtCell)),
        { totals: b.totals?.map(fmtCell) },
      );
      return;
    case 'text':
      pdf.paragraph(b.text, { muted: b.muted, size: b.muted ? 8.5 : 10 });
      return;
    case 'bullets':
      blockTitle(pdf, brand, b.title);
      for (const it of b.items) {
        pdf.ensureSpace(24);
        const y = doc.y;
        doc.circle(pdf.margin + 4, y + 5, 2).fill(brand.subtitleColor);
        doc.fillColor(TEXT).font('Helvetica').fontSize(9.5).text(it, pdf.margin + 14, y, { width: pdf.width - 14 });
        doc.moveDown(0.35);
      }
      doc.x = pdf.margin;
      doc.moveDown(0.3);
      return;
    case 'bars': {
      blockTitle(pdf, brand, b.title);
      const h = 120;
      pdf.ensureSpace(h + 40);
      const top = doc.y + 14;
      const max = Math.max(1, ...b.items.map((i) => Math.abs(i.cents)));
      const slot = pdf.width / Math.max(1, b.items.length);
      const barW = Math.min(56, slot * 0.55);
      const base = top + h;
      doc.moveTo(pdf.margin, base).lineTo(pdf.margin + pdf.width, base).lineWidth(0.6).strokeColor(brand.lineColor).stroke();
      b.items.forEach((it, i) => {
        const x = pdf.margin + i * slot + (slot - barW) / 2;
        const bh = Math.max(1, (Math.abs(it.cents) / max) * (h - 18));
        doc.rect(x, base - bh, barW, bh).fill(it.cents < 0 ? TONE.negative : brand.subtitleColor);
        doc
          .fillColor(TEXT)
          .font('Helvetica-Bold')
          .fontSize(7)
          .text(compactMoney(it.cents), x - 20, base - bh - 11, { width: barW + 40, align: 'center' });
        doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(it.label, pdf.margin + i * slot, base + 5, { width: slot, align: 'center' });
      });
      doc.x = pdf.margin;
      doc.y = base + 24;
      return;
    }
    case 'points': {
      if (!b.points.length) {
        pdf.paragraph(b.empty, { muted: true });
        return;
      }
      for (const p of b.points) {
        const color = SEVERITY_COLOR[p.severity];
        const textW = pdf.width - 90;
        doc.font('Helvetica').fontSize(9);
        const hDetail = doc.heightOfString(p.detail, { width: textW });
        const hRec = doc.fontSize(8.5).heightOfString(p.recommendation, { width: textW });
        const h = 20 + hDetail + hRec + 14;
        pdf.ensureSpace(h + 8);
        const y = doc.y;
        doc.roundedRect(pdf.margin, y, pdf.width, h, 5).fillAndStroke('#ffffff', brand.lineColor);
        doc.rect(pdf.margin, y, 4, h).fill(color);
        doc.roundedRect(pdf.margin + 14, y + 10, 58, 15, 3).fill(color);
        doc
          .fillColor('#ffffff')
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .text(ATTENTION_SEVERITY[p.severity].toUpperCase(), pdf.margin + 14, y + 14, { width: 58, align: 'center' });
        doc.fillColor(brand.titleColor).font('Helvetica-Bold').fontSize(10).text(p.title, pdf.margin + 82, y + 10, { width: textW });
        doc.fillColor(TEXT).font('Helvetica').fontSize(9).text(p.detail, pdf.margin + 82, undefined, { width: textW });
        doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.5).text(p.recommendation, pdf.margin + 82, undefined, { width: textW });
        doc.x = pdf.margin;
        doc.y = y + h + 8;
      }
      doc.moveDown(0.3);
      return;
    }
  }
}

/**
 * Finaliza o PDF. Zera a margem inferior antes de o PdfBuilder escrever o rodapé: com a
 * margem, o pdfkit trata o rodapé como estouro de página e acrescenta páginas em branco.
 */
export async function finishPdf(pdf: PdfBuilder): Promise<Buffer> {
  const range = pdf.doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.doc.switchToPage(i);
    pdf.doc.page.margins.bottom = 0;
  }
  return pdf.finish();
}

function compactMoney(cents: number) {
  const v = cents / 100;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1_000) return `R$ ${(v / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
  return formatMoney(cents);
}

/** Uma aba por seção; blocos empilhados com uma linha em branco entre eles. */
export async function renderXlsx(sections: Section[], brand: PdfBranding, heading: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = brand.officeName;
  const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;
  const used = new Set<string>();
  for (const s of sections) {
    const base = (s.sheet ?? s.title).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim();
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base.slice(0, 26)} (${i})`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.getColumn(1).width = 42;
    for (let c = 2; c <= 8; c++) ws.getColumn(c).width = 18;
    const t = ws.addRow([s.title]);
    t.font = { bold: true, size: 14, color: { argb: argb(brand.titleColor) } };
    ws.addRow([s.subtitle ?? heading]).font = { italic: true, color: { argb: 'FF636E7C' } };
    ws.addRow([]);
    const put = (cells: Cell[], opts: { bold?: boolean; header?: boolean } = {}) => {
      const row = ws.addRow(
        cells.map((c) => {
          if (typeof c === 'string') return c;
          if ('money' in c) return c.money / 100;
          if ('pct' in c) return c.pct;
          return c.date ? new Date(`${c.date.slice(0, 10)}T12:00:00`) : '';
        }),
      );
      cells.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        if (typeof c !== 'string') {
          if ('money' in c) cell.numFmt = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
          else if ('pct' in c) cell.numFmt = '0.0%';
          else cell.numFmt = 'dd/mm/yyyy';
        }
        if (opts.header) {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(brand.titleColor) } };
        } else if (opts.bold) cell.font = { bold: true };
      });
    };
    for (const b of s.blocks) {
      switch (b.type) {
        case 'stats':
          for (const it of b.items) put([it.label, it.value], {});
          break;
        case 'kv':
          if (b.title) put([b.title], { bold: true });
          for (const [k, v] of b.pairs) put([k, v]);
          break;
        case 'table':
          if (b.title) put([b.title], { bold: true });
          put(b.columns.map((c) => c.label), { header: true });
          if (!b.rows.length) put([b.empty ?? 'Nenhum registro.']);
          for (const r of b.rows) put(r);
          if (b.totals) put(b.totals, { bold: true });
          break;
        case 'text':
          put([b.text]);
          break;
        case 'bullets':
          if (b.title) put([b.title], { bold: true });
          for (const it of b.items) put([`• ${it}`]);
          break;
        case 'bars':
          put([b.title], { bold: true });
          for (const it of b.items) put([it.label, { money: it.cents }]);
          break;
        case 'points':
          if (!b.points.length) {
            put([b.empty]);
            break;
          }
          put(['Gravidade', 'Ponto de atenção', 'Detalhe', 'Recomendação'], { header: true });
          for (const p of b.points) put([ATTENTION_SEVERITY[p.severity], p.title, p.detail, p.recommendation]);
          break;
      }
      ws.addRow([]);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
