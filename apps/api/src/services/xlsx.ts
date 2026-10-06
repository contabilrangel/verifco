import ExcelJS from 'exceljs';

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

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/**
 * Lê .xlsx ou .csv (separado por ; ou ,) e devolve linhas com os cabeçalhos normalizados
 * (sem acento, minúsculos, com _). Ex.: "CPF/CNPJ - Procurador" → "cpf_cnpj_procurador".
 */
export async function readSheet(data: Buffer, filename: string): Promise<{ rowNumber: number; values: Record<string, string> }[]> {
  if (/\.csv$/i.test(filename) || /\.txt$/i.test(filename)) return readCsv(data.toString('utf8').replace(/^﻿/, ''));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = normalize(String(cell.text ?? ''));
  });
  const out: { rowNumber: number; values: Record<string, string> }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const v = cell.value;
      values[key] = v instanceof Date ? v.toISOString().slice(0, 10) : String(cell.text ?? '').trim();
    });
    if (Object.values(values).some((v) => v !== '')) out.push({ rowNumber, values });
  });
  return out;
}

export function readCsv(text: string): { rowNumber: number; values: Record<string, string> }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
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
  return lines.slice(1).map((line, i) => {
    const cells = parseLine(line);
    const values: Record<string, string> = {};
    headers.forEach((h, j) => (values[h] = cells[j] ?? ''));
    return { rowNumber: i + 2, values };
  });
}

/** Converte "1.234,56" ou "1234.56" em centavos. */
export function parseMoneyToCents(v: string | undefined | null): number | null {
  if (!v) return null;
  const s = v.replace(/[R$\s]/g, '');
  if (!s) return null;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Converte "31/12/2025" ou "2025-12-31" em AAAA-MM-DD. */
export function parseDate(v: string | undefined | null): string | null {
  if (!v) return null;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}
