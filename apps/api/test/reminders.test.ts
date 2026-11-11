/**
 * Lembretes diários (job `reminders.daily`): cada aviso sai uma vez, as preferências do escritório
 * valem, um escritório não vê nada do outro e cada categoria respeita o limite por rodada.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { addDaysIso, todayIso } from '@verifco/shared';
import { createContext } from '../src/bootstrap';
import {
  billings,
  budgets,
  checklists,
  contracts,
  customers,
  darfs,
  declarationItems,
  declarations,
  deliveries,
  installments,
  jobs,
  notifications,
  offices,
  procurators,
  reminderMarks,
  taxIndices,
  type OfficeSettings,
} from '../src/db/schema';
import { MemoryProviders } from '../src/integrations/providers';
import {
  RECOMPUTE_TOTALS_JOB,
  RECOMPUTE_TOTALS_MARK,
  REMINDERS_DAILY,
  REMINDERS_ENSURE,
  enqueueTotalsRecompute,
  ensureReminderSchedules,
  nextReminderRun,
  scheduleDailyReminders,
  scheduleReminderEnsure,
  scheduleRoutines,
} from '../src/modules/reminders/jobs';
import { contractCoverageEnd, runDailyReminders } from '../src/modules/reminders/service';
import { recomputeStoredTotals, refreshDeclaration } from '../src/services/declarations';
import { SELIC_JOB } from '../src/services/indices';
import { createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
  // Selic de out/2026, que a tabela fixa não tem: a quota 7 que vence em novembro sai com o valor atualizado
  await env.ctx.db.insert(taxIndices).values({ code: 'selic', period: '2026-10', value: '1.05' });
});
afterAll(async () => env.close());

/** Terça-feira; as datas dos testes são relativas a este dia. */
const TODAY = '2026-11-10';
const day = (n: number) => addDaysIso(TODAY, n);

let seq = 0;
const cpf = () => `7${String(++seq).padStart(10, '0')}`;

type Office = Awaited<ReturnType<typeof registerOffice>>;

/** Escritório novo sem o contrato de avaliação do cadastro (os testes de contrato cadastram os seus). */
async function newOffice(): Promise<Office> {
  const office = await registerOffice(env);
  await env.ctx.db.delete(contracts).where(eq(contracts.officeId, office.officeId));
  return office;
}

async function settings(officeId: string, patch: OfficeSettings) {
  const office = await env.ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId) });
  await env.ctx.db.update(offices).set({ settings: { ...office!.settings, ...patch } }).where(eq(offices.id, officeId));
}

async function customer(office: Office, name: string, data: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await env.ctx.db
    .insert(customers)
    .values({ officeId: office.officeId, name, cpfCnpj: cpf(), email: `${name.toLowerCase().replace(/\W+/g, '.')}@ex.com`, ...data })
    .returning();
  return row;
}

async function darf(office: Office, customerId: string, data: { dueDate: string; quotaNumber?: number; valueCents?: number; source?: string; paidAt?: string; status?: string; year?: number }) {
  const year = data.year ?? 2026;
  const existing = await env.ctx.db.query.declarations.findFirst({ where: and(eq(declarations.customerId, customerId), eq(declarations.exerciseYear, year)) });
  const decl = existing ?? (await env.ctx.db.insert(declarations).values({ officeId: office.officeId, customerId, exerciseYear: year }).returning())[0];
  const [row] = await env.ctx.db
    .insert(darfs)
    .values({
      officeId: office.officeId,
      customerId,
      declarationId: decl.id,
      quotaNumber: data.quotaNumber ?? 1,
      valueCents: data.valueCents ?? 100_000,
      dueDate: data.dueDate,
      source: data.source ?? 'manual',
      paidAt: data.paidAt ?? null,
      status: data.status ?? 'open',
    })
    .returning();
  return row;
}

/** Cobrança com as parcelas dadas (vencimento e, se for o caso, situação e link). */
async function billing(office: Office, customerId: string, parts: { dueDate: string; amountCents?: number; status?: string; externalUrl?: string; paidAt?: string }[]) {
  const total = parts.reduce((a, p) => a + (p.amountCents ?? 45_000), 0);
  const [budget] = await env.ctx.db.insert(budgets).values({ officeId: office.officeId, customerId, exerciseYear: 2026, status: 'approved', amountCents: total, totalCents: total, installments: parts.length }).returning();
  const [bill] = await env.ctx.db.insert(billings).values({ officeId: office.officeId, budgetId: budget.id, customerId, totalCents: total }).returning();
  return env.ctx.db
    .insert(installments)
    .values(
      parts.map((p, i) => ({
        officeId: office.officeId,
        billingId: bill.id,
        number: i + 1,
        dueDate: p.dueDate,
        amountCents: p.amountCents ?? 45_000,
        status: p.status ?? 'open',
        paidAt: p.paidAt ?? null,
        externalUrl: p.externalUrl ?? null,
        canceledAt: p.status === 'canceled' ? new Date() : null,
      })),
    )
    .returning();
}

async function checklist(office: Office, customerId: string, data: { expiresAt: Date; finished?: boolean }) {
  const year = 2026;
  const existing = await env.ctx.db.query.declarations.findFirst({ where: and(eq(declarations.customerId, customerId), eq(declarations.exerciseYear, year)) });
  const decl = existing ?? (await env.ctx.db.insert(declarations).values({ officeId: office.officeId, customerId, exerciseYear: year }).returning())[0];
  const token = crypto.randomUUID();
  const [row] = await env.ctx.db
    .insert(checklists)
    .values({ officeId: office.officeId, declarationId: decl.id, accessTokenHash: `hash-${token}`, accessCodeHash: 'codigo', accessExpiresAt: data.expiresAt, sentAt: new Date(), finishedAt: data.finished ? new Date() : null })
    .returning();
  return row;
}

const bell = (officeId: string) => env.ctx.db.select().from(notifications).where(eq(notifications.officeId, officeId)).orderBy(asc(notifications.createdAt), asc(notifications.title));
const emails = (officeId: string) => env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId)).orderBy(asc(deliveries.createdAt));
const marks = (officeId: string) => env.ctx.db.select().from(reminderMarks).where(eq(reminderMarks.officeId, officeId));
const ZERO = {
  emails: { darfCustomer: 0, installmentCustomer: 0, installmentOverdueCustomer: 0 },
  notices: { procuration: 0, certificate: 0, darfToday: 0, installmentOverdue: 0, checklistLink: 0, contract: 0 },
  capped: [],
};

/** Um escritório com um caso de cada categoria no dia TODAY. */
async function fullOffice() {
  const office = await newOffice();
  const { userId } = await createEmployee(env, office.api, ['customer.list']);
  // cliente: quota 7 (gerada, só o principal) vence em 3 dias; outra quota vence hoje
  const ana = await customer(office, 'Ana Lima', { responsibleUserId: userId });
  await darf(office, ana.id, { dueDate: day(3), quotaNumber: 7, source: 'generated' });
  await darf(office, ana.id, { dueDate: TODAY, quotaNumber: 6, valueCents: 55_000 });
  await darf(office, ana.id, { dueDate: day(4), quotaNumber: 8 });
  // honorários: parcela 1 vencida há 3 dias, parcela 2 vencida ontem, parcela 3 vence em 2 dias
  const bruno = await customer(office, 'Bruno Reis');
  await billing(office, bruno.id, [{ dueDate: day(-3) }, { dueDate: day(-1) }, { dueDate: day(2), externalUrl: 'https://pagar.example/abc' }]);
  // procurações: 30, 15, 7 e 1 dia, e a que venceu ontem
  const proc = [30, 15, 7, 1, -1];
  for (const n of proc) await customer(office, `Procuração ${n}`, { email: null, procurationStatus: 'valid', procurationExpiresAt: day(n) });
  // certificado A1 do procurador: 15 dias
  await env.ctx.db.insert(procurators).values({ officeId: office.officeId, name: 'Escritório Ltda', cpfCnpj: '11222333000181', authType: 'certificate', certificateExpiresAt: day(15) });
  // link do checklist expira em 3 dias (às 20h de Brasília) e o cliente não finalizou
  const carla = await customer(office, 'Carla Dias', { email: null });
  await checklist(office, carla.id, { expiresAt: new Date(`${day(3)}T20:00:00-03:00`) });
  // contrato do escritório vence em 7 dias
  await env.ctx.db.insert(contracts).values({ officeId: office.officeId, name: 'Plano 2026', year: 2026, startsAt: '2026-01-01', expiresAt: day(7) });
  return { office, ana, bruno, carla, employeeId: userId };
}

describe('lembretes diários', () => {
  it('cada categoria sai uma vez: repetir no mesmo dia ou no dia seguinte não avisa de novo', async () => {
    const { office, ana, bruno, carla, employeeId } = await fullOffice();
    const first = await runDailyReminders(env.ctx, office.officeId, { today: TODAY });
    expect(first).toEqual({
      day: TODAY,
      emails: { darfCustomer: 1, installmentCustomer: 1, installmentOverdueCustomer: 1 },
      // as duas parcelas vencidas nos últimos dias (a rodada cobre os dias em que não rodou)
      notices: { procuration: 5, certificate: 1, darfToday: 1, installmentOverdue: 2, checklistLink: 1, contract: 1 },
      capped: [],
    });

    // e-mails ao cliente, com o template e os valores de cada caso
    const sent = await emails(office.officeId);
    expect(sent.map((d) => [d.templateKey, d.customerId, d.channel]).sort()).toEqual(
      [
        ['darf_reminder', ana.id, 'email'],
        ['installment_overdue', bruno.id, 'email'],
        ['installment_reminder', bruno.id, 'email'],
      ].sort(),
    );
    const darfMail = sent.find((d) => d.templateKey === 'darf_reminder')!;
    expect(darfMail.subject).toBe(`Lembrete: DARF do Imposto de Renda vence em 13/11/2026`);
    // quota 7 com a Selic do banco (jun a out/2026 = 5,56%) + 1%: R$ 1.000,00 + 6,56%
    expect(darfMail.body).toMatch(/A quota 7 do seu Imposto de Renda 2026, no valor de <strong>R\$\s1\.065,60 \(principal de R\$\s1\.000,00 \+ juros de 6,56%: Selic acumulada \+ 1%\)<\/strong>, vence em <strong>13\/11\/2026<\/strong>/);
    expect(darfMail.body).toContain(`${env.ctx.config.WEB_URL}/portal`);
    const reminder = sent.find((d) => d.templateKey === 'installment_reminder')!;
    expect(reminder.body).toMatch(/A parcela 3\/3 dos honorários, no valor de <strong>R\$\s450,00<\/strong>, vence em <strong>12\/11\/2026<\/strong>/);
    expect(reminder.body).toContain('https://pagar.example/abc');
    const overdue = sent.find((d) => d.templateKey === 'installment_overdue')!;
    expect(overdue.subject).toBe('Honorários em aberto desde 07/11/2026');
    expect(overdue.body).toContain('parcela 1/3');
    await env.ctx.jobs.drain();
    expect(env.providers.sentEmails.filter((e) => e.officeId === office.officeId && e.to.endsWith('@ex.com')).map((e) => e.to).sort()).toEqual(['ana.lima@ex.com', 'bruno.reis@ex.com', 'bruno.reis@ex.com']);

    // avisos no sino, para o responsável pelo cliente quando há um
    const notes = await bell(office.officeId);
    expect(notes.map((n) => n.title).sort()).toEqual(
      [
        'Procuração eletrônica vence em 30 dias',
        'Procuração eletrônica vence em 15 dias',
        'Procuração eletrônica vence em 7 dias',
        'Procuração eletrônica vence amanhã',
        'Procuração eletrônica venceu',
        'Certificado A1 vence em 15 dias',
        'DARF vence hoje',
        'Honorários vencidos',
        'Honorários vencidos',
        'Link do checklist expira em 3 dias',
        'Contrato do Verifco vence em 7 dias',
      ].sort(),
    );
    const darfToday = notes.find((n) => n.title === 'DARF vence hoje')!;
    expect(darfToday).toMatchObject({ userId: employeeId, customerId: ana.id, link: `/clientes/${ana.id}/irpf/darf` });
    expect(darfToday.body).toMatch(/^Ana Lima: a quota 6 do IRPF 2026, de R\$\s550,00, vence hoje e não consta como paga\.$/);
    const fees = notes.filter((n) => n.title === 'Honorários vencidos');
    expect(fees[0]).toMatchObject({ userId: null, customerId: bruno.id, link: `/clientes/${bruno.id}/irpf/orcamento` });
    expect(fees.map((n) => /parcela (\d\/3)/.exec(n.body!)?.[1]).sort()).toEqual(['1/3', '2/3']);
    expect(fees.find((n) => n.body!.includes('2/3'))!.body).toMatch(/^Bruno Reis: a parcela 2\/3 dos honorários, de R\$\s450,00, venceu em 09\/11\/2026 e continua em aberto\.$/);
    expect(notes.find((n) => n.title === 'Link do checklist expira em 3 dias')).toMatchObject({ customerId: carla.id, link: `/clientes/${carla.id}/irpf/documentacao` });
    // o contrato vai para o dono da conta
    expect(notes.find((n) => n.title === 'Contrato do Verifco vence em 7 dias')).toMatchObject({ userId: office.userId, customerId: null, link: '/admin/contratos' });
    expect(notes.find((n) => n.title === 'Certificado A1 vence em 15 dias')!.body).toContain('Escritório Ltda');

    // de novo no mesmo dia: nada
    expect(await runDailyReminders(env.ctx, office.officeId, { today: TODAY })).toEqual({ day: TODAY, ...ZERO });
    expect(await emails(office.officeId)).toHaveLength(3);
    expect(await bell(office.officeId)).toHaveLength(11);

    // no dia seguinte: só o que entrou na janela agora (a quota que vence em 3 dias a partir de amanhã)
    const next = await runDailyReminders(env.ctx, office.officeId, { today: day(1) });
    expect(next).toEqual({ day: day(1), ...ZERO, emails: { ...ZERO.emails, darfCustomer: 1 } });
    expect(await runDailyReminders(env.ctx, office.officeId, { today: day(1) })).toEqual({ day: day(1), ...ZERO });
    expect(await bell(office.officeId)).toHaveLength(11);

    // oito dias depois (sem rodada no meio): a procuração dos 15 dias chega aos 7 e as duas que
    // venceram no intervalo são avisadas como vencidas
    const later = await runDailyReminders(env.ctx, office.officeId, { today: day(8) });
    expect(later.notices.procuration).toBe(3);
    const titles = async (title: string) => (await bell(office.officeId)).filter((n) => n.title === title).length;
    expect(await titles('Procuração eletrônica vence em 7 dias')).toBe(2);
    expect(await titles('Procuração eletrônica venceu')).toBe(3);
    // a parcela vencida há mais de 3 dias, que ainda não tinha sido cobrada, sai agora (uma vez)
    expect(later.emails.installmentOverdueCustomer).toBe(2);
    // aos 15 dias: a dos 30 chega aos 15 e a dos 15 vence hoje; depois, só o aviso de vencida
    expect((await runDailyReminders(env.ctx, office.officeId, { today: day(15) })).notices.procuration).toBe(2);
    expect(await titles('Procuração eletrônica vence hoje')).toBe(1);
    expect((await runDailyReminders(env.ctx, office.officeId, { today: day(16) })).notices.procuration).toBe(1);
    expect((await runDailyReminders(env.ctx, office.officeId, { today: day(17) })).notices.procuration).toBe(0);
  });

  it('não avisa de quota paga, parcela paga ou cancelada, checklist finalizado, cliente sem e-mail ou excluído', async () => {
    const office = await newOffice();
    const noEmail = await customer(office, 'Sem Email', { email: null });
    await darf(office, noEmail.id, { dueDate: day(2) });
    await billing(office, noEmail.id, [{ dueDate: day(1) }]);
    const blank = await customer(office, 'Email Vazio', { email: '  ' });
    await darf(office, blank.id, { dueDate: day(2) });
    const deleted = await customer(office, 'Excluído', { deletedAt: new Date(), procurationStatus: 'valid', procurationExpiresAt: day(7) });
    await darf(office, deleted.id, { dueDate: day(2) });
    await darf(office, deleted.id, { dueDate: TODAY, quotaNumber: 2 });
    const paid = await customer(office, 'Tudo Pago');
    await darf(office, paid.id, { dueDate: day(2), paidAt: day(-1), status: 'paid' });
    await darf(office, paid.id, { dueDate: TODAY, quotaNumber: 2, status: 'paid' });
    await billing(office, paid.id, [
      { dueDate: day(1), status: 'paid', paidAt: day(-2) },
      { dueDate: day(-3), status: 'canceled' },
      { dueDate: day(-1), status: 'paid', paidAt: day(-1) },
    ]);
    await checklist(office, paid.id, { expiresAt: new Date(`${day(2)}T12:00:00-03:00`), finished: true });
    // link já expirado, ou que expira só daqui a 10 dias: fora do aviso
    const other = await customer(office, 'Outro Checklist');
    await checklist(office, other.id, { expiresAt: new Date(`${day(10)}T12:00:00-03:00`) });
    // procuração sem validade útil: inválida, ou de cliente inativo
    await customer(office, 'Procuração Inválida', { procurationStatus: 'invalid', procurationExpiresAt: day(7) });
    await customer(office, 'Cliente Inativo', { status: 'inactive', procurationStatus: 'valid', procurationExpiresAt: day(7) });
    // contrato que vence em 40 dias, e um renovado sem intervalo
    await env.ctx.db.insert(contracts).values([
      { officeId: office.officeId, name: 'Plano 2026', year: 2026, startsAt: '2026-01-01', expiresAt: day(5) },
      { officeId: office.officeId, name: 'Plano 2027', year: 2027, startsAt: day(6), expiresAt: day(370) },
    ]);
    const res = await runDailyReminders(env.ctx, office.officeId, { today: TODAY });
    expect(res).toEqual({ day: TODAY, ...ZERO });
    expect(await emails(office.officeId)).toHaveLength(0);
    expect(await bell(office.officeId)).toHaveLength(0);
    expect(await marks(office.officeId)).toHaveLength(0);
  });

  it('respeita as preferências: dias configurados, 0 desliga e cada chave vale por si', async () => {
    const office = await newOffice();
    const c = await customer(office, 'Dora Prazo', { procurationStatus: 'valid', procurationExpiresAt: day(7) });
    await darf(office, c.id, { dueDate: day(5) });
    await billing(office, c.id, [{ dueDate: day(-3) }, { dueDate: day(4) }]);

    // tudo desligado: nenhuma consulta de aviso, nenhuma marca
    await settings(office.officeId, { reminderDarfCustomerDays: 0, reminderInstallmentCustomerDays: 0, reminderInstallmentOverdueCustomer: false, reminderOfficeDigest: false });
    expect(await runDailyReminders(env.ctx, office.officeId, { today: TODAY })).toEqual({ day: TODAY, ...ZERO });
    expect(await marks(office.officeId)).toHaveLength(0);

    // padrão (3 e 2 dias): a quota em 5 dias e a parcela em 4 ainda não entram
    await settings(office.officeId, { reminderDarfCustomerDays: 3, reminderInstallmentCustomerDays: 2 });
    expect(await runDailyReminders(env.ctx, office.officeId, { today: TODAY })).toEqual({ day: TODAY, ...ZERO });

    // 5 dias para o DARF: entra; a parcela continua de fora
    await settings(office.officeId, { reminderDarfCustomerDays: 5 });
    expect((await runDailyReminders(env.ctx, office.officeId, { today: TODAY })).emails).toEqual({ darfCustomer: 1, installmentCustomer: 0, installmentOverdueCustomer: 0 });
    await settings(office.officeId, { reminderInstallmentCustomerDays: 4 });
    expect((await runDailyReminders(env.ctx, office.officeId, { today: TODAY })).emails).toEqual({ darfCustomer: 0, installmentCustomer: 1, installmentOverdueCustomer: 0 });
    await settings(office.officeId, { reminderInstallmentOverdueCustomer: true });
    expect((await runDailyReminders(env.ctx, office.officeId, { today: TODAY })).emails).toEqual({ darfCustomer: 0, installmentCustomer: 0, installmentOverdueCustomer: 1 });
    expect(await bell(office.officeId)).toHaveLength(0);

    // avisos do escritório ligados: saem só os do sino
    await settings(office.officeId, { reminderOfficeDigest: true });
    const res = await runDailyReminders(env.ctx, office.officeId, { today: TODAY });
    expect(res.emails).toEqual(ZERO.emails);
    expect(res.notices).toEqual({ ...ZERO.notices, procuration: 1, installmentOverdue: 1 });
    expect((await emails(office.officeId)).map((d) => d.templateKey).sort()).toEqual(['darf_reminder', 'installment_overdue', 'installment_reminder']);
  });

  it('um escritório não recebe nem marca nada do outro', async () => {
    const a = await fullOffice();
    const b = await fullOffice();
    const res = await runDailyReminders(env.ctx, a.office.officeId, { today: TODAY });
    expect(res.emails).toEqual({ darfCustomer: 1, installmentCustomer: 1, installmentOverdueCustomer: 1 });
    expect(await emails(b.office.officeId)).toHaveLength(0);
    expect(await bell(b.office.officeId)).toHaveLength(0);
    expect(await marks(b.office.officeId)).toHaveLength(0);
    const idsA = new Set((await env.ctx.db.select({ id: customers.id }).from(customers).where(eq(customers.officeId, a.office.officeId))).map((c) => c.id));
    expect((await emails(a.office.officeId)).every((d) => idsA.has(d.customerId!))).toBe(true);
    expect((await bell(a.office.officeId)).every((n) => !n.customerId || idsA.has(n.customerId))).toBe(true);
    // pela API, cada dono vê só os avisos do próprio escritório
    expect((await b.office.api.get('/api/notifications')).body.filter((n: any) => /vence|venc/i.test(n.title))).toHaveLength(0);
    expect((await a.office.api.get('/api/notifications')).body.some((n: any) => n.title === 'Contrato do Verifco vence em 7 dias')).toBe(true);

    // o outro escritório recebe os seus quando a rodada dele roda
    const resB = await runDailyReminders(env.ctx, b.office.officeId, { today: TODAY });
    expect(resB.emails).toEqual(res.emails);
    expect(resB.notices).toEqual(res.notices);
    expect(await emails(a.office.officeId)).toHaveLength(3);
  });

  it('limita cada categoria por rodada e manda o restante nas rodadas seguintes', async () => {
    const office = await newOffice();
    for (let i = 0; i < 5; i++) {
      const c = await customer(office, `Lote ${i}`, { procurationStatus: 'valid', procurationExpiresAt: day(7) });
      await darf(office, c.id, { dueDate: day(i < 2 ? 1 : 2) });
    }
    const first = await runDailyReminders(env.ctx, office.officeId, { today: TODAY, cap: 2 });
    expect(first.emails.darfCustomer).toBe(2);
    expect(first.notices.procuration).toBe(2);
    expect(first.capped).toEqual(['darfCustomer', 'procuration']);
    // os de vencimento mais próximo saem primeiro
    const firstBatch = await env.ctx.db.select({ subject: deliveries.subject }).from(deliveries).where(eq(deliveries.officeId, office.officeId));
    expect(firstBatch.every((d) => d.subject!.includes(day(1).split('-').reverse().join('/')))).toBe(true);

    const second = await runDailyReminders(env.ctx, office.officeId, { today: TODAY, cap: 2 });
    expect(second.emails.darfCustomer).toBe(2);
    expect(second.capped).toEqual(['darfCustomer', 'procuration']);
    const third = await runDailyReminders(env.ctx, office.officeId, { today: TODAY, cap: 2 });
    expect(third.emails.darfCustomer).toBe(1);
    expect(third.notices.procuration).toBe(1);
    expect(third.capped).toEqual([]);
    expect(await runDailyReminders(env.ctx, office.officeId, { today: TODAY, cap: 2 })).toEqual({ day: TODAY, ...ZERO });
    // cada cliente recebeu um e-mail só
    const all = await emails(office.officeId);
    expect(all).toHaveLength(5);
    expect(new Set(all.map((d) => d.customerId)).size).toBe(5);
    expect(await bell(office.officeId)).toHaveLength(5);
  });

  it('contrato: avisa aos 15, 7 e 1 dia e no vencimento; a renovação sem intervalo adia o aviso', async () => {
    const c = (startsAt: string, expiresAt: string, status = 'active') => ({ status, startsAt, expiresAt });
    expect(contractCoverageEnd([], TODAY)).toBeNull();
    expect(contractCoverageEnd([c('2026-01-01', day(5))], TODAY)).toBe(day(5));
    expect(contractCoverageEnd([c('2026-01-01', day(5)), c(day(6), day(300))], TODAY)).toBe(day(300));
    // renovação com intervalo ou cancelada não cobre
    expect(contractCoverageEnd([c('2026-01-01', day(5)), c(day(9), day(300))], TODAY)).toBe(day(5));
    expect(contractCoverageEnd([c('2026-01-01', day(5)), c(day(6), day(300), 'cancelled')], TODAY)).toBe(day(5));
    // nenhum vigente: a expiração mais recente
    expect(contractCoverageEnd([c('2025-01-01', day(-400)), c('2026-01-01', day(-2))], TODAY)).toBe(day(-2));

    const office = await newOffice();
    await env.ctx.db.insert(contracts).values({ officeId: office.officeId, name: 'Plano', year: 2026, startsAt: '2026-01-01', expiresAt: day(15) });
    const titles = async () => (await bell(office.officeId)).map((n) => n.title);
    const run = (n: number) => runDailyReminders(env.ctx, office.officeId, { today: day(n) });
    expect((await run(-1)).notices.contract).toBe(0);
    expect((await run(0)).notices.contract).toBe(1);
    expect((await run(1)).notices.contract).toBe(0);
    expect((await run(8)).notices.contract).toBe(1);
    expect((await run(14)).notices.contract).toBe(1);
    expect((await run(15)).notices.contract).toBe(1);
    expect((await run(16)).notices.contract).toBe(0);
    expect(await titles()).toEqual(['Contrato do Verifco vence em 15 dias', 'Contrato do Verifco vence em 7 dias', 'Contrato do Verifco vence amanhã', 'Contrato do Verifco vence hoje']);
  });
});

describe('agendamento da rodada', () => {
  const queued = (officeId: string) => env.ctx.db.select().from(jobs).where(and(eq(jobs.type, REMINDERS_DAILY), eq(jobs.officeId, officeId))).orderBy(asc(jobs.runAt));

  it('às 8h de Brasília, uma na fila por escritório, com chave pelo dia', async () => {
    // 10h de Brasília: a rodada de hoje já passou; 7h: é hoje
    expect(nextReminderRun(new Date('2026-11-10T13:00:00Z')).toISOString()).toBe('2026-11-11T11:00:00.000Z');
    expect(nextReminderRun(new Date('2026-11-10T10:00:00Z')).toISOString()).toBe('2026-11-10T11:00:00.000Z');
    expect(nextReminderRun(new Date('2026-11-10T10:00:00Z'), '2026-11-10').toISOString()).toBe('2026-11-11T11:00:00.000Z');

    const office = await newOffice();
    // o cadastro não agenda nada: quem agenda é a conferência (ao subir e todo dia)
    expect(await queued(office.officeId)).toHaveLength(0);
    const now = new Date('2026-11-10T13:00:00Z');
    const job = await scheduleDailyReminders(env.ctx, office.officeId, { now });
    expect(job).toMatchObject({ status: 'queued', officeId: office.officeId, idempotencyKey: `reminders:${office.officeId}:2026-11-11`, payload: { day: '2026-11-11' } });
    expect(job!.runAt.toISOString()).toBe('2026-11-11T11:00:00.000Z');
    expect((await scheduleDailyReminders(env.ctx, office.officeId, { now }))!.id).toBe(job!.id);
    expect(await queued(office.officeId)).toHaveLength(1);
  });

  it('a conferência agenda os escritórios que ainda não têm rodada (os criados depois) sem duplicar', async () => {
    const a = await newOffice();
    const b = await newOffice();
    await scheduleDailyReminders(env.ctx, a.officeId);
    const before = (await queued(a.officeId))[0];
    expect(await ensureReminderSchedules(env.ctx)).toBeGreaterThanOrEqual(1);
    expect(await queued(a.officeId)).toEqual([before]);
    const [jobB] = await queued(b.officeId);
    expect(jobB).toMatchObject({ status: 'queued', idempotencyKey: `reminders:${b.officeId}:${todayIso(jobB.runAt)}` });
    expect(jobB.runAt.getTime()).toBe(nextReminderRun().getTime());
    expect(await ensureReminderSchedules(env.ctx)).toBe(0);

    // a conferência é um job diário (7h30), que se reagenda
    const now = new Date('2026-11-10T13:00:00Z');
    await env.ctx.db.delete(jobs).where(eq(jobs.type, REMINDERS_ENSURE));
    const ensure = await scheduleReminderEnsure(env.ctx, { now });
    expect(ensure).toMatchObject({ status: 'queued', officeId: null, idempotencyKey: 'reminders-ensure:2026-11-11' });
    expect(ensure!.runAt.toISOString()).toBe('2026-11-11T10:30:00.000Z');
    const c = await newOffice();
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, ensure!.id));
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, ensure!.id) }))!).toMatchObject({ status: 'done', result: { scheduled: 1 } });
    expect(await queued(c.officeId)).toHaveLength(1);
    const chain = await env.ctx.db.select().from(jobs).where(and(eq(jobs.type, REMINDERS_ENSURE), eq(jobs.status, 'queued')));
    expect(chain).toHaveLength(1);
    expect(String(chain[0].payload.day) > '2026-11-11').toBe(true);
  });

  it('a rodada se reagenda para o dia seguinte e não roda duas vezes no mesmo dia', async () => {
    const office = await newOffice();
    const c = await customer(office, 'Eva Hoje');
    await darf(office, c.id, { dueDate: todayIso() });
    const job = (await scheduleDailyReminders(env.ctx, office.officeId))!;
    const runDay = String(job.payload.day);
    // ainda não é hora: a fila não roda a rodada
    await env.ctx.jobs.drain();
    expect((await queued(office.officeId))[0].status).toBe('queued');
    expect(await bell(office.officeId)).toHaveLength(0);

    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, job.id));
    await env.ctx.jobs.drain();
    const rows = await queued(office.officeId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: job.id, status: 'done', result: { notices: { darfToday: 1 } } });
    expect(rows[1]).toMatchObject({ status: 'queued', payload: { day: addDaysIso(runDay, 1) }, idempotencyKey: `reminders:${office.officeId}:${addDaysIso(runDay, 1)}` });
    expect((await bell(office.officeId)).map((n) => n.title)).toEqual(['DARF vence hoje']);

    // a mesma chave do dia devolve a rodada já feita: não há segunda rodada no dia
    const again = await env.ctx.jobs.enqueue(REMINDERS_DAILY, { day: runDay }, { officeId: office.officeId, idempotencyKey: `reminders:${office.officeId}:${runDay}` });
    expect(again).toMatchObject({ id: job.id, status: 'done' });
    expect((await scheduleDailyReminders(env.ctx, office.officeId))!.id).toBe(rows[1].id);

    // escritório bloqueado: a rodada não manda nada, mas a cadeia continua
    await env.ctx.db.update(offices).set({ blockedAt: new Date() }).where(eq(offices.id, office.officeId));
    await darf(office, c.id, { dueDate: todayIso(), quotaNumber: 2 });
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, rows[1].id));
    await env.ctx.jobs.drain();
    const after = await queued(office.officeId);
    expect(after[1]).toMatchObject({ status: 'done', result: { skipped: true } });
    expect(after[2]).toMatchObject({ status: 'queued' });
    expect(await bell(office.officeId)).toHaveLength(1);
  });

  it('ao subir, só a instância que executa a fila agenda as rotinas (uma vez cada)', async () => {
    // a dos testes sobe com RUN_WORKER desligado: o recálculo único e a Selic não estão na fila
    expect(await env.ctx.db.select().from(jobs).where(eq(jobs.type, RECOMPUTE_TOTALS_JOB))).toHaveLength(0);
    expect(await env.ctx.db.select().from(jobs).where(eq(jobs.type, SELIC_JOB))).toHaveLength(0);

    const providers = new MemoryProviders();
    const worker = await createContext({ DATABASE_URL: 'pglite:memory', PLATFORM_DATABASE_URL: 'pglite:memory', NODE_ENV: 'test', RUN_WORKER: true }, { providers, memoryStorage: true });
    try {
      // só as rotinas deste módulo (outros módulos agendam as suas ao subir)
      const mine = [SELIC_JOB, RECOMPUTE_TOTALS_JOB, REMINDERS_ENSURE, REMINDERS_DAILY];
      const routines = async () => (await worker.ctx.db.select().from(jobs)).filter((j) => mine.includes(j.type));
      const rows = await routines();
      // sem escritórios ainda: a conferência diária, a Selic (semanal e a busca inicial) e o recálculo único
      expect(rows.map((j) => j.type).sort()).toEqual([SELIC_JOB, SELIC_JOB, RECOMPUTE_TOTALS_JOB, REMINDERS_ENSURE].sort());
      expect(rows.every((j) => j.officeId === null && j.status === 'queued')).toBe(true);
      // subir de novo (outra instância) não duplica
      await scheduleRoutines(worker.ctx);
      expect(await routines()).toHaveLength(4);
    } finally {
      await worker.close();
    }
  });
});

describe('recálculo único dos totais gravados', () => {
  const item = (officeId: string, declarationId: string, kind: string, valueCents: number, extra: Partial<typeof declarationItems.$inferInsert> = {}) => ({ officeId, declarationId, kind, valueCents, ...extra });

  async function staleDeclaration(office: Office, year: number) {
    const c = await customer(office, `Totais ${year} ${seq}`);
    // totais gravados por uma regra antiga: tudo errado
    const [d] = await env.ctx.db
      .insert(declarations)
      .values({ officeId: office.officeId, customerId: c.id, exerciseYear: year, taxation: 'complete', totalIncomeCents: 1, taxableIncomeCents: 2, assetsTotalCents: 3, cashBalanceCents: 999, updatedAt: new Date('2026-01-15T12:00:00Z') })
      .returning();
    await env.ctx.db.insert(declarationItems).values([
      item(office.officeId, d.id, 'income_pj', 12_000_000, { withheldCents: 1_500_000 }),
      item(office.officeId, d.id, 'income_exempt', 500_000),
      item(office.officeId, d.id, 'asset', 3_000_000, { groupCode: '06', prevValueCents: 1_000_000 }),
    ]);
    return d;
  }

  it('recalcula em lotes com as contas de sempre, só as declarações com linhas, e roda uma vez só', async () => {
    const office = await newOffice();
    const stale = [await staleDeclaration(office, 2024), await staleDeclaration(office, 2025), await staleDeclaration(office, 2026)];
    // sem linhas: os totais gravados não vêm das linhas e ficam como estão
    const c = await customer(office, 'Sem Linhas');
    const [bare] = await env.ctx.db.insert(declarations).values({ officeId: office.officeId, customerId: c.id, exerciseYear: 2023, totalIncomeCents: 7_000_000, assetsTotalCents: 9_000_000 }).returning();

    // em lotes pequenos, do menor id para o maior
    let afterId: string | null = null;
    let rounds = 0;
    let updated = 0;
    for (;;) {
      const r = await recomputeStoredTotals(env.ctx.db, { afterId, limit: 2 });
      updated += r.updated;
      if (!r.lastId) break;
      afterId = r.lastId;
      rounds += 1;
    }
    expect(rounds).toBeGreaterThanOrEqual(2);
    expect(updated).toBeGreaterThanOrEqual(2);
    const fresh = async (id: string) => (await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.id, id) }))!;
    for (const d of stale) {
      const row = await fresh(d.id);
      expect(row).toMatchObject({ totalIncomeCents: 12_500_000, taxableIncomeCents: 12_000_000, exemptIncomeCents: 500_000, withheldTaxCents: 1_500_000, assetsTotalCents: 3_000_000, assetsPrevTotalCents: 1_000_000 });
      expect(row.cashBalanceCents).not.toBe(999);
      expect(row.cashBalanceCents).not.toBeNull();
    }
    // o mesmo saldo que a rotina de sempre (`refreshDeclaration`) grava
    const batchBalance = (await fresh(stale[1].id)).cashBalanceCents;
    expect((await refreshDeclaration(env.ctx, stale[1].id)).cashBalanceCents).toBe(batchBalance);
    expect(await fresh(bare.id)).toMatchObject({ totalIncomeCents: 7_000_000, assetsTotalCents: 9_000_000, cashBalanceCents: null });
    // nada mudou de novo: a segunda passada não grava
    expect((await recomputeStoredTotals(env.ctx.db, { limit: 500 })).updated).toBe(0);

    // o job: enfileirado com chave fixa, roda uma vez por instalação
    await env.ctx.db.update(declarations).set({ totalIncomeCents: 5, cashBalanceCents: 5 }).where(eq(declarations.id, stale[2].id));
    const job = (await enqueueTotalsRecompute(env.ctx))!;
    expect((await enqueueTotalsRecompute(env.ctx))!.id).toBe(job.id);
    expect(await env.ctx.db.select().from(jobs).where(eq(jobs.type, RECOMPUTE_TOTALS_JOB))).toHaveLength(1);
    await env.ctx.jobs.drain();
    const done = (await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, job.id) }))!;
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ updated: 1 });
    const row = await fresh(stale[2].id);
    expect(row.totalIncomeCents).toBe(12_500_000);
    // recálculo de manutenção não conta como edição
    expect(row.updatedAt.toISOString()).toBe('2026-01-15T12:00:00.000Z');

    // subir de novo não roda outra vez: o recálculo concluído deixa a marca nos escritórios
    await env.ctx.db.update(declarations).set({ totalIncomeCents: 5 }).where(eq(declarations.id, stale[2].id));
    expect((await marks(office.officeId)).map((m) => m.key)).toContain(RECOMPUTE_TOTALS_MARK);
    expect(await enqueueTotalsRecompute(env.ctx)).toBeNull();
    // nem depois que a rotina de retenção apaga a tarefa concluída
    await env.ctx.db.delete(jobs).where(eq(jobs.type, RECOMPUTE_TOTALS_JOB));
    expect(await enqueueTotalsRecompute(env.ctx)).toBeNull();
    await scheduleRoutines(env.ctx);
    await env.ctx.db.delete(jobs).where(eq(jobs.type, SELIC_JOB));
    await env.ctx.jobs.drain();
    expect((await fresh(stale[2].id)).totalIncomeCents).toBe(5);
    expect(await env.ctx.db.select().from(jobs).where(eq(jobs.type, RECOMPUTE_TOTALS_JOB))).toHaveLength(0);
  });
});
