import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checklistLock, checklistProgress, currentExerciseYear, customerDeclarationStatus, isValidCpfCnpj, onlyDigits, stageOfSubstatus, type DeclarationSubstatus } from '@verifco/shared';
import {
  auditLogs,
  backlogs,
  checklistItems,
  checklistSections,
  checklists,
  customers,
  declarations,
  documents,
  files,
  messages,
  offices,
} from '../../db/schema';
import { safeEqual, sha256 } from '../../lib/crypto';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import { signCustomerToken } from '../../plugins/auth';
import { CUSTOMER_LOGIN_RULE, check, fail, resetLimit } from '../../services/rate-limit';
import { getOfficeSettings } from '../../services/settings';
import { sendStoredFile } from '../../services/uploads';
import { firstName, maskCpf, requirePortal } from './access';

/**
 * Portal do cliente: login com CPF + código do portal (gerado em
 * `POST /customers/:id/portal-access`), status das declarações, pendências,
 * checklist do ano, documentos do escritório e mensagens (módulo messages).
 */
export async function portalRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  app.post('/portal/login', async (req) => {
    const body = parse(
      z.object({ cpf: z.string().max(20), code: z.string().max(12), officeId: z.uuid().optional() }),
      req.body,
    );
    const cpf = onlyDigits(body.cpf);
    if (!isValidCpfCnpj(cpf)) throw badRequest('Informe um CPF válido.');
    const code = onlyDigits(body.code);
    // falhas por CPF no banco (valem para todas as instâncias), além do limite por IP de app.ts
    const key = `portal:${cpf}`;
    await check(ctx, key, CUSTOMER_LOGIN_RULE);

    const candidates = await db
      .select({ customer: customers, officeName: offices.name })
      .from(customers)
      .innerJoin(offices, eq(offices.id, customers.officeId))
      .where(
        and(
          eq(customers.cpfCnpj, cpf),
          isNull(customers.deletedAt),
          eq(customers.portalEnabled, true),
          isNotNull(customers.portalCodeHash),
          ...(body.officeId ? [eq(customers.officeId, body.officeId)] : []),
        ),
      );
    const codeMatches = candidates.filter((c) => code.length > 0 && safeEqual(c.customer.portalCodeHash ?? '', sha256(`${c.customer.id}:${code}`)));
    const valid = codeMatches.filter((c) => !c.customer.portalCodeExpiresAt || c.customer.portalCodeExpiresAt.getTime() > Date.now());
    if (!valid.length) {
      if (codeMatches.length) throw new HttpError(401, 'Seu código expirou. Peça um novo código ao seu escritório.');
      await fail(ctx, key, CUSTOMER_LOGIN_RULE);
      throw new HttpError(401, 'CPF ou código incorretos. Confira os dados que o escritório enviou.');
    }
    // o mesmo CPF com o mesmo código em mais de um escritório: o cliente escolhe pelo nome
    if (valid.length > 1) {
      return { needsOffice: true, offices: valid.map((v) => ({ id: v.customer.officeId, name: v.officeName })).sort((a, b) => a.name.localeCompare(b.name)) };
    }
    await resetLimit(ctx, key);
    const { customer, officeName } = valid[0];
    await db.insert(auditLogs).values({ officeId: customer.officeId, userId: null, action: 'portal_login', entity: 'customer', entityId: customer.id });
    return {
      token: signCustomerToken(app, customer, 'portal'),
      customer: { firstName: firstName(customer.name) },
      office: { name: officeName },
    };
  });

  app.get('/portal/me', async (req) => {
    const auth = requirePortal(req);
    const customer = await db.query.customers.findFirst({ where: and(eq(customers.id, auth.customerId), eq(customers.officeId, auth.officeId)) });
    const office = await db.query.offices.findFirst({ where: eq(offices.id, auth.officeId) });
    if (!customer || !office) throw notFound('Cliente');
    const settings = await getOfficeSettings(db, office.id);
    return {
      customer: { name: customer.name, firstName: firstName(customer.name), cpf: maskCpf(customer.cpfCnpj), email: customer.email },
      office: { name: office.name, email: office.email, phone: office.phone, whatsapp: settings.whatsappServiceNumber || null },
    };
  });

  /** Tela inicial: declarações (atual e anterior), pendências, checklist, documentos e mensagens. */
  app.get('/portal/overview', async (req) => {
    const auth = requirePortal(req);
    const year = currentExerciseYear();
    const decls = await db
      .select()
      .from(declarations)
      .where(and(eq(declarations.customerId, auth.customerId), eq(declarations.officeId, auth.officeId), inArray(declarations.exerciseYear, [year, year - 1])));
    const declarationCards = [year, year - 1].map((y) => {
      const d = decls.find((x) => x.exerciseYear === y);
      const substatus = (d?.substatus ?? 'not_started') as DeclarationSubstatus;
      const stage = stageOfSubstatus(substatus);
      const delivered = stage === 'transmitted' || stage === 'finished';
      return {
        exerciseYear: y,
        calendarYear: y - 1,
        stage,
        status: customerDeclarationStatus(substatus),
        transmittedAt: d?.transmittedAt ?? null,
        refundCents: delivered ? (d?.refundCents ?? 0) : 0,
        taxDueCents: delivered ? (d?.taxDueCents ?? 0) : 0,
      };
    });

    const pendencies = await db
      .select({ id: backlogs.id, description: backlogs.description, dueDate: backlogs.dueDate, exerciseYear: declarations.exerciseYear, createdAt: backlogs.createdAt })
      .from(backlogs)
      .innerJoin(declarations, eq(declarations.id, backlogs.declarationId))
      .where(and(eq(backlogs.customerId, auth.customerId), eq(backlogs.officeId, auth.officeId), isNull(backlogs.resolvedAt)))
      .orderBy(asc(backlogs.dueDate), asc(backlogs.createdAt));

    const current = decls.find((d) => d.exerciseYear === year);
    const checklistRow = current ? await db.query.checklists.findFirst({ where: eq(checklists.declarationId, current.id) }) : null;
    let checklist = null;
    if (checklistRow && current) {
      const items = await db.select({ status: checklistItems.status }).from(checklistItems).where(eq(checklistItems.checklistId, checklistRow.id));
      const sections = await db.select({ status: checklistSections.status }).from(checklistSections).where(eq(checklistSections.checklistId, checklistRow.id));
      const lock = checklistLock(await getOfficeSettings(db, auth.officeId), current);
      checklist = {
        id: checklistRow.id,
        exerciseYear: year,
        progress: checklistProgress(items),
        sectionsTotal: sections.length,
        sectionsDone: sections.filter((s) => s.status !== 'open').length,
        sectionsPending: sections.filter((s) => s.status === 'pending_documents').length,
        finishedAt: checklistRow.finishedAt,
        readOnly: lock.readOnly,
      };
    }

    const sharedDocs = await db
      .select({ id: documents.id, filename: files.filename, size: files.size, createdAt: documents.createdAt, exerciseYear: declarations.exerciseYear })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .leftJoin(declarations, eq(declarations.id, documents.declarationId))
      .where(and(eq(documents.customerId, auth.customerId), eq(documents.officeId, auth.officeId), eq(documents.uploadedBy, 'office'), eq(documents.category, 'shared_with_customer')))
      .orderBy(desc(documents.createdAt))
      .limit(100);

    const [{ unread }] = await db
      .select({ unread: count() })
      .from(messages)
      .where(and(eq(messages.customerId, auth.customerId), eq(messages.officeId, auth.officeId), eq(messages.direction, 'out'), isNull(messages.readAt)));

    return { exerciseYear: year, declarations: declarationCards, pendencies, checklist, documents: sharedDocs, unreadMessages: unread };
  });

  /** Download de documento que o escritório compartilhou com o cliente. */
  app.get('/portal/documents/:id', async (req, reply) => {
    const auth = requirePortal(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.id, id),
        eq(documents.customerId, auth.customerId),
        eq(documents.officeId, auth.officeId),
        eq(documents.uploadedBy, 'office'),
        eq(documents.category, 'shared_with_customer'),
      ),
    });
    if (!doc) throw notFound('Documento');
    const { row, data } = await ctx.files.get(auth.officeId, doc.fileId);
    return sendStoredFile(reply, row, data, (req.query as Record<string, string>).inline === '1');
  });
}
