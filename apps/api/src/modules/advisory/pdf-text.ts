import type { PdfBuilder } from '../../services/pdf';

const stripInline = (s: string) =>
  s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

/** Escreve Markdown simples (títulos, listas, tabelas e parágrafos) no PDF. */
export function writeMarkdown(pdf: PdfBuilder, markdown: string) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) pdf.paragraph(stripInline(paragraph.join(' ')));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      pdf.heading(stripInline(h[2]));
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const cells = lines[i]
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c) => stripInline(c.trim()));
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      if (rows.length) {
        const [head, ...body] = rows;
        pdf.table(
          head.map((label) => ({ label, width: 1 })),
          body.map((r) => head.map((_, j) => r[j] ?? '')),
        );
      }
      continue;
    }
    const li = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const bullet = /^\d/.test(li[1]) ? li[1] : '•';
      pdf.paragraph(`${bullet} ${stripInline(li[2])}`);
      continue;
    }
    if (/^---+$/.test(line)) {
      flush();
      pdf.rule();
      continue;
    }
    paragraph.push(line);
  }
  flush();
}

/** Texto puro (minuta) preservando parágrafos. */
export function writePlainText(pdf: PdfBuilder, text: string) {
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const t = block.trim();
    if (t) pdf.paragraph(t);
  }
}
