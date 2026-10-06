import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ECAC_DECLARATION_STATUS, type DeclarationItem, type ItemKind } from '@verifco/shared';
import type { Tone } from '../../ds';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';

export interface Declaration {
  id: string | null;
  exists: boolean;
  customerId: string;
  exerciseYear: number;
  stage: string;
  substatus: string;
  ecacStatus: string;
  taxation: 'complete' | 'simplified' | null;
  isRectification: boolean;
  receiptNumber: string | null;
  transmittedAt: string | null;
  taxDueCents: number;
  refundCents: number;
  refundLotDate: string | null;
  refundPaidAt: string | null;
  totalIncomeCents: number;
  taxableIncomeCents: number;
  exemptIncomeCents: number;
  exclusiveIncomeCents: number;
  deductionsCents: number;
  withheldTaxCents: number;
  assetsTotalCents: number;
  assetsPrevTotalCents: number;
  debtsTotalCents: number;
  debtsPrevTotalCents: number;
  cashBalanceCents: number | null;
  otherExpenses: Record<string, number | undefined>;
  finishedAt: string | null;
  /**
   * Recibo de entrega (.REC) mais recente guardado na declaração (só no GET, com
   * `declaration.view`). O arquivo sai por `/documents/:documentId/file`.
   */
  receiptFile?: ReceiptFile | null;
}

export interface ReceiptFile {
  documentId: string;
  filename: string;
  /** `sync` quando veio do sincronizador. */
  uploadedBy: string;
  receivedAt: string;
}

export type ItemRow = DeclarationItem & { id: string; kind: ItemKind; createdAt: string; source: string };

export const declarationKey = (customerId: string, year: number) => ['declaration', customerId, year] as const;

/**
 * Declaração do cliente no exercício. `ensure()` cria a declaração quando ainda
 * não existe (necessário antes de lançar linhas, quotas, pendências etc.).
 */
export function useDeclaration(customerId: string, year: number) {
  const qc = useQueryClient();
  const q = useApi<Declaration>(declarationKey(customerId, year), `/customers/${customerId}/declarations/${year}`);
  const ensure = useCallback(async (): Promise<string> => {
    if (q.data?.id) return q.data.id;
    const created = await api.put<Declaration>(`/customers/${customerId}/declarations/${year}`, {});
    qc.setQueryData(declarationKey(customerId, year), created);
    return created.id!;
  }, [q.data?.id, customerId, year, qc]);
  return { ...q, declaration: q.data, ensure };
}

export const ecacLabel = (s: string | null | undefined) => (s ? (ECAC_DECLARATION_STATUS[s as keyof typeof ECAC_DECLARATION_STATUS] ?? s) : '—');
export const ecacTone = (s: string | null | undefined): Tone =>
  s === 'processed' || s === 'refund_lot' ? 'success' : s === 'fine_mesh' || s === 'pending_issues' ? 'danger' : s === 'waiting' || s === 'processing' ? 'warning' : 'neutral';

/** Data AAAA-MM-DD a partir de um timestamp ISO (ou já uma data). */
export const dateOnly = (v: string | null | undefined) => (v ? v.slice(0, 10) : '');

export const SEND_STATUS_LABEL: Record<string, string> = { not_sent: 'Não enviado', queued: 'Na fila', sent: 'Enviado', delivered: 'Entregue', failed: 'Falhou' };
export const sendTone = (s: string): Tone => (s === 'sent' || s === 'delivered' ? 'success' : s === 'failed' ? 'danger' : s === 'queued' ? 'warning' : 'neutral');

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
