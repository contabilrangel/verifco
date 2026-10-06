import { BUDGET_STATUS, BUDGET_TYPES, INSTALLMENT_STATUS } from '@verifco/shared';
import { Tag, type Tone } from '../../ds';
import type { BudgetStatus, PaymentStatus } from './types';

export const budgetStatusTone = (s: string): Tone =>
  s === 'approved' ? 'success' : s === 'sent' ? 'primary' : s === 'rejected' ? 'danger' : s === 'canceled' ? 'neutral' : 'warning';

export function BudgetStatusTag({ status }: { status: BudgetStatus | string }) {
  return <Tag tone={budgetStatusTone(status)}>{BUDGET_STATUS[status as BudgetStatus] ?? status}</Tag>;
}

export const installmentTone = (s: string): Tone => (s === 'paid' ? 'success' : s === 'overdue' ? 'danger' : s === 'canceled' ? 'neutral' : 'warning');

export function InstallmentStatusTag({ status }: { status: string }) {
  return <Tag tone={installmentTone(status)}>{INSTALLMENT_STATUS[status as keyof typeof INSTALLMENT_STATUS] ?? status}</Tag>;
}

export const PAYMENT_STATUS: Record<PaymentStatus, string> = {
  not_billed: 'Sem faturamento',
  open: 'Em aberto',
  overdue: 'Com vencidas',
  paid: 'Pago',
};

export const paymentStatusTone = (s: PaymentStatus): Tone => (s === 'paid' ? 'success' : s === 'overdue' ? 'danger' : s === 'open' ? 'warning' : 'neutral');

export const budgetTypeLabel = (t: string) => BUDGET_TYPES[t as keyof typeof BUDGET_TYPES] ?? t;

/** Forma de pagamento Asaas/Omie cuja integração não está ativa: nome do provedor (para avisar); senão null. */
export function inactiveIntegration(methodType: string | null | undefined, integrations: { asaas: boolean; omie: boolean } | undefined) {
  if (!integrations || (methodType !== 'asaas' && methodType !== 'omie')) return null;
  return integrations[methodType] ? null : methodType === 'asaas' ? 'Asaas' : 'Omie';
}

/** Número com até 2 casas, no formato brasileiro (ex.: 12,5). */
export const formatNumber = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** Converte "12,5" em 12.5 (vazio → null). */
export const parseNumber = (s: string): number | null => {
  const raw = s.trim();
  const t = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Estilo de grupo de campos sem borda (fieldset). */
export const bareFieldset: React.CSSProperties = { border: 0, padding: 0, margin: 0, minWidth: 0 };
