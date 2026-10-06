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
 * Só o que o texto diz com essas frases vira dado; se o texto não puder ser lido ou não tiver as
 * frases, o PDF é guardado e a situação fica "não interpretada" (nunca deduzimos nada).
 * O Integra Contador não emite a CND: quando o relatório não mostra certidão vigente, a CND precisa
 * ser emitida no site da Receita.
 */
import { inflateSync, constants as zlibConstants } from 'node:zlib';

// ---------------------------------------------------------------------------
// Texto de um PDF (o suficiente para relatórios gerados por sistema)
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
    const end = text.indexOf('endobj', start);
    if (end < 0) break;
    const body = text.slice(start, end);
    const s = /\bstream\r?\n/.exec(body);
    let dict = body;
    let stream: Buffer | null = null;
    if (s) {
      dict = body.slice(0, s.index);
      const dataStart = start + s.index + s[0].length;
      const endStream = text.lastIndexOf('endstream', end);
      if (endStream > dataStart) {
        let raw = pdf.subarray(dataStart, endStream);
        if (raw.at(-1) === 0x0a) raw = raw.subarray(0, -1);
        if (raw.at(-1) === 0x0d) raw = raw.subarray(0, -1);
        stream = /\/FlateDecode/.test(dict) ? inflate(raw) : /\/Filter/.test(dict) ? null : raw;
      }
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
    for (let i = 0; i < n; i++) {
      const num = header[i * 2];
      const off = header[i * 2 + 1];
      const next = i + 1 < n ? header[(i + 1) * 2 + 1] : content.length - first;
      if (!objects.has(num)) objects.set(num, { dict: content.slice(first + off, first + next), stream: null });
    }
  }
  return objects;
}

/** Tabela de código → texto de um CMap ToUnicode (bfchar e bfrange). */
function parseToUnicode(cmap: string): { map: Map<string, string>; bytes: number } {
  const map = new Map<string, string>();
  const hexToText = (hex: string) => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  };
  const range = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(/begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmap)?.[1] ?? '');
  const bytes = range ? Math.max(1, range[1].length / 2) : 1;
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(p[1].toLowerCase(), hexToText(p[2]));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const width = p[1].length;
      if (hi - lo > 5000) continue;
      if (p[3].startsWith('[')) {
        const list = [...p[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hexToText(x[1]));
        for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(width, '0'), list[c - lo] ?? '');
      } else {
        const base = parseInt(p[3].slice(1, -1), 16);
        for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(width, '0'), String.fromCharCode(base + c - lo));
      }
    }
  }
  return { map, bytes };
}

/** Bytes de uma string literal `(...)` do PDF (com os escapes). */
function literalBytes(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out.push(s.charCodeAt(i) & 0xff);
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (n in esc) out.push(esc[n]);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? '')) oct += s[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (n === '\r' || n === '\n') {
      if (n === '\r' && s[i + 1] === '\n') i++;
    } else out.push(n.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

type Font = { map: Map<string, string>; bytes: number } | null;

function decodeString(bytes: Buffer, font: Font): string {
  if (!font) return latin1(bytes);
  let out = '';
  for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) {
    const key = bytes.subarray(i, i + font.bytes).toString('hex');
    out += font.map.get(key) ?? '';
  }
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

/** Texto de um content stream: operadores Tj, TJ, ' e ", com quebra de linha nos posicionamentos. */
function contentText(content: string, fonts: Map<string, Font>): string {
  let out = '';
  let font: Font = null;
  const tokens = /\/([^\s/<>[\]()]+)\s+[-\d.]+\s+Tf|\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-fA-F\s]*>|\[|\]|-?\d*\.?\d+|(Tj|TJ|'|"|Td|TD|T\*|Tm|ET|BT)\b|'|"/g;
  let pending: string[] = [];
  let inArray = false;
  let m: RegExpExecArray | null;
  const piece = (tok: string) => (tok.startsWith('(') ? decodeString(literalBytes(tok.slice(1, -1)), font) : decodeString(Buffer.from(tok.slice(1, -1).replace(/\s+/g, ''), 'hex'), font));
  while ((m = tokens.exec(content))) {
    const tok = m[0];
    if (m[1] !== undefined) {
      font = fonts.get(m[1]) ?? null;
      continue;
    }
    if (tok === '[') {
      inArray = true;
      pending = [];
    } else if (tok === ']') inArray = false;
    else if (tok.startsWith('(') || (tok.startsWith('<') && !tok.startsWith('<<'))) pending.push(piece(tok));
    else if (inArray && /^-?\d*\.?\d+$/.test(tok)) {
      if (Number(tok) < -200) pending.push(' ');
    } else if (tok === 'Tj' || tok === 'TJ') {
      out += pending.join('');
      pending = [];
    } else if (tok === "'" || tok === '"') {
      out += '\n' + pending.join('');
      pending = [];
    } else if (['Td', 'TD', 'T*', 'Tm', 'ET', 'BT'].includes(tok)) {
      if (!out.endsWith('\n')) out += '\n';
      pending = [];
    }
  }
  return out;
}

/** Texto de um PDF gerado por sistema (sem OCR). Devolve '' quando não consegue ler. */
export function pdfText(pdf: Buffer): string {
  try {
    if (latin1(pdf.subarray(0, 5)) !== '%PDF-') return '';
    const objects = readObjects(pdf);
    const fonts = fontsByName(objects);
    const parts: string[] = [];
    for (const obj of objects.values()) {
      if (!obj.stream || /\/Subtype\s*\/(Image|Form)|\/Type\s*\/(XRef|ObjStm|Font|FontDescriptor|Metadata)|\/Length1|\/CMapName|begincmap/.test(obj.dict + latin1(obj.stream.subarray(0, 200)))) continue;
      const content = latin1(obj.stream);
      if (!/\b(Tj|TJ)\b/.test(content)) continue;
      parts.push(contentText(content, fonts));
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
  /** "Negativa" ou "Positiva com Efeitos de Negativa", como escrito no relatório. */
  type: string;
  code: string | null;
  issuedAt: string | null;
  validUntil: string | null;
}

export interface SitfisReading {
  /** O texto do PDF pôde ser lido. */
  readable: boolean;
  /** 'clear' = o relatório diz que não há pendências; 'pending' = lista pendências; null = não reconhecido. */
  status: 'clear' | 'pending' | null;
  situation: string | null;
  message: string | null;
  pendencies: string[];
  certificate: SitfisCertificate | null;
}

const brDate = (s: string | undefined) => {
  const m = s ? /(\d{2})\/(\d{2})\/(\d{4})/.exec(s) : null;
  return m && !m[0].startsWith('99/') ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/** Lê o relatório SITFIS. Sem as frases do modelo oficial, devolve tudo como não reconhecido. */
export function interpretSitfis(text: string): SitfisReading {
  const flat = text.replace(/\s+/g, ' ');
  if (!flat.trim()) return { readable: false, status: null, situation: null, message: null, pendencies: [], certificate: null };
  const clear = /N[ãa]o foram detectadas pend[êe]ncias[^.]*\./i.exec(flat);
  const pendencies = [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^Pend[êe]ncia\s*[-–:]/i.test(l))
        .map((l) => l.slice(0, 200)),
    ),
  ].slice(0, 30);
  let certificate: SitfisCertificate | null = null;
  const cert = /Certid[ãa]o\s+(Negativa|Positiva com Efeitos de Negativa|Positiva)\s*:\s*([A-Z0-9][A-Z0-9.]{5,40})?/i.exec(flat);
  if (cert && /Certid[ãa]o Emitida/i.test(flat)) {
    const after = flat.slice(cert.index, cert.index + 400);
    const code = cert[2] && !/^Z+(\.Z+)*$/i.test(cert[2]) ? cert[2] : null;
    certificate = {
      type: cert[1],
      code,
      issuedAt: brDate(/Emiss[ãa]o\s*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(after)?.[1]),
      validUntil: brDate(/Validade\s*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(after)?.[1]),
    };
  }
  if (pendencies.length) {
    return { readable: true, status: 'pending', situation: 'Com pendências', message: 'O relatório de situação fiscal lista pendências na Receita Federal ou na PGFN.', pendencies, certificate };
  }
  if (clear) return { readable: true, status: 'clear', situation: 'Sem pendências', message: clear[0], pendencies: [], certificate };
  return { readable: true, status: null, situation: null, message: null, pendencies: [], certificate };
}
