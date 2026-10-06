/** Formatos devolvidos pela API do checklist, do portal e das mensagens. */
export interface ChecklistFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedBy: 'office' | 'customer' | string;
  createdAt: string;
}

export interface ChecklistItem {
  id: string;
  section: string;
  title: string;
  description: string | null;
  ownerName: string | null;
  ownerCpf: string | null;
  fromPreviousYear: boolean;
  status: 'pending' | 'sent' | 'not_applicable' | 'removed';
  customerNote: string | null;
  createdBy: 'system' | 'office' | 'customer' | string;
  files: ChecklistFile[];
}

export interface Progress {
  total: number;
  pending: number;
  sent: number;
  notApplicable: number;
  removed: number;
  resolved: number;
  percent: number;
}

export interface ChecklistSectionView {
  section: string;
  label: string;
  hint: string;
  status: 'open' | 'done' | 'pending_documents' | 'no_documents';
  note: string | null;
  finishedAt: string | null;
  progress: Progress;
  items: ChecklistItem[];
}

export interface OfficeChecklist {
  id: string;
  createdAt: string;
  sentAt: string | null;
  lastCustomerAccessAt: string | null;
  finishedAt: string | null;
  progress: Progress;
  fromPreviousYear: number;
  filesCount: number;
  sections: ChecklistSectionView[];
}

export interface ChecklistLockInfo {
  readOnly: boolean;
  reason: string | null;
  customerReason: string | null;
}

export interface OfficeChecklistResponse {
  exerciseYear: number;
  declaration: { id: string; stage: string; substatus: string; checklistLocked: boolean } | null;
  lock: ChecklistLockInfo;
  previous: { exerciseYear: number; hasDeclaration: boolean; items: number };
  contact: { email: string | null; mobile: string | null };
  checklist: OfficeChecklist | null;
}

export interface CustomerChecklistView {
  id: string;
  exerciseYear: number;
  officeName: string;
  customerFirstName: string;
  readOnly: boolean;
  readOnlyReason: string | null;
  finishedAt: string | null;
  progress: Progress;
  sections: ChecklistSectionView[];
}

export interface OfficeMessage {
  id: string;
  direction: 'in' | 'out';
  channel: 'portal' | 'whatsapp' | string;
  body: string;
  createdAt: string;
  readAt: string | null;
  authorName: string | null;
  deliveryStatus: string | null;
}

export interface PortalMessage {
  id: string;
  direction: 'in' | 'out';
  channel: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  fromMe: boolean;
}

export type CustomerTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface PortalOverview {
  exerciseYear: number;
  declarations: {
    exerciseYear: number;
    calendarYear: number;
    stage: string;
    status: { title: string; description: string; tone: CustomerTone };
    transmittedAt: string | null;
    refundCents: number;
    taxDueCents: number;
  }[];
  pendencies: { id: string; description: string; dueDate: string | null; exerciseYear: number; createdAt: string }[];
  checklist: { id: string; exerciseYear: number; progress: Progress; sectionsTotal: number; sectionsDone: number; sectionsPending: number; finishedAt: string | null; readOnly: boolean } | null;
  documents: { id: string; filename: string; size: number; createdAt: string; exerciseYear: number | null }[];
  unreadMessages: number;
}

/** Orçamento do portal (módulo financeiro); campos opcionais para tolerar variações do contrato. */
export interface PortalBudget {
  id: string;
  status?: string;
  category?: string;
  description?: string | null;
  exerciseYear?: number;
  totalCents?: number;
  amountCents?: number;
  installments?: number;
}
