import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CND_STATUS,
  DARF_STATUS,
  ECAC_DECLARATION_STATUS,
  ECAC_RECORD_KIND_LIST,
  GOVBR_LEVELS,
  PROCURATION_STATUS,
  TAXATION_TYPES,
  type EcacRecordKind,
  type EcacRecordSource,
} from '@verifco/shared';
import type { AppContext } from '../../context';
import { customers, darfs, declarations, ecacRecords, procurators } from '../../db/schema';
import { getOrCreateDeclaration, syncStatusWithEcac } from '../../services/declarations';
import { getOfficeSettings } from '../../services/settings';
import type { CustomerRow } from '../../services/customers';
import type { UploadedFile } from '../../services/uploads';
import { jobView, latestJob, normalizeDate } from './util';

export type EcacRecordRow = typeof ecacRecords.$inferSelect;

/** Entrada de um registro do eCAC (manual, extensão, sincronizador ou SERPRO). */
export const recordInputSchema = z.object({
  kind: z.enum(ECAC_RECORD_KIND_LIST as [EcacRecordKind, ...EcacRecordKind[]]),
  year: z.coerce.number().int().min(2000).max(2100).nullable().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  /** Identificador estável na origem (nº do recibo, id da mensagem...). Evita duplicar registros. */
  externalId: z.string().trim().min(1).max(200).optional(),
});
export type RecordInput = z.infer<typeof recordInputSchema>;

const keyOf = <T extends Record<string, string>>(obj: T, v: unknown): keyof T | null =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(obj, v) ? (v as keyof T) : null;

const int = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
};

/**
 * Grava um registro do eCAC e aplica os efeitos no cadastro:
 * - `procuration`: situação, validade e nível gov.br do cliente;
 * - `cnd`: situação da CND do cliente;
 * - `mailbox_message`: recalcula as mensagens não lidas da caixa postal;
 * - `declaration`: situação no eCAC, tributação, retificadora e recibo da declaração do ano, e a
 *   etapa/subestado do Kanban (transmitida → subestado da situação eCAC; finalizada não regride);
 * - `darf`: cria a guia em "Acompanhamento de DARF" (origem `ecac`).
 * Campos fora do formato esperado são guardados em `data`, mas não alteram o cadastro.
 */
export async function saveEcacRecord(
  ctx: AppContext,
  input: RecordInput & {
    officeId: string;
    customer: CustomerRow;
    source: EcacRecordSource;
    file?: UploadedFile | null;
    userId?: string | null;
  },
): Promise<{ record: EcacRecordRow; effects: string[]; duplicate: boolean }> {
  const { db } = ctx;
  const { officeId, customer, kind } = input;
  const data: Record<string, unknown> = { ...input.data };
  if (input.externalId) data.externalId = input.externalId;
  const year = input.year ?? null;
  let fileId: string | null = null;
  if (input.file) {
    const saved = await ctx.files.save({
      officeId,
      data: input.file.data,
      filename: input.file.filename,
      mimeType: input.file.mimeType,
      userId: input.userId ?? null,
    });
    fileId = saved.id;
  }

  let record: EcacRecordRow;
  let duplicate = false;
  const existing = input.externalId
    ? await db.query.ecacRecords.findFirst({
        where: and(eq(ecacRecords.customerId, customer.id), eq(ecacRecords.kind, kind), sql`${ecacRecords.data}->>'externalId' = ${input.externalId}`),
      })
    : null;
  if (existing) {
    duplicate = true;
    [record] = await db
      .update(ecacRecords)
      .set({ data, year, fileId: fileId ?? existing.fileId, source: input.source, fetchedAt: new Date() })
      .where(eq(ecacRecords.id, existing.id))
      .returning();
  } else {
    [record] = await db.insert(ecacRecords).values({ officeId, customerId: customer.id, kind, year, data, fileId, source: input.source }).returning();
  }

  const effects: string[] = [];
  const now = new Date();
  if (kind === 'procuration') {
    const status = keyOf(PROCURATION_STATUS, data.status);
    const expiresAt = normalizeDate(data.expiresAt);
    const level = keyOf(GOVBR_LEVELS, data.govbrLevel);
    const set: Partial<CustomerRow> = {};
    if (status && status !== 'none') set.procurationStatus = status;
    if (expiresAt) set.procurationExpiresAt = expiresAt;
    if (level) set.govbrLevel = level;
    if (Object.keys(set).length) {
      await db.update(customers).set({ ...set, updatedAt: now }).where(eq(customers.id, customer.id));
      effects.push('procuration');
    }
  } else if (kind === 'cnd') {
    const status = keyOf(CND_STATUS, data.status);
    if (status) {
      await db.update(customers).set({ cndStatus: status, cndCheckedAt: now, updatedAt: now }).where(eq(customers.id, customer.id));
      effects.push('cnd');
    }
  } else if (kind === 'mailbox_message') {
    const [{ unread }] = await db
      .select({ unread: count() })
      .from(ecacRecords)
      .where(and(eq(ecacRecords.customerId, customer.id), eq(ecacRecords.kind, 'mailbox_message'), sql`coalesce(${ecacRecords.data}->>'read', 'false') <> 'true'`));
    await db.update(customers).set({ ecacMailboxMessages: unread, updatedAt: now }).where(eq(customers.id, customer.id));
    effects.push('mailbox');
  } else if (kind === 'declaration' && year) {
    const status = keyOf(ECAC_DECLARATION_STATUS, data.status);
    const taxation = keyOf(TAXATION_TYPES, data.taxation);
    const receiptNumber = typeof data.receiptNumber === 'string' && data.receiptNumber.trim() ? data.receiptNumber.trim().slice(0, 60) : null;
    const set: Partial<typeof declarations.$inferSelect> = {};
    if (status) set.ecacStatus = status;
    if (taxation) set.taxation = taxation;
    if (typeof data.isRectification === 'boolean') set.isRectification = data.isRectification;
    if (receiptNumber) set.receiptNumber = receiptNumber;
    if (Object.keys(set).length) {
      const decl = await getOrCreateDeclaration(db, officeId, customer.id, year);
      const [updated] = await db.update(declarations).set({ ...set, updatedAt: now }).where(eq(declarations.id, decl.id)).returning();
      // a declaração aparece no eCAC (recibo ou situação conhecida): foi transmitida. A etapa do
      // Kanban segue a situação eCAC pelas mesmas regras do resumo da declaração.
      const row = await syncStatusWithEcac(db, decl, updated, { transmitted: Boolean(receiptNumber || (status && status !== 'unknown')) });
      effects.push('declaration');
      if (row.substatus !== decl.substatus) effects.push('declaration_status');
    }
  } else if (kind === 'darf') {
    const valueCents = int(data.valueCents);
    const dueDate = normalizeDate(data.dueDate);
    if (valueCents && valueCents > 0 && dueDate) {
      const quotaNumber = int(data.quotaNumber) ?? 1;
      const dup = await db.query.darfs.findFirst({
        where: and(eq(darfs.customerId, customer.id), eq(darfs.dueDate, dueDate), eq(darfs.valueCents, valueCents), eq(darfs.quotaNumber, quotaNumber), eq(darfs.source, 'ecac')),
      });
      if (!dup) {
        const decl = year ? await getOrCreateDeclaration(db, officeId, customer.id, year) : null;
        await db.insert(darfs).values({
          officeId,
          customerId: customer.id,
          declarationId: decl?.id ?? null,
          quotaNumber,
          valueCents,
          dueDate,
          status: keyOf(DARF_STATUS, data.status) ?? 'open',
          barcode: typeof data.barcode === 'string' ? data.barcode.slice(0, 120) : null,
          fileId,
          source: 'ecac',
        });
        effects.push('darf');
      }
    }
  }
  return { record, effects, duplicate };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Monta os painéis da aba eCAC do cliente. */
export async function buildEcacPanel(ctx: AppContext, customer: CustomerRow) {
  const { db } = ctx;
  const settings = await getOfficeSettings(db, customer.officeId);
  const records = await db
    .select()
    .from(ecacRecords)
    .where(and(eq(ecacRecords.customerId, customer.id), eq(ecacRecords.officeId, customer.officeId)))
    .orderBy(desc(ecacRecords.year), desc(ecacRecords.fetchedAt));
  const of = (k: string) => records.filter((r) => r.kind === k);
  const procurator = customer.procuratorId ? await db.query.procurators.findFirst({ where: eq(procurators.id, customer.procuratorId) }) : null;
  const darfRows = await db
    .select({ d: darfs, year: declarations.exerciseYear })
    .from(darfs)
    .leftJoin(declarations, eq(declarations.id, darfs.declarationId))
    .where(and(eq(darfs.customerId, customer.id), eq(darfs.officeId, customer.officeId)))
    .orderBy(desc(darfs.dueDate), asc(darfs.quotaNumber));
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const lastCnd = of('cnd')[0] ?? null;
  const simplified = [...of('simplified_status'), ...of('fiscal_situation')].sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0] ?? null;
  const base = (r: EcacRecordRow) => ({ id: r.id, year: r.year, fileId: r.fileId, source: r.source, fetchedAt: r.fetchedAt });
  const last = await latestJob(db, customer.officeId, ['ecac.sync'], { customerId: customer.id });

  return {
    customer: { id: customer.id, name: customer.name, cpfCnpj: customer.cpfCnpj },
    credentials: { hasLogin: Boolean(customer.ecacLoginEnc), hasPassword: Boolean(customer.ecacPasswordEnc) },
    procuration: {
      status: customer.procurationStatus,
      expiresAt: customer.procurationExpiresAt,
      expiringSoon: Boolean(customer.procurationExpiresAt && customer.procurationExpiresAt >= today && customer.procurationExpiresAt <= in30),
      expired: Boolean(customer.procurationExpiresAt && customer.procurationExpiresAt < today),
      govbrLevel: customer.govbrLevel,
      mailboxMessages: customer.ecacMailboxMessages,
      procurator: procurator ? { id: procurator.id, name: procurator.name, cpfCnpj: procurator.cpfCnpj, authType: procurator.authType } : null,
    },
    declarations: of('declaration').map((r) => ({
      ...base(r),
      status: str(r.data.status),
      type: str(r.data.type),
      isRectification: typeof r.data.isRectification === 'boolean' ? r.data.isRectification : null,
      taxation: str(r.data.taxation),
      receiptNumber: str(r.data.receiptNumber),
    })),
    incomeStatements: of('income_statement').map((r) => ({ ...base(r), issuedAt: normalizeDate(r.data.issuedAt), description: str(r.data.description) ?? str(r.data.source) })),
    darfs: darfRows.map(({ d, year }) => ({
      id: d.id,
      year,
      quotaNumber: d.quotaNumber,
      valueCents: d.valueCents,
      dueDate: d.dueDate,
      status: d.status === 'open' && d.dueDate < today ? 'overdue' : d.status,
      sendStatus: d.sendStatus,
      fileId: d.fileId,
      source: d.source,
    })),
    cnd: {
      status: customer.cndStatus,
      checkedAt: customer.cndCheckedAt,
      autoGenerateCnd: settings.autoGenerateCnd,
      latest: lastCnd ? { ...base(lastCnd), issuedAt: normalizeDate(lastCnd.data.issuedAt), validUntil: normalizeDate(lastCnd.data.validUntil) } : null,
    },
    simplified: simplified
      ? { ...base(simplified), kind: simplified.kind, situation: str(simplified.data.situation), message: str(simplified.data.message), pendencies: strList(simplified.data.pendencies) }
      : null,
    mailbox: of('mailbox_message')
      .slice(0, 20)
      .map((r) => ({ ...base(r), subject: str(r.data.subject), receivedAt: normalizeDate(r.data.receivedAt), read: r.data.read === true })),
    others: [...of('procuration'), ...of('other')].slice(0, 20).map((r) => ({ ...base(r), kind: r.kind, data: r.data })),
    lastSync: jobView(last),
  };
}
