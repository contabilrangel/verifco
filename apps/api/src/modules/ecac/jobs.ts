import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { brazilToday } from '@verifco/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { auditLogs, customers, darfs, ecacRecords, integrations, jobs, procurators } from '../../db/schema';
import type { JobRow } from '../../jobs/queue';
import type { CustomerRow } from '../../services/customers';
import { notify } from '../../services/notify';
import { uploadedFromBase64 } from '../../services/uploads';
import { saveEcacRecord } from './records';
import {
  SERPRO_SERVICES,
  findField,
  interpretMailbox,
  interpretMailboxList,
  interpretPayments,
  interpretProcuration,
  requireSerpro,
  revenueCode,
  type SerproClient,
} from './serpro';
import { fanoutOf, type Fanout } from './util';

export const ECAC_SYNC = 'ecac.sync';
export const ECAC_SYNC_OFFICE = 'ecac.sync_office';
/** Rodada automática diária (payload `trigger` do `ecac.sync_office`). */
export const DAILY_TRIGGER = 'daily';

/** A situação fiscal (SITFIS, bilhetada) é renovada pela sincronização a cada 30 dias. */
export const FISCAL_SITUATION_REFRESH_DAYS = 30;
/** Pagamentos (PAGTOWEB, bilhetado): quotas em aberto que vencem em até 7 dias ou venceram há até 120. */
export const PAYMENT_CHECK_DAYS_AHEAD = 7;
export const PAYMENT_CHECK_DAYS_BACK = 120;
/** Receita do IRPF pago em quotas (DARF). */
export const IRPF_QUOTA_REVENUE = '0211';
const PAYMENT_PAGE = 100;
const PAYMENT_MAX_PAGES = 5;
const SITFIS_ATTEMPTS = 3;
const SITFIS_WAIT = { min: 1_000, max: 10_000, fallback: 5_000 };
/** Erros guardados no pai de uma sincronização geral (o total de falhas é sempre contado). */
const MAX_FANOUT_ERRORS = 50;

/** Espera entre as tentativas do relatório de situação fiscal (os testes trocam por uma espera nula). */
export const robotTiming = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export interface SyncOptions {
  /** Pedido de um cliente só (botão da aba eCAC): faz agora as consultas que a rotina diária espaça. */
  thorough?: boolean;
  /** Data de hoje (AAAA-MM-DD, Brasília). */
  today?: string;
}

/**
 * Sincroniza um cliente pelo SERPRO Integra Contador:
 * 1. procuração eletrônica (cliente → procurador): validade e situação;
 * 2. indicador de mensagens novas na caixa postal (não bilhetado);
 * 3. lista da caixa postal (MSGCONTRIBUINTE61) quando há mensagem nova ou alguma registrada como
 *    não lida; cada mensagem é gravada uma vez (`externalId` = isn) e atualizada depois;
 * 4. relatório de situação fiscal (SITFIS) com o PDF, a cada 30 dias;
 * 5. pagamentos da receita 0211 (PAGTOWEB) quando há quota do DARF em aberto perto do
 *    vencimento: a quota de mesmo vencimento e valor (principal ou total da guia) fica paga.
 * As etapas 3 a 5 são bilhetadas pelo SERPRO, por isso só rodam quando há o que conferir (o pedido
 * de um cliente só consulta tudo). Uma falha nelas vira aviso no resultado e não derruba as outras.
 * Cada resposta é guardada como registro do eCAC (origem `serpro`); o cadastro só muda quando a
 * resposta traz os campos reconhecidos. O Integra Contador não informa a situação da declaração
 * (malha, processamento, lote de restituição) nem emite CND de pessoa física.
 */
export async function syncCustomerViaSerpro(ctx: AppContext, client: SerproClient, customer: CustomerRow, opts: SyncOptions = {}) {
  const { db } = ctx;
  if (!customer.procuratorId) throw new Error('Cliente sem procurador associado: associe um procurador para consultar a procuração eletrônica.');
  const procurator = await db.query.procurators.findFirst({ where: eq(procurators.id, customer.procuratorId) });
  if (!procurator) throw new Error('Procurador do cliente não encontrado.');
  const today = opts.today ?? brazilToday();
  const thorough = opts.thorough === true;
  const steps: string[] = [];
  const warnings: string[] = [];

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
  const procInfo = proc.pending ? null : interpretProcuration(proc.dados, today);
  // um registro por cliente, atualizado a cada sincronização (a rotina diária não acumula cópias)
  await saveEcacRecord(ctx, {
    officeId: customer.officeId,
    customer,
    kind: 'procuration',
    year: null,
    source: 'serpro',
    externalId: 'serpro:procuracao',
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
    externalId: 'serpro:caixa-postal',
    data: { service: 'CAIXAPOSTAL/INNOVAMSG63', raw: mail.dados as never, unread },
  });
  if (unread !== null) {
    await db.update(customers).set({ ecacMailboxMessages: unread, updatedAt: new Date() }).where(eq(customers.id, customer.id));
  }
  steps.push(unread !== null ? `caixa postal: ${unread} mensagem(ns) nova(s)` : 'caixa postal: resposta registrada');

  if (procInfo?.status === 'expired') {
    steps.push('demais consultas não feitas: a procuração eletrônica venceu');
    return { customerId: customer.id, steps, warnings };
  }
  const step = async (label: string, fn: () => Promise<string | null>) => {
    try {
      const done = await fn();
      if (done) steps.push(done);
    } catch (err) {
      warnings.push(`${label}: ${errMsg(err)}`);
      steps.push(`${label}: falhou (${errMsg(err)})`);
    }
  };
  await step('mensagens da caixa postal', () => syncMailbox(ctx, client, customer, unread, thorough));
  await step('situação fiscal', () => syncFiscalSituation(ctx, client, customer, today, thorough));
  await step('pagamentos do DARF', () => syncPayments(ctx, client, customer, today, thorough));
  return { customerId: customer.id, steps, warnings };
}

/** Lista da caixa postal (bilhetada): só com mensagem nova, alguma ainda não lida no Verifco ou pedido manual. */
async function syncMailbox(ctx: AppContext, client: SerproClient, customer: CustomerRow, indicator: number | null, thorough: boolean) {
  const [{ unreadStored }] = await ctx.db
    .select({ unreadStored: count() })
    .from(ecacRecords)
    .where(and(eq(ecacRecords.customerId, customer.id), eq(ecacRecords.kind, 'mailbox_message'), sql`coalesce(${ecacRecords.data}->>'read', 'false') <> 'true'`));
  // sem mensagem nova e nada pendente aqui (o indicador zera quando a mensagem é lida no e-CAC)
  if (!thorough && indicator === 0 && unreadStored === 0) return null;
  const r = await client.call({ ...SERPRO_SERVICES.mailboxList, contribuinte: customer.cpfCnpj, dados: { statusLeitura: '0', indicadorPagina: '0' } });
  if (r.pending) return 'mensagens da caixa postal: o SERPRO ainda está processando; nova tentativa na próxima sincronização';
  const list = interpretMailboxList(r.dados);
  let created = 0;
  for (const m of list) {
    const saved = await saveEcacRecord(ctx, {
      officeId: customer.officeId,
      customer,
      kind: 'mailbox_message',
      year: null,
      source: 'serpro',
      externalId: m.id,
      data: {
        service: 'CAIXAPOSTAL/MSGCONTRIBUINTE61',
        subject: m.subject,
        receivedAt: m.receivedAt,
        read: m.read,
        origin: m.origin,
        relevant: m.relevant,
        controlNumber: m.controlNumber,
        validUntil: m.validUntil,
      },
    });
    if (!saved.duplicate) created += 1;
  }
  return `mensagens da caixa postal: ${list.length} consultada(s), ${created} nova(s)`;
}

/** Relatório de situação fiscal (SITFIS): pede o protocolo, espera o tempo indicado e grava o PDF. */
async function syncFiscalSituation(ctx: AppContext, client: SerproClient, customer: CustomerRow, today: string, thorough: boolean) {
  const last = await ctx.db.query.ecacRecords.findFirst({
    where: and(eq(ecacRecords.customerId, customer.id), eq(ecacRecords.kind, 'fiscal_situation'), eq(ecacRecords.source, 'serpro')),
    orderBy: desc(ecacRecords.fetchedAt),
  });
  if (last) {
    const lastDay = brazilToday(last.fetchedAt);
    // um por dia no máximo; a rotina diária renova a cada 30 dias
    if (lastDay === today || (!thorough && lastDay > addDays(today, -FISCAL_SITUATION_REFRESH_DAYS))) return null;
  }
  const contribuinte = customer.cpfCnpj;
  const requested = await client.call({ ...SERPRO_SERVICES.fiscalSituationRequest, contribuinte, dados: '' });
  const protocol = findField(requested.dados, 'protocoloRelatorio');
  if (!protocol) return 'situação fiscal: o SERPRO não liberou o protocolo agora; nova tentativa na próxima sincronização';
  let wait: number | undefined = requested.tempoEsperaMs ?? (Number(findField(requested.dados, 'tempoEspera')) || undefined);
  for (let attempt = 0; attempt < SITFIS_ATTEMPTS; attempt++) {
    if (wait !== undefined) await robotTiming.sleep(Math.min(SITFIS_WAIT.max, Math.max(SITFIS_WAIT.min, wait)));
    const report = await client.call({ ...SERPRO_SERVICES.fiscalSituationReport, contribuinte, dados: { protocoloRelatorio: protocol } });
    if (report.pending) {
      wait = report.tempoEsperaMs ?? SITFIS_WAIT.fallback;
      continue;
    }
    const pdf = findField(report.dados, 'pdf');
    const file = pdf ? uploadedFromBase64(`situacao-fiscal-${contribuinte}-${today}.pdf`, pdf) : null;
    if (!file || file.data.subarray(0, 5).toString('latin1') !== '%PDF-') return 'situação fiscal: a resposta do SERPRO não trouxe o PDF do relatório';
    await saveEcacRecord(ctx, {
      officeId: customer.officeId,
      customer,
      kind: 'fiscal_situation',
      year: null,
      source: 'serpro',
      externalId: `sitfis:${today}`,
      data: {
        service: 'SITFIS/RELATORIOSITFIS92',
        issuedAt: today,
        message: 'Relatório de situação fiscal emitido pela Receita Federal: abra o PDF para ver as pendências.',
      },
      file,
    });
    return 'situação fiscal: relatório emitido';
  }
  return 'situação fiscal: relatório ainda em processamento no SERPRO; nova tentativa na próxima sincronização';
}

/** Pagamentos da receita 0211 (PAGTOWEB): marca como pagas as quotas de mesmo vencimento e valor. */
async function syncPayments(ctx: AppContext, client: SerproClient, customer: CustomerRow, today: string, thorough: boolean) {
  const { db } = ctx;
  const conds = [eq(darfs.officeId, customer.officeId), eq(darfs.customerId, customer.id), ne(darfs.status, 'paid'), isNull(darfs.paidAt)];
  if (!thorough) conds.push(gte(darfs.dueDate, addDays(today, -PAYMENT_CHECK_DAYS_BACK)), lte(darfs.dueDate, addDays(today, PAYMENT_CHECK_DAYS_AHEAD)));
  const open = await db.select().from(darfs).where(and(...conds)).orderBy(asc(darfs.dueDate));
  if (!open.length) return null;

  // as quotas de um exercício vencem no próprio ano; o pagamento pode ter sido antecipado
  const from = `${open[0].dueDate.slice(0, 4)}-01-01`;
  const payments = [];
  for (let page = 0; page < PAYMENT_MAX_PAGES; page++) {
    const r = await client.call({
      ...SERPRO_SERVICES.payments,
      contribuinte: customer.cpfCnpj,
      dados: {
        codigoReceitaLista: [IRPF_QUOTA_REVENUE],
        intervaloDataArrecadacao: { dataInicial: from, dataFinal: today },
        primeiroDaPagina: page * PAYMENT_PAGE,
        tamanhoDaPagina: PAYMENT_PAGE,
      },
    });
    if (r.pending) return 'pagamentos do DARF: o SERPRO ainda está processando; nova tentativa na próxima sincronização';
    const docs = interpretPayments(r.dados);
    payments.push(...docs);
    if (docs.length < PAYMENT_PAGE) break;
  }
  const revenue = revenueCode(IRPF_QUOTA_REVENUE);
  const quotas = payments.filter((p) => p.revenue === revenue);
  const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 1;
  const used = new Set<string>();
  let paid = 0;
  for (const d of open) {
    // a quota gerada guarda o principal; a editada, o valor da guia (com juros)
    const match = quotas.find((p) => !used.has(p.documentNumber) && p.dueDate === d.dueDate && (near(p.principalCents, d.valueCents) || near(p.totalCents, d.valueCents)));
    if (!match) continue;
    used.add(match.documentNumber);
    const [row] = await db
      .update(darfs)
      .set({ status: 'paid', paidAt: match.paidAt ?? today })
      .where(and(eq(darfs.id, d.id), isNull(darfs.paidAt)))
      .returning({ id: darfs.id });
    if (!row) continue;
    paid += 1;
    await db.insert(auditLogs).values({
      officeId: customer.officeId,
      userId: null,
      action: 'darf.serpro_paid',
      entity: 'darf',
      entityId: d.id,
      data: { documentNumber: match.documentNumber, paidAt: match.paidAt, totalCents: match.totalCents },
    });
  }
  return `pagamentos do DARF: ${paid} de ${open.length} quota(s) em aberto encontrada(s) paga(s)`;
}

// ---------------------------------------------------------------------------
// Sincronização geral: um job por cliente, com o pai somando o andamento
// ---------------------------------------------------------------------------

/** Soma no pai o resultado de um cliente; o último a terminar fecha a sincronização. */
async function childFinished(ctx: AppContext, parentId: string, failure: Fanout['errors'][number] | null) {
  const fan = sql`coalesce(${jobs.payload}->'fanout', '{}'::jsonb)`;
  const errors = sql`coalesce(${jobs.payload}->'fanout'->'errors', '[]'::jsonb)`;
  const [row] = await ctx.db
    .update(jobs)
    .set({
      payload: sql`jsonb_set(${jobs.payload}, '{fanout}', ${fan} || jsonb_build_object(
        'ok', coalesce((${jobs.payload}->'fanout'->>'ok')::int, 0) + ${failure ? 0 : 1}::int,
        'failed', coalesce((${jobs.payload}->'fanout'->>'failed')::int, 0) + ${failure ? 1 : 0}::int,
        'errors', case when jsonb_array_length(${errors}) >= ${MAX_FANOUT_ERRORS}::int then ${errors}
                       else ${errors} || ${JSON.stringify(failure ? [failure] : [])}::jsonb end))`,
    })
    .where(and(eq(jobs.id, parentId), eq(jobs.type, ECAC_SYNC_OFFICE)))
    .returning();
  const counts = row ? fanoutOf(row) : null;
  if (counts && counts.ok + counts.failed >= counts.total) await finishOfficeSync(ctx, parentId);
}

/** Fecha a sincronização geral uma vez só (último cliente ou escritório sem clientes) e avisa no sino. */
async function finishOfficeSync(ctx: AppContext, parentId: string) {
  const [row] = await ctx.db
    .update(jobs)
    .set({ payload: sql`jsonb_set(${jobs.payload}, '{fanout,finishedAt}', to_jsonb(now()))` })
    .where(and(eq(jobs.id, parentId), sql`${jobs.payload}->'fanout'->>'finishedAt' is null`))
    .returning();
  const fan = row ? fanoutOf(row) : null;
  if (!row?.officeId || !fan) return;
  const daily = row.payload.trigger === DAILY_TRIGGER;
  // a rodada automática só avisa quando algum cliente falhou
  if (daily && !fan.failed) return;
  await notify(ctx.db, {
    officeId: row.officeId,
    userId: row.createdByUserId,
    title: daily ? 'Sincronização automática do eCAC com erros' : 'Sincronização eCAC concluída',
    body: `${fan.ok} de ${fan.total} cliente(s) sincronizado(s)${fan.failed ? `, ${fan.failed} com erro` : ''}.`,
    link: '/admin/robo',
  });
}

/**
 * Divide a sincronização do escritório em um `ecac.sync` por cliente ativo com procurador. O pai
 * só confere o SERPRO (falha cedo, com aviso) e guarda o total; cada filho soma o seu resultado.
 */
async function fanOutOfficeSync(ctx: AppContext, job: JobRow) {
  const { db } = ctx;
  const officeId = job.officeId!;
  await requireSerpro(ctx, officeId);
  const list = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.officeId, officeId), isNull(customers.deletedAt), isNotNull(customers.procuratorId), eq(customers.status, 'active')))
    .orderBy(asc(customers.name));
  const fanout: Fanout = { total: list.length, ok: 0, failed: 0, errors: [] };
  // o total vai para o pai antes de os filhos existirem (eles somam nele ao terminar)
  await db.update(jobs).set({ payload: { ...job.payload, fanout } }).where(eq(jobs.id, job.id));
  for (const c of list) {
    await ctx.jobs.enqueue(ECAC_SYNC, { customerId: c.id, parentJobId: job.id }, { officeId, userId: job.createdByUserId, idempotencyKey: `${job.id}:${c.id}`, maxAttempts: 2 });
  }
  if (!list.length) await finishOfficeSync(ctx, job.id);
  return { total: list.length };
}

// ---------------------------------------------------------------------------
// Rodada automática diária
// ---------------------------------------------------------------------------

/** Brasília não tem horário de verão desde 2019: UTC−3. */
const BRASILIA_OFFSET_MS = 3 * 3600_000;
const spread = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

/** Próxima rodada do escritório: todo dia entre 3h e 6h (Brasília), espalhada entre os escritórios. */
export function nextDailyRun(officeId: string, now = new Date()): Date {
  const minute = 180 + (spread(officeId) % 180);
  const local = new Date(now.getTime() - BRASILIA_OFFSET_MS);
  let at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + minute * 60_000 + BRASILIA_OFFSET_MS;
  if (at <= now.getTime()) at += 86_400_000;
  return new Date(at);
}

const dailyQueued = (officeId: string) =>
  and(eq(jobs.type, ECAC_SYNC_OFFICE), eq(jobs.officeId, officeId), eq(jobs.status, 'queued'), sql`${jobs.payload}->>'trigger' = ${DAILY_TRIGGER}`);

/**
 * Agenda a sincronização diária do escritório com SERPRO ativo, no padrão de `scheduleOmiePoll`:
 * no máximo uma na fila por escritório e chave de idempotência por escritório e dia. Ao encadear,
 * `afterDay` é o dia da rodada em andamento: a próxima fica para um dia depois dele.
 */
export async function scheduleEcacDailySync(ctx: AppContext, officeId: string, opts: { now?: Date; afterDay?: string } = {}) {
  const queued = await ctx.db.query.jobs.findFirst({ where: dailyQueued(officeId) });
  if (queued) return queued;
  let runAt = nextDailyRun(officeId, opts.now);
  while (opts.afterDay && brazilToday(runAt) <= opts.afterDay) runAt = new Date(runAt.getTime() + 86_400_000);
  return ctx.jobs.enqueue(ECAC_SYNC_OFFICE, { trigger: DAILY_TRIGGER }, { officeId, runAt, idempotencyKey: `daily:${officeId}:${brazilToday(runAt)}`, maxAttempts: 1 });
}

/** Dia (Brasília) de uma rodada diária: o da chave de idempotência ou o do horário marcado. */
const dailyRunDay = (job: JobRow) => /:(\d{4}-\d{2}-\d{2})$/.exec(job.idempotencyKey ?? '')?.[1] ?? brazilToday(job.runAt);

/** SERPRO desativado ou removido: a rodada que ainda não começou sai da fila. */
export async function cancelEcacDailySync(ctx: AppContext, officeId: string) {
  await ctx.db.delete(jobs).where(dailyQueued(officeId));
}

/** Próxima rodada automática agendada (para a tela do robô). */
export async function nextScheduledOfficeSync(db: Db, officeId: string) {
  const row = await db.query.jobs.findFirst({ where: dailyQueued(officeId), orderBy: asc(jobs.runAt) });
  return row?.runAt ?? null;
}

/** Última sincronização geral já iniciada ou na vez (a rodada agendada para depois não conta). */
export async function latestOfficeSync(db: Db, officeId: string) {
  const [row] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.officeId, officeId), eq(jobs.type, ECAC_SYNC_OFFICE), lte(jobs.runAt, new Date())))
    .orderBy(desc(jobs.runAt), desc(jobs.createdAt))
    .limit(1);
  return row ?? null;
}

const serproEnabled = async (ctx: AppContext, officeId: string) =>
  Boolean(await ctx.db.query.integrations.findFirst({ where: and(eq(integrations.officeId, officeId), eq(integrations.provider, 'serpro'), eq(integrations.enabled, true)) }));

/** Ao subir a API: escritórios com o SERPRO ativo ganham a rodada diária, se ainda não tiverem. */
async function ensureDailySchedules(ctx: AppContext) {
  const rows = await ctx.db
    .select({ officeId: integrations.officeId })
    .from(integrations)
    .where(and(eq(integrations.provider, 'serpro'), eq(integrations.enabled, true)));
  // outra instância pode agendar ao mesmo tempo: a chave de idempotência recusa a duplicata
  for (const r of rows) await scheduleEcacDailySync(ctx, r.officeId).catch(() => undefined);
}

export async function registerJobs(ctx: AppContext) {
  const { db } = ctx;

  /**
   * Sincronização de um cliente: o botão "Solicitar sincronização" da aba eCAC (consulta tudo) ou
   * uma parte da sincronização geral (`parentJobId`), que recebe o resultado deste cliente.
   */
  ctx.jobs.register(ECAC_SYNC, async (job) => {
    const officeId = job.officeId;
    const customerId = String(job.payload.customerId ?? '');
    const parentJobId = typeof job.payload.parentJobId === 'string' ? job.payload.parentJobId : null;
    let name = customerId;
    let result: Awaited<ReturnType<typeof syncCustomerViaSerpro>> | undefined;
    let failure: unknown = null;
    try {
      if (!officeId) throw new Error('Job sem escritório.');
      const customer = await db.query.customers.findFirst({
        where: and(eq(customers.id, customerId), eq(customers.officeId, officeId), isNull(customers.deletedAt)),
      });
      if (!customer) throw new Error('Cliente não encontrado.');
      name = customer.name;
      const client = await requireSerpro(ctx, officeId);
      result = await syncCustomerViaSerpro(ctx, client, customer, { thorough: !parentJobId });
    } catch (err) {
      failure = err;
    }
    // a fila repete enquanto attempts < maxAttempts: o pai só recebe o resultado definitivo
    if (parentJobId && (!failure || job.attempts >= job.maxAttempts)) {
      await childFinished(ctx, parentJobId, failure ? { customerId, name, error: errMsg(failure) } : null).catch(() => undefined);
    }
    if (failure) throw failure;
    return result;
  });

  /**
   * Sincronização de todos os clientes com procurador do escritório (botão do robô ou rodada
   * diária). Quem pediu é avisado no sino ao terminar o último cliente, e também quando a
   * sincronização inteira falha (ex.: SERPRO não configurado); a rodada diária avisa o escritório
   * só quando há erro.
   */
  ctx.jobs.register(ECAC_SYNC_OFFICE, async (job) => {
    const officeId = job.officeId;
    if (!officeId) throw new Error('Job sem escritório.');
    try {
      if (job.payload.trigger === DAILY_TRIGGER) {
        // SERPRO desativado depois do agendamento: a cadeia para aqui
        if (!(await serproEnabled(ctx, officeId))) return { skipped: true, reason: 'Integração SERPRO desativada.' };
        // agenda a próxima antes de começar, para a cadeia não parar se esta falhar
        await scheduleEcacDailySync(ctx, officeId, { afterDay: dailyRunDay(job) });
      }
      return await fanOutOfficeSync(ctx, job);
    } catch (err) {
      // a fila repete enquanto attempts < maxAttempts: avisa só quando não haverá nova tentativa
      if (job.attempts >= job.maxAttempts) {
        await notify(db, {
          officeId,
          userId: job.createdByUserId,
          title: 'Sincronização do eCAC falhou',
          body: errMsg(err),
          link: '/admin/robo',
        }).catch(() => undefined);
      }
      throw err;
    }
  });

  await ensureDailySchedules(ctx).catch(() => undefined);
}
