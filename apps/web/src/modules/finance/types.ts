import type { BudgetAmountResult, DeclarationTotalsForPricing, PriceTableConfigShape } from '@verifco/shared';

export interface PaymentMethod {
  id: string;
  type: string;
  typeLabel: string;
  name: string;
  maxInstallments: number;
  active: boolean;
  isDefault: boolean;
  budgets: number;
}

export interface PriceTable {
  id: string;
  name: string;
  type: 'fixed' | 'hourly' | 'items' | 'percentage';
  typeLabel: string;
  active: boolean;
  isDefault: boolean;
  validFrom: string;
  validUntil: string | null;
  validNow: boolean;
  config: PriceTableConfigShape;
  budgets: number;
}

export interface Installment {
  id: string;
  number: number;
  dueDate: string;
  amountCents: number;
  status: 'open' | 'paid' | 'overdue' | 'canceled';
  paidAt: string | null;
  paidAmountCents: number | null;
  receiptNumber: number | null;
  receiptFileId: string | null;
  receiptSentAt: string | null;
  externalId: string | null;
  externalUrl: string | null;
}

/** Emissão da cobrança no Asaas/Omie (último job do faturamento). */
export interface BillingSync {
  status: 'none' | 'queued' | 'running' | 'done' | 'failed';
  error: string | null;
  attempts: number;
  maxAttempts: number;
  /** Próxima tentativa automática depois de uma falha. */
  nextAttemptAt: string | null;
  finishedAt: string | null;
  /** A integração do provedor está ativa e configurada. */
  integrationReady: boolean;
}

export interface Billing {
  id: string;
  totalCents: number;
  provider: string | null;
  createdAt: string;
  paidCents: number;
  openCents: number;
  overdueCents: number;
  installments: Installment[];
  /** Só nos faturamentos com cobrança integrada (null nos demais). */
  externalSync?: BillingSync | null;
}

export type BudgetStatus = 'draft' | 'sent' | 'approved' | 'rejected' | 'canceled';
export type PaymentStatus = 'not_billed' | 'open' | 'overdue' | 'paid';

export interface Budget {
  id: string;
  customerId: string;
  exerciseYear: number;
  type: 'fixed' | 'variable' | 'integration';
  status: BudgetStatus;
  category: string;
  categoryLabel: string;
  description: string | null;
  priceTableId: string | null;
  priceTableName: string | null;
  pricingInputs: { hours?: number; items?: Record<string, number> };
  amountCents: number;
  discountPercent: number;
  totalCents: number;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  paymentMethodType: string | null;
  billingStartDate: string | null;
  installments: number;
  internalNote: string | null;
  sentAt: string | null;
  linkExpiresAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  createdAt: string;
  paymentStatus: PaymentStatus;
  billing: Billing | null;
}

export interface BudgetList {
  data: Budget[];
  previous: Budget | null;
  declarationTotals: DeclarationTotalsForPricing | null;
  customer: { id: string; name: string; hasEmail: boolean; hasMobile: boolean };
  settings: { allowAuthorizationWithoutBudget: boolean };
  /** Integrações de cobrança ativas e configuradas no escritório. */
  integrations?: { asaas: boolean; omie: boolean };
}

export type Quote = BudgetAmountResult & { declarationTotals: DeclarationTotalsForPricing | null };

export interface PublicBudget {
  office: { name: string; email: string | null; phone: string | null; hasLogo: boolean };
  customer: { name: string };
  expiresAt: string | null;
  budget: {
    id: string;
    status: BudgetStatus;
    exerciseYear: number;
    categoryLabel: string;
    description: string | null;
    amountCents: number;
    discountPercent: number;
    totalCents: number;
    installments: number;
    installmentAmounts: number[];
    plan: { number: number; dueDate: string; amountCents: number }[] | null;
    paymentMethod: string | null;
    billingStartDate: string | null;
    approvedAt: string | null;
    rejectedAt: string | null;
  };
}

export interface BillingReportRow {
  budgetId: string;
  customerId: string;
  customerName: string;
  cpfCnpj: string;
  responsibleName: string | null;
  category: string;
  categoryLabel: string;
  type: string;
  status: BudgetStatus;
  paymentMethodName: string | null;
  installmentsCount: number;
  budgetedCents: number;
  billedCents: number;
  receivedCents: number;
  openCents: number;
  overdueCents: number;
  paymentStatus: PaymentStatus;
  /** Cobrança no Asaas/Omie não emitida (a emissão falhou de vez ou não foi pedida) com parcela em aberto. */
  externalSyncFailed: boolean;
}

export interface BillingReport {
  data: BillingReportRow[];
  totals: { budgetedCents: number; billedCents: number; receivedCents: number; openCents: number; overdueCents: number };
  customers: number;
  generatedAt: string;
}

export interface ImportBatch {
  id: string;
  createdAt: string;
  /** "processing" enquanto a fila de tarefas importa as linhas. */
  status: 'processing' | 'done' | 'failed';
  total: number;
  succeeded: number;
  failed: number;
  results: { row: number; ok: boolean; message: string }[];
  skipped?: number;
  year?: number;
}
