import { currentYearInBrazil } from '@verifco/shared';
import type { Db } from '../../db/client';
import { paymentMethods, priceTables } from '../../db/schema';

/** Cadastros iniciais de um escritório novo, para ele já conseguir orçar e cobrar. */
export async function seedOfficeDefaults(db: Db, officeId: string) {
  await db.insert(paymentMethods).values([
    { officeId, type: 'pix', name: 'Pix', maxInstallments: 1, isDefault: true },
    { officeId, type: 'boleto', name: 'Boleto', maxInstallments: 3 },
    { officeId, type: 'credit_card', name: 'Cartão de crédito', maxInstallments: 6 },
  ]);
  await db.insert(priceTables).values({
    officeId,
    name: 'Declaração simples',
    type: 'fixed',
    isDefault: true,
    validFrom: `${currentYearInBrazil()}-01-01`,
    config: { amountCents: 30000 },
  });
}
