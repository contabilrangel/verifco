/**
 * Esquema do banco do Verifco (PostgreSQL).
 *
 * Regras gerais:
 * - Toda tabela de negócio tem `office_id`; as consultas sempre filtram por ele.
 * - Valores monetários em centavos (`bigint` em modo number).
 * - Segredos (senhas eCAC, gov.br, certificados, chaves de API) ficam cifrados (colunas *_enc).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const officeId = () => uuid('office_id').notNull().references(() => offices.id, { onDelete: 'cascade' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const money = (name: string) => bigint(name, { mode: 'number' });

export type Address = {
  street?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  zip?: string;
};

export type OfficeSettings = {
  restrictCustomersToResponsible?: boolean;
  autoSendDarfEmail?: boolean;
  notifyMainEmailOnEcacChanges?: boolean;
  simplifiedQueryWithoutProcurator?: boolean;
  autoGenerateCnd?: boolean;
  receiptTwoCopies?: boolean;
  receiptShowDetails?: boolean;
  authorizationShowDetails?: boolean;
  allowAuthorizationWithoutBudget?: boolean;
  cashAnalysisSimplifiedDiscount?: 'standard' | 'proportional';
  checklistReadOnlyAfterStart?: boolean;
  lockChecklistFromSubstatus?: string | null;
  highNetWorthBaseCents?: number;
  reportTitleColor?: string;
  reportSubtitleColor?: string;
  reportLineColor?: string;
  whatsappServiceNumber?: string;
};

// ---------------------------------------------------------------------------
// Escritório, usuários e acesso
// ---------------------------------------------------------------------------
export const offices = pgTable('offices', {
  id: id(),
  name: text('name').notNull(),
  cpfCnpj: text('cpf_cnpj'),
  email: text('email'),
  phone: text('phone'),
  website: text('website'),
  city: text('city'),
  state: text('state'),
  logoFileId: uuid('logo_file_id'),
  settings: jsonb('settings').$type<OfficeSettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const roles = pgTable(
  'roles',
  {
    id: id(),
    officeId: officeId(),
    name: text('name').notNull(),
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_office_name_uq').on(t.officeId, t.name)],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    officeId: officeId(),
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    isActive: boolean('is_active').notNull().default(true),
    isOwner: boolean('is_owner').notNull().default(false),
    notificationPrefs: jsonb('notification_prefs').$type<{ enabled?: boolean; devices?: string[] }>().notNull().default({}),
    lastLoginAt: ts('last_login_at'),
    tokenVersion: integer('token_version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  // busca pelo token na rota pública /auth/reset-password
  (t) => [index('password_resets_token_idx').on(t.tokenHash)],
);

export const userFavorites = pgTable(
  'user_favorites',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    label: text('label').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.path] })],
);

export const contracts = pgTable('contracts', {
  id: id(),
  officeId: officeId(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('basic'),
  declarationLimit: integer('declaration_limit'),
  year: integer('year').notNull(),
  startsAt: date('starts_at').notNull(),
  expiresAt: date('expires_at').notNull(),
  hasBackup: boolean('has_backup').notNull().default(false),
  status: text('status').notNull().default('active'),
  termsUrl: text('terms_url'),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Arquivos
// ---------------------------------------------------------------------------
export const files = pgTable(
  'files',
  {
    id: id(),
    officeId: officeId(),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    /** Bytes; bigint porque o backup do escritório passa de 2 GB. */
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('files_office_idx').on(t.officeId)],
);

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------
export const customerGroups = pgTable(
  'customer_groups',
  {
    id: id(),
    officeId: officeId(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('customer_groups_office_name_uq').on(t.officeId, t.name)],
);

export const procurators = pgTable(
  'procurators',
  {
    id: id(),
    officeId: officeId(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    cpfCnpj: text('cpf_cnpj').notNull(),
    authType: text('auth_type').notNull().default('govbr'),
    certificateFileId: uuid('certificate_file_id'),
    certificatePasswordEnc: text('certificate_password_enc'),
    certificateExpiresAt: date('certificate_expires_at'),
    loginStatus: text('login_status').notNull().default('unknown'),
    lastValidatedAt: ts('last_validated_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('procurators_office_doc_uq').on(t.officeId, t.cpfCnpj)],
);

export const customers = pgTable(
  'customers',
  {
    id: id(),
    officeId: officeId(),
    name: text('name').notNull(),
    cpfCnpj: text('cpf_cnpj').notNull(),
    voterTitle: text('voter_title'),
    birthDate: date('birth_date'),
    sex: text('sex'),
    email: text('email'),
    mobileCountry: text('mobile_country').default('55'),
    mobile: text('mobile'),
    phoneCountry: text('phone_country').default('55'),
    phone: text('phone'),
    status: text('status').notNull().default('active'),
    responsibleUserId: uuid('responsible_user_id').references(() => users.id, { onDelete: 'set null' }),
    procuratorId: uuid('procurator_id').references(() => procurators.id, { onDelete: 'set null' }),
    notes: text('notes'),
    address: jsonb('address').$type<Address>().notNull().default({}),
    secondaryAddress: jsonb('secondary_address').$type<Address>().notNull().default({}),
    // eCAC / procuração
    procurationStatus: text('procuration_status').notNull().default('none'),
    procurationExpiresAt: date('procuration_expires_at'),
    govbrLevel: text('govbr_level'),
    ecacMailboxMessages: integer('ecac_mailbox_messages').notNull().default(0),
    cndStatus: text('cnd_status').notNull().default('not_requested'),
    cndCheckedAt: ts('cnd_checked_at'),
    ecacLoginEnc: text('ecac_login_enc'),
    ecacPasswordEnc: text('ecac_password_enc'),
    inssPasswordEnc: text('inss_password_enc'),
    // portal do cliente
    portalEnabled: boolean('portal_enabled').notNull().default(false),
    portalCodeHash: text('portal_code_hash'),
    portalCodeExpiresAt: ts('portal_code_expires_at'),
    externalRefs: jsonb('external_refs').$type<{ asaasId?: string; omieId?: string }>().notNull().default({}),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('customers_office_idx').on(t.officeId),
    uniqueIndex('customers_office_doc_uq').on(t.officeId, t.cpfCnpj).where(sql`${t.deletedAt} is null`),
  ],
);

export const customerGroupMembers = pgTable(
  'customer_group_members',
  {
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').notNull().references(() => customerGroups.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.groupId] })],
);

// ---------------------------------------------------------------------------
// Declarações
// ---------------------------------------------------------------------------
export const declarations = pgTable(
  'declarations',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    exerciseYear: integer('exercise_year').notNull(),
    stage: text('stage').notNull().default('not_started'),
    substatus: text('substatus').notNull().default('not_started'),
    ecacStatus: text('ecac_status').notNull().default('unknown'),
    taxation: text('taxation'),
    isRectification: boolean('is_rectification').notNull().default(false),
    receiptNumber: text('receipt_number'),
    transmittedAt: ts('transmitted_at'),
    taxDueCents: money('tax_due_cents').notNull().default(0),
    refundCents: money('refund_cents').notNull().default(0),
    refundLotDate: date('refund_lot_date'),
    refundPaidAt: date('refund_paid_at'),
    totalIncomeCents: money('total_income_cents').notNull().default(0),
    taxableIncomeCents: money('taxable_income_cents').notNull().default(0),
    exemptIncomeCents: money('exempt_income_cents').notNull().default(0),
    exclusiveIncomeCents: money('exclusive_income_cents').notNull().default(0),
    deductionsCents: money('deductions_cents').notNull().default(0),
    withheldTaxCents: money('withheld_tax_cents').notNull().default(0),
    assetsTotalCents: money('assets_total_cents').notNull().default(0),
    assetsPrevTotalCents: money('assets_prev_total_cents').notNull().default(0),
    debtsTotalCents: money('debts_total_cents').notNull().default(0),
    debtsPrevTotalCents: money('debts_prev_total_cents').notNull().default(0),
    cashBalanceCents: money('cash_balance_cents'),
    elaborationStatus: text('elaboration_status').notNull().default('no_files'),
    exportedFileId: uuid('exported_file_id'),
    sourceFileId: uuid('source_file_id'),
    checklistLocked: boolean('checklist_locked').notNull().default(false),
    otherExpenses: jsonb('other_expenses')
      .$type<{ annualPaymentCents?: number; principalCents?: number; interestCents?: number; creditCardCents?: number; capitalLossCents?: number }>()
      .notNull()
      .default({}),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('declarations_customer_year_uq').on(t.customerId, t.exerciseYear),
    index('declarations_office_year_idx').on(t.officeId, t.exerciseYear),
  ],
);

/**
 * Linhas da DIRPF (rendimentos, pagamentos, bens, dívidas, dependentes...).
 * Um modelo genérico com `kind` e `code` permite cobrir todas as fichas.
 */
export const declarationItems = pgTable(
  'declaration_items',
  {
    id: id(),
    officeId: officeId(),
    declarationId: uuid('declaration_id').notNull().references(() => declarations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    code: text('code'),
    groupCode: text('group_code'),
    description: text('description'),
    ownerCpf: text('owner_cpf'),
    ownerName: text('owner_name'),
    counterpartyDoc: text('counterparty_doc'),
    counterpartyName: text('counterparty_name'),
    prevValueCents: money('prev_value_cents').notNull().default(0),
    valueCents: money('value_cents').notNull().default(0),
    withheldCents: money('withheld_cents').notNull().default(0),
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    source: text('source').notNull().default('manual'),
    createdAt: createdAt(),
  },
  (t) => [index('declaration_items_decl_idx').on(t.declarationId, t.kind)],
);

export const backlogs = pgTable(
  'backlogs',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    declarationId: uuid('declaration_id').notNull().references(() => declarations.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    dueDate: date('due_date'),
    resolvedAt: ts('resolved_at'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('backlogs_decl_idx').on(t.declarationId)],
);

export const darfs = pgTable(
  'darfs',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    declarationId: uuid('declaration_id').references(() => declarations.id, { onDelete: 'cascade' }),
    quotaNumber: integer('quota_number').notNull().default(1),
    valueCents: money('value_cents').notNull(),
    dueDate: date('due_date').notNull(),
    status: text('status').notNull().default('open'),
    sendStatus: text('send_status').notNull().default('not_sent'),
    fileId: uuid('file_id'),
    barcode: text('barcode'),
    paidAt: date('paid_at'),
    source: text('source').notNull().default('manual'),
    createdAt: createdAt(),
  },
  (t) => [index('darfs_customer_idx').on(t.customerId), index('darfs_decl_idx').on(t.declarationId)],
);

// ---------------------------------------------------------------------------
// Checklist digital e documentos
// ---------------------------------------------------------------------------
export const checklists = pgTable(
  'checklists',
  {
    id: id(),
    officeId: officeId(),
    declarationId: uuid('declaration_id').notNull().references(() => declarations.id, { onDelete: 'cascade' }),
    accessTokenHash: text('access_token_hash').notNull(),
    accessCodeHash: text('access_code_hash').notNull(),
    /** Validade do link e do código atuais (definida a cada envio); vazio = sem acesso pelo link. */
    accessExpiresAt: ts('access_expires_at'),
    sentAt: ts('sent_at'),
    lastCustomerAccessAt: ts('last_customer_access_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
  },
  // o token do link público (/checklist/:token) é buscado sem escritório: precisa de índice
  (t) => [uniqueIndex('checklists_decl_uq').on(t.declarationId), uniqueIndex('checklists_token_uq').on(t.accessTokenHash)],
);

export const checklistSections = pgTable(
  'checklist_sections',
  {
    id: id(),
    checklistId: uuid('checklist_id').notNull().references(() => checklists.id, { onDelete: 'cascade' }),
    section: text('section').notNull(),
    status: text('status').notNull().default('open'),
    note: text('note'),
    finishedAt: ts('finished_at'),
  },
  (t) => [uniqueIndex('checklist_sections_uq').on(t.checklistId, t.section)],
);

export const checklistItems = pgTable(
  'checklist_items',
  {
    id: id(),
    checklistId: uuid('checklist_id').notNull().references(() => checklists.id, { onDelete: 'cascade' }),
    section: text('section').notNull(),
    ownerName: text('owner_name'),
    ownerCpf: text('owner_cpf'),
    title: text('title').notNull(),
    description: text('description'),
    fromPreviousYear: boolean('from_previous_year').notNull().default(false),
    status: text('status').notNull().default('pending'),
    customerNote: text('customer_note'),
    createdBy: text('created_by').notNull().default('office'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('checklist_items_checklist_idx').on(t.checklistId, t.section)],
);

export const documents = pgTable(
  'documents',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    declarationId: uuid('declaration_id').references(() => declarations.id, { onDelete: 'set null' }),
    checklistItemId: uuid('checklist_item_id').references(() => checklistItems.id, { onDelete: 'set null' }),
    fileId: uuid('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
    category: text('category').notNull().default('other'),
    uploadedBy: text('uploaded_by').notNull().default('office'),
    processingStatus: text('processing_status').notNull().default('not_processed'),
    extracted: jsonb('extracted').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('documents_customer_idx').on(t.customerId),
    index('documents_decl_idx').on(t.declarationId),
    index('documents_checklist_item_idx').on(t.checklistItemId),
  ],
);

// ---------------------------------------------------------------------------
// Financeiro
// ---------------------------------------------------------------------------
export const paymentMethods = pgTable('payment_methods', {
  id: id(),
  officeId: officeId(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  maxInstallments: integer('max_installments').notNull().default(1),
  active: boolean('active').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
});

export type PriceTableConfig = {
  amountCents?: number;
  hourRateCents?: number;
  minHours?: number;
  items?: { code: string; label: string; unitPriceCents: number }[];
  percent?: number;
  base?: 'refund' | 'tax_due' | 'assets_total' | 'total_income';
  minCents?: number;
  maxCents?: number;
};

export const priceTables = pgTable('price_tables', {
  id: id(),
  officeId: officeId(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  active: boolean('active').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  validFrom: date('valid_from').notNull(),
  validUntil: date('valid_until'),
  config: jsonb('config').$type<PriceTableConfig>().notNull().default({}),
  createdAt: createdAt(),
});

export const budgets = pgTable(
  'budgets',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    declarationId: uuid('declaration_id').references(() => declarations.id, { onDelete: 'set null' }),
    exerciseYear: integer('exercise_year').notNull(),
    type: text('type').notNull().default('fixed'),
    status: text('status').notNull().default('draft'),
    category: text('category').notNull().default('irpf'),
    description: text('description'),
    priceTableId: uuid('price_table_id').references(() => priceTables.id, { onDelete: 'set null' }),
    pricingInputs: jsonb('pricing_inputs').$type<{ hours?: number; items?: Record<string, number> }>().notNull().default({}),
    amountCents: money('amount_cents').notNull(),
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2, mode: 'number' }).notNull().default(0),
    totalCents: money('total_cents').notNull(),
    paymentMethodId: uuid('payment_method_id').references(() => paymentMethods.id, { onDelete: 'set null' }),
    billingStartDate: date('billing_start_date'),
    installments: integer('installments').notNull().default(1),
    internalNote: text('internal_note'),
    approvalTokenHash: text('approval_token_hash'),
    sentAt: ts('sent_at'),
    approvedAt: ts('approved_at'),
    approvedBy: text('approved_by'),
    rejectedAt: ts('rejected_at'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('budgets_customer_idx').on(t.customerId, t.exerciseYear), uniqueIndex('budgets_token_uq').on(t.approvalTokenHash)],
);

export const billings = pgTable(
  'billings',
  {
    id: id(),
    officeId: officeId(),
    budgetId: uuid('budget_id').notNull().references(() => budgets.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    totalCents: money('total_cents').notNull(),
    provider: text('provider'),
    createdAt: createdAt(),
  },
  // um orçamento aprovado gera faturamento uma única vez
  (t) => [uniqueIndex('billings_budget_uq').on(t.budgetId)],
);

export const installments = pgTable(
  'installments',
  {
    id: id(),
    officeId: officeId(),
    billingId: uuid('billing_id').notNull().references(() => billings.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    dueDate: date('due_date').notNull(),
    amountCents: money('amount_cents').notNull(),
    status: text('status').notNull().default('open'),
    paidAt: date('paid_at'),
    paidAmountCents: money('paid_amount_cents'),
    receiptNumber: integer('receipt_number'),
    receiptFileId: uuid('receipt_file_id'),
    receiptSentAt: ts('receipt_sent_at'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('installments_billing_number_uq').on(t.billingId, t.number),
    index('installments_external_idx').on(t.externalId),
    index('installments_office_receipt_idx').on(t.officeId, t.receiptNumber),
  ],
);

// ---------------------------------------------------------------------------
// Comunicação
// ---------------------------------------------------------------------------
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: id(),
    officeId: officeId(),
    key: text('key').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('email_templates_office_key_uq').on(t.officeId, t.key)],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    templateKey: text('template_key'),
    subject: text('subject'),
    toAddress: text('to_address').notNull(),
    toName: text('to_name'),
    body: text('body').notNull(),
    attachments: jsonb('attachments').$type<{ fileId: string; filename: string }[]>().notNull().default([]),
    status: text('status').notNull().default('queued'),
    error: text('error'),
    providerMessageId: text('provider_message_id'),
    idempotencyKey: text('idempotency_key'),
    createdByUserId: uuid('created_by_user_id'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('deliveries_office_idx').on(t.officeId, t.createdAt),
    uniqueIndex('deliveries_idempotency_uq').on(t.officeId, t.idempotencyKey),
    index('deliveries_customer_idx').on(t.customerId, t.createdAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    channel: text('channel').notNull().default('portal'),
    body: text('body').notNull(),
    authorUserId: uuid('author_user_id'),
    deliveryId: uuid('delivery_id'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_customer_idx').on(t.customerId, t.createdAt)],
);

/**
 * Notificações do sino. Sem `userId`, valem para o escritório todo; com `customerId`, só
 * aparecem para quem enxerga o cliente (restrição "contadores veem só seus clientes").
 * `readAt` marca a leitura das notificações pessoais; as do escritório têm a leitura
 * guardada por usuário em `notification_reads`.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    officeId: officeId(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.officeId, t.userId, t.createdAt)],
);

/** Leitura, por usuário, das notificações do escritório inteiro. */
export const notificationReads = pgTable(
  'notification_reads',
  {
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: ts('read_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.notificationId, t.userId] }), index('notification_reads_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Integrações, eCAC e tarefas
// ---------------------------------------------------------------------------
export const integrations = pgTable(
  'integrations',
  {
    id: id(),
    officeId: officeId(),
    provider: text('provider').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    publicConfig: jsonb('public_config').$type<Record<string, unknown>>().notNull().default({}),
    secretsEnc: text('secrets_enc'),
    status: text('status').notNull().default('not_configured'),
    lastError: text('last_error'),
    webhookToken: text('webhook_token'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('integrations_office_provider_uq').on(t.officeId, t.provider), index('integrations_webhook_token_idx').on(t.webhookToken)],
);

export const ecacRecords = pgTable(
  'ecac_records',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    year: integer('year'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    fileId: uuid('file_id'),
    source: text('source').notNull().default('manual'),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [index('ecac_records_customer_idx').on(t.customerId, t.kind)],
);

export const prefilledStatements = pgTable(
  'prefilled_statements',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    exerciseYear: integer('exercise_year').notNull(),
    fileId: uuid('file_id').notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    downloadedAt: ts('downloaded_at'),
  },
  (t) => [index('prefilled_office_year_idx').on(t.officeId, t.exerciseYear)],
);

/**
 * Tokens de máquina usados pela extensão do navegador e pelo sincronizador local
 * (`Authorization: Bearer vfk_...`). Só o hash SHA-256 é guardado; o token aparece uma única
 * vez, na criação. Escopo: `extension` ou `sync`. Revogar preenche `revoked_at`.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    officeId: officeId(),
    name: text('name').notNull(),
    scope: text('scope').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Início do token (ex.: `vfk_AbC1`) para o usuário reconhecer qual é. */
    prefix: text('prefix').notNull(),
    createdByUserId: uuid('created_by_user_id'),
    lastUsedAt: ts('last_used_at'),
    lastUsedIp: text('last_used_ip'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_tokens_hash_uq').on(t.tokenHash), index('api_tokens_office_idx').on(t.officeId)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    officeId: uuid('office_id').references(() => offices.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAt: ts('run_at').notNull().defaultNow(),
    lockedAt: ts('locked_at'),
    progress: integer('progress').notNull().default(0),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    idempotencyKey: text('idempotency_key'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('jobs_status_run_idx').on(t.status, t.runAt),
    uniqueIndex('jobs_idempotency_uq').on(t.type, t.idempotencyKey),
    index('jobs_office_type_status_idx').on(t.officeId, t.type, t.status),
  ],
);

export const importBatches = pgTable('import_batches', {
  id: id(),
  officeId: officeId(),
  kind: text('kind').notNull(),
  fileId: uuid('file_id'),
  status: text('status').notNull().default('done'),
  total: integer('total').notNull().default(0),
  succeeded: integer('succeeded').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  results: jsonb('results').$type<{ row: number; ok: boolean; message: string }[]>().notNull().default([]),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: createdAt(),
});

/**
 * Contadores de tentativas com janela fixa (login, redefinição de senha, cadastro, links públicos).
 * Ficam no banco para valer com várias instâncias da API.
 */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  windowStartedAt: ts('window_started_at').notNull().defaultNow(),
});

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    officeId: officeId(),
    userId: uuid('user_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_office_idx').on(t.officeId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Consultoria: Radar, IA, holding, livro caixa e copiloto
// ---------------------------------------------------------------------------
export const opportunities = pgTable(
  'opportunities',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    exerciseYear: integer('exercise_year').notNull(),
    status: text('status').notNull().default('open'),
    score: integer('score').notNull().default(0),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('opportunities_uq').on(t.customerId, t.category, t.exerciseYear)],
);

export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    assistant: text('assistant').notNull(),
    title: text('title'),
    createdByUserId: uuid('created_by_user_id'),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [index('ai_conversations_customer_idx').on(t.customerId, t.assistant)],
);

export const aiMessages = pgTable(
  'ai_messages',
  {
    id: id(),
    conversationId: uuid('conversation_id').notNull().references(() => aiConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    attachments: jsonb('attachments').$type<{ fileId: string; filename: string }[]>().notNull().default([]),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    rating: integer('rating'),
    createdAt: createdAt(),
  },
  (t) => [index('ai_messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

/** Arquivos enviados como anexo na conversa com a IA, vinculados ao cliente da conversa. */
export const aiAttachments = pgTable(
  'ai_attachments',
  {
    fileId: uuid('file_id')
      .primaryKey()
      .references(() => files.id, { onDelete: 'cascade' }),
    officeId: officeId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('ai_attachments_customer_idx').on(t.customerId)],
);

export const aiAnalyses = pgTable('ai_analyses', {
  id: id(),
  officeId: officeId(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('financial_advisor'),
  documentIds: jsonb('document_ids').$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('queued'),
  result: text('result'),
  fileId: uuid('file_id'),
  rating: integer('rating'),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: createdAt(),
});

export const holdingSimulations = pgTable(
  'holding_simulations',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    exerciseYear: integer('exercise_year').notNull(),
    params: jsonb('params').$type<Record<string, number>>().notNull().default({}),
    selectedItemIds: jsonb('selected_item_ids').$type<string[]>().notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('holding_customer_year_uq').on(t.customerId, t.exerciseYear)],
);

export const cashbookEntries = pgTable(
  'cashbook_entries',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    kind: text('kind').notNull(),
    entryDate: date('entry_date').notNull(),
    code: text('code').notNull(),
    description: text('description'),
    valueCents: money('value_cents').notNull(),
    counterpartyCpf: text('counterparty_cpf'),
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    importBatchId: uuid('import_batch_id'),
    createdAt: createdAt(),
  },
  (t) => [index('cashbook_customer_year_idx').on(t.customerId, t.year)],
);

export const copilotEnrollments = pgTable(
  'copilot_enrollments',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('copilot_enrollments_customer_uq').on(t.customerId)],
);

export const copilotEntries = pgTable(
  'copilot_entries',
  {
    id: id(),
    officeId: officeId(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    year: integer('year').notNull(),
    month: integer('month'),
    category: text('category'),
    description: text('description').notNull(),
    amountCents: money('amount_cents').notNull().default(0),
    dueDate: date('due_date'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('copilot_entries_customer_idx').on(t.customerId, t.year, t.kind)],
);
