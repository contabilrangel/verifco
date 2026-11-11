/**
 * Lembretes diários do escritório (job `reminders.daily`, às 8h de Brasília).
 *
 * Ao CLIENTE, por e-mail (só quem tem e-mail e não foi excluído), conforme as preferências:
 * - quota do DARF em aberto que vence nos próximos N dias (`darf_reminder`);
 * - parcela dos honorários em aberto que vence nos próximos N dias (`installment_reminder`);
 * - parcela dos honorários vencida há 3 dias e ainda em aberto (`installment_overdue`).
 *
 * Ao ESCRITÓRIO, no sino (para o responsável pelo cliente, quando há um ativo), com os avisos
 * diários ligados: procuração eletrônica e certificado A1 do procurador perto de vencer (30, 15, 7
 * e 1 dia; a procuração também quando vence), quota do DARF que vence hoje sem pagamento, parcela
 * dos honorários que venceu, link do checklist perto de expirar sem o cliente ter finalizado e o
 * contrato do escritório perto de vencer (15, 7 e 1 dia e no vencimento; para o dono da conta).
 *
 * Nada se repete: cada aviso grava uma marca (`reminder_marks`, única por escritório) e só sai
 * quando a marca foi incluída agora. As consultas já deixam de fora o que tem marca, olham uma
 * janela de dias (uma rodada perdida não perde o aviso) e trazem no máximo `REMINDER_CAP` por
 * categoria em cada rodada; o que passar disso fica para a rodada seguinte, com uma linha no log.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notExists, notInArray, sql, type SQL } from 'drizzle-orm';
import { addDaysIso, darfValueText, daysBetweenIso, formatDate, formatMoney, todayIso } from '@verifco/shared';
import type { AppContext } from '../../context';
import type { DbOrTx } from '../../db/client';
import { billings, budgets, checklists, customers, darfs, declarations, installments, procurators, reminderMarks, users } from '../../db/schema';
import type { CustomerRow } from '../../services/customers';
import { createDeliveryBatch } from '../../services/delivery';
import { logRoutine, selicTable } from '../../services/indices';
import { notify } from '../../services/notify';
import { planStatus, type ContractRow } from '../../services/plan';
import { getOfficeSettings } from '../../services/settings';

/** Máximo de avisos de cada categoria por rodada. */
export const REMINDER_CAP = 500;
/** O cliente é avisado da parcela vencida quando ela completa estes dias em aberto. */
export const INSTALLMENT_OVERDUE_DAYS = 3;
/** Rodadas perdidas: avisos "do dia" ainda saem até este número de dias depois. */
const CATCH_UP_DAYS = 7;
/** O link do checklist entra no aviso quando faltam até estes dias para expirar. */
export const CHECKLIST_LINK_DAYS = 3;
const EXPIRY_STEPS = [1, 7, 15, 30] as const;
const CONTRACT_STEPS = [1, 7, 15] as const;

export type ReminderEmailCategory = 'darfCustomer' | 'installmentCustomer' | 'installmentOverdueCustomer';
export type ReminderNoticeCategory = 'procuration' | 'certificate' | 'darfToday' | 'installmentOverdue' | 'checklistLink' | 'contract';
export type ReminderCategory = ReminderEmailCategory | ReminderNoticeCategory;

export interface ReminderRunResult {
  [k: string]: unknown;
  day: string;
  /** E-mails ao cliente postos na fila nesta rodada, por categoria. */
  emails: Record<ReminderEmailCategory, number>;
  /** Avisos no sino criados nesta rodada, por categoria. */
  notices: Record<ReminderNoticeCategory, number>;
  /** Categorias que bateram no limite da rodada (o restante sai na próxima). */
  capped: ReminderCategory[];
}

export interface ReminderOptions {
  /** Dia da rodada (AAAA-MM-DD, Brasília); por padrão, hoje. */
  today?: string;
  /** Instante da rodada (validade dos links); por padrão, agora (ou 8h do `today` informado). */
  now?: Date;
  /** Limite por categoria (padrão `REMINDER_CAP`). */
  cap?: number;
}

interface Run {
  ctx: AppContext;
  officeId: string;
  today: string;
  now: Date;
  cap: number;
  result: ReminderRunResult;
}

interface EmailItem {
  key: string;
  customer: CustomerRow;
  values: Record<string, string | number>;
}

interface Notice {
  key: string;
  userId: string | null;
  customerId?: string | null;
  title: string;
  body: string;
  link: string;
}

// ---------------------------------------------------------------------------
// Marcas (o que já foi avisado)
// ---------------------------------------------------------------------------

/** Chave da marca montada no banco: `prefixo:parte:parte...` (o prefixo é uma constante do código). */
const markKey = (prefix: string, ...parts: SQL[]): SQL<string> => sql<string>`${sql.raw(`'${prefix}'`)} || ${sql.join(parts.map((p) => sql`':' || (${p})::text`), sql` || `)}`;

/** Condição: ainda não há marca com esta chave no escritório. */
const unmarked = (db: DbOrTx, officeId: string, key: SQL<string>) =>
  notExists(db.select({ one: sql`1` }).from(reminderMarks).where(and(eq(reminderMarks.officeId, officeId), eq(reminderMarks.key, key))));

/** Grava as marcas e devolve só as incluídas agora (as que já existiam não geram aviso de novo). */
async function claim(db: DbOrTx, officeId: string, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await db.insert(reminderMarks).values(keys.map((key) => ({ officeId, key }))).onConflictDoNothing().returning({ key: reminderMarks.key });
  return new Set(rows.map((r) => r.key));
}

/** Corta a categoria no limite da rodada (a consulta traz um a mais para saber) e registra no log. */
function capRows<T>(run: Run, category: ReminderCategory, rows: T[]): T[] {
  if (rows.length <= run.cap) return rows;
  run.result.capped.push(category);
  logRoutine(run.ctx, 'warn', 'Lembretes: categoria no limite da rodada; o restante sai na próxima', { officeId: run.officeId, category, cap: run.cap });
  return rows.slice(0, run.cap);
}

/** E-mails ao cliente em lote (um template), só para as marcas incluídas agora. */
async function sendEmails(run: Run, templateKey: string, items: EmailItem[]): Promise<number> {
  const { ctx, officeId } = run;
  const fresh = await claim(ctx.db, officeId, items.map((i) => i.key));
  const todo = items.filter((i) => fresh.delete(i.key));
  if (!todo.length) return 0;
  try {
    const batch = await createDeliveryBatch(ctx, { officeId, templateKey, customers: todo.map((i) => i.customer) });
    const queued = await batch.queue(todo.map((i) => ({ customer: i.customer, channel: 'email' as const, values: i.values, idempotencyKey: `lembrete:${i.key}` })));
    return queued.queued;
  } catch (err) {
    // sem as marcas, a próxima rodada tenta de novo (o envio já gravado não se repete, pela chave dele)
    await ctx.db.delete(reminderMarks).where(and(eq(reminderMarks.officeId, officeId), inArray(reminderMarks.key, todo.map((i) => i.key)))).catch(() => undefined);
    throw err;
  }
}

/** Avisos no sino: a marca e a notificação são gravadas juntas (ou nenhuma das duas). */
async function postNotices(run: Run, items: Notice[]): Promise<number> {
  if (!items.length) return 0;
  return run.ctx.db.transaction(async (tx) => {
    const fresh = await claim(tx, run.officeId, items.map((i) => i.key));
    let posted = 0;
    for (const n of items) {
      if (!fresh.delete(n.key)) continue;
      await notify(tx, { officeId: run.officeId, userId: n.userId, customerId: n.customerId ?? null, title: n.title, body: n.body, link: n.link });
      posted += 1;
    }
    return posted;
  });
}

// ---------------------------------------------------------------------------
// Condições comuns
// ---------------------------------------------------------------------------

const liveCustomer = (officeId: string) => and(eq(customers.officeId, officeId), isNull(customers.deletedAt))!;
const hasEmail = and(isNotNull(customers.email), ne(sql`btrim(${customers.email})`, ''))!;
const openDarf = and(ne(darfs.status, 'paid'), isNull(darfs.paidAt))!;
const openInstallment = and(notInArray(installments.status, ['paid', 'canceled']), isNull(installments.paidAt), isNull(installments.canceledAt))!;
/** Responsável pelo cliente, se ainda for um usuário ativo (senão o aviso vai para o escritório). */
const activeResponsible = and(eq(users.id, customers.responsibleUserId), eq(users.isActive, true))!;
/** Parcelas não canceladas da cobrança (o "3" de "1/3"). */
const installmentCount = sql<number>`(select count(*) from ${installments} i2 where i2.billing_id = ${installments.billingId} and i2.status <> 'canceled')`.mapWith(Number);

const daysText = (days: number) => (days <= 0 ? 'hoje' : days === 1 ? 'amanhã' : `em ${days} dias`);
/** Degrau do aviso: o menor dos prazos que ainda cobre os dias que faltam (30, 15, 7 ou 1). */
const stepSql = (days: SQL, steps: readonly number[]) =>
  sql<number>`case ${sql.join(steps.slice(0, -1).map((s) => sql`when ${days} <= ${sql.raw(String(s))} then ${sql.raw(String(s))}`), sql` `)} else ${sql.raw(String(steps[steps.length - 1]))} end`;

// ---------------------------------------------------------------------------
// Ao cliente (e-mail)
// ---------------------------------------------------------------------------

/** Quota do DARF em aberto que vence nos próximos `days` dias. */
async function darfCustomerReminders(run: Run, days: number): Promise<number> {
  const { ctx, officeId, today } = run;
  const key = markKey('darf-cliente', sql`${darfs.id}`, sql`${darfs.dueDate}`);
  const rows = await ctx.db
    .select({ darf: darfs, customer: customers, year: declarations.exerciseYear, key })
    .from(darfs)
    .innerJoin(customers, eq(customers.id, darfs.customerId))
    .leftJoin(declarations, eq(declarations.id, darfs.declarationId))
    .where(and(eq(darfs.officeId, officeId), liveCustomer(officeId), hasEmail, openDarf, gt(darfs.dueDate, today), lte(darfs.dueDate, addDaysIso(today, days)), unmarked(ctx.db, officeId, key)))
    .orderBy(asc(darfs.dueDate), asc(darfs.id))
    .limit(run.cap + 1);
  if (!rows.length) return 0;
  const selic = await selicTable(ctx.db);
  const link = `${ctx.config.WEB_URL}/portal`;
  return sendEmails(
    run,
    'darf_reminder',
    capRows(run, 'darfCustomer', rows).map((r) => ({
      key: r.key,
      customer: r.customer,
      values: {
        ANO_EXERCICIO: r.year ?? Number(r.darf.dueDate.slice(0, 4)),
        QUOTA: r.darf.quotaNumber,
        // valor atualizado: principal + juros (Selic do banco antes da tabela fixa), como na guia
        VALOR: darfValueText(r.darf, selic),
        VENCIMENTO: formatDate(r.darf.dueDate),
        LINK: link,
      },
    })),
  );
}

/** Parcelas dos honorários em aberto com vencimento entre `from` e `to` (inclusive), de clientes com e-mail. */
async function installmentEmails(run: Run, category: ReminderEmailCategory, templateKey: string, prefix: string, from: string, to: string): Promise<number> {
  const { ctx, officeId } = run;
  const key = markKey(prefix, sql`${installments.id}`, sql`${installments.dueDate}`);
  const rows = await ctx.db
    .select({ inst: installments, customer: customers, year: budgets.exerciseYear, total: installmentCount, key })
    .from(installments)
    .innerJoin(billings, eq(billings.id, installments.billingId))
    .innerJoin(customers, eq(customers.id, billings.customerId))
    .innerJoin(budgets, eq(budgets.id, billings.budgetId))
    .where(and(eq(installments.officeId, officeId), liveCustomer(officeId), hasEmail, openInstallment, gte(installments.dueDate, from), lte(installments.dueDate, to), unmarked(ctx.db, officeId, key)))
    .orderBy(asc(installments.dueDate), asc(installments.id))
    .limit(run.cap + 1);
  return sendEmails(
    run,
    templateKey,
    capRows(run, category, rows).map((r) => ({
      key: r.key,
      customer: r.customer,
      values: {
        ANO_EXERCICIO: r.year,
        PARCELA: `${r.inst.number}/${Math.max(r.total, r.inst.number)}`,
        VALOR: formatMoney(r.inst.amountCents),
        VENCIMENTO: formatDate(r.inst.dueDate),
        LINK: r.inst.externalUrl ?? '',
      },
    })),
  );
}

// ---------------------------------------------------------------------------
// Ao escritório (sino)
// ---------------------------------------------------------------------------

/** Procuração eletrônica perto de vencer (30, 15, 7 e 1 dia) ou vencida nos últimos dias. */
async function procurationNotices(run: Run): Promise<number> {
  const { ctx, officeId, today } = run;
  const days = sql<number>`(${customers.procurationExpiresAt} - ${today}::date)`;
  const step = sql<number>`case when ${days} < 0 then 0 else ${stepSql(days, EXPIRY_STEPS)} end`;
  const key = markKey('procuracao', sql`${customers.id}`, sql`${customers.procurationExpiresAt}`, step);
  const rows = await ctx.db
    .select({ id: customers.id, name: customers.name, expiresAt: customers.procurationExpiresAt, responsibleId: users.id, key })
    .from(customers)
    .leftJoin(users, activeResponsible)
    .where(
      and(
        liveCustomer(officeId),
        eq(customers.status, 'active'),
        // só procuração que está (ou estava) valendo: as inválidas, negadas e canceladas já pedem outra ação
        inArray(customers.procurationStatus, ['valid', 'validating', 'pending', 'expired']),
        gte(customers.procurationExpiresAt, addDaysIso(today, -CATCH_UP_DAYS)),
        lte(customers.procurationExpiresAt, addDaysIso(today, EXPIRY_STEPS[EXPIRY_STEPS.length - 1])),
        unmarked(ctx.db, officeId, key),
      ),
    )
    .orderBy(asc(customers.procurationExpiresAt), asc(customers.id))
    .limit(run.cap + 1);
  return postNotices(
    run,
    capRows(run, 'procuration', rows).map((r) => {
      const left = daysBetweenIso(today, r.expiresAt!);
      return {
        key: r.key,
        userId: r.responsibleId,
        customerId: r.id,
        title: left < 0 ? 'Procuração eletrônica venceu' : `Procuração eletrônica vence ${daysText(left)}`,
        body:
          left < 0
            ? `${r.name}: a procuração eletrônica venceu em ${formatDate(r.expiresAt)}. Peça ao cliente uma nova procuração no eCAC.`
            : `${r.name}: a procuração eletrônica vence em ${formatDate(r.expiresAt)}. Peça ao cliente a renovação no eCAC.`,
        link: `/clientes/${r.id}/ecac`,
      };
    }),
  );
}

/** Certificado A1 do procurador perto de vencer (30, 15, 7 e 1 dia). */
async function certificateNotices(run: Run): Promise<number> {
  const { ctx, officeId, today } = run;
  const days = sql<number>`(${procurators.certificateExpiresAt} - ${today}::date)`;
  const key = markKey('certificado', sql`${procurators.id}`, sql`${procurators.certificateExpiresAt}`, stepSql(days, EXPIRY_STEPS));
  const rows = await ctx.db
    .select({ id: procurators.id, name: procurators.name, expiresAt: procurators.certificateExpiresAt, userId: users.id, key })
    .from(procurators)
    .leftJoin(users, and(eq(users.id, procurators.userId), eq(users.isActive, true)))
    .where(
      and(
        eq(procurators.officeId, officeId),
        gte(procurators.certificateExpiresAt, today),
        lte(procurators.certificateExpiresAt, addDaysIso(today, EXPIRY_STEPS[EXPIRY_STEPS.length - 1])),
        unmarked(ctx.db, officeId, key),
      ),
    )
    .orderBy(asc(procurators.certificateExpiresAt), asc(procurators.id))
    .limit(run.cap + 1);
  return postNotices(
    run,
    capRows(run, 'certificate', rows).map((r) => ({
      key: r.key,
      userId: r.userId,
      title: `Certificado A1 vence ${daysText(daysBetweenIso(today, r.expiresAt!))}`,
      body: `O certificado digital de ${r.name} vence em ${formatDate(r.expiresAt)}. Envie o novo certificado em Meu escritório › Procuradores para o robô do eCAC não parar.`,
      link: '/admin/procuradores',
    })),
  );
}

/** Quota do DARF que vence hoje e não consta como paga. */
async function darfTodayNotices(run: Run): Promise<number> {
  const { ctx, officeId, today } = run;
  const key = markKey('darf-hoje', sql`${darfs.id}`, sql`${darfs.dueDate}`);
  const rows = await ctx.db
    .select({ darf: darfs, customerId: customers.id, name: customers.name, year: declarations.exerciseYear, responsibleId: users.id, key })
    .from(darfs)
    .innerJoin(customers, eq(customers.id, darfs.customerId))
    .leftJoin(declarations, eq(declarations.id, darfs.declarationId))
    .leftJoin(users, activeResponsible)
    .where(and(eq(darfs.officeId, officeId), liveCustomer(officeId), openDarf, eq(darfs.dueDate, today), unmarked(ctx.db, officeId, key)))
    .orderBy(asc(darfs.id))
    .limit(run.cap + 1);
  if (!rows.length) return 0;
  const selic = await selicTable(ctx.db);
  return postNotices(
    run,
    capRows(run, 'darfToday', rows).map((r) => ({
      key: r.key,
      userId: r.responsibleId,
      customerId: r.customerId,
      title: 'DARF vence hoje',
      body: `${r.name}: a quota ${r.darf.quotaNumber} do IRPF${r.year ? ` ${r.year}` : ''}, de ${darfValueText(r.darf, selic)}, vence hoje e não consta como paga.`,
      link: `/clientes/${r.customerId}/irpf/darf`,
    })),
  );
}

/** Parcela dos honorários que venceu (ontem, ou há poucos dias se a rodada não rodou) e segue em aberto. */
async function installmentOverdueNotices(run: Run): Promise<number> {
  const { ctx, officeId, today } = run;
  const key = markKey('parcela-vencida', sql`${installments.id}`, sql`${installments.dueDate}`);
  const rows = await ctx.db
    .select({ inst: installments, customerId: customers.id, name: customers.name, total: installmentCount, responsibleId: users.id, key })
    .from(installments)
    .innerJoin(billings, eq(billings.id, installments.billingId))
    .innerJoin(customers, eq(customers.id, billings.customerId))
    .leftJoin(users, activeResponsible)
    .where(
      and(eq(installments.officeId, officeId), liveCustomer(officeId), openInstallment, gte(installments.dueDate, addDaysIso(today, -CATCH_UP_DAYS)), lt(installments.dueDate, today), unmarked(ctx.db, officeId, key)),
    )
    .orderBy(asc(installments.dueDate), asc(installments.id))
    .limit(run.cap + 1);
  return postNotices(
    run,
    capRows(run, 'installmentOverdue', rows).map((r) => ({
      key: r.key,
      userId: r.responsibleId,
      customerId: r.customerId,
      title: 'Honorários vencidos',
      body: `${r.name}: a parcela ${r.inst.number}/${Math.max(r.total, r.inst.number)} dos honorários, de ${formatMoney(r.inst.amountCents)}, venceu em ${formatDate(r.inst.dueDate)} e continua em aberto.`,
      link: `/clientes/${r.customerId}/irpf/orcamento`,
    })),
  );
}

/** Link do checklist que expira nos próximos dias sem o cliente ter finalizado. */
async function checklistLinkNotices(run: Run): Promise<number> {
  const { ctx, officeId, today, now } = run;
  // até o fim do dia (Brasília) em que faltam CHECKLIST_LINK_DAYS dias
  const until = new Date(`${addDaysIso(today, CHECKLIST_LINK_DAYS + 1)}T00:00:00-03:00`);
  const key = markKey('checklist-link', sql`${checklists.id}`, sql`extract(epoch from ${checklists.accessExpiresAt})::bigint`);
  const rows = await ctx.db
    .select({ customerId: customers.id, name: customers.name, year: declarations.exerciseYear, expiresAt: checklists.accessExpiresAt, responsibleId: users.id, key })
    .from(checklists)
    .innerJoin(declarations, eq(declarations.id, checklists.declarationId))
    .innerJoin(customers, eq(customers.id, declarations.customerId))
    .leftJoin(users, activeResponsible)
    .where(and(eq(checklists.officeId, officeId), liveCustomer(officeId), isNull(checklists.finishedAt), gt(checklists.accessExpiresAt, now), lt(checklists.accessExpiresAt, until), unmarked(ctx.db, officeId, key)))
    .orderBy(asc(checklists.accessExpiresAt), asc(checklists.id))
    .limit(run.cap + 1);
  return postNotices(
    run,
    capRows(run, 'checklistLink', rows).map((r) => {
      const expiresDay = todayIso(r.expiresAt!);
      return {
        key: r.key,
        userId: r.responsibleId,
        customerId: r.customerId,
        title: `Link do checklist expira ${daysText(daysBetweenIso(today, expiresDay))}`,
        body: `${r.name}: o link do checklist ${r.year} expira em ${formatDate(expiresDay)} e o cliente ainda não finalizou. Envie o checklist de novo para renovar o acesso.`,
        link: `/clientes/${r.customerId}/irpf/documentacao`,
      };
    }),
  );
}

/**
 * Até quando o escritório está coberto: a maior expiração entre os contratos vigentes, estendida
 * pelos contratos ativos que começam sem intervalo (renovação já cadastrada). Sem contrato
 * vigente, a expiração mais recente (o escritório está só para consulta). `null` sem contratos.
 */
export function contractCoverageEnd(all: Pick<ContractRow, 'status' | 'startsAt' | 'expiresAt'>[], today: string): string | null {
  const live = all.filter((c) => c.status === 'active').map((c) => ({ startsAt: String(c.startsAt), expiresAt: String(c.expiresAt) }));
  const current = live.filter((c) => c.startsAt <= today && c.expiresAt >= today);
  const pool = current.length ? current : live.filter((c) => c.expiresAt < today);
  if (!pool.length) return null;
  let end = pool.map((c) => c.expiresAt).sort().at(-1)!;
  for (let i = 0; i < live.length; i++) {
    const next = live.filter((c) => c.startsAt <= addDaysIso(end, 1) && c.expiresAt > end).map((c) => c.expiresAt).sort().at(-1);
    if (!next) break;
    end = next;
  }
  return end;
}

/** Contrato do escritório perto de vencer (15, 7 e 1 dia) e no vencimento, para o dono da conta. */
async function contractNotices(run: Run): Promise<number> {
  const { ctx, officeId, today } = run;
  const end = contractCoverageEnd((await planStatus(ctx.db, officeId, today)).all, today);
  if (!end) return 0;
  const left = daysBetweenIso(today, end);
  if (left > CONTRACT_STEPS[CONTRACT_STEPS.length - 1] || left < -CATCH_UP_DAYS) return 0;
  const step = left <= 0 ? 0 : CONTRACT_STEPS.find((s) => left <= s)!;
  const owners = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.officeId, officeId), eq(users.isOwner, true), eq(users.isActive, true)));
  const targets: (string | null)[] = owners.length ? owners.map((o) => o.id) : [null];
  return postNotices(
    run,
    targets.map((userId) => ({
      key: `contrato:${end}:${step}:${userId ?? 'escritorio'}`,
      userId,
      title: left < 0 ? 'Contrato do Verifco venceu' : `Contrato do Verifco vence ${daysText(left)}`,
      body:
        left < 0
          ? `O contrato do escritório venceu em ${formatDate(end)}: o sistema está só para consulta. Fale com o suporte do Verifco para renovar.`
          : `O contrato do escritório vence em ${formatDate(end)}. Depois dessa data, o sistema fica só para consulta. Fale com o suporte do Verifco para renovar.`,
      link: '/admin/contratos',
    })),
  );
}

// ---------------------------------------------------------------------------
// Rodada
// ---------------------------------------------------------------------------

/**
 * Uma rodada de lembretes do escritório. Pode ser repetida à vontade (no mesmo dia ou depois):
 * as marcas garantem que cada aviso sai uma vez. Uma categoria com erro não impede as outras; o
 * primeiro erro é relançado no fim, para a fila repetir a rodada.
 */
export async function runDailyReminders(ctx: AppContext, officeId: string, opts: ReminderOptions = {}): Promise<ReminderRunResult> {
  const now = opts.now ?? (opts.today ? new Date(`${opts.today}T08:00:00-03:00`) : new Date());
  const today = opts.today ?? todayIso(now);
  const result: ReminderRunResult = {
    day: today,
    emails: { darfCustomer: 0, installmentCustomer: 0, installmentOverdueCustomer: 0 },
    notices: { procuration: 0, certificate: 0, darfToday: 0, installmentOverdue: 0, checklistLink: 0, contract: 0 },
    capped: [],
  };
  const run: Run = { ctx, officeId, today, now, cap: Math.max(1, opts.cap ?? REMINDER_CAP), result };
  const settings = await getOfficeSettings(ctx.db, officeId);
  const errors: unknown[] = [];
  const guard = async (category: ReminderCategory, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(err);
      logRoutine(ctx, 'warn', 'Lembretes: categoria falhou nesta rodada', { officeId, category, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const email = (category: ReminderEmailCategory, fn: () => Promise<number>) => guard(category, async () => void (result.emails[category] = await fn()));
  const notice = (category: ReminderNoticeCategory, fn: () => Promise<number>) => guard(category, async () => void (result.notices[category] = await fn()));

  if (settings.reminderDarfCustomerDays > 0) await email('darfCustomer', () => darfCustomerReminders(run, settings.reminderDarfCustomerDays));
  if (settings.reminderInstallmentCustomerDays > 0) {
    await email('installmentCustomer', () =>
      installmentEmails(run, 'installmentCustomer', 'installment_reminder', 'parcela-cliente', addDaysIso(today, 1), addDaysIso(today, settings.reminderInstallmentCustomerDays)),
    );
  }
  if (settings.reminderInstallmentOverdueCustomer) {
    await email('installmentOverdueCustomer', () =>
      installmentEmails(run, 'installmentOverdueCustomer', 'installment_overdue', 'parcela-vencida-cliente', addDaysIso(today, -INSTALLMENT_OVERDUE_DAYS - CATCH_UP_DAYS), addDaysIso(today, -INSTALLMENT_OVERDUE_DAYS)),
    );
  }
  if (settings.reminderOfficeDigest) {
    await notice('procuration', () => procurationNotices(run));
    await notice('certificate', () => certificateNotices(run));
    await notice('darfToday', () => darfTodayNotices(run));
    await notice('installmentOverdue', () => installmentOverdueNotices(run));
    await notice('checklistLink', () => checklistLinkNotices(run));
    await notice('contract', () => contractNotices(run));
  }
  if (errors.length) throw errors[0];
  return result;
}
