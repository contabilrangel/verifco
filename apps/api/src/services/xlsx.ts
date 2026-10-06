import ExcelJS from 'exceljs';
import { normalizeHeader, parseBrDate, parseBrMoney, toCents } from '@verifco/shared';

export interface SheetColumn {
  header: string;
  key: string;
  width?: number;
  /** 'money' formata centavos como R$; 'date' espera AAAA-MM-DD. */
  type?: 'text' | 'money' | 'number' | 'date';
}

/** Gera um .xlsx a partir de linhas. */
export async function buildWorkbook(sheets: { name: string; columns: SheetColumn[]; rows: Record<string, unknown>[] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Verifco';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    ws.columns = s.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 4) }));
    for (const r of s.rows) {
      const row: Record<string, unknown> = {};
      for (const c of s.columns) {
        const v = r[c.key];
        if (c.type === 'money') row[c.key] = typeof v === 'number' ? v / 100 : v;
        else if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) row[c.key] = new Date(`${v.slice(0, 10)}T12:00:00`);
        else row[c.key] = v ?? '';
      }
      ws.addRow(row);
    }
    s.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      if (c.type === 'money') col.numFmt = '"R$" #,##0.00';
      if (c.type === 'date') col.numFmt = 'dd/mm/yyyy';
    });
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2457' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Cabeçalho normalizado (sem acento, minúsculo, com _): o mesmo `normalizeHeader` do livro caixa. */
const normalize = normalizeHeader;

/**
 * Bytes 0x80–0x9F do Windows-1252, onde ele difere do Latin-1 (aspas curvas, travessão, €...).
 * Os bytes sem caractere (0x81, 0x8D, 0x8F, 0x90, 0x9D) ficam como o controle de mesmo código,
 * como no padrão WHATWG. Não usamos `TextDecoder('windows-1252')`: o do Node 22 decodifica como
 * Latin-1 e transforma "–" (0x96) no controle U+0096.
 */
const CP1252_HIGH = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

/** Decodifica Windows-1252 (o "ANSI" do Excel e do Bloco de Notas em português). */
export function decodeWindows1252(data: Buffer): string {
  return data.toString('latin1').replace(/[\u0080-\u009f]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]);
}

/**
 * Texto de um CSV/TXT: UTF-8 (com ou sem BOM) ou, se não for UTF-8 válido, Windows-1252 (o
 * "CSV (separado por vírgulas)" do Excel em português). Sem isso, "Descrição" chega quebrado.
 * Leitor único de texto de planilha: importações, orçamentos em lote e livro caixa passam por aqui
 * (via `readSheet`/`readSheetTable`).
 */
export function decodeCsvText(data: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    text = decodeWindows1252(data);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Linha lida de planilha, com os cabeçalhos normalizados como chaves. */
export interface SheetRow {
  rowNumber: number;
  /** Texto de cada célula (no .xlsx, `cell.text`: CPF numérico vira "52998224725"; data, AAAA-MM-DD). */
  values: Record<string, string>;
  /**
   * Número cru das células numéricas do .xlsx (valor digitado ou resultado de fórmula), nas mesmas
   * chaves de `values`; vazio no CSV. Valores em reais devem sair daqui: o texto de uma célula
   * numérica usa ponto decimal ("104.895", que o Excel mostra como R$ 104,90) e é ambíguo com o
   * milhar brasileiro. Ver `sheetMoneyToCents`.
   */
  numbers: Record<string, number>;
}

/** Número de uma célula numérica ou de fórmula com resultado numérico; undefined nas demais. */
function cellNumber(cell: ExcelJS.Cell): number | undefined {
  const v = cell.value;
  const n = typeof v === 'number' ? v : v !== null && typeof v === 'object' && 'result' in v ? v.result : undefined;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Lê .xlsx ou .csv (separado por ; ou ,) e devolve linhas com os cabeçalhos normalizados
 * (sem acento, minúsculos, com _). Ex.: "CPF/CNPJ - Procurador" → "cpf_cnpj_procurador".
 * CSV em UTF-8 ou Windows-1252 (detectado).
 */
export async function readSheet(data: Buffer, filename: string): Promise<SheetRow[]> {
  return (await readSheetTable(data, filename)).rows;
}

/** Como `readSheet`, devolvendo também os cabeçalhos normalizados (mesmo sem nenhuma linha preenchida). */
export async function readSheetTable(data: Buffer, filename: string): Promise<{ headers: string[]; rows: SheetRow[] }> {
  if (/\.csv$/i.test(filename) || /\.txt$/i.test(filename)) return parseCsv(decodeCsvText(data));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = normalize(String(cell.text ?? ''));
  });
  const out: SheetRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    const numbers: Record<string, number> = {};
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const v = cell.value;
      values[key] = v instanceof Date ? v.toISOString().slice(0, 10) : String(cell.text ?? '').trim();
      const n = cellNumber(cell);
      if (n !== undefined) numbers[key] = n;
    });
    if (Object.values(values).some((v) => v !== '')) out.push({ rowNumber, values, numbers });
  });
  return { headers: headers.filter(Boolean), rows: out };
}

/** Linhas de um CSV já decodificado (use `readSheet` para ler o arquivo). */
export function readCsv(text: string): SheetRow[] {
  return parseCsv(text).rows;
}

function parseCsv(text: string): { headers: string[]; rows: SheetRow[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };
  const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const parseLine = (line: string) => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === sep && !quoted) {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const headers = parseLine(lines[0]).map(normalize);
  const rows = lines.slice(1).map((line, i) => {
    const cells = parseLine(line);
    const values: Record<string, string> = {};
    headers.forEach((h, j) => (values[h] = cells[j] ?? ''));
    return { rowNumber: i + 2, values, numbers: {} };
  });
  return { headers: headers.filter(Boolean), rows };
}

/**
 * Converte valor em reais em centavos com o parser único do sistema (`parseBrMoney`):
 * "R$ 1.500" → 150000, "1.500,50" → 150050, "1500.5" → 150050, "1,5" → 150; ambíguo → null.
 */
export function parseMoneyToCents(v: string | undefined | null): number | null {
  if (!v) return null;
  return parseBrMoney(v);
}

/**
 * Valor em reais de uma coluna da planilha, em centavos: célula numérica do .xlsx (ou fórmula) pelo
 * número cru, arredondado como o Excel mostra (104,895 → 10490); texto digitado e CSV por
 * `parseMoneyToCents`. Sem isso, o texto "104.895" de uma célula numérica virava R$ 104.895,00.
 */
export function sheetMoneyToCents(row: Pick<SheetRow, 'values' | 'numbers'>, key: string): number | null {
  const n = row.numbers[key];
  if (n !== undefined) return toCents(n);
  return parseMoneyToCents(row.values[key]?.trim());
}

/** Converte "31/12/2025" ou "2025-12-31" em AAAA-MM-DD, recusando datas que não existem (31/02). */
export function parseDate(v: string | undefined | null): string | null {
  if (!v) return null;
  return parseBrDate(v);
}
