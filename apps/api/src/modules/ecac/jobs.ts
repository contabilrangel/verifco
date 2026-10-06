import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { SITFIS_STATUS, addDaysIso as addDays, brazilToday, ecacAutoSyncPeriod, ecacAutoSyncSetting, isEcacAutoSyncDay, nextEcacAutoSyncDay, type EcacAutoSyncSetting } from '@verifco/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { auditLogs, customers, darfs, ecacRecords, integrations, jobs, procurators } from '../../db/schema';
import { WAIT_FOR_CHILDREN, type JobHelpers, type JobRow } from '../../jobs/queue';
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
import { readSitfisReport, type SitfisReading } from './sitfis';
import { fanoutOf, summarizeOfficeChildren } from './util';

export const ECAC_SYNC = 'ecac.sync';
export const ECAC_SYNC_OFFICE = 'ecac.sync_office';
/** Rodadas automáticas (payload `trigger` do `ecac.sync_office`): diária ou semanal, conforme a integração SERPRO. */
export const DAILY_TRIGGER = 'daily';
export const WEEKLY_TRIGGER = 'weekly';
const AUTO_TRIGGERS = [DAILY_TRIGGER, WEEKLY_TRIGGER];
const autoTrigger = (job: Pick<JobRow, 'payload'>) => (AUTO_TRIGGERS.includes(String(job.payload.trigger)) ? (job.payload.trigger as 'daily' | 'weekly') : null);

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

/** Espera entre as tentativas do relatório de situação fiscal (os testes trocam por uma espera nula). */
export const robotTiming = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
 * 4. relatório de situação fiscal (SITFIS) com o PDF, a cada 30 dias, e a leitura dele (situação,
 *    pendências e certidão vigente; "não interpretado" quando o texto foge do modelo oficial);
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

/** Mensagem gravada com a leitura do relatório (a situação em si fica em `status`). */
function sitfisMessage(reading: SitfisReading): string {
  if (reading.status === 'regular') return reading.message ?? 'O relatório não aponta pendências na Receita Federal nem na PGFN.';
  if (reading.status === 'pending') return 'O relatório lista pendências na Receita Federal ou na PGFN: confira os detalhes no PDF.';
  return reading.readable
    ? 'Relatório salvo, mas o texto não segue o modelo conhecido e não foi interpretado: abra o PDF para conferir.'
    : 'Relatório salvo, mas não foi possível ler o texto do PDF: abra o PDF para conferir.';
}

/** Resumo da leitura para o resultado da sincronização. */
const sitfisStep = (reading: SitfisReading) =>
  reading.status === 'pending' ? `com pendências: ${reading.pendencies.length}` : SITFIS_STATUS[reading.status].toLowerCase();

/**
 * Relatório de situação fiscal (SITFIS): pede o protocolo, espera o tempo indicado, grava o PDF e a
 * leitura dele. A leitura nunca impede a gravação: o PDF é a fonte da verdade.
 */
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
    const reading = readSitfisReport(file.data);
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
        status: reading.status,
        situation: reading.status === 'unknown' ? null : SITFIS_STATUS[reading.status],
        message: sitfisMessage(reading),
        pendencies: reading.pendencies,
        certificate: reading.certificate,
      },
      file,
    });
    return `situação fiscal: relatório emitido (${sitfisStep(reading)})`;
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

/** Fecha a sincronização geral uma vez só (último cliente ou escritório sem clientes) e avisa no sino. */
async function finishOfficeSync(ctx: AppContext, parentId: string) {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set({ payload: sql`jsonb_set(${jobs.payload}, '{fanout,finishedAt}', to_jsonb(now()))` })
      .where(and(eq(jobs.id, parentId), sql`${jobs.payload}->'fanout'->>'finishedAt' is null`))
      .returning();
    const fan = row ? fanoutOf(row) : null;
    if (!row?.officeId || !fan) return;
    const daily = autoTrigger(row) !== null;
    // a rodada automática só avisa quando algum cliente falhou
    if (daily && !fan.failed) return;
    await notify(tx, {
      officeId: row.officeId,
      userId: row.createdByUserId,
      title: daily ? 'Sincronização automática do eCAC com erros' : 'Sincronização eCAC concluída',
      body: `${fan.ok} de ${fan.total} cliente(s) sincronizado(s)${fan.failed ? `, ${fan.failed} com erro` : ''}.`,
      link: '/admin/robo',
    });
  });
}

/**
 * Divide a sincronização do escritório em um `ecac.sync` por cliente ativo com procurador. O pai
 * confere o SERPRO e espera os estados definitivos dos filhos para somar o resultado.
 */
async function fanOutOfficeSync(ctx: AppContext, job: JobRow, helpers: JobHelpers) {
  const { db } = ctx;
  const officeId = job.officeId!;
  const children = await helpers.children();
  if (children.length) {
    if (children.some((k) => k.status === 'queued' || k.status === 'running')) return WAIT_FOR_CHILDREN;
    const fanout = summarizeOfficeChildren(children);
    // Soma os estados definitivos, incluindo filhos abandonados, sem contar uma tentativa duas vezes.
    const current = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
    await db.update(jobs).set({ payload: { ...job.payload, fanout: { ...fanout, finishedAt: fanoutOf(current ?? job)?.finishedAt } } }).where(eq(jobs.id, job.id));
    await finishOfficeSync(ctx, job.id);
    return { ...fanout };
  }
  await requireSerpro(ctx, officeId);
  const list = await db.select({ id: customers.id, name: customers.name }).from(customers)
    .where(and(eq(customers.officeId, officeId), isNull(customers.deletedAt), isNotNull(customers.procuratorId), eq(customers.status, 'active')))
    .orderBy(asc(customers.name));
  // A fila grava todos os filhos numa transação e retoma o pai depois do último estado definitivo.
  await helpers.spawn(list.map((c) => ({ type: ECAC_SYNC, payload: { customerId: c.id, customerName: c.name, parentJobId: job.id }, idempotencyKey: `${job.id}:${c.id}`, maxAttempts: 2 })));
  await db.update(jobs).set({ payload: { ...job.payload, fanout: { total: list.length, ok: 0, failed: 0, errors: [] } } }).where(eq(jobs.id, job.id));
  if (list.length) return WAIT_FOR_CHILDREN;
  await finishOfficeSync(ctx, job.id);
  return { total: 0, ok: 0, failed: 0, errors: [] };
}

// ---------------------------------------------------------------------------
// Rodada automática (diária ou semanal, configurada na integração SERPRO)
// ---------------------------------------------------------------------------

/** Brasília não tem horário de verão desde 2019: UTC−3. */
const BRASILIA_OFFSET_MS = 3 * 3600_000;
const spread = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

/** Horário da rodada do escritório no dia (AAAA-MM-DD de Brasília): entre 3h e 6h, espalhado entre os escritórios. */
function runAtOn(officeId: string, day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + (180 + (spread(officeId) % 180)) * 60_000 + BRASILIA_OFFSET_MS);
}

/**
 * Próxima rodada automática do escritório depois de `now` (e num dia depois de `afterDay`), nos
 * dias da frequência configurada; `null` se desligada.
 */
export function nextAutoSyncRun(officeId: string, setting: EcacAutoSyncSetting, opts: { now?: Date; afterDay?: string } = {}): Date | null {
  const now = opts.now ?? new Date();
  const today = brazilToday(now);
  let from = runAtOn(officeId, today) > now ? today : addDays(today, 1);
  if (opts.afterDay && from <= opts.afterDay) from = addDays(opts.afterDay, 1);
  const day = nextEcacAutoSyncDay(setting, from);
  return day ? runAtOn(officeId, day) : null;
}

/** Próxima rodada diária do escritório: todo dia entre 3h e 6h (Brasília). */
export function nextDailyRun(officeId: string, now = new Date()): Date {
  return nextAutoSyncRun(officeId, { mode: 'daily', weekday: 0 }, { now })!;
}

const autoQueued = (officeId: string) =>
  and(eq(jobs.type, ECAC_SYNC_OFFICE), eq(jobs.officeId, officeId), eq(jobs.status, 'queued'), sql`${jobs.payload}->>'trigger' in (${DAILY_TRIGGER}, ${WEEKLY_TRIGGER})`);

/** Dia (Brasília) de uma rodada automática: o gravado no payload, o da chave da diária ou o do horário marcado. */
const autoRunDay = (job: JobRow) =>
  (typeof job.payload.day === 'string' ? job.payload.day : null) ?? /^daily:.*:(\d{4}-\d{2}-\d{2})$/.exec(job.idempotencyKey ?? '')?.[1] ?? brazilToday(job.runAt);

/** Frequência da rodada automática do escritório; `null` com o SERPRO inativo ou removido. */
async function autoSyncSettingOf(ctx: AppContext, officeId: string) {
  const row = await ctx.db.query.integrations.findFirst({ where: and(eq(integrations.officeId, officeId), eq(integrations.provider, 'serpro'), eq(integrations.enabled, true)) });
  return row ? ecacAutoSyncSetting(row.publicConfig) : null;
}

/**
 * Agenda a rodada automática conforme a integração SERPRO (no padrão de `scheduleOmiePoll`): no
 * máximo uma na fila por escritório, com chave de idempotência por escritório e período (dia na
 * diária, semana na semanal), o que impede rodadas repetidas no período mesmo com vários workers.
 * SERPRO inativo ou rodada desligada tira da fila a que não começou; frequência ou dia da semana
 * trocados substituem a agendada. Ao encadear, `afterDay` é o dia da rodada em andamento.
 */
export async function scheduleEcacAutoSync(ctx: AppContext, officeId: string, opts: { now?: Date; afterDay?: string } = {}) {
  const setting = await autoSyncSettingOf(ctx, officeId);
  const queued = await ctx.db.query.jobs.findFirst({ where: autoQueued(officeId) });
  if (!setting || setting.mode === 'off') {
    await cancelEcacAutoSync(ctx, officeId);
    return null;
  }
  const mode = setting.mode;
  if (queued && autoTrigger(queued) === mode && isEcacAutoSyncDay(setting, autoRunDay(queued))) return queued;
  if (queued) await ctx.db.delete(jobs).where(and(eq(jobs.id, queued.id), eq(jobs.status, 'queued')));
  let afterDay = opts.afterDay;
  for (let i = 0; i < 3; i++) {
    const runAt = nextAutoSyncRun(officeId, setting, { now: opts.now, afterDay })!;
    const day = brazilToday(runAt);
    const job = await ctx.jobs.enqueue(ECAC_SYNC_OFFICE, { trigger: mode, ...(mode === 'weekly' ? { day } : {}) }, {
      officeId,
      runAt,
      idempotencyKey: `${mode}:${officeId}:${ecacAutoSyncPeriod(mode, day)}`,
      maxAttempts: 1,
    });
    // a rodada deste período já rodou (ou está rodando): fica para o período seguinte
    if (job.status === 'queued') return job;
    afterDay = mode === 'weekly' ? addDays(ecacAutoSyncPeriod(mode, day), 6) : day;
  }
  return null;
}

/** SERPRO desativado, removido ou rodada desligada: a rodada que ainda não começou sai da fila. */
export async function cancelEcacAutoSync(ctx: AppContext, officeId: string) {
  await ctx.db.delete(jobs).where(autoQueued(officeId));
}

/** Próxima rodada automática agendada (para a tela do robô). */
export async function nextScheduledOfficeSync(db: Db, officeId: string) {
  const row = await db.query.jobs.findFirst({ where: autoQueued(officeId), orderBy: asc(jobs.runAt) });
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

/** Ao subir a API: escritórios com o SERPRO ativo e a rodada ligada ganham a rodada automática, se ainda não tiverem. */
async function ensureDailySchedules(ctx: AppContext) {
  const rows = await ctx.db
    .select({ officeId: integrations.officeId })
    .from(integrations)
    .where(and(eq(integrations.provider, 'serpro'), eq(integrations.enabled, true)));
  // outra instância pode agendar ao mesmo tempo: a chave de idempotência recusa a duplicata
  for (const r of rows) await scheduleEcacAutoSync(ctx, r.officeId).catch(() => undefined);
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
    let result: Awaited<ReturnType<typeof syncCustomerViaSerpro>> | undefined;
    let failure: unknown = null;
    try {
      if (!officeId) throw new Error('Job sem escritório.');
      const customer = await db.query.customers.findFirst({
        where: and(eq(customers.id, customerId), eq(customers.officeId, officeId), isNull(customers.deletedAt)),
      });
      if (!customer) throw new Error('Cliente não encontrado.');
      const client = await requireSerpro(ctx, officeId);
      result = await syncCustomerViaSerpro(ctx, client, customer, { thorough: !parentJobId });
    } catch (err) {
      failure = err;
    }
    if (failure) throw failure;
    return result;
  });

  /**
   * Sincronização de todos os clientes com procurador do escritório (botão do robô ou rodada
   * automática). Quem pediu é avisado no sino ao terminar o último cliente, e também quando a
   * sincronização inteira falha (ex.: SERPRO não configurado); a rodada automática avisa o
   * escritório só quando há erro.
   */
  ctx.jobs.register(ECAC_SYNC_OFFICE, async (job, helpers) => {
    const officeId = job.officeId;
    if (!officeId) throw new Error('Job sem escritório.');
    const trigger = autoTrigger(job);
    if (trigger && !job.payload.fanout) {
      // a configuração vale na hora de rodar: SERPRO desativado ou rodada desligada param a cadeia
      const setting = await autoSyncSettingOf(ctx, officeId);
      if (!setting) return { skipped: true, reason: 'Integração SERPRO desativada.' };
      if (setting.mode === 'off') return { skipped: true, reason: 'Sincronização automática desligada.' };
      // agenda a próxima antes de começar, para a cadeia não parar se esta falhar
      const day = autoRunDay(job);
      await scheduleEcacAutoSync(ctx, officeId, { afterDay: day });
      if (setting.mode !== trigger || !isEcacAutoSyncDay(setting, day)) return { skipped: true, reason: 'A frequência da sincronização automática mudou: vale a próxima rodada agendada.' };
    }
    return fanOutOfficeSync(ctx, job, helpers);
  }, {
    // Também cobre a queda do processo com as tentativas esgotadas (sem executar o handler).
    onFailed: async (job, error) => {
      if (!job.officeId) return;
      await notify(db, { officeId: job.officeId, userId: job.createdByUserId, title: 'Sincronização do eCAC falhou', body: error, link: '/admin/robo' });
    },
  });

  await ensureDailySchedules(ctx).catch(() => undefined);
}
