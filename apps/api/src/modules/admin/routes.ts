import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DECLARATION_SUBSTATUS, PERMISSION_CATEGORIES, isPermission, isValidCpfCnpj, isValidEmail, onlyDigits, type DeclarationSubstatus } from '@verifco/shared';
import type { AuthUser } from '../../context';
import { contracts, customerGroupMembers, customerGroups, customers, offices, passwordResets, roles, users } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { exposeDevSecrets } from '../../config';
import { audit, can, guard, optionalText, parse, requirePermission, requireUser, uuidParam } from '../../lib/http';
import { DEFAULT_SETTINGS, getOfficeSettings } from '../../services/settings';
import { LOGO_TYPES, readUploads } from '../../services/uploads';
import { EMAIL_CHANGED_JOB, type EmailChangedPayload } from '../auth/jobs';

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
  /** Dados do escritório; as preferências só para quem tem settings.view ou settings.edit. */
  app.get('/office', async (req) => {
    const user = requireUser(req);
    const office = await db.query.offices.findFirst({ where: eq(offices.id, user.officeId) });
    if (!office) throw notFound('Escritório');
    return officeView(user, office);
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
    // mesmo formato do GET: quem só edita os dados do escritório não recebe as preferências
    return officeView(user, row);
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
    // os PDFs só desenham PNG/JPG; SVG ficaria de fora e ainda pode carregar script
    const {
      files: [file],
    } = await readUploads(req, { types: LOGO_TYPES, maxBytes: LOGO_MAX_BYTES, maxFiles: 1, accepted: 'uma imagem PNG ou JPG de até 2 MB' });
    if (!file) throw badRequest('Envie uma imagem.');
    const saved = await app.ctx.files.save({ officeId: user.officeId, data: file.data, filename: file.filename, mimeType: file.mimeType, userId: user.userId });
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
    assertGrantable(user, body.permissions);
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
    // quem não é dono só mexe em funções que não passam das próprias permissões
    assertGrantable(user, role.permissions, 'Esta função tem permissões que você não tem. Peça ao dono da conta para alterá-la.');
    assertGrantable(user, body.permissions);
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
    assertRoleAssignable(user, role);
    const exists = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${body.email.toLowerCase()}` });
    if (exists) throw conflict('Já existe um usuário com este e-mail.');
    const [row] = await db
      .insert(users)
      .values({ officeId: user.officeId, name: body.name, email: body.email.toLowerCase(), roleId: body.roleId, passwordHash: null })
      .returning();
    const link = await sendInvite(req, user, row);
    await audit(req, 'create', 'employee', row.id, { email: row.email });
    reply.status(201);
    return { id: row.id, name: row.name, email: row.email, roleId: row.roleId, inviteLink: exposeDevSecrets(app.ctx.config) ? link : undefined };
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
    return { ok: true, inviteLink: exposeDevSecrets(app.ctx.config) ? link : undefined };
  });

  /** Quem não é dono só administra colaboradores cuja função não passa das próprias permissões. */
  async function assertCanManage(user: AuthUser, target: { isOwner: boolean; roleId: string | null }) {
    if (user.isOwner) return;
    if (target.isOwner) throw forbidden('Só o dono da conta pode alterar os dados dele.');
    const role = target.roleId ? await db.query.roles.findFirst({ where: eq(roles.id, target.roleId) }) : null;
    if (role && role.permissions.some((p) => !user.permissions.has(p))) {
      throw forbidden('Este colaborador tem permissões que você não tem. Peça ao dono da conta para alterá-lo.');
    }
  }

  /** Avisa o endereço antigo de que o e-mail de acesso mudou (pela fila, com repetição se o envio falhar). */
  async function notifyEmailChange(by: AuthUser, target: { id: string; email: string }, newEmail: string) {
    const payload: EmailChangedPayload = { userId: target.id, oldEmail: target.email, newEmail, changedBy: by.name };
    await app.ctx.jobs.enqueue(EMAIL_CHANGED_JOB, payload, { officeId: by.officeId, userId: by.userId });
  }

  app.put('/employees/:id', { preHandler: guard('employee.edit') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(employeeBody, req.body);
    const target = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.officeId, user.officeId)) });
    if (!target) throw notFound('Colaborador');
    const role = await db.query.roles.findFirst({ where: and(eq(roles.id, body.roleId), eq(roles.officeId, user.officeId)) });
    if (!role) throw badRequest('Função inválida.');
    const email = body.email.toLowerCase();
    const emailChanged = email !== target.email.toLowerCase();
    const roleChanged = body.roleId !== target.roleId;
    const activeChanged = body.isActive !== undefined && body.isActive !== target.isActive;
    const self = target.id === user.userId;
    // a própria função, o próprio e-mail e a própria situação só mudam por outra pessoa (ou pelo dono)
    if (self && !user.isOwner && (emailChanged || roleChanged || activeChanged)) {
      throw forbidden('Você não pode alterar o próprio e-mail, função ou situação. Peça a quem administra o escritório.');
    }
    await assertCanManage(user, target);
    if (roleChanged) assertRoleAssignable(user, role);
    if (target.isOwner && (body.isActive === false || !role.isSystem)) throw badRequest('O dono da conta precisa continuar ativo e administrador.');
    const clash = await db.query.users.findFirst({ where: and(sql`lower(${users.email}) = ${email}`, ne(users.id, id)) });
    if (clash) throw conflict('Já existe um usuário com este e-mail.');
    const deactivating = body.isActive === false && target.isActive;
    // e-mail novo de outra pessoa: encerra as sessões dela e invalida links de senha pendentes
    const resetSessions = deactivating || (emailChanged && !self);
    const [row] = await db
      .update(users)
      .set({
        name: body.name,
        email,
        roleId: body.roleId,
        isActive: body.isActive ?? target.isActive,
        tokenVersion: resetSessions ? target.tokenVersion + 1 : target.tokenVersion,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    if (emailChanged) {
      await db.update(passwordResets).set({ usedAt: new Date() }).where(and(eq(passwordResets.userId, target.id), isNull(passwordResets.usedAt)));
      await notifyEmailChange(user, target, email);
    }
    await audit(req, 'update', 'employee', id, emailChanged ? { emailChanged: true, from: target.email, to: email } : undefined);
    return { id: row.id, name: row.name, email: row.email, roleId: row.roleId, isActive: row.isActive };
  });

  app.delete('/employees/:id', { preHandler: guard('employee.delete') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const target = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.officeId, user.officeId)) });
    if (!target) throw notFound('Colaborador');
    if (target.isOwner) throw badRequest('O dono da conta não pode ser excluído.');
    if (target.id === user.userId) throw badRequest('Você não pode excluir o próprio usuário.');
    await assertCanManage(user, target);
    await db.delete(users).where(eq(users.id, id));
    await audit(req, 'delete', 'employee', id, { email: target.email });
    return { ok: true };
  });

  // ---------------------------------------------------------------- grupos de clientes
  /** Grupos com a quantidade de clientes (não excluídos) em cada um. */
  app.get('/customer-groups', async (req) => {
    const user = requirePermission(req);
    // os seletores (cadastro, filtros) só precisam de id e nome; a contagem é da tela de grupos
    if (!GROUP_ADMIN.some((p) => can(user, p))) {
      return db
        .select({ id: customerGroups.id, name: customerGroups.name })
        .from(customerGroups)
        .where(eq(customerGroups.officeId, user.officeId))
        .orderBy(asc(customerGroups.name));
    }
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

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const GROUP_ADMIN = ['customer_group.list', 'customer_group.create', 'customer_group.edit', 'customer_group.delete'];

const canSeeSettings = (user: AuthUser) => can(user, 'settings.view') || can(user, 'settings.edit');

/** Escritório como a API devolve (GET e PUT /office): as preferências só para quem pode vê-las. */
function officeView(user: AuthUser, office: typeof offices.$inferSelect) {
  const { settings, ...rest } = office;
  return canSeeSettings(user) ? { ...rest, settings: { ...DEFAULT_SETTINGS, ...settings } } : rest;
}

/**
 * Quem não é dono só concede permissões que ele mesmo tem (evita, por exemplo, que quem tem
 * role.edit ou employee.create se dê acesso total).
 */
function assertGrantable(user: AuthUser, permissions: readonly string[], message = 'Você só pode conceder permissões que você mesmo tem.') {
  if (user.isOwner) return;
  if (permissions.some((p) => !user.permissions.has(p))) throw forbidden(message);
}

/** A função Administrador só é atribuída pelo dono; as demais, se não passarem das permissões de quem atribui. */
function assertRoleAssignable(user: AuthUser, role: { isSystem: boolean; permissions: string[] }) {
  if (user.isOwner) return;
  if (role.isSystem) throw forbidden('Só o dono da conta pode atribuir a função Administrador.');
  assertGrantable(user, role.permissions, 'Você só pode atribuir funções com permissões que você mesmo tem.');
}
