/**
 * Utilitários de leitura das planilhas de importação: colunas com apelidos,
 * normalização de CPF/CNPJ e telefone, detecção de codificação do CSV.
 */
import { onlyDigits } from '@verifco/shared';
import { readSheet } from '../../services/xlsx';

export type SheetRow = { rowNumber: number; values: Record<string, string> };

/** Lê .xlsx ou .csv; CSV salvo pelo Excel em Windows-1252 é convertido para UTF-8. */
export async function readImportFile(data: Buffer, filename: string): Promise<SheetRow[]> {
  if (/\.csv$/i.test(filename)) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      text = new TextDecoder('windows-1252').decode(data);
    }
    return readSheet(Buffer.from(text, 'utf8'), filename);
  }
  return readSheet(data, filename);
}

/** Primeiro valor preenchido entre os apelidos da coluna (cabeçalhos já normalizados). */
export function pick(values: Record<string, string>, aliases: readonly string[]): string {
  for (const a of aliases) {
    const v = values[a];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return '';
}

/** A coluna aparece preenchida em ao menos uma linha. */
export function hasColumn(rows: SheetRow[], aliases: readonly string[]): boolean {
  return rows.some((r) => pick(r.values, aliases) !== '');
}

/**
 * Normaliza CPF/CNPJ vindo da planilha. O Excel remove zeros à esquerda de células
 * numéricas, então completamos CPFs de 9-10 dígitos (e CNPJs de 12-13 quando permitido).
 */
export function normalizeDoc(raw: string, allowCnpj: boolean): string {
  const d = onlyDigits(raw);
  if (d.length >= 9 && d.length <= 11) return d.padStart(11, '0');
  if (allowCnpj && d.length >= 12 && d.length <= 14) return d.padStart(14, '0');
  return d;
}

/**
 * Celular/telefone com DDD. Aceita o código do país 55 na frente.
 * Devolve só dígitos ou null se inválido.
 */
export function normalizePhone(raw: string): string | null {
  let d = onlyDigits(raw);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

/** Assinatura da linha para detectar linhas idênticas repetidas no arquivo. */
export function rowSignature(values: Record<string, string>): string {
  return Object.keys(values)
    .filter((k) => values[k].trim() !== '')
    .sort()
    .map((k) => `${k}=${values[k].trim().toLowerCase()}`)
    .join('\u0001');
}

/** Apelidos aceitos para cada coluna (cabeçalhos normalizados: sem acento, minúsculos, com _). */
export const COLUMNS = {
  name: ['nome', 'nome_do_cliente', 'nome_completo', 'cliente'],
  cpf: ['cpf', 'cpf_do_cliente', 'cpf_cnpj', 'cpf_cnpj_do_cliente', 'documento'],
  responsible: ['e_mail_do_responsavel', 'email_do_responsavel', 'e_mail_responsavel', 'email_responsavel', 'responsavel'],
  email: ['e_mail', 'email', 'e_mail_do_cliente', 'email_do_cliente'],
  mobile: ['celular', 'telefone_celular', 'whatsapp'],
  phone: ['telefone', 'telefone_fixo', 'fone'],
  group: ['grupo', 'grupos', 'grupo_de_clientes'],
  birthDate: ['data_de_nascimento', 'data_nascimento', 'nascimento'],
  procurator: ['cpf_cnpj_do_procurador', 'cpf_cnpj_procurador', 'cpf_cnpj_procurador_a', 'procurador', 'documento_do_procurador'],
  ecacLogin: ['login', 'login_ecac', 'login_gov_br', 'usuario'],
  ecacPassword: ['senha', 'senha_ecac', 'senha_gov_br'],
} as const;
