import { inflateSync } from 'node:zlib';

/** Caracteres 0x80–0x9F da codificação WinAnsi (os demais coincidem com o Latin-1). */
const WIN_ANSI: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

const decodeHex = (hex: string) =>
  (hex.match(/../g) ?? [])
    .map((h) => parseInt(h, 16))
    .map((b) => WIN_ANSI[b] ?? String.fromCharCode(b))
    .join('');

/**
 * Linhas de texto de um PDF gerado pelo pdfkit com as fontes padrão (cada linha desenhada é um
 * bloco `TJ`), para os testes compararem o conteúdo de dois PDFs.
 */
export function pdfLines(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const lines: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const t of content.matchAll(/\[((?:<[0-9a-fA-F]*>|[^\]<])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
      const parts = t[1] !== undefined ? [...t[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]) : [t[2]];
      lines.push(parts.map(decodeHex).join(''));
    }
  }
  return lines;
}

/** Linhas do PDF sem o rodapé ("gerado em" com data e hora, que muda a cada geração). */
export const pdfContent = (pdf: Buffer) => pdfLines(pdf).filter((l) => !l.includes('gerado em'));
