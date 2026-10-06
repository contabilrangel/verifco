import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ASSET_GROUPS,
  DECLARATION_SUBSTATUS,
  DEPENDENT_RELATIONSHIPS,
  ECAC_DECLARATION_STATUS,
  INCOME_NATURES,
  ITEM_KIND_LIST,
  PAYMENT_NATURES,
  SYNC_FILE_CATEGORY,
  isValidCpf,
  isValidCpfCnpj,
  onlyDigits,
  type DeclarationSubstatus,
  type EcacDeclarationStatus,
  type ItemKind,
} from '@verifco/shared';
import { declarationItems, declarations, documents, files } from '../../db/schema';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { audit, can, dateStr, guard, optionalText, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import {
  assertCanSetSubstatus,
  changeDeclarationStatus,
  computeCashAnalysis,
  getOrCreateDeclaration,
  refreshDeclaration,
  syncStatusWithEcac,
} from '../../services/declarations';
import { emptyDeclaration, getDeclarationForUser, presentDeclaration } from './access';
import { backlogRoutes } from './backlogs';
import { darfRoutes } from './darfs';
import { kanbanRoutes } from './kanban';

const customerYearParams = z.object({ id: z.uuid(), year: yearSchema });
const itemParams = z.object({ id: z.uuid(), itemId: z.uuid() });

const money = z.coerce.number().int().min(0).max(10_000_000_000_000);
const nullableDate = z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional());
const substatusEnum = z.enum(Object.keys(DECLARATION_SUBSTATUS) as [DeclarationSubstatus, ...DeclarationSubstatus[]]);
const ecacEnum = z.enum(Object.keys(ECAC_DECLARATION_STATUS) as [EcacDeclarationStatus, ...EcacDeclarationStatus[]]);

/** Resumo da declaração (todos os campos opcionais: atualização parcial). */
const summarySchema = z
  .object({
    taxation: z.enum(['complete', 'simplified']).nullable(),
    isRectification: z.boolean(),
    receiptNumber: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(40).nullable()),
    transmittedAt: nullableDate,
    taxDueCents: money,
    refundCents: money,
    refundLotDate: nullableDate,
    refundPaidAt: nullableDate,
    ecacStatus: ecacEnum,
    otherExpenses: z
      .object({
        annualPaymentCents: money,
        principalCents: money,
        interestCents: money,
        creditCardCents: money,
        capitalLossCents: money,
      })
      .partial(),
  })
  .partial();

const extraSchema = z
  .object({
    nature: z.string().max(60).optional(),
    relationship: z.string().max(60).optional(),
    birthDate: nullableDate,
    officialPensionCents: money.optional(),
    reimbursedCents: money.optional(),
  })
  .catchall(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]));

const shortText = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(200).nullable().optional());

/** Linha da DIRPF com as validações de cada ficha. */
const itemSchema = z
  .object({
    kind: z.enum(ITEM_KIND_LIST as [ItemKind, ...ItemKind[]]),
    code: shortText,
    groupCode: shortText,
    description: optionalText,
    ownerCpf: shortText,
    ownerName: shortText,
    counterpartyDoc: shortText,
    counterpartyName: shortText,
    prevValueCents: money.default(0),
    valueCents: money.default(0),
    withheldCents: money.default(0),
    extra: extraSchema.default({}),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (v.ownerCpf && !isValidCpf(v.ownerCpf)) issue('ownerCpf', 'CPF inválido');
    if (v.counterpartyDoc && !isValidCpfCnpj(v.counterpartyDoc)) issue('counterpartyDoc', 'CPF/CNPJ inválido');
    if (v.kind === 'dependent') {
      if (!v.ownerName) issue('ownerName', 'Informe o nome do dependente');
      if (v.extra.relationship && !(v.extra.relationship in DEPENDENT_RELATIONSHIPS)) issue('extra.relationship', 'Relação de dependência inválida');
    }
    if (v.kind === 'asset' && v.groupCode && !(v.groupCode in ASSET_GROUPS)) issue('groupCode', 'Grupo de bens inválido');
    if (v.kind === 'payment' && v.extra.nature && !(v.extra.nature in PAYMENT_NATURES)) issue('extra.nature', 'Natureza do pagamento inválida');
    if ((v.kind === 'income_exempt' || v.kind === 'income_exclusive') && v.extra.nature && !(v.extra.nature in INCOME_NATURES)) {
      issue('extra.nature', 'Natureza do rendimento inválida');
    }
    if (v.kind === 'payment' && (v.extra.reimbursedCents ?? 0) > v.valueCents) issue('extra.reimbursedCents', 'O reembolso não pode passar do valor pago');
  });

/** Dados da linha gravados na auditoria (sem CPF/CNPJ). */
const itemAudit = (i: typeof declarationItems.$inferSelect) => ({ itemId: i.id, kind: i.kind, code: i.code, valueCents: i.valueCents, source: i.source });

const normalizeItem = (v: z.infer<typeof itemSchema>) => ({
  ...v,
  ownerCpf: v.ownerCpf ? onlyDigits(v.ownerCpf) : null,
  counterpartyDoc: v.counterpartyDoc ? onlyDigits(v.counterpartyDoc) : null,
  groupCode: v.kind === 'asset' ? (v.groupCode ?? '99') : (v.groupCode ?? null),
  code: v.code ?? null,
  description: v.description ?? null,
  ownerName: v.ownerName ?? null,
  counterpartyName: v.counterpartyName ?? null,
});

export async function declarationRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  // ------------------------------------------------------------ declaração por cliente e ano
  /** Recibo de entrega (.REC) mais recente recebido do sincronizador para a declaração. */
  const receiptFileOf = async (declarationId: string) => {
    const [r] = await db
      .select({ documentId: documents.id, fileId: documents.fileId, filename: files.filename, receivedAt: documents.createdAt })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .where(and(eq(documents.declarationId, declarationId), eq(documents.category, SYNC_FILE_CATEGORY.rec)))
      .orderBy(desc(documents.createdAt))
      .limit(1);
    return r ?? null;
  };

  /**
   * Declaração do cliente no exercício. Quem só cuida de DARF (`darf.view`, sem
   * `declaration.view`) recebe só o necessário para a etapa DARF (id e imposto a pagar).
   */
  app.get('/customers/:id/declarations/:year', { preHandler: guard('declaration.view', 'darf.view') }, async (req) => {
    const user = requireUser(req);
    const { id, year } = parse(customerYearParams, req.params);
    const customer = await getCustomerForUser(app.ctx, user, id);
    const d = await db.query.declarations.findFirst({ where: and(eq(declarations.customerId, customer.id), eq(declarations.exerciseYear, year)) });
    if (!can(user, 'declaration.view')) {
      const base = d ?? emptyDeclaration(customer.id, year);
      return { id: d?.id ?? null, exists: Boolean(d), customerId: customer.id, exerciseYear: year, stage: base.stage, substatus: base.substatus, taxDueCents: base.taxDueCents, limited: true };
    }
    return d ? { ...presentDeclaration(d), receiptFile: await receiptFileOf(d.id) } : { ...emptyDeclaration(customer.id, year), receiptFile: null };
  });

  /**
   * Cria (se preciso) e atualiza o resumo. Regras de status:
   * - informar a transmissão (data ou recibo) leva uma declaração anterior à etapa
   *   "Transmitida" para o subestado da situação eCAC;
   * - mudar a situação eCAC de uma declaração transmitida atualiza o subestado.
   */
  app.put('/customers/:id/declarations/:year', { preHandler: guard('declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id, year } = parse(customerYearParams, req.params);
    const body = parse(summarySchema, req.body);
    const customer = await getCustomerForUser(app.ctx, user, id);
    const current = await getOrCreateDeclaration(db, user.officeId, customer.id, year);
    if ((body.taxDueCents ?? current.taxDueCents) > 0 && (body.refundCents ?? current.refundCents) > 0) {
      throw badRequest('Informe imposto a pagar ou a restituir, não os dois.');
    }
    const { transmittedAt, otherExpenses, ...fields } = body;
    const [updated] = await db
      .update(declarations)
      .set({
        ...fields,
        ...(transmittedAt !== undefined ? { transmittedAt: transmittedAt ? new Date(`${transmittedAt}T12:00:00-03:00`) : null } : {}),
        ...(otherExpenses ? { otherExpenses: { ...current.otherExpenses, ...otherExpenses } } : {}),
        updatedAt: new Date(),
      })
      .where(eq(declarations.id, current.id))
      .returning();
    let row = await syncStatusWithEcac(db, current, updated);
    if (otherExpenses || body.taxation !== undefined) row = await refreshDeclaration(app.ctx, row.id);
    await audit(req, 'update', 'declaration', row.id, { fields: Object.keys(body) });
    return presentDeclaration(row);
  });

  /** Muda o status interno (Kanban). Finalizar exige a permissão de finalização. */
  app.patch('/declarations/:id/substatus', { preHandler: guard('declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { substatus } = parse(z.object({ substatus: substatusEnum }), req.body);
    assertCanSetSubstatus(user, substatus);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const row = await changeDeclarationStatus(db, declaration, substatus, { by: user });
    await audit(req, 'substatus', 'declaration', declaration.id, { from: declaration.substatus, to: substatus });
    return presentDeclaration(row);
  });

  app.post('/declarations/:id/finish', { preHandler: guard('declaration.finish') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    if (declaration.stage === 'finished') throw conflict('Esta declaração já está finalizada.');
    const row = await changeDeclarationStatus(db, declaration, 'finished', { by: user });
    await audit(req, 'finish', 'declaration', declaration.id, { from: declaration.substatus });
    return presentDeclaration(row);
  });

  // ------------------------------------------------------------ linhas da DIRPF
  app.get('/declarations/:id/items', { preHandler: guard('declaration.view') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    return db.select().from(declarationItems).where(eq(declarationItems.declarationId, declaration.id)).orderBy(asc(declarationItems.kind), asc(declarationItems.createdAt));
  });

  app.post('/declarations/:id/items', { preHandler: guard('declaration.edit') }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = normalizeItem(parse(itemSchema, req.body));
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const [item] = await db
      .insert(declarationItems)
      .values({ ...body, officeId: user.officeId, declarationId: declaration.id, source: 'manual' })
      .returning();
    const updated = await refreshDeclaration(app.ctx, declaration.id);
    await audit(req, 'create_item', 'declaration', declaration.id, itemAudit(item));
    reply.status(201);
    return { item, declaration: presentDeclaration(updated) };
  });

  const loadItem = async (declarationId: string, itemId: string) => {
    const item = await db.query.declarationItems.findFirst({ where: and(eq(declarationItems.id, itemId), eq(declarationItems.declarationId, declarationId)) });
    if (!item) throw notFound('Linha da declaração');
    return item;
  };

  app.put('/declarations/:id/items/:itemId', { preHandler: guard('declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id, itemId } = parse(itemParams, req.params);
    const body = normalizeItem(parse(itemSchema, req.body));
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const before = await loadItem(declaration.id, itemId);
    const [item] = await db.update(declarationItems).set(body).where(eq(declarationItems.id, itemId)).returning();
    const updated = await refreshDeclaration(app.ctx, declaration.id);
    await audit(req, 'update_item', 'declaration', declaration.id, { ...itemAudit(item), fromValueCents: before.valueCents });
    return { item, declaration: presentDeclaration(updated) };
  });

  app.delete('/declarations/:id/items/:itemId', { preHandler: guard('declaration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const item = await loadItem(declaration.id, itemId);
    await db.delete(declarationItems).where(eq(declarationItems.id, itemId));
    const updated = await refreshDeclaration(app.ctx, declaration.id);
    await audit(req, 'delete_item', 'declaration', declaration.id, itemAudit(item));
    return { ok: true, declaration: presentDeclaration(updated) };
  });

  /** Análise de caixa (recursos × aplicações); grava o saldo na declaração. */
  app.get('/declarations/:id/cash-analysis', { preHandler: guard('declaration.view', 'report.cash_analysis') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { declaration } = await getDeclarationForUser(app.ctx, user, id);
    const { result, itemCount } = await computeCashAnalysis(app.ctx, declaration);
    const cashBalanceCents = itemCount ? result.balanceCents : null;
    if (cashBalanceCents !== declaration.cashBalanceCents) {
      await db.update(declarations).set({ cashBalanceCents }).where(eq(declarations.id, declaration.id));
    }
    return { ...result, itemCount, taxation: declaration.taxation };
  });

  await kanbanRoutes(app);
  await darfRoutes(app);
  await backlogRoutes(app);
}
