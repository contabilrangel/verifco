import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DECLARATION_SUBSTATUS, PERMISSION_CATEGORIES, isPermission, isValidCpfCnpj, isValidEmail, onlyDigits, type DeclarationSubstatus } from '@verifco/shared';
import type { AuthUser } from '../../context';
import { contracts, customerGroupMembers, customerGroups, customers, offices, passwordResets, roles, users } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { audit, guard, optionalText, parse, requirePermission, requireUser, uuidParam } from '../../lib/http';
import { DEFAULT_SETTINGS, getOfficeSettings } from '../../services/settings';

const settingsSchema = z
  .object({
    restrictCustomersToResponsible: z.boolean(),
    autoSendDarfEmail: z.boolean(),
    notifyMainEmailOnEcacChanges: z.boolean(),
    simplifiedQueryWithoutProcurator: z.boolean(),
    autoGenerateCnd: z.boolean(),
    receiptTwoCopies: z.boolean(),
    receiptShowDetails: z.boolean(),
    authorizationShowDetails: z.boolean(),
    allowAuthorizationWithoutBudget: z.boolean(),
    cashAnalysisSimplifiedDiscount: z.enum(['standard', 'proportional']),
    checklistReadOnlyAfterStart: z.boolean(),
    lockChecklistFromSubstatus: z.enum(Object.keys(DECLARATION_SUBSTATUS) as [DeclarationSubstatus, ...DeclarationSubstatus[]]).nullable(),
    highNetWorthBaseCents: z.number().int().min(0),
    reportTitleColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    reportSubtitleColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    reportLineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    whatsappServiceNumber: z.string().trim().max(30).refine((v) => v === '' || /^[\d\s()+-]{10,30}$/.test(v), 'Número inválido'),
  })
  .partial();

export async function adminRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  // ---------------------------------------------------------------- escritório
  app.get('/office', async (req) => {
    const user = requireUser(req);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, user.officeId) });
    if (!office) throw notFound('Escritório');
    return { ...office, settings: { ...DEFAULT_SETTINGS, ...office.settings } };
  });

  app.put('/office', { preHandler: guard('office.edit') }, async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(200),
        cpfCnpj: optionalText,
        email: optionalText,
        phone: optionalText,
        website: optionalText,
        city: optionalText,
        state: optionalText,
      }),
      req.body,
    );
    if (body.cpfCnpj && !isValidCpfCnpj(body.cpfCnpj)) throw badRequest('CPF/CNPJ inválido.');
    if (body.email && !isValidEmail(body.email)) throw badRequest('E-mail inválido.');
    if (body.state && !/^[A-Za-z]{2}$/.test(body.state)) throw badRequest('UF deve ter 2 letras.');
    const website = body.website ? (/^https?:\/\//i.test(body.website) ? body.website : `https://${body.website}`) : null;
    if (website && !URL.canParse(website)) throw badRequest('Site inválido.');
    const [row] = await db
      .update(offices)
      .set({
        ...body,
        cpfCnpj: body.cpfCnpj ? onlyDigits(body.cpfCnpj) : null,
        email: body.email ? body.email.toLowerCase() : null,
        phone: body.phone ? onlyDigits(body.phone) : null,
        state: body.state ? body.state.toUpperCase() : null,
        website,
        updatedAt: new Date(),
      })
      .where(eq(offices.id, user.officeId))
      .returning();
    await audit(req, 'update', 'office', row.id);
    return row;
  });

  app.put('/office/settings', { preHandler: guard('settings.edit') }, async (req) => {
    const user = requireUser(req);
    const body = parse(settingsSchema, req.body);
    const current = await getOfficeSettings(db, user.officeId);
    const settings = { ...current, ...body };
    await db.update(offices).set({ settings, updatedAt: new Date() }).where(eq(offices.id, user.officeId));
    await audit(req, 'update', 'office_settings', user.officeId, body);
    return settings;
  });

  app.post('/office/logo', { preHandler: guard('office.edit') }, async (req) => {
    const user = requireUser(req);
    const file = await req.file();
    if (!file) throw badRequest('Envie uma imagem.');
    // os PDFs só desenham PNG/JPG; SVG ficaria de fora e ainda pode carregar script
    if (!/^image\/(png|jpe?g)$/.test(file.mimetype)) throw badRequest('Use uma imagem PNG ou JPG.');
    const data = await file.toBuffer();
    if (data.length > LOGO_MAX_BYTES) throw badRequest('A imagem deve ter até 2 MB.');
    const kind = imageKind(data);
    if (!kind) throw badRequest('O arquivo não é uma imagem PNG ou JPG válida.');
    const saved = await app.ctx.files.save({ officeId: user.officeId, data, filename: file.filename, mimeType: kind, userId: user.userId });
    const office = await db.query.offices.findFirst({ where: eq(offices.id, user.officeId) });
    await db.update(offices).set({ logoFileId: saved.id, updatedAt: new Date() }).where(eq(offices.id, user.officeId));
    if (office?.logoFileId) await app.ctx.files.remove(user.officeId, office.logoFileId);
    await audit(req, 'update_logo', 'office', user.officeId);
    return { logoFileId: saved.id };
  });

  app.delete('/office/logo', { preHandler: guard('office.edit') }, async (req) => {
    const user = requireUser(req);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, user.officeId) });
    if (!office?.logoFileId) return { ok: true };
    await db.update(offices).set({ logoFileId: null, updatedAt: new Date() }).where(eq(offices.id, user.officeId));
    await app.ctx.files.remove(user.officeId, office.logoFileId);
    await audit(req, 'remove_logo', 'office', user.officeId);
    return { ok: true };
  });

  app.get('/office/contracts', { preHandler: guard('contracts.view') }, async (req) => {
    const user = requireUser(req);
    return db.select().from(contracts).where(eq(contracts.officeId, user.officeId)).orderBy(sql`${contracts.startsAt} desc`);
  });

  // ---------------------------------------------------------------- funções
  app.get('/permissions/catalog', async (req) => {
    requireUser(req);
    return PERMISSION_CATEGORIES;
  });

  app.get('/roles', { preHandler: guard('role.list', 'employee.list') }, async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select({ id: roles.id, name: roles.name, permissions: roles.permissions, isSystem: roles.isSystem, users: count(users.id) })
      .from(roles)
      .leftJoin(users, eq(users.roleId, roles.id))
      .where(eq(roles.officeId, user.officeId))
      .groupBy(roles.id)
      .orderBy(asc(roles.name));
    return rows;
  });

  const roleBody = z.object({
    name: z.string().trim().min(2).max(100),
    permissions: z.array(z.string()).refine((list) => list.every(isPermission), 'Permissão desconhecida'),
  });

  const assertRoleNameFree = async (officeId: string, name: string, exceptId?: string) => {
    const clash = await db.query.roles.findFirst({
      where: and(eq(roles.officeId, officeId), sql`lower(${roles.name}) = ${name.toLowerCase()}`, exceptId ? ne(roles.id, exceptId) : undefined),
    });
    if (clash) throw conflict('Já existe uma função com este nome.');
  };

  app.post('/roles', { preHandler: guard('role.create') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(roleBody, req.body);
    await assertRoleNameFree(user.officeId, body.name);
    const [row] = await db.insert(roles).values({ officeId: user.officeId, ...body }).returning();
    await audit(req, 'create', 'role', row.id, { name: row.name });
    reply.status(201);
    return row;
  });

  app.put('/roles/:id', { preHandler: guard('role.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(roleBody, req.body);
    const role = await db.query.roles.findFirst({ where: and(eq(roles.id, id), eq(roles.officeId, user.officeId)) });
    if (!role) throw notFound('Função');
    if (role.isSystem) throw badRequest('A função Administrador não pode ser alterada.');
    await assertRoleNameFree(user.officeId, body.name, id);
    const [row] = await db.update(roles).set({ ...body, updatedAt: new Date() }).where(eq(roles.id, id)).returning();
    await audit(req, 'update', 'role', id, { permissions: body.permissions.length });
    return row;
  });

  app.delete('/roles/:id', { preHandler: guard('role.delete') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const role = await db.query.roles.findFirst({ where: and(eq(roles.id, id), eq(roles.officeId, user.officeId)) });
    if (!role) throw notFound('Função');
    if (role.isSystem) throw badRequest('A função Administrador não pode ser excluída.');
    const [{ n }] = await db.select({ n: count() }).from(users).where(eq(users.roleId, id));
    if (n > 0) throw conflict('Há colaboradores com esta função. Troque a função deles antes de excluir.');
    await db.delete(roles).where(eq(roles.id, id));
    await audit(req, 'delete', 'role', id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- colaboradores
  /** Convite: link para o colaborador definir a senha (válido por 7 dias). */
  async function sendInvite(req: Parameters<typeof requireUser>[0], by: AuthUser, target: { id: string; name: string; email: string }) {
    const token = randomToken();
    await db.insert(passwordResets).values({ userId: target.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 86400_000) });
    const link = `${app.ctx.config.WEB_URL}/redefinir-senha?token=${token}&convite=1`;
    const office = await db.query.offices.findFirst({ where: eq(offices.id, by.officeId) });
    await app.ctx.providers.email
      .send(by.officeId, {
        to: target.email,
        toName: target.name,
        subject: `Convite para o Verifco — ${office?.name ?? ''}`,
        html: `<p>Olá, ${escapeHtml(target.name)}.</p><p>${escapeHtml(by.name)} convidou você para acessar o Verifco do escritório ${escapeHtml(office?.name ?? '')}.</p><p>Defina sua senha em: <a href="${link}">${link}</a> (válido por 7 dias).</p>`,
      })
      .catch((err) => req.log.warn({ err }, 'falha ao enviar convite'));
    return link;
  }

  app.get('/employees', async (req) => {
    const user = requireUser(req);
    // a lista de responsáveis aparece em vários filtros; quem não tem employee.list vê só nome
    const full = user.isOwner || user.permissions.has('employee.list');
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        roleId: users.roleId,
        roleName: roles.name,
        isOwner: users.isOwner,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        invitePending: sql<boolean>`${users.passwordHash} is null`,
      })
      .from(users)
      .leftJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.officeId, user.officeId))
      .orderBy(asc(users.name));
    return full ? rows : rows.map((r) => ({ id: r.id, name: r.name }));
  });

  const employeeBody = z.object({
    name: z.string().trim().min(2).max(200),
    email: z.email(),
    roleId: z.uuid(),
    isActive: z.boolean().optional(),
  });

  app.post('/employees', { preHandler: guard('employee.create') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(employeeBody, req.body);
    const role = await db.query.roles.findFirst({ where: and(eq(roles.id, body.roleId), eq(roles.officeId, user.officeId)) });
    if (!role) throw badRequest('Função inválida.');
    const exists = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${body.email.toLowerCase()}` });
    if (exists) throw conflict('Já existe um usuário com este e-mail.');
    const [row] = await db
      .insert(users)
      .values({ officeId: user.officeId, name: body.name, email: body.email.toLowerCase(), roleId: body.roleId, passwordHash: null })
      .returning();
    const link = await sendInvite(req, user, row);
    await audit(req, 'create', 'employee', row.id, { email: row.email });
    reply.status(201);
    return { id: row.id, name: row.name, email: row.email, roleId: row.roleId, inviteLink: app.ctx.config.NODE_ENV === 'production' ? undefined : link };
  });

  /** Reenvia o convite de quem ainda não definiu a senha (o link anterior deixa de valer). */
  app.post('/employees/:id/invite', { preHandler: guard('employee.create', 'employee.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const target = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.officeId, user.officeId)) });
    if (!target) throw notFound('Colaborador');
    if (target.passwordHash) throw badRequest('Este colaborador já definiu a senha. Ele pode usar “Esqueci minha senha”.');
    if (!target.isActive) throw badRequest('Ative o colaborador antes de reenviar o convite.');
    await db.update(passwordResets).set({ usedAt: new Date() }).where(and(eq(passwordResets.userId, target.id), isNull(passwordResets.usedAt)));
    const link = await sendInvite(req, user, target);
    await audit(req, 'resend_invite', 'employee', target.id);
    return { ok: true, inviteLink: app.ctx.config.NODE_ENV === 'production' ? undefined : link };
  });

  app.put('/employees/:id', { preHandler: guard('employee.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(employeeBody, req.body);
    const target = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.officeId, user.officeId)) });
    if (!target) throw notFound('Colaborador');
    const role = await db.query.roles.findFirst({ where: and(eq(roles.id, body.roleId), eq(roles.officeId, user.officeId)) });
    if (!role) throw badRequest('Função inválida.');
    if (target.isOwner && (body.isActive === false || !role.isSystem)) throw badRequest('O dono da conta precisa continuar ativo e administrador.');
    const clash = await db.query.users.findFirst({ where: and(sql`lower(${users.email}) = ${body.email.toLowerCase()}`, ne(users.id, id)) });
    if (clash) throw conflict('Já existe um usuário com este e-mail.');
    const deactivating = body.isActive === false && target.isActive;
    const [row] = await db
      .update(users)
      .set({
        name: body.name,
        email: body.email.toLowerCase(),
        roleId: body.roleId,
        isActive: body.isActive ?? target.isActive,
        tokenVersion: deactivating ? target.tokenVersion + 1 : target.tokenVersion,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    await audit(req, 'update', 'employee', id);
    return { id: row.id, name: row.name, email: row.email, roleId: row.roleId, isActive: row.isActive };
  });

  app.delete('/employees/:id', { preHandler: guard('employee.delete') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const target = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.officeId, user.officeId)) });
    if (!target) throw notFound('Colaborador');
    if (target.isOwner) throw badRequest('O dono da conta não pode ser excluído.');
    if (target.id === user.userId) throw badRequest('Você não pode excluir o próprio usuário.');
    await db.delete(users).where(eq(users.id, id));
    await audit(req, 'delete', 'employee', id, { email: target.email });
    return { ok: true };
  });

  // ---------------------------------------------------------------- grupos de clientes
  /** Grupos com a quantidade de clientes (não excluídos) em cada um. */
  app.get('/customer-groups', async (req) => {
    const user = requirePermission(req);
    return db
      .select({ id: customerGroups.id, officeId: customerGroups.officeId, name: customerGroups.name, createdAt: customerGroups.createdAt, customers: count(customers.id) })
      .from(customerGroups)
      .leftJoin(customerGroupMembers, eq(customerGroupMembers.groupId, customerGroups.id))
      .leftJoin(customers, and(eq(customers.id, customerGroupMembers.customerId), isNull(customers.deletedAt)))
      .where(eq(customerGroups.officeId, user.officeId))
      .groupBy(customerGroups.id)
      .orderBy(asc(customerGroups.name));
  });

  const groupBody = z.object({ name: z.string().trim().min(1).max(120) });

  const assertGroupNameFree = async (officeId: string, name: string, exceptId?: string) => {
    const clash = await db.query.customerGroups.findFirst({
      where: and(eq(customerGroups.officeId, officeId), sql`lower(${customerGroups.name}) = ${name.toLowerCase()}`, exceptId ? ne(customerGroups.id, exceptId) : undefined),
    });
    if (clash) throw conflict('Já existe um grupo com este nome.');
  };

  app.post('/customer-groups', { preHandler: guard('customer_group.create') }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(groupBody, req.body);
    await assertGroupNameFree(user.officeId, body.name);
    const [row] = await db.insert(customerGroups).values({ officeId: user.officeId, name: body.name }).returning();
    await audit(req, 'create', 'customer_group', row.id, { name: row.name });
    reply.status(201);
    return row;
  });

  app.put('/customer-groups/:id', { preHandler: guard('customer_group.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(groupBody, req.body);
    await assertGroupNameFree(user.officeId, body.name, id);
    const [row] = await db
      .update(customerGroups)
      .set({ name: body.name })
      .where(and(eq(customerGroups.id, id), eq(customerGroups.officeId, user.officeId)))
      .returning();
    if (!row) throw notFound('Grupo');
    return row;
  });

  app.delete('/customer-groups/:id', { preHandler: guard('customer_group.delete') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const rows = await db.delete(customerGroups).where(and(eq(customerGroups.id, id), eq(customerGroups.officeId, user.officeId))).returning();
    if (!rows.length) throw notFound('Grupo');
    await audit(req, 'delete', 'customer_group', id, { name: rows[0].name });
    return { ok: true };
  });
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Tipo real da imagem pelos primeiros bytes (não confia no mimetype enviado). */
function imageKind(data: Buffer): 'image/png' | 'image/jpeg' | null {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  return null;
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
