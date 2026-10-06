import { and, asc, count, desc, eq, exists, gte, ilike, inArray, isNotNull, isNull, lte, ne, notExists, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CND_STATUS,
  DECLARATION_SUBSTATUS,
  PROCURATION_STATUS,
  formatCep,
  formatCpfCnpj,
  formatPhone,
  isValidCpfCnpj,
  onlyDigits,
  stageOfSubstatus,
  type DeclarationSubstatus,
} from '@verifco/shared';
import { auditLogs, customerGroupMembers, customerGroups, customers, declarations, procurators, users } from '../../db/schema';
import { randomCode, sha256 } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit, can, dateStr, guard, optionalText, paginate, parse, requirePermission, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { customerScope, getCustomerForUser, publicCustomer } from '../../services/customers';
import { assertCanSetSubstatus, changeSubstatus, getOrCreateDeclarations } from '../../services/declarations';
import { queueDelivery } from '../../services/delivery';
import { PdfBuilder, loadBranding } from '../../services/pdf';
import { CERTIFICATE_TYPES, readUploads } from '../../services/uploads';
import { buildWorkbook } from '../../services/xlsx';
import { exposeDevSecrets } from '../../config';

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

const listQuery = z.object({
  search: z.string().trim().optional(),
  year: yearSchema.optional(),
  responsible: csv,
  groups: csv,
  noGroup: z.coerce.boolean().optional(),
  email: z.enum(['with', 'without']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  procurator: z.enum(['with', 'without']).optional(),
  procurationStatus: csv,
  mailbox: z.coerce.boolean().optional(),
  govbrRequired: z.coerce.boolean().optional(),
  expiring: z.coerce.boolean().optional(),
  cnd: csv,
  stage: csv,
  substatus: csv,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  sort: z.enum(['name', 'created', 'updated']).default('name'),
});
type ListQuery = z.infer<typeof listQuery>;

const addressSchema = z
  .object({
    street: optionalText,
    number: optionalText,
    complement: optionalText,
    neighborhood: optionalText,
    city: optionalText,
    state: optionalText,
    zip: optionalText,
  })
  .partial();

const identificationSchema = z.object({
  name: z.string().trim().min(2).max(200),
  voterTitle: optionalText,
  birthDate: z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional()),
  sex: optionalText,
  email: z.preprocess((v) => (v === '' ? null : v), z.email().nullable().optional()),
  mobileCountry: optionalText,
  mobile: optionalText,
  phoneCountry: optionalText,
  phone: optionalText,
  responsibleUserId: z.uuid().nullable().optional(),
  procuratorId: z.uuid().nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  groupIds: z.array(z.uuid()).optional(),
  notes: optionalText,
});

export async function customerRoutes(app: FastifyInstance) {
  const { db, secrets } = app.ctx;

  /** Monta as condições de filtro (sempre dentro do escopo do usuário). */
  const buildWhere = async (req: Parameters<typeof requireUser>[0], q: Partial<ListQuery>) => {
    const user = requireUser(req);
    const conds: SQL[] = [await customerScope(app.ctx, user)];
    if (q.search) {
      const term = `%${q.search}%`;
      const digits = onlyDigits(q.search);
      const or1 = [ilike(customers.name, term), ilike(customers.email, term)];
      if (digits.length >= 3) or1.push(ilike(customers.cpfCnpj, `%${digits}%`));
      conds.push(or(...or1)!);
    }
    if (q.responsible?.length) conds.push(inArray(customers.responsibleUserId, q.responsible));
    if (q.email === 'with') conds.push(and(isNotNull(customers.email), ne(customers.email, ''))!);
    if (q.email === 'without') conds.push(or(isNull(customers.email), eq(customers.email, ''))!);
    if (q.status) conds.push(eq(customers.status, q.status));
    if (q.procurator === 'with') conds.push(isNotNull(customers.procuratorId));
    if (q.procurator === 'without') conds.push(isNull(customers.procuratorId));
    if (q.procurationStatus?.length) conds.push(inArray(customers.procurationStatus, q.procurationStatus));
    if (q.mailbox) conds.push(sql`${customers.ecacMailboxMessages} > 0`);
    if (q.govbrRequired) conds.push(eq(customers.govbrLevel, 'bronze'));
    if (q.expiring) {
      const today = new Date().toISOString().slice(0, 10);
      const in30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
      conds.push(and(gte(customers.procurationExpiresAt, today), lte(customers.procurationExpiresAt, in30))!);
    }
    if (q.cnd?.length) conds.push(inArray(customers.cndStatus, q.cnd));
    const memberOf = (ids: string[]) =>
      exists(db.select().from(customerGroupMembers).where(and(eq(customerGroupMembers.customerId, customers.id), inArray(customerGroupMembers.groupId, ids))));
    const noGroup = notExists(db.select().from(customerGroupMembers).where(eq(customerGroupMembers.customerId, customers.id)));
    if (q.groups?.length && q.noGroup) conds.push(or(memberOf(q.groups), noGroup)!);
    else if (q.groups?.length) conds.push(memberOf(q.groups));
    else if (q.noGroup) conds.push(noGroup);
    if ((q.stage?.length || q.substatus?.length) && q.year) {
      // clientes sem declaração no ano contam como "não iniciado"
      const declConds: SQL[] = [eq(declarations.customerId, customers.id), eq(declarations.exerciseYear, q.year)];
      if (q.stage?.length) declConds.push(inArray(declarations.stage, q.stage));
      if (q.substatus?.length) declConds.push(inArray(declarations.substatus, q.substatus));
      const hasMatch = exists(db.select().from(declarations).where(and(...declConds)));
      const wantsNotStarted = q.stage?.includes('not_started') || q.substatus?.includes('not_started');
      const noDecl = notExists(db.select().from(declarations).where(and(eq(declarations.customerId, customers.id), eq(declarations.exerciseYear, q.year))));
      conds.push(wantsNotStarted ? or(hasMatch, noDecl)! : hasMatch);
    }
    return { user, where: and(...conds)! };
  };

  const loadExtras = async (ids: string[], year?: number) => {
    if (!ids.length) return { groups: new Map<string, { id: string; name: string }[]>(), decls: new Map<string, typeof declarations.$inferSelect>() };
    const gm = await db
      .select({ customerId: customerGroupMembers.customerId, id: customerGroups.id, name: customerGroups.name })
      .from(customerGroupMembers)
      .innerJoin(customerGroups, eq(customerGroups.id, customerGroupMembers.groupId))
      .where(inArray(customerGroupMembers.customerId, ids));
    const groups = new Map<string, { id: string; name: string }[]>();
    for (const g of gm) groups.set(g.customerId, [...(groups.get(g.customerId) ?? []), { id: g.id, name: g.name }]);
    const decls = new Map<string, typeof declarations.$inferSelect>();
    if (year) {
      const rows = await db.select().from(declarations).where(and(inArray(declarations.customerId, ids), eq(declarations.exerciseYear, year)));
      for (const d of rows) decls.set(d.customerId, d);
    }
    return { groups, decls };
  };

  app.get('/customers', { preHandler: guard('customer.list') }, async (req) => {
    const q = parse(listQuery, req.query);
    const { where } = await buildWhere(req, q);
    const order = q.sort === 'created' ? desc(customers.createdAt) : q.sort === 'updated' ? desc(customers.updatedAt) : asc(customers.name);
    const [{ total }] = await db.select({ total: count() }).from(customers).where(where);
    const rows = await db
      .select({ c: customers, responsibleName: users.name, procuratorName: procurators.name })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.responsibleUserId))
      .leftJoin(procurators, eq(procurators.id, customers.procuratorId))
      .where(where)
      .orderBy(order)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const { groups, decls } = await loadExtras(rows.map((r) => r.c.id), q.year);
    const data = rows.map((r) => {
      const d = decls.get(r.c.id);
      return {
        ...publicCustomer(r.c),
        responsibleName: r.responsibleName,
        procuratorName: r.procuratorName,
        groups: groups.get(r.c.id) ?? [],
        declaration: d ? { id: d.id, stage: d.stage, substatus: d.substatus, ecacStatus: d.ecacStatus, refundCents: d.refundCents, taxDueCents: d.taxDueCents } : null,
      };
    });
    return paginate(data, total, q.page, q.pageSize);
  });

  /** Contagens de cada opção de filtro, como na barra de filtros da lista. */
  app.get('/customers/facets', { preHandler: guard('customer.list') }, async (req) => {
    const user = requireUser(req);
    const scope = await customerScope(app.ctx, user);
    const n = async (extra?: SQL) => (await db.select({ n: count() }).from(customers).where(extra ? and(scope, extra) : scope))[0].n;
    const byCol = async (col: typeof customers.procurationStatus | typeof customers.cndStatus) => {
      const rows = await db.select({ k: col, n: count() }).from(customers).where(scope).groupBy(col);
      return Object.fromEntries(rows.map((r) => [r.k, r.n]));
    };
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const groupCounts = await db
      .select({ id: customerGroups.id, name: customerGroups.name, n: count(customers.id) })
      .from(customerGroups)
      .leftJoin(customerGroupMembers, eq(customerGroupMembers.groupId, customerGroups.id))
      .leftJoin(customers, and(eq(customers.id, customerGroupMembers.customerId), scope))
      .where(eq(customerGroups.officeId, user.officeId))
      .groupBy(customerGroups.id)
      .orderBy(asc(customerGroups.name));
    const respCounts = await db
      .select({ id: users.id, name: users.name, n: count(customers.id) })
      .from(users)
      .leftJoin(customers, and(eq(customers.responsibleUserId, users.id), scope))
      .where(eq(users.officeId, user.officeId))
      .groupBy(users.id)
      .orderBy(asc(users.name));
    return {
      total: await n(),
      email: { with: await n(and(isNotNull(customers.email), ne(customers.email, ''))), without: await n(or(isNull(customers.email), eq(customers.email, ''))) },
      status: { active: await n(eq(customers.status, 'active')), inactive: await n(eq(customers.status, 'inactive')) },
      procurator: { with: await n(isNotNull(customers.procuratorId)), without: await n(isNull(customers.procuratorId)) },
      procurationStatus: await byCol(customers.procurationStatus),
      mailbox: await n(sql`${customers.ecacMailboxMessages} > 0`),
      govbrRequired: await n(eq(customers.govbrLevel, 'bronze')),
      expiring: await n(and(gte(customers.procurationExpiresAt, today), lte(customers.procurationExpiresAt, in30))),
      cnd: await byCol(customers.cndStatus),
      groups: groupCounts,
      noGroup: await n(notExists(db.select().from(customerGroupMembers).where(eq(customerGroupMembers.customerId, customers.id)))),
      responsible: respCounts,
      labels: { procurationStatus: PROCURATION_STATUS, cnd: CND_STATUS },
    };
  });

  app.post('/customers', { preHandler: guard('customer.create') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(200),
        cpfCnpj: z.string().refine(isValidCpfCnpj, 'CPF/CNPJ inválido'),
        email: z.preprocess((v) => (v === '' ? null : v), z.email().nullable().optional()),
        responsibleUserId: z.uuid().nullable().optional(),
      }),
      req.body,
    );
    const doc = onlyDigits(body.cpfCnpj);
    const dup = await db.query.customers.findFirst({ where: and(eq(customers.officeId, user.officeId), eq(customers.cpfCnpj, doc), isNull(customers.deletedAt)) });
    if (dup) throw conflict('Já existe um cliente com este CPF/CNPJ.');
    if (body.responsibleUserId) await assertUserInOffice(body.responsibleUserId, user.officeId);
    const [row] = await db
      .insert(customers)
      .values({ officeId: user.officeId, name: body.name, cpfCnpj: doc, email: body.email ?? null, responsibleUserId: body.responsibleUserId ?? user.userId })
      .returning();
    await audit(req, 'create', 'customer', row.id, { name: row.name });
    reply.status(201);
    return publicCustomer(row);
  });

  async function assertUserInOffice(userId: string, officeId: string) {
    const u = await db.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.officeId, officeId)) });
    if (!u) throw badRequest('Responsável inválido.');
  }

  app.get('/customers/:id', { preHandler: guard('customer.list') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const c = await getCustomerForUser(app.ctx, user, id);
    const { groups } = await loadExtras([c.id]);
    const responsible = c.responsibleUserId ? await db.query.users.findFirst({ where: eq(users.id, c.responsibleUserId) }) : null;
    const procurator = c.procuratorId ? await db.query.procurators.findFirst({ where: eq(procurators.id, c.procuratorId) }) : null;
    return {
      ...publicCustomer(c),
      groups: groups.get(c.id) ?? [],
      responsibleName: responsible?.name ?? null,
      procurator: procurator ? { id: procurator.id, name: procurator.name, cpfCnpj: procurator.cpfCnpj } : null,
    };
  });

  app.put('/customers/:id/identification', { preHandler: guard('customer.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(identificationSchema, req.body);
    const c = await getCustomerForUser(app.ctx, user, id);
    if (body.responsibleUserId) await assertUserInOffice(body.responsibleUserId, user.officeId);
    if (body.procuratorId) {
      const p = await db.query.procurators.findFirst({ where: and(eq(procurators.id, body.procuratorId), eq(procurators.officeId, user.officeId)) });
      if (!p) throw badRequest('Procurador inválido.');
    }
    const { groupIds, ...fields } = body;
    const procuratorChanged = body.procuratorId !== undefined && body.procuratorId !== c.procuratorId;
    const [row] = await db
      .update(customers)
      .set({
        ...fields,
        mobile: fields.mobile ? onlyDigits(fields.mobile) : fields.mobile,
        phone: fields.phone ? onlyDigits(fields.phone) : fields.phone,
        // trocar de procurador exige nova validação da procuração
        ...(procuratorChanged ? { procurationStatus: body.procuratorId ? 'validating' : 'none' } : {}),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, c.id))
      .returning();
    if (groupIds) await setGroups(c.id, groupIds, user.officeId);
    await audit(req, 'update', 'customer', c.id);
    return publicCustomer(row);
  });

  async function setGroups(customerId: string, groupIds: string[], officeId: string) {
    if (groupIds.length) {
      const valid = await db.select({ id: customerGroups.id }).from(customerGroups).where(and(eq(customerGroups.officeId, officeId), inArray(customerGroups.id, groupIds)));
      if (valid.length !== new Set(groupIds).size) throw badRequest('Grupo inválido.');
    }
    await db.delete(customerGroupMembers).where(eq(customerGroupMembers.customerId, customerId));
    if (groupIds.length) await db.insert(customerGroupMembers).values([...new Set(groupIds)].map((groupId) => ({ customerId, groupId })));
  }

  app.put('/customers/:id/address', { preHandler: guard('customer.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ address: addressSchema, secondaryAddress: addressSchema.optional() }), req.body);
    const c = await getCustomerForUser(app.ctx, user, id);
    const clean = (a: z.infer<typeof addressSchema> | undefined) =>
      Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, k === 'zip' && v ? onlyDigits(v) : (v ?? undefined)]));
    const [row] = await db
      .update(customers)
      .set({ address: clean(body.address), secondaryAddress: clean(body.secondaryAddress), updatedAt: new Date() })
      .where(eq(customers.id, c.id))
      .returning();
    return publicCustomer(row);
  });

  /** Credenciais eCAC/gov.br e INSS: gravadas cifradas, nunca devolvidas ao navegador. */
  app.put('/customers/:id/credentials', { preHandler: guard('ecac.credentials') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({ ecacLogin: z.string().max(200).nullable().optional(), ecacPassword: z.string().max(200).nullable().optional(), inssPassword: z.string().max(200).nullable().optional() }),
      req.body,
    );
    const c = await getCustomerForUser(app.ctx, user, id);
    const enc = (v: string | null | undefined, current: string | null) => (v === undefined ? current : v === null || v === '' ? null : secrets.encrypt(v));
    const [row] = await db
      .update(customers)
      .set({
        ecacLoginEnc: enc(body.ecacLogin, c.ecacLoginEnc),
        ecacPasswordEnc: enc(body.ecacPassword, c.ecacPasswordEnc),
        inssPasswordEnc: enc(body.inssPassword, c.inssPasswordEnc),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, c.id))
      .returning();
    await audit(req, 'update', 'customer_credentials', c.id, { fields: Object.keys(body) });
    return publicCustomer(row);
  });

  app.delete('/customers/:id', { preHandler: guard('customer.delete') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const c = await getCustomerForUser(app.ctx, user, id);
    await db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, c.id));
    await audit(req, 'delete', 'customer', c.id, { name: c.name });
    return { ok: true };
  });

  /** Gera o código de acesso ao portal do cliente e envia por e-mail. */
  app.post('/customers/:id/portal-access', { preHandler: guard('customer.portal_access') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const c = await getCustomerForUser(app.ctx, user, id);
    if (!c.email) throw badRequest('Cadastre o e-mail do cliente antes de gerar o acesso.');
    const code = randomCode(6);
    await db
      .update(customers)
      .set({ portalEnabled: true, portalCodeHash: sha256(`${c.id}:${code}`), portalCodeExpiresAt: new Date(Date.now() + 30 * 86400_000) })
      .where(eq(customers.id, c.id));
    const link = `${app.ctx.config.WEB_URL}/portal`;
    await queueDelivery(app.ctx, {
      officeId: user.officeId,
      customerId: c.id,
      channel: 'email',
      subject: 'Seu acesso ao portal do cliente',
      body: `<p>Olá, ${c.name}!</p><p>Seu escritório liberou o acesso ao portal do cliente, onde você acompanha sua declaração e envia documentos.</p><p>Acesse <a href="${link}">${link}</a> e entre com seu CPF e o código <strong>${code}</strong> (válido por 30 dias).</p>`,
      // o código só vai no e-mail; o histórico de envios guarda a versão mascarada
      redact: [code],
      userId: user.userId,
    });
    await audit(req, 'portal_access', 'customer', c.id);
    return { ok: true, code: exposeDevSecrets(app.ctx.config) ? code : undefined };
  });

  /** Revoga o acesso ao portal: o código atual deixa de valer. */
  app.delete('/customers/:id/portal-access', { preHandler: guard('customer.portal_access') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const c = await getCustomerForUser(app.ctx, user, id);
    const [row] = await db
      .update(customers)
      .set({ portalEnabled: false, portalCodeHash: null, portalCodeExpiresAt: null, updatedAt: new Date() })
      .where(eq(customers.id, c.id))
      .returning();
    await audit(req, 'revoke_portal_access', 'customer', c.id);
    return publicCustomer(row);
  });

  // ------------------------------------------------------------ ações em massa
  const bulkSchema = z.object({
    ids: z.array(z.uuid()).min(1).max(2000),
    action: z.enum(['status', 'responsible', 'procurator', 'groups_add', 'groups_remove', 'groups_set', 'substatus', 'delete']),
    value: z.unknown().optional(),
    year: yearSchema.optional(),
  });

  app.post('/customers/bulk', async (req) => {
    const body = parse(bulkSchema, req.body);
    const user = requirePermission(req, body.action === 'delete' ? 'customer.delete' : body.action === 'substatus' ? 'declaration.edit' : 'customer.edit');
    const scope = await customerScope(app.ctx, user);
    const targets = await db.select({ id: customers.id }).from(customers).where(and(scope, inArray(customers.id, body.ids)));
    const ids = targets.map((t) => t.id);
    if (!ids.length) throw notFound('Cliente');
    const now = new Date();
    switch (body.action) {
      case 'status': {
        const v = parse(z.enum(['active', 'inactive']), body.value);
        await db.update(customers).set({ status: v, updatedAt: now }).where(inArray(customers.id, ids));
        break;
      }
      case 'responsible': {
        const v = parse(z.uuid().nullable(), body.value);
        if (v) await assertUserInOffice(v, user.officeId);
        await db.update(customers).set({ responsibleUserId: v, updatedAt: now }).where(inArray(customers.id, ids));
        break;
      }
      case 'procurator': {
        const v = parse(z.uuid().nullable(), body.value);
        if (v) {
          const p = await db.query.procurators.findFirst({ where: and(eq(procurators.id, v), eq(procurators.officeId, user.officeId)) });
          if (!p) throw badRequest('Procurador inválido.');
        }
        await db.update(customers).set({ procuratorId: v, procurationStatus: v ? 'validating' : 'none', updatedAt: now }).where(inArray(customers.id, ids));
        break;
      }
      case 'groups_add':
      case 'groups_remove':
      case 'groups_set': {
        const groupIds = parse(z.array(z.uuid()), body.value);
        const valid = groupIds.length
          ? await db.select({ id: customerGroups.id }).from(customerGroups).where(and(eq(customerGroups.officeId, user.officeId), inArray(customerGroups.id, groupIds)))
          : [];
        if (valid.length !== new Set(groupIds).size) throw badRequest('Grupo inválido.');
        if (body.action !== 'groups_add') {
          await db
            .delete(customerGroupMembers)
            .where(and(inArray(customerGroupMembers.customerId, ids), ...(body.action === 'groups_remove' ? [inArray(customerGroupMembers.groupId, groupIds)] : [])));
        }
        if (body.action !== 'groups_remove' && groupIds.length) {
          await db
            .insert(customerGroupMembers)
            .values(ids.flatMap((customerId) => groupIds.map((groupId) => ({ customerId, groupId }))))
            .onConflictDoNothing();
        }
        break;
      }
      case 'substatus': {
        const v = parse(z.enum(Object.keys(DECLARATION_SUBSTATUS) as [DeclarationSubstatus, ...DeclarationSubstatus[]]), body.value);
        const year = body.year;
        if (!year) throw badRequest('Informe o ano-exercício.');
        // mesma regra do status da declaração (finalizar exige permissão própria, conferida antes
        // de gravar; a situação eCAC acompanha), numa transação e com consultas em lote
        assertCanSetSubstatus(user, v);
        await db.transaction(async (tx) => {
          const decls = await getOrCreateDeclarations(tx, user.officeId, ids, year);
          const changed = await changeSubstatus(tx, user, decls, v);
          if (changed.length) {
            await tx.insert(auditLogs).values(
              changed.map(({ before }) => ({
                officeId: user.officeId,
                userId: user.userId,
                action: 'substatus',
                entity: 'declaration',
                entityId: before.id,
                data: { from: before.substatus, to: v, bulk: true },
              })),
            );
          }
        });
        break;
      }
      case 'delete':
        await db.update(customers).set({ deletedAt: now }).where(inArray(customers.id, ids));
        break;
    }
    await audit(req, `bulk_${body.action}`, 'customer', null, { count: ids.length });
    return { ok: true, affected: ids.length, stage: body.action === 'substatus' ? stageOfSubstatus(body.value as DeclarationSubstatus) : undefined };
  });

  /** Exporta para Excel os selecionados ou todos que atendem aos filtros. */
  app.post('/customers/export', { preHandler: guard('customer.list') }, async (req, reply) => {
    const body = parse(z.object({ ids: z.array(z.uuid()).optional(), filters: z.record(z.string(), z.unknown()).optional() }), req.body);
    const q = parse(listQuery.partial(), body.filters ?? {});
    const { where } = await buildWhere(req, q);
    const rows = await db
      .select({ c: customers, responsibleName: users.name, procuratorName: procurators.name })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.responsibleUserId))
      .leftJoin(procurators, eq(procurators.id, customers.procuratorId))
      .where(body.ids?.length ? and(where, inArray(customers.id, body.ids)) : where)
      .orderBy(asc(customers.name));
    const { groups, decls } = await loadExtras(rows.map((r) => r.c.id), q.year);
    const xlsx = await buildWorkbook([
      {
        name: 'Clientes',
        columns: [
          { header: 'Nome', key: 'name', width: 36 },
          { header: 'CPF/CNPJ', key: 'doc', width: 20 },
          { header: 'E-mail', key: 'email', width: 32 },
          { header: 'Celular', key: 'mobile', width: 18 },
          { header: 'Telefone', key: 'phone', width: 18 },
          { header: 'Responsável', key: 'responsible', width: 24 },
          { header: 'Grupos', key: 'groups', width: 24 },
          { header: 'Procurador', key: 'procurator', width: 24 },
          { header: 'Procuração', key: 'procuration', width: 20 },
          { header: 'Situação', key: 'status', width: 12 },
          { header: 'Status da declaração', key: 'decl', width: 24 },
          { header: 'Cidade', key: 'city', width: 20 },
          { header: 'CEP', key: 'zip', width: 12 },
        ],
        rows: rows.map((r) => ({
          name: r.c.name,
          doc: formatCpfCnpj(r.c.cpfCnpj),
          email: r.c.email,
          mobile: formatPhone(r.c.mobile),
          phone: formatPhone(r.c.phone),
          responsible: r.responsibleName,
          groups: (groups.get(r.c.id) ?? []).map((g) => g.name).join(', '),
          procurator: r.procuratorName,
          procuration: PROCURATION_STATUS[r.c.procurationStatus as keyof typeof PROCURATION_STATUS] ?? r.c.procurationStatus,
          status: r.c.status === 'active' ? 'Ativo' : 'Inativo',
          decl: decls.get(r.c.id) ? DECLARATION_SUBSTATUS[decls.get(r.c.id)!.substatus as DeclarationSubstatus] : 'Não iniciado',
          city: r.c.address?.city,
          zip: formatCep(r.c.address?.zip),
        })),
      },
    ]);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="clientes.xlsx"`)
      .send(xlsx);
  });

  /** Etiquetas de endereçamento em PDF (3 colunas). */
  app.post('/customers/labels', { preHandler: guard('customer.list') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ ids: z.array(z.uuid()).min(1).max(2000) }), req.body);
    const scope = await customerScope(app.ctx, user);
    const rows = await db.select().from(customers).where(and(scope, inArray(customers.id, body.ids))).orderBy(asc(customers.name));
    const pdf = new PdfBuilder(await loadBranding(app.ctx, user.officeId), 'Etiquetas');
    const { doc } = pdf;
    const cols = 3;
    const w = pdf.width / cols;
    const h = 76;
    let i = 0;
    let top = doc.y;
    for (const c of rows) {
      const col = i % cols;
      if (col === 0 && i > 0) top += h;
      if (top + h > doc.page.height - pdf.margin - 20) {
        doc.addPage();
        top = pdf.margin;
      }
      const a = c.address ?? {};
      const lines = [
        c.name,
        [a.street, a.number].filter(Boolean).join(', ') + (a.complement ? ` - ${a.complement}` : ''),
        [a.neighborhood, a.city && a.state ? `${a.city}/${a.state}` : a.city].filter(Boolean).join(' - '),
        a.zip ? `CEP ${formatCep(a.zip)}` : '',
      ].filter((l) => l && l.trim());
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#212429').text(lines[0] ?? '', pdf.margin + col * w + 6, top + 6, { width: w - 12 });
      doc.font('Helvetica').fontSize(8).text(lines.slice(1).join('\n'), { width: w - 12 });
      doc.rect(pdf.margin + col * w, top, w - 4, h - 4).lineWidth(0.3).strokeColor('#cfd3d8').stroke();
      i++;
    }
    const buf = await pdf.finish();
    return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'attachment; filename="etiquetas.pdf"').send(buf);
  });

  // ------------------------------------------------------------ procuradores
  /** Quem administra procuradores vê os dados completos; os demais, só id e nome (seletores). */
  const PROCURATOR_ADMIN = ['procuration.list', 'procuration.edit', 'procuration.certificate'];

  app.get('/procurators', async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select({ p: procurators, customers: count(customers.id) })
      .from(procurators)
      .leftJoin(customers, and(eq(customers.procuratorId, procurators.id), isNull(customers.deletedAt)))
      .where(eq(procurators.officeId, user.officeId))
      .groupBy(procurators.id)
      .orderBy(asc(procurators.name));
    if (!PROCURATOR_ADMIN.some((perm) => can(user, perm))) return rows.map(({ p }) => ({ id: p.id, name: p.name }));
    return rows.map(({ p, customers: n }) => ({ ...publicProcurator(p), customers: n }));
  });

  const procuratorBody = z.object({
    name: z.string().trim().min(2).max(200),
    cpfCnpj: z.string().refine(isValidCpfCnpj, 'CPF/CNPJ inválido'),
    authType: z.enum(['govbr', 'certificate_local', 'certificate_cloud']).optional(),
    userId: z.uuid().nullable().optional(),
    certificateExpiresAt: z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional()),
  });

  app.post('/procurators', { preHandler: guard('procuration.edit') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(procuratorBody, req.body);
    const doc = onlyDigits(body.cpfCnpj);
    const dup = await db.query.procurators.findFirst({ where: and(eq(procurators.officeId, user.officeId), eq(procurators.cpfCnpj, doc)) });
    if (dup) throw conflict('Já existe um procurador com este CPF/CNPJ.');
    if (body.userId && !(await db.query.users.findFirst({ where: and(eq(users.id, body.userId), eq(users.officeId, user.officeId)) }))) throw badRequest('Colaborador inválido.');
    const [row] = await db.insert(procurators).values({ ...body, authType: body.authType ?? 'govbr', cpfCnpj: doc, officeId: user.officeId }).returning();
    reply.status(201);
    return publicProcurator(row);
  });

  app.put('/procurators/:id', { preHandler: guard('procuration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(procuratorBody, req.body);
    const doc = onlyDigits(body.cpfCnpj);
    const dup = await db.query.procurators.findFirst({ where: and(eq(procurators.officeId, user.officeId), eq(procurators.cpfCnpj, doc), ne(procurators.id, id)) });
    if (dup) throw conflict('Já existe um procurador com este CPF/CNPJ.');
    if (body.userId && !(await db.query.users.findFirst({ where: and(eq(users.id, body.userId), eq(users.officeId, user.officeId)) }))) throw badRequest('Colaborador inválido.');
    // sem authType no corpo, mantém a forma de acesso atual
    const [row] = await db
      .update(procurators)
      .set({ ...body, cpfCnpj: doc, updatedAt: new Date() })
      .where(and(eq(procurators.id, id), eq(procurators.officeId, user.officeId)))
      .returning();
    if (!row) throw notFound('Procurador');
    return publicProcurator(row);
  });

  app.delete('/procurators/:id', { preHandler: guard('procuration.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const rows = await db.delete(procurators).where(and(eq(procurators.id, id), eq(procurators.officeId, user.officeId))).returning();
    if (!rows.length) throw notFound('Procurador');
    await db.update(customers).set({ procurationStatus: 'none' }).where(and(eq(customers.officeId, user.officeId), isNull(customers.procuratorId), ne(customers.procurationStatus, 'none')));
    return { ok: true };
  });

  /**
   * Procurador que o usuário pode alterar: com a permissão, qualquer um do escritório;
   * sem ela, só o registro em que ele mesmo é o procurador (Minha conta).
   */
  async function procuratorForUpdate(req: FastifyRequest, permission: string) {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const admin = can(user, permission);
    const p = await db.query.procurators.findFirst({
      where: and(eq(procurators.id, id), eq(procurators.officeId, user.officeId), ...(admin ? [] : [eq(procurators.userId, user.userId)])),
    });
    if (!p) throw admin ? notFound('Procurador') : forbidden();
    return { user, p };
  }

  /** Forma de acesso do procurador (gov.br ou certificado); o próprio procurador também pode mudar. */
  app.patch('/procurators/:id/auth-type', async (req) => {
    const { p } = await procuratorForUpdate(req, 'procuration.edit');
    const { authType } = parse(z.object({ authType: z.enum(['govbr', 'certificate_local', 'certificate_cloud']) }), req.body);
    const [row] = await db.update(procurators).set({ authType, updatedAt: new Date() }).where(eq(procurators.id, p.id)).returning();
    await audit(req, 'update_auth_type', 'procurator', p.id, { authType });
    return publicProcurator(row);
  });

  /** Certificado digital A1 (.pfx) do procurador, com a senha cifrada; o próprio procurador também pode enviar. */
  app.post('/procurators/:id/certificate', async (req) => {
    const { user, p } = await procuratorForUpdate(req, 'procuration.certificate');
    const { files: received, fields } = await readUploads(req, {
      types: CERTIFICATE_TYPES,
      maxFiles: 1,
      maxBytes: 1024 * 1024,
      accepted: 'o arquivo .pfx ou .p12 do certificado A1',
    });
    const file = received[0];
    if (!file) throw badRequest('Envie o arquivo .pfx ou .p12 do certificado A1.');
    const password = fields.password ?? '';
    if (!password) throw badRequest('Informe a senha de instalação do certificado.');
    const saved = await app.ctx.files.save({ officeId: user.officeId, data: file.data, filename: file.filename, mimeType: file.mimeType, userId: user.userId });
    if (p.certificateFileId) await app.ctx.files.remove(user.officeId, p.certificateFileId);
    await db
      .update(procurators)
      .set({ certificateFileId: saved.id, certificatePasswordEnc: secrets.encrypt(password), authType: 'certificate_cloud', updatedAt: new Date() })
      .where(eq(procurators.id, p.id));
    await audit(req, 'upload_certificate', 'procurator', p.id, { self: p.userId === user.userId });
    return { ok: true };
  });

  app.delete('/procurators/:id/certificate', async (req) => {
    const { user, p } = await procuratorForUpdate(req, 'procuration.certificate');
    if (p.certificateFileId) await app.ctx.files.remove(user.officeId, p.certificateFileId);
    await db.update(procurators).set({ certificateFileId: null, certificatePasswordEnc: null, updatedAt: new Date() }).where(eq(procurators.id, p.id));
    await audit(req, 'remove_certificate', 'procurator', p.id, { self: p.userId === user.userId });
    return { ok: true };
  });
}

type ProcuratorRow = typeof procurators.$inferSelect;

/** Procurador para o navegador: sem o arquivo e sem a senha do certificado (regra 6). */
export function publicProcurator(p: ProcuratorRow) {
  const { certificateFileId, certificatePasswordEnc, ...rest } = p;
  return { ...rest, hasCertificate: Boolean(certificateFileId && certificatePasswordEnc) };
}
