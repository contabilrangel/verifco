import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { PROCURATION_STATUS, formatMoney } from '@verifco/shared';
import type { AppContext } from '../../context';
import { customers, darfs, ecacRecords, integrations, jobs, offices, procurators } from '../../db/schema';
import { loadIntegration } from '../../integrations/store';
import type { CustomerRow } from '../../services/customers';
import { queueDelivery } from '../../services/delivery';
import { notify } from '../../services/notify';
import { getOfficeSettings } from '../../services/settings';
import { saveEcacRecord } from './records';
import {
  IRPF_QUOTA_REVENUE_CODE,
  SERPRO_SERVICES,
  interpretMailbox,
  interpretMailboxList,
  interpretPayments,
  interpretProcuration,
  interpretSitfisProtocol,
  requireSerpro,
  sitfisPdf,
  type SerproClient,
} from './serpro';
import { interpretSitfis, pdfText } from './sitfis';

export interface SerproSyncOptions {
  /** Pede o relatório de situação fiscal (preferência "autoGenerateCnd" do escritório). */
  fiscalSituation?: boolean;
  /** Espera entre as tentativas do SITFIS (injetável nos testes). */
  sleep?: (ms: number) => Promise<void>;
  today?: string;
}

export interface SerproSyncResult {
  customerId: string;
  steps: string[];
  /** Mudanças encontradas (procuração, caixa postal, situação fiscal, quotas pagas). */
  changes: string[];
}

/** Espera máxima por tentativa do relatório SITFIS e número de tentativas. */
const SITFIS_MAX_WAIT_MS = 20_000;
const SITFIS_ATTEMPTS = 3;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const br = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : '');
const procurationLabel = (s: string | null | undefined) => PROCURATION_STATUS[(s ?? 'none') as keyof typeof PROCURATION_STATUS] ?? s ?? '—';

/**
 * Sincroniza um cliente pelo SERPRO Integra Contador:
 * 1. procuração eletrônica (cliente → procurador): validade e situação;
 * 2. caixa postal: indicador de mensagens novas (gratuito) e, quando há novidade ou na primeira vez,
 *    a lista das mensagens (assunto, data e se foi lida — o conteúdo não é aberto, porque abrir
 *    caracteriza ciência da intimação);
 * 3. situação fiscal (SITFIS), se o escritório ligou a preferência: protocolo, relatório em PDF,
 *    pendências e a certidão vigente informada no relatório;
 * 4. pagamentos (PAGTOWEB), só quando o cliente tem quotas do IRPF em aberto: dá baixa nas quotas
 *    com DARF pago de mesmo vencimento e valor (código 0211).
 * Cada resposta é guardada como registro do eCAC (origem `serpro`); o cadastro só muda com campos
 * reconhecidos. Falha na procuração interrompe o cliente; nas demais etapas, a etapa é registrada
 * como falha e as outras continuam.
 */
export async function syncCustomerViaSerpro(ctx: AppContext, client: SerproClient, customer: CustomerRow, opts: SerproSyncOptions = {}): Promise<SerproSyncResult> {
  const { db } = ctx;
  if (!customer.procuratorId) throw new Error('Cliente sem procurador associado: associe um procurador para consultar a procuração eletrônica.');
  const procurator = await db.query.procurators.findFirst({ where: eq(procurators.id, customer.procuratorId) });
  if (!procurator) throw new Error('Procurador do cliente não encontrado.');
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const steps: string[] = [];
  const changes: string[] = [];
  const base = { officeId: customer.officeId, customer, source: 'serpro' as const };

  // 1. procuração
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
  await saveEcacRecord(ctx, {
    ...base,
    kind: 'procuration',
    year: null,
    data: {
      service: 'PROCURACOES/OBTERPROCURACAO41',
      raw: proc.dados as never,
      ...(procInfo ?? { note: proc.pending ? 'SERPRO ainda processando; tente de novo em instantes.' : 'Resposta registrada sem data de expiração reconhecível; cadastro não alterado.' }),
    },
  });
  steps.push(procInfo ? `procuração: ${procInfo.status} até ${procInfo.expiresAt}` : 'procuração: resposta registrada (sem validade reconhecida)');
  if (procInfo && (procInfo.status !== customer.procurationStatus || procInfo.expiresAt !== customer.procurationExpiresAt)) {
    changes.push(`procuração ${procurationLabel(procInfo.status).toLowerCase()} até ${br(procInfo.expiresAt)} (antes: ${procurationLabel(customer.procurationStatus).toLowerCase()})`);
  }

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      steps.push(`${name}: falhou (${errMsg(err)})`);
    }
  };

  // 2. caixa postal
  await step('caixa postal', async () => {
    const mail = await client.call({ ...SERPRO_SERVICES.mailboxIndicator, contribuinte: customer.cpfCnpj, dados: '' });
    const indicator = mail.pending ? null : interpretMailbox(mail.dados);
    await saveEcacRecord(ctx, { ...base, kind: 'other', year: null, data: { service: 'CAIXAPOSTAL/INNOVAMSG63', raw: mail.dados as never, unread: indicator } });
    const [{ listed }] = await db
      .select({ listed: count() })
      .from(ecacRecords)
      .where(and(eq(ecacRecords.customerId, customer.id), eq(ecacRecords.kind, 'mailbox_message'), eq(ecacRecords.source, 'serpro')));
    if (indicator === 0 && listed > 0) {
      // sem mensagens novas: as que ainda constavam como não lidas foram lidas no eCAC
      await db
        .update(ecacRecords)
        .set({ data: sql`jsonb_set(${ecacRecords.data}, '{read}', 'true'::jsonb)` })
        .where(and(eq(ecacRecords.customerId, customer.id), eq(ecacRecords.kind, 'mailbox_message'), eq(ecacRecords.source, 'serpro'), sql`${ecacRecords.data}->>'read' = 'false'`));
      await recountMailbox(ctx, customer.id);
      steps.push('caixa postal: nenhuma mensagem nova');
      return;
    }
    // com novidade (ou na primeira vez, para preencher o histórico), lista as mensagens
    const list = await client.call({ ...SERPRO_SERVICES.mailboxList, contribuinte: customer.cpfCnpj, dados: { statusLeitura: '0', indicadorPagina: '0' } });
    const messages = list.pending ? [] : interpretMailboxList(list.dados);
    const fresh: string[] = [];
    // a lista vem da mais recente para a mais antiga; grava ao contrário para a mais recente ficar por cima no painel
    for (const m of [...messages].reverse()) {
      const saved = await saveEcacRecord(ctx, {
        ...base,
        kind: 'mailbox_message',
        year: null,
        externalId: m.externalId,
        data: {
          service: 'CAIXAPOSTAL/MSGCONTRIBUINTE61',
          subject: m.subject,
          receivedAt: m.receivedAt,
          read: m.read,
          relevant: m.relevant,
          origin: m.origin,
          controlNumber: m.controlNumber,
          acknowledgedAt: m.acknowledgedAt,
        },
      });
      if (!saved.duplicate && !m.read) fresh.push(m.subject);
    }
    if (!messages.length && indicator !== null) {
      await db.update(customers).set({ ecacMailboxMessages: indicator, updatedAt: new Date() }).where(eq(customers.id, customer.id));
    }
    const unread = messages.filter((m) => !m.read).length;
    steps.push(list.pending ? 'caixa postal: lista em processamento no SERPRO' : `caixa postal: ${messages.length} mensagem(ns) listada(s), ${unread} não lida(s)`);
    if (fresh.length) changes.push(`${fresh.length} mensagem(ns) nova(s) na caixa postal: ${fresh.slice(0, 3).join('; ')}${fresh.length > 3 ? '…' : ''}`);
  });

  // 3. situação fiscal (SITFIS)
  if (opts.fiscalSituation) {
    await step('situação fiscal', async () => {
      const sleep = opts.sleep ?? realSleep;
      const req = await client.call({ ...SERPRO_SERVICES.fiscalSituationRequest, contribuinte: customer.cpfCnpj, dados: '' });
      const { protocol, waitMs } = interpretSitfisProtocol(req.dados);
      if (!protocol) {
        steps.push('situação fiscal: o SERPRO não devolveu o protocolo do relatório; tente de novo mais tarde');
        return;
      }
      let wait = waitMs ?? req.tempoEsperaMs ?? 0;
      let pdf: Buffer | null = null;
      for (let attempt = 0; attempt < SITFIS_ATTEMPTS && !pdf; attempt++) {
        if (wait > 0) await sleep(Math.min(wait, SITFIS_MAX_WAIT_MS));
        const rep = await client.call({ ...SERPRO_SERVICES.fiscalSituationReport, contribuinte: customer.cpfCnpj, dados: { protocoloRelatorio: protocol } });
        pdf = rep.pending ? null : sitfisPdf(rep.dados);
        if (!rep.pending && !pdf) break;
        wait = interpretSitfisProtocol(rep.dados).waitMs ?? rep.tempoEsperaMs ?? 5_000;
      }
      if (!pdf) {
        steps.push('situação fiscal: relatório ainda em processamento no SERPRO; será buscado na próxima sincronização');
        return;
      }
      const reading = interpretSitfis(pdfText(pdf));
      const previous = await db.query.ecacRecords.findFirst({
        where: and(eq(ecacRecords.customerId, customer.id), eq(ecacRecords.kind, 'fiscal_situation')),
        orderBy: desc(ecacRecords.fetchedAt),
      });
      const sameDay = previous?.data.externalId === `sitfis:${today}` ? previous : null;
      const saved = await saveEcacRecord(ctx, {
        ...base,
        kind: 'fiscal_situation',
        year: null,
        externalId: `sitfis:${today}`,
        file: { filename: `situacao-fiscal-${customer.cpfCnpj}-${today}.pdf`, mimeType: 'application/pdf', data: pdf },
        data: {
          service: 'SITFIS/RELATORIOSITFIS92',
          status: reading.status,
          situation: reading.situation,
          message: reading.readable
            ? (reading.message ?? 'Relatório salvo; o texto não tem as frases do modelo oficial. Abra o PDF para conferir.')
            : 'Relatório salvo; não foi possível ler o texto do PDF. Abra o relatório para conferir.',
          pendencies: reading.pendencies,
          certificate: reading.certificate as never,
        },
      });
      // nova consulta no mesmo dia: o relatório anterior é substituído
      if (sameDay?.fileId && sameDay.fileId !== saved.record.fileId) await ctx.files.remove(customer.officeId, sameDay.fileId).catch(() => undefined);
      // certidão vigente informada no relatório (o Integra Contador não emite a CND)
      const cert = reading.certificate;
      if (cert?.validUntil && cert.validUntil >= today) {
        await saveEcacRecord(ctx, {
          ...base,
          kind: 'cnd',
          year: null,
          externalId: `sitfis-cnd:${cert.code ?? cert.validUntil}`,
          data: {
            status: 'success',
            certificateType: cert.type,
            code: cert.code,
            issuedAt: cert.issuedAt,
            validUntil: cert.validUntil,
            note: 'Certidão informada no relatório de situação fiscal (SITFIS). O PDF da certidão não vem pelo Integra Contador.',
          },
        });
      } else if (reading.status === 'pending') {
        await saveEcacRecord(ctx, {
          ...base,
          kind: 'cnd',
          year: null,
          externalId: `sitfis-pendencias:${today}`,
          data: { status: 'pending_issues', note: 'O relatório de situação fiscal lista pendências; a CND não seria emitida.' },
        });
      }
      steps.push(`situação fiscal: ${reading.situation ? reading.situation.toLowerCase() : 'relatório salvo (situação não reconhecida)'}`);
      const before = typeof previous?.data.status === 'string' ? previous.data.status : null;
      if (reading.status && reading.status !== before) {
        changes.push(
          reading.status === 'pending'
            ? `situação fiscal com pendências: ${reading.pendencies.slice(0, 3).join('; ')}`
            : `situação fiscal sem pendências${before === 'pending' ? ' (as pendências anteriores foram resolvidas)' : ''}`,
        );
      }
    });
  }

  // 4. pagamentos das quotas do IRPF (PAGTOWEB)
  const open = await db
    .select()
    .from(darfs)
    .where(and(eq(darfs.customerId, customer.id), eq(darfs.officeId, customer.officeId), eq(darfs.status, 'open')))
    .orderBy(asc(darfs.dueDate), asc(darfs.quotaNumber));
  if (open.length) {
    await step('pagamentos', async () => {
      const from = `${open[0].dueDate.slice(0, 4)}-01-01`;
      const res = await client.call({
        ...SERPRO_SERVICES.payments,
        contribuinte: customer.cpfCnpj,
        dados: { codigoReceitaLista: [IRPF_QUOTA_REVENUE_CODE], intervaloDataArrecadacao: { dataInicial: from, dataFinal: today }, primeiroDaPagina: 0, tamanhoDaPagina: 100 },
      });
      const payments = res.pending ? [] : interpretPayments(res.dados).filter((p) => p.revenueCode === IRPF_QUOTA_REVENUE_CODE);
      const used = new Set<string>();
      let paid = 0;
      for (const d of open) {
        const p = payments.find((x) => !used.has(x.documentNumber) && x.dueDate === d.dueDate && (x.principalCents === d.valueCents || x.totalCents === d.valueCents));
        if (!p) continue;
        used.add(p.documentNumber);
        await db.update(darfs).set({ status: 'paid', paidAt: p.paidOn ?? today }).where(eq(darfs.id, d.id));
        await saveEcacRecord(ctx, {
          ...base,
          kind: 'other',
          year: null,
          externalId: `pagtoweb:${p.documentNumber}`,
          data: { service: 'PAGTOWEB/PAGAMENTOS71', documentNumber: p.documentNumber, revenueCode: p.revenueCode, paidOn: p.paidOn, dueDate: p.dueDate, totalCents: p.totalCents, darfId: d.id, quotaNumber: d.quotaNumber },
        });
        paid++;
        changes.push(`quota ${d.quotaNumber} do IRPF (${formatMoney(d.valueCents)}, vencimento ${br(d.dueDate)}) paga em ${br(p.paidOn ?? today)}`);
      }
      steps.push(res.pending ? 'pagamentos: consulta em processamento no SERPRO' : `pagamentos: ${paid} de ${open.length} quota(s) em aberto com pagamento encontrado`);
    });
  }
  return { customerId: customer.id, steps, changes };
}

/** Recalcula as mensagens não lidas da caixa postal do cliente. */
async function recountMailbox(ctx: AppContext, customerId: string) {
  const [{ unread }] = await ctx.db
    .select({ unread: count() })
    .from(ecacRecords)
    .where(and(eq(ecacRecords.customerId, customerId), eq(ecacRecords.kind, 'mailbox_message'), sql`coalesce(${ecacRecords.data}->>'read', 'false') <> 'true'`));
  await ctx.db.update(customers).set({ ecacMailboxMessages: unread, updatedAt: new Date() }).where(eq(customers.id, customerId));
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Avisa as mudanças encontradas pelo robô: no sino (responsável pelo cliente ou escritório todo) e,
 * com a preferência "Avisar o e-mail principal do escritório sobre mudanças no eCAC", num único
 * e-mail para o e-mail principal do escritório (uma vez por sincronização).
 */
export async function reportEcacChanges(ctx: AppContext, officeId: string, found: { customer: CustomerRow; changes: string[] }[], key: string) {
  const list = found.filter((f) => f.changes.length);
  if (!list.length) return { notified: 0, emailed: false };
  for (const { customer, changes } of list) {
    await notify(ctx.db, {
      officeId,
      userId: customer.responsibleUserId ?? null,
      customerId: customer.id,
      title: `Mudanças no eCAC de ${customer.name}`,
      body: changes.join(' · ').slice(0, 500),
      link: `/clientes/${customer.id}/ecac`,
    });
  }
  const settings = await getOfficeSettings(ctx.db, officeId);
  const office = await ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId) });
  if (!settings.notifyMainEmailOnEcacChanges || !office?.email) return { notified: list.length, emailed: false };
  const items = list
    .map(({ customer, changes }) => `<li><strong>${escapeHtml(customer.name)}</strong><ul>${changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></li>`)
    .join('');
  await queueDelivery(ctx, {
    officeId,
    customerId: null,
    channel: 'email',
    to: office.email,
    subject: `Mudanças no eCAC: ${list.length} cliente(s)`,
    body: `<p>A sincronização com o SERPRO Integra Contador encontrou mudanças no eCAC:</p><ul>${items}</ul><p>Os detalhes estão na aba eCAC de cada cliente, no Verifco.</p>`,
    idempotencyKey: `ecac-changes:${key}`,
  });
  return { notified: list.length, emailed: true };
}

// ---------------------------------------------------------------------------
// Sincronização automática (diária ou semanal, configurada na integração SERPRO)
// ---------------------------------------------------------------------------
export const ECAC_SCHEDULE_JOB = 'ecac.sync_schedule';
/** Horário das rodadas automáticas: 6h de Brasília (9h UTC; sem horário de verão desde 2019). */
const AUTO_SYNC_UTC_HOUR = 9;

/** Próxima rodada a partir de `now`: o próximo 6h de Brasília (+6 dias na semanal). */
export function nextAutoSyncAt(mode: 'daily' | 'weekly', now = new Date()): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), AUTO_SYNC_UTC_HOUR));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  if (mode === 'weekly') next.setUTCDate(next.getUTCDate() + 6);
  return next;
}

/**
 * Agenda a próxima sincronização automática do escritório, se a integração SERPRO estiver ativa
 * com "Sincronização automática" ligada. Mantém no máximo uma na fila (a chave usa o dia).
 */
export async function scheduleEcacAutoSync(ctx: AppContext, officeId: string, now = new Date()) {
  const loaded = await loadIntegration<{ autoSync?: string }>(ctx, officeId, 'serpro');
  const mode = loaded?.config.autoSync;
  const queuedWhere = and(eq(jobs.type, ECAC_SCHEDULE_JOB), eq(jobs.officeId, officeId), eq(jobs.status, 'queued'));
  if (!loaded?.row.enabled || (mode !== 'daily' && mode !== 'weekly')) {
    await ctx.db.delete(jobs).where(queuedWhere);
    return null;
  }
  const queued = await ctx.db.query.jobs.findFirst({ where: queuedWhere });
  if (queued?.payload.mode === mode) return queued;
  // mudou a frequência: a rodada agendada com a frequência anterior dá lugar à nova
  if (queued) await ctx.db.delete(jobs).where(eq(jobs.id, queued.id));
  let runAt = nextAutoSyncAt(mode, now);
  for (let i = 0; i < 3; i++) {
    try {
      const job = await ctx.jobs.enqueue(ECAC_SCHEDULE_JOB, { mode }, { officeId, runAt, idempotencyKey: `${officeId}:${runAt.toISOString().slice(0, 10)}`, maxAttempts: 1 });
      if (job.status === 'queued') return job;
    } catch {
      // outra instância agendou o mesmo dia ao mesmo tempo
      const other = await ctx.db.query.jobs.findFirst({ where: queuedWhere });
      if (other) return other;
    }
    // a rodada desse dia já rodou (ou está rodando): vai para a seguinte
    runAt = new Date(runAt.getTime() + (mode === 'weekly' ? 7 : 1) * 86_400_000);
  }
  return null;
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
    const settings = await getOfficeSettings(db, officeId);
    const result = await syncCustomerViaSerpro(ctx, client, customer, { fiscalSituation: settings.autoGenerateCnd });
    await reportEcacChanges(ctx, officeId, [{ customer, changes: result.changes }], job.id);
    return { ...result };
  });

  /**
   * Sincronização de todos os clientes com procurador do escritório. Quem pediu é avisado no sino
   * ao terminar, inclusive quando a sincronização inteira falha (ex.: SERPRO não configurado). Nas
   * rodadas automáticas (`scheduled`), o aviso de conclusão só sai quando há erro.
   */
  ctx.jobs.register('ecac.sync_office', async (job, { progress }) => {
    const officeId = job.officeId;
    if (!officeId) throw new Error('Job sem escritório.');
    try {
      return await syncOffice(ctx, officeId, job, progress);
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

  /** Rodada automática: agenda a seguinte e enfileira a sincronização geral (se não houver uma). */
  ctx.jobs.register(ECAC_SCHEDULE_JOB, async (job) => {
    const officeId = job.officeId;
    if (!officeId) throw new Error('Job sem escritório.');
    const next = await scheduleEcacAutoSync(ctx, officeId);
    if (!next) return { skipped: true, reason: 'Sincronização automática desligada ou integração SERPRO inativa.' };
    const running = await db.query.jobs.findFirst({
      where: and(eq(jobs.officeId, officeId), eq(jobs.type, 'ecac.sync_office'), inArray(jobs.status, ['queued', 'running'])),
    });
    if (running) return { skipped: true, reason: 'Já havia uma sincronização geral na fila.', next: next.runAt };
    const queued = await ctx.jobs.enqueue('ecac.sync_office', { scheduled: true }, { officeId, maxAttempts: 1 });
    return { queued: queued.id, next: next.runAt };
  });

  // retoma as rodadas automáticas dos escritórios ao subir o processo que executa a fila
  if (ctx.config.RUN_WORKER) {
    return (async () => {
      try {
        const rows = await db.select({ officeId: integrations.officeId }).from(integrations).where(and(eq(integrations.provider, 'serpro'), eq(integrations.enabled, true)));
        for (const r of rows) await scheduleEcacAutoSync(ctx, r.officeId);
      } catch (err) {
        console.warn(`[ecac] não foi possível agendar a sincronização automática: ${errMsg(err)}`);
      }
    })();
  }
}

async function syncOffice(ctx: AppContext, officeId: string, job: typeof jobs.$inferSelect, progress: (pct: number) => Promise<void>) {
  const { db } = ctx;
  const scheduled = job.payload.scheduled === true;
  const client = await requireSerpro(ctx, officeId);
  const settings = await getOfficeSettings(db, officeId);
  const list = await db
    .select()
    .from(customers)
    .where(and(eq(customers.officeId, officeId), isNull(customers.deletedAt), isNotNull(customers.procuratorId), eq(customers.status, 'active')))
    .orderBy(asc(customers.name));
  let ok = 0;
  const errors: { customerId: string; name: string; error: string }[] = [];
  const found: { customer: CustomerRow; changes: string[] }[] = [];
  for (const [i, c] of list.entries()) {
    try {
      const r = await syncCustomerViaSerpro(ctx, client, c, { fiscalSituation: settings.autoGenerateCnd });
      found.push({ customer: c, changes: r.changes });
      ok++;
    } catch (err) {
      errors.push({ customerId: c.id, name: c.name, error: errMsg(err) });
    }
    await progress(((i + 1) / Math.max(1, list.length)) * 100);
  }
  const reported = await reportEcacChanges(ctx, officeId, found, job.id);
  if (!scheduled || errors.length) {
    await notify(db, {
      officeId,
      userId: job.createdByUserId,
      title: 'Sincronização eCAC concluída',
      body: `${ok} de ${list.length} cliente(s) sincronizado(s)${errors.length ? `, ${errors.length} com erro` : ''}${reported.notified ? `; ${reported.notified} com mudanças` : ''}.`,
      link: '/admin/robo',
    });
  }
  return { total: list.length, ok, failed: errors.length, changed: reported.notified, scheduled, errors: errors.slice(0, 50) };
}
