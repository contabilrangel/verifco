import type { SitfisStatus } from '@verifco/shared';

export interface JobView {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  finishedAt: string | null;
}

interface RecordBase {
  id: string;
  year: number | null;
  fileId: string | null;
  source: string;
  fetchedAt: string;
}

export interface EcacPanel {
  customer: { id: string; name: string; cpfCnpj: string };
  credentials: { hasLogin: boolean; hasPassword: boolean };
  procuration: {
    status: string;
    expiresAt: string | null;
    expiringSoon: boolean;
    expired: boolean;
    govbrLevel: string | null;
    mailboxMessages: number;
    procurator: { id: string; name: string; cpfCnpj: string; authType: string } | null;
  };
  declarations: (RecordBase & { status: string | null; type: string | null; isRectification: boolean | null; taxation: string | null; receiptNumber: string | null })[];
  incomeStatements: (RecordBase & { issuedAt: string | null; description: string | null })[];
  darfs: { id: string; year: number | null; quotaNumber: number; valueCents: number; dueDate: string; status: string; sendStatus: string; fileId: string | null; source: string }[];
  cnd: {
    status: string;
    checkedAt: string | null;
    autoGenerateCnd: boolean;
    latest: (RecordBase & { issuedAt: string | null; validUntil: string | null }) | null;
  };
  simplified:
    | (RecordBase & {
        kind: string;
        situation: string | null;
        message: string | null;
        pendencies: string[];
        /** Leitura do relatório SITFIS (`null` no status simplificado lançado à mão). */
        status: SitfisStatus | null;
        certificate: { type: string; code: string | null; issuedAt: string | null; validUntil: string | null } | null;
      })
    | null;
  mailbox: (RecordBase & { subject: string | null; receivedAt: string | null; read: boolean })[];
  others: (RecordBase & { kind: string; data: Record<string, unknown> })[];
  lastSync: JobView | null;
}

export interface MachineToken {
  id: string;
  name: string;
  scope: 'extension' | 'sync';
  prefix: string;
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  active: boolean;
}

export interface RobotOverview {
  customersWithProcurator: number;
  activeTokens: number;
  serpro: 'ready' | 'not_configured' | 'missing';
  lastOfficeSync: JobView | null;
  /** Próxima rodada diária do SERPRO na fila. */
  nextAutoSync: string | null;
  activity: { at: string; type: 'file' | 'record' | 'prefilled'; customerId: string; customerName: string; detail: string; category: string }[];
}

export interface PrefilledRow {
  customerId: string;
  name: string;
  cpfCnpj: string;
  procuratorName: string | null;
  procurationStatus: string;
  documents: { id: string; filename: string; size: number; fetchedAt: string; downloadedAt: string | null }[];
  newCount: number;
}

export interface ElaborationCounts {
  total: number;
  eligible: number;
  processed: number;
  errors: number;
  programFiles: number;
  lines: number;
  conflicts: number;
  pendingLines: number;
}

export interface ElaborationRow {
  customerId: string;
  name: string;
  cpfCnpj: string;
  declarationId: string | null;
  status: string;
  counts: ElaborationCounts;
  sourceFileId: string | null;
  exported: { fileId: string; at: string | null } | null;
}

export interface ExtractedLineView {
  index: number;
  kindLabel: string;
  item: {
    kind: string;
    code?: string;
    description?: string;
    counterpartyDoc?: string;
    counterpartyName?: string;
    ownerName?: string;
    valueCents?: number;
    withheldCents?: number;
    prevValueCents?: number;
  };
  match: 'new' | 'duplicate' | 'conflict';
  existing: { valueCents: number; withheldCents: number; prevValueCents: number; description: string | null } | null;
  decision: 'accept' | 'reject' | null;
  appliedAt: string | null;
}

export interface ElaborationDetail {
  customer: { id: string; name: string; cpfCnpj: string };
  declarationId: string | null;
  status: string;
  counts: ElaborationCounts;
  itemsCount: number;
  documents: {
    id: string;
    fileId: string;
    filename: string;
    mimeType: string;
    category: string;
    uploadedBy: string;
    createdAt: string;
    extractable: boolean;
    processingStatus: string;
    error: string | null;
    notes: string | null;
    discarded: number;
    lines: ExtractedLineView[];
  }[];
}
