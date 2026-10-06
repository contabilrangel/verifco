import { and, asc, eq, gt, gte, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  DECLARATION_SUBSTATUS,
  ECAC_DECLARATION_STATUS,
  INDIVIDUAL_REPORTS,
  INDIVIDUAL_REPORT_KEYS,
  ITEM_KINDS,
  formatCpfCnpj,
  getIndividualReport,
  type DeclarationSubstatus,
  type IndividualReportKey,
} from '@verifco/shared';
import type { AuthUser } from '../../context';
import { backlogs, customers, declarations } from '../../db/schema';
import { badRequest, forbidden } from '../../lib/errors';
import { audit, can, centsSchema, guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { customerScope, getCustomerForUser } from '../../services/customers';
import { getOrCreateDeclaration, refreshDeclaration } from '../../services/declarations';
import { queueDelivery } from '../../services/delivery';
import { PdfBuilder, loadBranding } from '../../services/pdf';
import { buildWorkbook } from '../../services/xlsx';
import { findSpouse, getDeclarationForUser, loadHistory, loadItems, officeSettings } from './data';
import { finishPdf, renderPdf, renderXlsx } from './document';
import { buildIndividualSections, personSubtitle, type PersonContext } from './individual';
import { buildKitPdf, slug } from './kit';

const INDIVIDUAL_PERMS = INDIVIDUAL_REPORTS.map((r) => r.permission);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const today = () => new Date().toISOString().slice(0, 10);
const bool = z.preprocess((v) => (v === 'true' || v === '1' || v === true ? true : v === 'false' || v === '0' || v === false ? false : undefined), z.boolean().optional());

const generateSchema = z.object({
  reports: z.array(z.enum(INDIVIDUAL_REPORT_KEYS)).min(1, 'Escolha ao menos um relatório.'),
  format: z.enum(['pdf', 'xlsx']).default('pdf'),
  includeSpouse: z.boolean().default(false),
});

const otherExpensesSchema = z.object({
  annualPaymentCents: centsSchema.nullable().optional(),
  principalCents: centsSchema.nullable().optional(),
  interestCents: centsSchema.nullable().optional(),
  creditCardCents: centsSchema.nullable().optional(),
  capitalLossCents: centsSchema.nullable().optional(),
});

const sendFile = (reply: FastifyReply, buf: Buffer, filename: string, type: string) =>
  reply.header('Content-Type', type).header('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`).send(buf);

export async function reportRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  /** Garante a permissão de cada relatório pedido (403 se faltar alguma). */
  const assertReportPerms = (user: AuthUser, keys: IndividualReportKey[]) => {
    const missing = keys.filter((k) => !can(user, getIndividualReport(k)!.permission));
    if (missing.length) throw forbidden(`Você não tem permissão para: ${missing.map((k) => getIndividualReport(k)!.label).join(', ')}.`);
  };

  /** Monta titular (e cônjuge) com linhas e histórico. */
  const buildPeople = async (user: AuthUser, declarationId: string, includeSpouse: boolean) => {
    const { declaration, customer } = await getDeclarationForUser(ctx, user, declarationId);
    const settings = await officeSettings(ctx, user.officeId);
    const items = await loadItems(ctx, declaration.id);
    if (!items.length) throw badRequest('A declaração deste exercício ainda não tem linhas cadastradas. Cadastre ou importe a declaração antes de gerar relatórios.');
    const holder: PersonContext = { customer, declaration, items, history: await loadHistory(ctx, customer.id, declaration.exerciseYear, settings) };
    let spouse: PersonContext | null = null;
    if (includeSpouse) {
      const s = await findSpouse(ctx, user, declaration, customer, items);
      if (!s.available || !s.customer || !s.declaration) throw badRequest(s.reason);
      spouse = {
        customer: s.customer,
        declaration: s.declaration,
        items: await loadItems(ctx, s.declaration.id),
        history: await loadHistory(ctx, s.customer.id, declaration.exerciseYear, settings),
      };
    }
    return { holder, spouse, settings };
  };

  const renderReports = async (user: AuthUser, declarationId: string, body: z.infer<typeof generateSchema>) => {
    const keys = INDIVIDUAL_REPORT_KEYS.filter((k) => body.reports.includes(k));
    assertReportPerms(user, keys);
    const { holder, spouse, settings } = await buildPeople(user, declarationId, body.includeSpouse);
    const sections = buildIndividualSections(keys, holder, spouse, settings);
    const brand = await loadBranding(ctx, user.officeId);
    const year = holder.declaration.exerciseYear;
    const base = `relatorios-irpf-${year}-${slug(holder.customer.name)}`;
    if (body.format === 'xlsx') {
      return { buffer: await renderXlsx(sections, brand, personSubtitle(holder)), filename: `${base}.xlsx`, mimeType: XLSX, holder };
    }
    const title = keys.length === 1 ? `${getIndividualReport(keys[0])!.label} · IRPF ${year}` : `Relatórios IRPF ${year}`;
    const pdf = new PdfBuilder(brand, title, `${holder.customer.name}${spouse ? ` e ${spouse.customer.name}` : ''} · ano-calendário ${year - 1}`);
    renderPdf(pdf, brand, sections, { pageBreakBetween: true });
    return { buffer: await finishPdf(pdf), filename: `${base}.pdf`, mimeType: 'application/pdf', holder };
  };

  // ----------------------------------------------------------- relatórios individuais
  /** Declaração do cliente no exercício (criada na primeira vez que alguém a usa). */
  app.get('/reports/declaration', { preHandler: guard(...INDIVIDUAL_PERMS, 'post_declaration.send_kit', 'declaration.view') }, async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ customerId: z.uuid(), year: yearSchema }), req.query);
    const customer = await getCustomerForUser(ctx, user, q.customerId);
    const d = await getOrCreateDeclaration(db, user.officeId, customer.id, q.year);
    return { declarationId: d.id };
  });

  app.get('/declarations/:id/reports', { preHandler: guard(...INDIVIDUAL_PERMS, 'post_declaration.send_kit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { declaration, customer } = await getDeclarationForUser(ctx, user, id);
    const items = await loadItems(ctx, declaration.id);
    const spouse = await findSpouse(ctx, user, declaration, customer, items);
    const office = await db.query.offices.findFirst({ where: (o, { eq: e }) => e(o.id, user.officeId) });
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    return {
      declaration: {
        id: declaration.id,
        exerciseYear: declaration.exerciseYear,
        stage: declaration.stage,
        substatus: declaration.substatus,
        taxation: declaration.taxation,
        taxDueCents: declaration.taxDueCents,
        refundCents: declaration.refundCents,
        otherExpenses: declaration.otherExpenses,
      },
      customer: { id: customer.id, name: customer.name, cpfCnpj: customer.cpfCnpj, email: customer.email, mobile: customer.mobile },
      itemsCount: items.length,
      itemsByKind: Object.entries(counts).map(([kind, n]) => ({ kind, label: ITEM_KINDS[kind as keyof typeof ITEM_KINDS]?.label ?? kind, n })),
      spouse: { available: spouse.available, reason: spouse.reason, name: spouse.customer?.name ?? null },
      reports: INDIVIDUAL_REPORTS.map((r) => ({ ...r, allowed: can(user, r.permission) })),
      hasLogo: Boolean(office?.logoFileId),
      canEditOtherExpenses: can(user, 'declaration.edit') || can(user, 'report.cash_analysis'),
      canSendKit: can(user, 'post_declaration.send_kit'),
    };
  });

  app.put('/declarations/:id/other-expenses', { preHandler: guard('declaration.edit', 'report.cash_analysis') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(otherExpensesSchema, req.body);
    const { declaration } = await getDeclarationForUser(ctx, user, id);
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined && v > 0)) as typeof declaration.otherExpenses;
    await db.update(declarations).set({ otherExpenses: clean, updatedAt: new Date() }).where(eq(declarations.id, declaration.id));
    // os outros gastos entram na análise de caixa: o saldo gravado (alerta do dashboard) acompanha
    const row = await refreshDeclaration(ctx, declaration.id);
    await audit(req, 'update_other_expenses', 'declaration', declaration.id, clean);
    return { otherExpenses: row.otherExpenses, cashBalanceCents: row.cashBalanceCents };
  });

  app.post('/declarations/:id/reports/generate', { preHandler: guard(...INDIVIDUAL_PERMS) }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(generateSchema, req.body);
    const out = await renderReports(user, id, body);
    await audit(req, 'generate_reports', 'declaration', id, { reports: body.reports, format: body.format });
    return sendFile(reply, out.buffer, out.filename, out.mimeType);
  });

  /** Gera os relatórios e envia ao cliente por e-mail e/ou WhatsApp, com o arquivo anexo. */
  app.post('/declarations/:id/reports/send', { preHandler: guard(...INDIVIDUAL_PERMS) }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(generateSchema.extend({ channels: z.array(z.enum(['email', 'whatsapp'])).min(1), requestId: z.uuid() }), req.body);
    assertReportPerms(user, body.reports);
    const { declaration, customer } = await getDeclarationForUser(ctx, user, id);
    const channels = [...new Set(body.channels)];
    const skipped: { channel: string; reason: string }[] = [];
    const ready = channels.filter((ch) => {
      const ok = ch === 'email' ? Boolean(customer.email) : Boolean(customer.mobile);
      if (!ok) skipped.push({ channel: ch, reason: ch === 'email' ? 'O cliente não tem e-mail cadastrado.' : 'O cliente não tem celular cadastrado.' });
      return ok;
    });
    if (!ready.length) throw badRequest(skipped.map((s) => s.reason).join(' '));
    const keyOf = (ch: string) => `reports:${declaration.id}:${body.requestId}:${ch}`;
    // repetição da mesma operação: devolve o que já foi enfileirado sem gerar de novo
    const existing = await Promise.all(ready.map((ch) => db.query.deliveries.findFirst({ where: (d, { and: a, eq: e }) => a(e(d.officeId, user.officeId), e(d.idempotencyKey, keyOf(ch))) })));
    let queued = 0;
    if (existing.some((e) => !e)) {
      const out = await renderReports(user, id, body);
      const file = await ctx.files.save({ officeId: user.officeId, data: out.buffer, filename: out.filename, mimeType: out.mimeType, userId: user.userId });
      for (const ch of ready) {
        await queueDelivery(ctx, {
          officeId: user.officeId,
          customerId: customer.id,
          channel: ch,
          templateKey: 'customer_document',
          exerciseYear: declaration.exerciseYear,
          attachments: [{ fileId: file.id, filename: out.filename }],
          idempotencyKey: keyOf(ch),
          userId: user.userId,
        });
        queued++;
      }
    }
    await audit(req, 'send_reports', 'declaration', id, { reports: body.reports, channels: ready });
    return { queued, alreadyQueued: existing.filter(Boolean).length, skipped };
  });

  app.get('/declarations/:id/kit.pdf', { preHandler: guard('post_declaration.send_kit', 'declaration.view') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { declaration, customer } = await getDeclarationForUser(ctx, user, id);
    const kit = await buildKitPdf(ctx, declaration, customer);
    return sendFile(reply, kit.buffer, kit.filename, 'application/pdf');
  });

  // ----------------------------------------------------------- relatórios gerais
  /** Resultados: imposto a pagar/restituir das declarações do exercício. */
  app.get('/reports/results', { preHandler: guard('report.results') }, async (req, reply) => {
    const user = requireUser(req);
    const q = parse(z.object({ year: yearSchema, payable: bool, refundable: bool, neutral: bool, format: z.enum(['json', 'xlsx']).default('json') }), req.query);
    const scope = await customerScope(ctx, user);
    const flags: SQL[] = [];
    if (q.payable) flags.push(gt(declarations.taxDueCents, 0));
    if (q.refundable) flags.push(gt(declarations.refundCents, 0));
    if (q.neutral) flags.push(and(eq(declarations.taxDueCents, 0), eq(declarations.refundCents, 0))!);
    const rows = await db
      .select({ d: declarations, name: customers.name, cpf: customers.cpfCnpj })
      .from(declarations)
      .innerJoin(customers, eq(customers.id, declarations.customerId))
      .where(and(scope, eq(declarations.officeId, user.officeId), eq(declarations.exerciseYear, q.year), ne(declarations.stage, 'not_started'), flags.length ? or(...flags) : undefined))
      .orderBy(asc(customers.name));
    const data = rows.map((r) => ({
      declarationId: r.d.id,
      customerId: r.d.customerId,
      name: r.name,
      cpfCnpj: r.cpf,
      substatus: r.d.substatus,
      taxation: r.d.taxation,
      taxDueCents: r.d.taxDueCents,
      refundCents: r.d.refundCents,
      transmittedAt: r.d.transmittedAt,
    }));
    const totals = {
      count: data.length,
      taxDueCents: data.reduce((a, r) => a + r.taxDueCents, 0),
      refundCents: data.reduce((a, r) => a + r.refundCents, 0),
      payable: data.filter((r) => r.taxDueCents > 0).length,
      refundable: data.filter((r) => r.refundCents > 0).length,
      neutral: data.filter((r) => !r.taxDueCents && !r.refundCents).length,
    };
    if (q.format === 'xlsx') {
      const buf = await buildWorkbook([
        {
          name: `Resultados ${q.year}`,
          columns: [
            { header: 'Cliente', key: 'name', width: 36 },
            { header: 'CPF/CNPJ', key: 'doc', width: 20 },
            { header: 'Status', key: 'status', width: 24 },
            { header: 'Tributação', key: 'taxation', width: 16 },
            { header: 'A pagar', key: 'due', width: 16, type: 'money' },
            { header: 'A restituir', key: 'refund', width: 16, type: 'money' },
          ],
          rows: [
            ...data.map((r) => ({
              name: r.name,
              doc: formatCpfCnpj(r.cpfCnpj),
              status: DECLARATION_SUBSTATUS[r.substatus as DeclarationSubstatus] ?? r.substatus,
              taxation: r.taxation === 'complete' ? 'Completa' : r.taxation === 'simplified' ? 'Simplificada' : '',
              due: r.taxDueCents,
              refund: r.refundCents,
            })),
            { name: `Total (${totals.count} declarações)`, due: totals.taxDueCents, refund: totals.refundCents },
          ],
        },
      ]);
      return sendFile(reply, buf, `resultados-${q.year}.xlsx`, XLSX);
    }
    return { rows: data, totals };
  });

  /** Documentos faltantes em aberto, agrupados por cliente. */
  app.get('/reports/backlogs', { preHandler: guard('report.backlogs') }, async (req, reply) => {
    const user = requireUser(req);
    const q = parse(z.object({ year: yearSchema.optional(), overdueOnly: bool, format: z.enum(['json', 'xlsx']).default('json') }), req.query);
    const scope = await customerScope(ctx, user);
    const now = today();
    const rows = await db
      .select({ b: backlogs, name: customers.name, cpf: customers.cpfCnpj, email: customers.email, mobile: customers.mobile, year: declarations.exerciseYear })
      .from(backlogs)
      .innerJoin(customers, eq(customers.id, backlogs.customerId))
      .innerJoin(declarations, eq(declarations.id, backlogs.declarationId))
      .where(and(scope, eq(backlogs.officeId, user.officeId), isNull(backlogs.resolvedAt), q.year ? eq(declarations.exerciseYear, q.year) : undefined, q.overdueOnly ? lt(backlogs.dueDate, now) : undefined))
      .orderBy(asc(customers.name), asc(backlogs.dueDate));
    const days = (d: string | null) => (d && d < now ? Math.round((Date.parse(now) - Date.parse(d)) / 86400_000) : 0);
    const groups = new Map<string, { customerId: string; name: string; cpfCnpj: string; email: string | null; mobile: string | null; items: unknown[] }>();
    for (const r of rows) {
      const g = groups.get(r.b.customerId) ?? { customerId: r.b.customerId, name: r.name, cpfCnpj: r.cpf, email: r.email, mobile: r.mobile, items: [] };
      g.items.push({ id: r.b.id, description: r.b.description, dueDate: r.b.dueDate, createdAt: r.b.createdAt, exerciseYear: r.year, overdueDays: days(r.b.dueDate) });
      groups.set(r.b.customerId, g);
    }
    const data = [...groups.values()];
    if (q.format === 'xlsx') {
      const buf = await buildWorkbook([
        {
          name: 'Documentos faltantes',
          columns: [
            { header: 'Cliente', key: 'name', width: 34 },
            { header: 'CPF/CNPJ', key: 'doc', width: 20 },
            { header: 'E-mail', key: 'email', width: 30 },
            { header: 'Exercício', key: 'year', width: 10, type: 'number' },
            { header: 'Documento', key: 'description', width: 44 },
            { header: 'Criado em', key: 'created', width: 14, type: 'date' },
            { header: 'Data limite', key: 'due', width: 14, type: 'date' },
            { header: 'Dias em atraso', key: 'late', width: 14, type: 'number' },
          ],
          rows: rows.map((r) => ({
            name: r.name,
            doc: formatCpfCnpj(r.cpf),
            email: r.email,
            year: r.year,
            description: r.b.description,
            created: r.b.createdAt.toISOString().slice(0, 10),
            due: r.b.dueDate,
            late: days(r.b.dueDate) || '',
          })),
        },
      ]);
      return sendFile(reply, buf, `documentos-faltantes${q.overdueOnly ? '-vencidos' : ''}.xlsx`, XLSX);
    }
    return { groups: data, totals: { customers: data.length, items: rows.length, overdue: rows.filter((r) => r.b.dueDate && r.b.dueDate < now).length } };
  });

  /** Restituições do exercício, com lote previsto/pago. */
  app.get('/reports/refunds', { preHandler: guard('report.refund') }, async (req, reply) => {
    const user = requireUser(req);
    const q = parse(z.object({ year: yearSchema, futureOnly: bool, sort: z.enum(['date', 'name']).default('date'), format: z.enum(['json', 'xlsx']).default('json') }), req.query);
    const scope = await customerScope(ctx, user);
    const now = today();
    const rows = await db
      .select({ d: declarations, name: customers.name, cpf: customers.cpfCnpj })
      .from(declarations)
      .innerJoin(customers, eq(customers.id, declarations.customerId))
      .where(
        and(
          scope,
          eq(declarations.officeId, user.officeId),
          eq(declarations.exerciseYear, q.year),
          gt(declarations.refundCents, 0),
          q.futureOnly ? and(isNull(declarations.refundPaidAt), or(isNull(declarations.refundLotDate), gte(declarations.refundLotDate, now))) : undefined,
        ),
      )
      .orderBy(...(q.sort === 'name' ? [asc(customers.name)] : [sql`${declarations.refundLotDate} asc nulls last`, asc(customers.name)]));
    const data = rows.map((r) => ({
      declarationId: r.d.id,
      customerId: r.d.customerId,
      name: r.name,
      cpfCnpj: r.cpf,
      refundCents: r.d.refundCents,
      refundLotDate: r.d.refundLotDate,
      refundPaidAt: r.d.refundPaidAt,
      ecacStatus: r.d.ecacStatus,
      situation: r.d.refundPaidAt ? 'paid' : r.d.refundLotDate ? (r.d.refundLotDate < now ? 'released' : 'scheduled') : 'waiting',
    }));
    const LABEL = { paid: 'Paga', released: 'Lote liberado', scheduled: 'Lote previsto', waiting: 'Aguardando lote' } as const;
    if (q.format === 'xlsx') {
      const buf = await buildWorkbook([
        {
          name: `Restituições ${q.year}`,
          columns: [
            { header: 'Cliente', key: 'name', width: 36 },
            { header: 'CPF/CNPJ', key: 'doc', width: 20 },
            { header: 'Valor', key: 'value', width: 16, type: 'money' },
            { header: 'Data do lote', key: 'lot', width: 14, type: 'date' },
            { header: 'Paga em', key: 'paid', width: 14, type: 'date' },
            { header: 'Situação', key: 'situation', width: 18 },
            { header: 'Status eCAC', key: 'ecac', width: 22 },
          ],
          rows: [
            ...data.map((r) => ({
              name: r.name,
              doc: formatCpfCnpj(r.cpfCnpj),
              value: r.refundCents,
              lot: r.refundLotDate,
              paid: r.refundPaidAt,
              situation: LABEL[r.situation as keyof typeof LABEL],
              ecac: ECAC_DECLARATION_STATUS[r.ecacStatus as keyof typeof ECAC_DECLARATION_STATUS] ?? r.ecacStatus,
            })),
            { name: `Total (${data.length})`, value: data.reduce((a, r) => a + r.refundCents, 0) },
          ],
        },
      ]);
      return sendFile(reply, buf, `restituicoes-${q.year}.xlsx`, XLSX);
    }
    return { rows: data, totals: { count: data.length, refundCents: data.reduce((a, r) => a + r.refundCents, 0), paid: data.filter((r) => r.situation === 'paid').length } };
  });
}
