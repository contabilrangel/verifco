import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { customers, procurators } from '../../db/schema';
import type { CustomerRow } from '../../services/customers';
import { notify } from '../../services/notify';
import { saveEcacRecord } from './records';
import { SERPRO_SERVICES, interpretMailbox, interpretProcuration, requireSerpro, type SerproClient } from './serpro';

/**
 * Sincroniza um cliente pelo SERPRO Integra Contador:
 * 1. procuração eletrônica (cliente → procurador): validade e situação;
 * 2. indicador de mensagens novas na caixa postal.
 * Cada resposta é guardada como registro do eCAC (origem `serpro`, resposta bruta em `data.raw`);
 * o cadastro só muda quando a resposta traz os campos reconhecidos.
 */
export async function syncCustomerViaSerpro(ctx: AppContext, client: SerproClient, customer: CustomerRow) {
  const { db } = ctx;
  if (!customer.procuratorId) throw new Error('Cliente sem procurador associado: associe um procurador para consultar a procuração eletrônica.');
  const procurator = await db.query.procurators.findFirst({ where: eq(procurators.id, customer.procuratorId) });
  if (!procurator) throw new Error('Procurador do cliente não encontrado.');
  const steps: string[] = [];

  const proc = await client.call({
    ...SERPRO_SERVICES.procuration,
    contribuinte: customer.cpfCnpj,
    dados: {
      outorgante: customer.cpfCnpj,
      tipoOutorgante: customer.cpfCnpj.length === 11 ? '1' : '2',
      outorgado: procurator.cpfCnpj,
      tipoOutorgado: procurator.cpfCnpj.length === 11 ? '1' : '2',
    },
  });
  const procInfo = proc.pending ? null : interpretProcuration(proc.dados);
  await saveEcacRecord(ctx, {
    officeId: customer.officeId,
    customer,
    kind: 'procuration',
    year: null,
    source: 'serpro',
    data: {
      service: 'PROCURACOES/OBTERPROCURACAO41',
      raw: proc.dados as never,
      ...(procInfo ?? { note: proc.pending ? 'SERPRO ainda processando; tente de novo em instantes.' : 'Resposta registrada sem data de expiração reconhecível; cadastro não alterado.' }),
    },
  });
  steps.push(procInfo ? `procuração: ${procInfo.status} até ${procInfo.expiresAt}` : 'procuração: resposta registrada (sem validade reconhecida)');

  const mail = await client.call({ ...SERPRO_SERVICES.mailboxIndicator, contribuinte: customer.cpfCnpj, dados: '' });
  const unread = mail.pending ? null : interpretMailbox(mail.dados);
  await saveEcacRecord(ctx, {
    officeId: customer.officeId,
    customer,
    kind: 'other',
    year: null,
    source: 'serpro',
    data: { service: 'CAIXAPOSTAL/INNOVAMSG63', raw: mail.dados as never, unread },
  });
  if (unread !== null) {
    await db.update(customers).set({ ecacMailboxMessages: unread, updatedAt: new Date() }).where(eq(customers.id, customer.id));
  }
  steps.push(unread !== null ? `caixa postal: ${unread} mensagem(ns) nova(s)` : 'caixa postal: resposta registrada');
  return { customerId: customer.id, steps };
}

export function registerJobs(ctx: AppContext) {
  const { db } = ctx;

  /** Sincronização de um cliente (botão "Solicitar sincronização" da aba eCAC). */
  ctx.jobs.register('ecac.sync', async (job) => {
    const officeId = job.officeId;
    const customerId = String(job.payload.customerId ?? '');
    if (!officeId) throw new Error('Job sem escritório.');
    const customer = await db.query.customers.findFirst({
      where: and(eq(customers.id, customerId), eq(customers.officeId, officeId), isNull(customers.deletedAt)),
    });
    if (!customer) throw new Error('Cliente não encontrado.');
    const client = await requireSerpro(ctx, officeId);
    return syncCustomerViaSerpro(ctx, client, customer);
  });

  /** Sincronização de todos os clientes com procurador do escritório. */
  ctx.jobs.register('ecac.sync_office', async (job, { progress }) => {
    const officeId = job.officeId;
    if (!officeId) throw new Error('Job sem escritório.');
    const client = await requireSerpro(ctx, officeId);
    const list = await db
      .select()
      .from(customers)
      .where(and(eq(customers.officeId, officeId), isNull(customers.deletedAt), isNotNull(customers.procuratorId), eq(customers.status, 'active')))
      .orderBy(asc(customers.name));
    let ok = 0;
    const errors: { customerId: string; name: string; error: string }[] = [];
    for (const [i, c] of list.entries()) {
      try {
        await syncCustomerViaSerpro(ctx, client, c);
        ok++;
      } catch (err) {
        errors.push({ customerId: c.id, name: c.name, error: err instanceof Error ? err.message : String(err) });
      }
      await progress(((i + 1) / Math.max(1, list.length)) * 100);
    }
    await notify(db, {
      officeId,
      userId: job.createdByUserId,
      title: 'Sincronização eCAC concluída',
      body: `${ok} de ${list.length} cliente(s) sincronizado(s)${errors.length ? `, ${errors.length} com erro` : ''}.`,
      link: '/admin/robo',
    });
    return { total: list.length, ok, failed: errors.length, errors: errors.slice(0, 50) };
  });
}
