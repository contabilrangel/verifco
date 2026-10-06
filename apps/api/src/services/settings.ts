import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { offices, type OfficeSettings } from '../db/schema';

/** Preferências do escritório com os valores padrão aplicados. */
export const DEFAULT_SETTINGS: Required<OfficeSettings> = {
  restrictCustomersToResponsible: false,
  autoSendDarfEmail: false,
  notifyMainEmailOnEcacChanges: false,
  simplifiedQueryWithoutProcurator: false,
  autoGenerateCnd: false,
  receiptTwoCopies: false,
  receiptShowDetails: true,
  authorizationShowDetails: true,
  allowAuthorizationWithoutBudget: false,
  cashAnalysisSimplifiedDiscount: 'standard',
  checklistReadOnlyAfterStart: false,
  lockChecklistFromSubstatus: null,
  highNetWorthBaseCents: 300_000_000,
  reportTitleColor: '#0F2457',
  reportSubtitleColor: '#3468E6',
  reportLineColor: '#E1E4E8',
  whatsappServiceNumber: '',
};

export async function getOfficeSettings(db: DbOrTx, officeId: string): Promise<Required<OfficeSettings>> {
  const office = await db.query.offices.findFirst({ where: eq(offices.id, officeId) });
  return { ...DEFAULT_SETTINGS, ...(office?.settings ?? {}) } as Required<OfficeSettings>;
}

