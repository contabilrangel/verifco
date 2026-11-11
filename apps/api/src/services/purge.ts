/**
 * Eliminação definitiva de um cliente (LGPD, art. 18, VI): a linha do cliente, tudo o que
 * depende dela e o conteúdo dos arquivos. A exclusão comum (lixeira) só marca `deletedAt`;
 * esta não tem volta. Roda a pedido (Clientes › Excluídos) e na rotina de retenção, depois do
 * prazo de RETENTION_DELETED_CUSTOMERS_DAYS.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { customers, deliveries } from '../db/schema';

type Ctx = Pick<AppContext, 'db' | 'files'>;

/**
 * Arquivos que pertencem só a este cliente. Anexos de envios (mala direta, kit) ficam de fora:
 * o mesmo arquivo pode ter ido para vários clientes.
 */
export async function customerFileIds(ctx: Ctx, officeId: string, customerId: string): Promise<string[]> {
  const result = await ctx.db.execute<{ id: string }>(sql`
    select file_id as id from documents where customer_id = ${customerId}
    union select exported_file_id from declarations where customer_id = ${customerId} and exported_file_id is not null
    union select source_file_id from declarations where customer_id = ${customerId} and source_file_id is not null
    union select file_id from darfs where customer_id = ${customerId} and file_id is not null
    union select i.receipt_file_id from installments i join billings b on b.id = i.billing_id where b.customer_id = ${customerId} and i.receipt_file_id is not null
    union select file_id from ecac_records where customer_id = ${customerId} and file_id is not null
    union select file_id from prefilled_statements where customer_id = ${customerId}
    union select file_id from ai_attachments where customer_id = ${customerId}
    union select file_id from ai_analyses where customer_id = ${customerId} and file_id is not null
    union select (a->>'fileId')::uuid from messages m, jsonb_array_elements(m.attachments) a where m.customer_id = ${customerId} and a->>'fileId' is not null
  `);
  const ids = [...new Set(result.rows.map((r) => r.id).filter(Boolean))];
  if (!ids.length) return [];
  // só os que são mesmo deste escritório (defesa contra um id gravado errado em algum JSON)
  const owned = await ctx.db.execute<{ id: string }>(sql`select id from files where office_id = ${officeId} and id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
  return owned.rows.map((r) => r.id);
}

export interface PurgeResult {
  customerId: string;
  files: number;
  deliveries: number;
}

/** Apaga o cliente (já na lixeira) e o conteúdo dos arquivos dele. Devolve `null` se não havia o que apagar. */
export async function purgeCustomer(ctx: Ctx, officeId: string, customerId: string): Promise<PurgeResult | null> {
  const customer = await ctx.db.query.customers.findFirst({ where: and(eq(customers.id, customerId), eq(customers.officeId, officeId), isNotNull(customers.deletedAt)) });
  if (!customer) return null;
  const fileIds = await customerFileIds(ctx, officeId, customerId);
  const sent = await ctx.db.transaction(async (tx) => {
    // os envios guardam nome, endereço e o texto enviado: saem junto (a FK só zeraria o cliente)
    const gone = await tx.delete(deliveries).where(and(eq(deliveries.officeId, officeId), eq(deliveries.customerId, customerId))).returning({ id: deliveries.id });
    await tx.delete(customers).where(eq(customers.id, customerId));
    return gone.length;
  });
  // depois da transação: se o processo cair aqui, sobram arquivos sem dono, nunca um cliente sem arquivos
  let removed = 0;
  for (const id of fileIds) {
    try {
      await ctx.files.remove(officeId, id);
      removed += 1;
    } catch {
      /* o conteúdo pode já ter sumido do armazenamento; a linha do arquivo é o que importa */
    }
  }
  return { customerId, files: removed, deliveries: sent };
}
