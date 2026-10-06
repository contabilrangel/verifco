import { BUDGET_CATEGORIES, BUDGET_STATUS, BUDGET_TYPES, formatCep, type BudgetCategory } from '@verifco/shared';
import type { Address } from '../../db/schema';

/** Converte o HTML dos templates em texto simples (para PDF). */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|div)>/gi, '\n\n')
    .replace(/<li>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const categoryLabel = (c: string) => BUDGET_CATEGORIES[c as BudgetCategory] ?? c;
export const budgetTypeLabel = (t: string) => BUDGET_TYPES[t as keyof typeof BUDGET_TYPES] ?? t;
export const budgetStatusLabel = (s: string) => BUDGET_STATUS[s as keyof typeof BUDGET_STATUS] ?? s;

export function formatAddress(a: Address | null | undefined): string {
  if (!a) return '';
  const street = [a.street, a.number].filter(Boolean).join(', ') + (a.complement ? ` - ${a.complement}` : '');
  const city = a.city && a.state ? `${a.city}/${a.state}` : (a.city ?? a.state ?? '');
  return [street, a.neighborhood, city, a.zip ? `CEP ${formatCep(a.zip)}` : ''].filter((p) => p && p.trim()).join(' - ');
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "6 de outubro de 2026" a partir de AAAA-MM-DD. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} de ${MONTHS[m - 1]} de ${y}`;
}

export const brDate = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
