/**
 * Relatório de Situação Fiscal (SITFIS) do SERPRO Integra Contador: leitura do texto do PDF e
 * interpretação conservadora.
 *
 * O serviço RELATORIOSITFIS92 devolve só o PDF (base64), sem campos estruturados. O relatório
 * oficial ("Informações de apoio para emissão de certidão") traz:
 * - a seção "Certidão Emitida", com o tipo da certidão vigente (Negativa ou Positiva com Efeitos de
 *   Negativa), o código de controle, a data de emissão e a validade;
 * - o "Diagnóstico Fiscal na Receita Federal e Procuradoria-Geral da Fazenda Nacional", que diz
 *   "Não foram detectadas pendências/exigibilidades suspensas..." ou lista as pendências
 *   ("Pendência - Débito (SIEF)", "Pendência - Omissão de Declaração"...).
 * Exemplo oficial: apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/pt/solucoes/integra-sitfis/sitfis/exemplos/retorno_emitir_relatorio/
 *
 * O PDF guardado continua sendo a fonte da verdade. Só o que o texto diz com essas frases vira dado;
 * se o texto não puder ser lido ou não tiver as frases, a situação fica "não interpretada" (nada é
 * deduzido) e nenhuma função daqui lança erro: um layout novo nunca derruba a sincronização.
 */
import { inflateSync, constants as zlibConstants } from 'node:zlib';
import type { SitfisStatus } from '@verifco/shared';

/** Relatórios maiores que isso não são lidos (o SITFIS tem poucas páginas). */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PENDENCIES = 30;
const MAX_LINE = 200;

// ---------------------------------------------------------------------------
// Texto de um PDF (o suficiente para relatórios gerados por sistema, sem OCR)
// ---------------------------------------------------------------------------

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

const latin1 = (b: Buffer) => b.toString('latin1');

function inflate(data: Buffer): Buffer | null {
  try {
    return inflateSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
  } catch {
    return null;
  }
}

/** Objetos `N G obj ... endobj` do arquivo, com o stream já descompactado (Flate). */
function readObjects(pdf: Buffer): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const text = latin1(pdf);
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const s = /\bstream\r?\n/.exec(text.slice(start, start + 4096));
    const plainEnd = text.indexOf('endobj', start);
    if (plainEnd < 0) break;
    let dict = text.slice(start, plainEnd);
    let stream: Buffer | null = null;
    let end = plainEnd;
    if (s && start + s.index < plainEnd) {
      dict = text.slice(start, start + s.index);
      const dataStart = start + s.index + s[0].length;
      // o /Length direto é o mais confiável; sem ele, o primeiro "endstream" depois dos dados
      const length = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = -1;
      if (length) {
        const candidate = dataStart + Number(length[1]);
        if (/^\s*endstream/.test(text.slice(candidate, candidate + 16))) dataEnd = candidate;
      }
      if (dataEnd < 0) {
        dataEnd = text.indexOf('endstream', dataStart);
        if (dataEnd < 0) break;
        if (pdf[dataEnd - 1] === 0x0a) dataEnd -= 1;
        if (pdf[dataEnd - 1] === 0x0d) dataEnd -= 1;
      }
      const raw = pdf.subarray(dataStart, dataEnd);
      stream = /\/FlateDecode/.test(dict) && !/\/DecodeParms/.test(dict) ? inflate(raw) : /\/Filter/.test(dict) ? null : raw;
      const after = text.indexOf('endobj', dataEnd);
      if (after < 0) break;
      end = after;
    }
    objects.set(Number(m[1]), { dict, stream });
    re.lastIndex = end;
  }
  // objetos guardados dentro de object streams (PDF 1.5+)
  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict) || !obj.stream) continue;
    const n = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const content = latin1(obj.stream);
    const header = content.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n && i * 2 + 1 < header.length; i++) {
      const num = header[i * 2];
      const off = header[i * 2 + 1];
      const next = i + 1 < n ? header[(i + 1) * 2 + 1] : content.length - first;
      if (Number.isFinite(num) && !objects.has(num)) objects.set(num, { dict: content.slice(first + off, first + next), stream: null });
    }
  }
  return objects;
}

/** Texto de um par de bytes UTF-16BE em hexadecimal (destino dos CMaps). */
function utf16Hex(hex: string): string {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

type Font = { map: Map<string, string>; bytes: number } | null;

/** Tabela de código → texto de um CMap ToUnicode (bfchar e bfrange). */
function parseToUnicode(cmap: string): Font {
  const map = new Map<string, string>();
  const range = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(/begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmap)?.[1] ?? '');
  const bytes = range ? Math.max(1, Math.round(range[1].length / 2)) : 1;
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(p[1].toLowerCase(), utf16Hex(p[2]));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const width = p[1].length;
      if (!(hi >= lo) || hi - lo > 5000) continue;
      if (p[3].startsWith('[')) {
        const list = [...p[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => utf16Hex(x[1]));
        for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(width, '0'), list[c - lo] ?? '');
      } else {
        const base = parseInt(p[3].slice(1, -1), 16);
        for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(width, '0'), String.fromCharCode(base + c - lo));
      }
    }
  }
  return { map, bytes };
}

/** Caracteres 0x80–0x9F da codificação WinAnsi das fontes simples (os demais coincidem com o Latin-1). */
const WIN_ANSI: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

/** Bytes de uma string de texto do PDF, pela fonte em uso (sem ToUnicode, a codificação WinAnsi). */
function decodeString(bytes: Buffer, font: Font): string {
  if (!font) {
    let out = '';
    for (const b of bytes) out += WIN_ANSI[b] ?? String.fromCharCode(b);
    return out;
  }
  let out = '';
  for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) out += font.map.get(bytes.subarray(i, i + font.bytes).toString('hex')) ?? '';
  return out;
}

/** Fontes por nome de recurso (/F1...) → CMap ToUnicode (ou null para fontes simples). */
function fontsByName(objects: Map<number, PdfObject>): Map<string, Font> {
  const fonts = new Map<string, Font>();
  const cmapOf = (fontNum: number): Font => {
    const font = objects.get(fontNum);
    const ref = font && /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(font.dict);
    const stream = ref ? objects.get(Number(ref[1]))?.stream : null;
    return stream ? parseToUnicode(latin1(stream)) : null;
  };
  const addFrom = (dict: string) => {
    for (const p of dict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      if (!fonts.has(p[1]) && /\/Type\s*\/Font/.test(objects.get(Number(p[2]))?.dict ?? '')) fonts.set(p[1], cmapOf(Number(p[2])));
    }
  };
  for (const obj of objects.values()) {
    const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(obj.dict);
    if (inline) addFrom(inline[1]);
    const ref = /\/Font\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    if (ref) addFrom(objects.get(Number(ref[1]))?.dict ?? '');
  }
  return fonts;
}

type Token = { t: 'str'; bytes: Buffer } | { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'op'; v: string } | { t: '[' } | { t: ']' };

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const ESCAPES: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };

/** Tokens de um content stream (strings literais com parênteses aninhados, hex, nomes, números e operadores). */
function* tokenize(s: Buffer): Generator<Token> {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (WS.has(c)) {
      i++;
    } else if (c === 0x25) {
      while (i < n && s[i] !== 0x0a && s[i] !== 0x0d) i++;
    } else if (c === 0x28) {
      const out: number[] = [];
      let depth = 1;
      i++;
      while (i < n) {
        const ch = s[i++];
        if (ch === 0x5c) {
          const e = s[i++];
          if (e === undefined) break;
          if (e in ESCAPES) out.push(ESCAPES[e]);
          else if (e >= 0x30 && e <= 0x37) {
            let oct = e - 0x30;
            for (let k = 0; k < 2 && s[i] >= 0x30 && s[i] <= 0x37; k++) oct = oct * 8 + (s[i++] - 0x30);
            out.push(oct & 0xff);
          } else if (e === 0x0d) {
            if (s[i] === 0x0a) i++;
          } else if (e !== 0x0a) out.push(e);
        } else if (ch === 0x28) {
          depth++;
          out.push(ch);
        } else if (ch === 0x29) {
          if (--depth === 0) break;
          out.push(ch);
        } else out.push(ch);
      }
      yield { t: 'str', bytes: Buffer.from(out) };
    } else if (c === 0x3c && s[i + 1] === 0x3c) {
      i += 2;
    } else if (c === 0x3e && s[i + 1] === 0x3e) {
      i += 2;
    } else if (c === 0x3c) {
      const close = s.indexOf(0x3e, i + 1);
      const end = close < 0 ? n : close;
      let hex = latin1(s.subarray(i + 1, end)).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length % 2) hex += '0';
      yield { t: 'str', bytes: Buffer.from(hex, 'hex') };
      i = end + 1;
    } else if (c === 0x5b) {
      i++;
      yield { t: '[' };
    } else if (c === 0x5d) {
      i++;
      yield { t: ']' };
    } else if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !WS.has(s[j]) && !DELIM.has(s[j])) j++;
      yield { t: 'name', v: latin1(s.subarray(i + 1, j)) };
      i = j;
    } else if (DELIM.has(c)) {
      i++;
    } else {
      let j = i;
      while (j < n && !WS.has(s[j]) && !DELIM.has(s[j])) j++;
      const word = latin1(s.subarray(i, j));
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
        yield { t: 'num', v: Number(word) };
      } else if (word === 'ID') {
        // imagem embutida: pula os bytes até o EI
        const rest = latin1(s.subarray(i, Math.min(n, i + 1_000_000)));
        const ei = /\sEI(?=[\s]|$)/.exec(rest);
        i = ei ? i + ei.index + ei[0].length : n;
      } else {
        yield { t: 'op', v: word };
      }
    }
  }
}

/**
 * Texto de um content stream: operadores Tj, TJ, ' e ". Trechos na mesma altura viram uma linha
 * (separados por espaço); mudança de altura, T*, ' e " começam outra.
 */
function contentText(content: Buffer, fonts: Map<string, Font>): string {
  let out = '';
  let font: Font = null;
  let operands: Token[] = [];
  let array: string[] | null = null;
  let y = 0;
  let scaleY = 1;
  let lineY: number | null = null;
  let moved = true;
  const newline = () => {
    if (out && !out.endsWith('\n')) out += '\n';
    lineY = null;
  };
  const show = (text: string) => {
    if (moved) {
      if (lineY !== null && Math.abs(y - lineY) < 0.5) {
        if (!out.endsWith(' ')) out += ' ';
      } else newline();
      moved = false;
    }
    lineY = y;
    out += text;
  };
  const lastString = () => {
    const tok = [...operands].reverse().find((o) => o.t === 'str');
    return tok && tok.t === 'str' ? decodeString(tok.bytes, font) : '';
  };
  const nums = () => operands.filter((o): o is { t: 'num'; v: number } => o.t === 'num').map((o) => o.v);
  for (const tok of tokenize(content)) {
    if (tok.t === '[') {
      array = [];
      continue;
    }
    if (tok.t === ']') continue;
    if (array && tok.t === 'str') {
      array.push(decodeString(tok.bytes, font));
      continue;
    }
    if (array && tok.t === 'num') {
      // afastamento grande entre trechos do TJ funciona como espaço
      if (tok.v < -200) array.push(' ');
      continue;
    }
    if (tok.t !== 'op') {
      operands.push(tok);
      continue;
    }
    switch (tok.v) {
      case 'BT':
        y = 0;
        scaleY = 1;
        moved = true;
        break;
      case 'Tf': {
        const name = operands.find((o) => o.t === 'name');
        font = name && name.t === 'name' ? (fonts.get(name.v) ?? null) : null;
        break;
      }
      case 'Tm': {
        const v = nums();
        if (v.length >= 6) {
          y = v[5];
          scaleY = v[3] || 1;
        }
        moved = true;
        break;
      }
      case 'Td':
      case 'TD': {
        const v = nums();
        if (v.length >= 2) y += v[1] * scaleY;
        moved = true;
        break;
      }
      case 'T*':
        newline();
        moved = true;
        break;
      case 'Tj':
        show(lastString());
        break;
      case 'TJ':
        show((array ?? []).join(''));
        break;
      case "'":
      case '"':
        newline();
        moved = true;
        show(lastString());
        break;
      case 'ET':
        moved = true;
        break;
    }
    // arrays e operandos valem só para o operador seguinte
    array = null;
    operands = [];
  }
  return out;
}

/** Texto de um PDF gerado por sistema (sem OCR). Devolve '' quando não consegue ler. */
export function pdfText(pdf: Buffer): string {
  try {
    if (pdf.length > MAX_PDF_BYTES || latin1(pdf.subarray(0, 5)) !== '%PDF-') return '';
    const objects = readObjects(pdf);
    const fonts = fontsByName(objects);
    const parts: string[] = [];
    for (const obj of objects.values()) {
      if (!obj.stream) continue;
      if (/\/Subtype\s*\/(Image|Form|Type1C|CIDFontType0C|OpenType)|\/Type\s*\/(XRef|ObjStm|Font|FontDescriptor|Metadata|EmbeddedFile)|\/Length[123]\b/.test(obj.dict)) continue;
      const head = latin1(obj.stream.subarray(0, 300));
      if (/begincmap|CIDInit/.test(head)) continue;
      if (!/\b(Tj|TJ)\b|[\s)>]['"]\s/.test(latin1(obj.stream))) continue;
      parts.push(contentText(obj.stream, fonts));
    }
    return parts
      .join('\n')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Interpretação do relatório
// ---------------------------------------------------------------------------

export interface SitfisCertificate {
  /** "Negativa", "Positiva com Efeitos de Negativa" ou "Positiva", como no relatório. */
  type: string;
  /** Código de controle; `null` quando mascarado ou ausente. */
  code: string | null;
  issuedAt: string | null;
  validUntil: string | null;
}

export interface SitfisReading {
  /** O texto do PDF pôde ser lido. */
  readable: boolean;
  /** `regular`: o relatório diz que não há pendências; `pending`: lista pendências; `unknown`: não interpretado. */
  status: SitfisStatus;
  /** Frase do relatório que sustenta a situação (só quando `regular`). */
  message: string | null;
  pendencies: string[];
  certificate: SitfisCertificate | null;
}

const CERTIFICATE_TYPES: Record<string, string> = {
  negativa: 'Negativa',
  'positiva com efeitos de negativa': 'Positiva com Efeitos de Negativa',
  positiva: 'Positiva',
};

/** DD/MM/AAAA → AAAA-MM-DD, só para datas de calendário válidas (o modelo mascara com 99/99/9999). */
function brDate(s: string | undefined): string | null {
  const m = s ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s) : null;
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1990 || y > 2200 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const UNKNOWN = (readable: boolean): SitfisReading => ({ readable, status: 'unknown', message: null, pendencies: [], certificate: null });

/** Lê o texto do relatório SITFIS. Sem as frases do modelo oficial, devolve a situação como não interpretada. */
export function interpretSitfis(text: string): SitfisReading {
  try {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return UNKNOWN(false);
    const clear = /N[ãa]o foram detectadas pend[êe]ncias[^.]{0,300}\./i.exec(flat);
    const pendencies = [
      ...new Set(
        text
          .split('\n')
          .map((l) => l.replace(/\s+/g, ' ').trim())
          .filter((l) => /^Pend[êe]ncia\s*[-–—:]\s*\S/i.test(l))
          .map((l) => l.slice(0, MAX_LINE)),
      ),
    ].slice(0, MAX_PENDENCIES);

    let certificate: SitfisCertificate | null = null;
    const section = /Certid[ãa]o Emitida/i.exec(flat);
    if (section) {
      const cert = /Certid[ãa]o\s+(Positiva com Efeitos de Negativa|Negativa|Positiva)\s*:\s*([A-Z0-9][A-Z0-9.]{5,40})?/i.exec(flat.slice(section.index));
      if (cert) {
        const after = flat.slice(section.index + cert.index, section.index + cert.index + 400);
        const code = cert[2]?.replace(/\.+$/, '') ?? null;
        certificate = {
          type: CERTIFICATE_TYPES[cert[1].toLowerCase()] ?? cert[1],
          code: code && !/^Z+(\.Z+)*$/i.test(code) && /\d/.test(code) ? code : null,
          issuedAt: brDate(/Emiss[ãa]o\s*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(after)?.[1]),
          validUntil: brDate(/Validade\s*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(after)?.[1]),
        };
      }
    }
    if (pendencies.length) return { readable: true, status: 'pending', message: null, pendencies, certificate };
    if (clear) return { readable: true, status: 'regular', message: clear[0], pendencies: [], certificate };
    return { ...UNKNOWN(true), certificate };
  } catch {
    return UNKNOWN(false);
  }
}

/** Lê e interpreta o PDF do relatório; nunca lança erro. */
export function readSitfisReport(pdf: Buffer): SitfisReading {
  try {
    return interpretSitfis(pdfText(pdf));
  } catch {
    return UNKNOWN(false);
  }
}
