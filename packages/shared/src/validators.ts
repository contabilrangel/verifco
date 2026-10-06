/** Validação e formatação de documentos brasileiros. */
import { BRAZIL_TIME_ZONE, todayIso } from './dates';

export const onlyDigits = (v: string | null | undefined): string => (v ?? '').replace(/\D+/g, '');

export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

export function isValidCnpj(value: string): boolean {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(cnpj[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(cnpj[12]) && calc(13) === Number(cnpj[13]);
}

export const isValidCpfCnpj = (v: string) => {
  const d = onlyDigits(v);
  return d.length === 11 ? isValidCpf(d) : d.length === 14 ? isValidCnpj(d) : false;
};

export function formatCpfCnpj(value: string | null | undefined): string {
  const d = onlyDigits(value);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return value ?? '';
}

export function formatPhone(value: string | null | undefined): string {
  const d = onlyDigits(value);
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return value ?? '';
}

export function formatCep(value: string | null | undefined): string {
  const d = onlyDigits(value);
  return d.length === 8 ? d.replace(/(\d{5})(\d{3})/, '$1-$2') : value ?? '';
}

export const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

/**
 * Valores monetários trafegam em centavos (inteiro) para evitar erro de arredondamento.
 * Reais → centavos como a planilha mostra: o produto é lido com 15 algarismos significativos
 * (104,895 × 100 dá 10489,4999… em ponto flutuante e vira 10489,5) e o meio centavo arredonda
 * para longe do zero: 104,895 → 10490, 1,005 → 101, 0,125 → 13, −0,125 → −13.
 */
export const toCents = (reais: number) => {
  const x = Number((reais * 100).toPrecision(15));
  const c = Math.round(Math.abs(x));
  return x < 0 ? -c || 0 : c;
};
export const fromCents = (cents: number) => cents / 100;

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatMoney = (cents: number | null | undefined) => brl.format((cents ?? 0) / 100);

/** dd/mm/aaaa: data sem hora (AAAA-MM-DD) como está; data com hora no dia de Brasília. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleDateString('pt-BR', { timeZone: BRAZIL_TIME_ZONE });
}

/** Ano-exercício corrente: a declaração entregue em 2026 é do exercício 2026 (ano-calendário 2025). Conta o ano de Brasília. */
export function currentExerciseYear(now = new Date()): number {
  return Number(todayIso(now).slice(0, 4));
}
