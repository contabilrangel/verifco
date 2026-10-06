import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { formatCpfCnpj, formatDate } from '@verifco/shared';
import { aiAnalyses, aiConversations, aiMessages, declarations, documents, files } from '../../db/schema';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { audit, can, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { getCustomerForUser } from '../../services/customers';
import { PdfBuilder, loadBranding } from '../../services/pdf';
import type { AiMessage } from '../../integrations/providers';
import {
  ASSISTANTS,
  ASSISTANT_KEYS,
  DEFENSE_PROMPT,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentsForAi,
  completeWithTimeout,
  isSupportedAttachment,
  systemPrompt,
  type AssistantKey,
} from './ai-service';
import { clientContextText, requireAll } from './common';
import { copilotContextText, requireActiveEnrollment } from './copilot';
import { writeMarkdown, writePlainText } from './pdf-text';

const assistantParams = z.object({ id: z.uuid(), assistant: z.enum(ASSISTANT_KEYS as [AssistantKey, ...AssistantKey[]]) });
const ratingBody = z.object({ rating: z.union([z.literal(1), z.literal(-1), z.null()]) });
const AI_ANY = ['ai.use', 'irpfm.view', 'copilot.use'];

export async function aiRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  async function assistantAccess(req: FastifyRequest, customerId: string, assistant: AssistantKey) {
    const user = requireAll(req, ...ASSISTANTS[assistant].perms);
    const customer = await getCustomerForUser(app.ctx, user, customerId);
    if (assistant === 'copilot') await requireActiveEnrollment(app.ctx, user.officeId, customer.id);
    return { user, customer };
  }

  const activeConversation = (officeId: string, customerId: string, assistant: AssistantKey) =>
    db.query.aiConversations.findFirst({
      where: and(
        eq(aiConversations.officeId, officeId),
        eq(aiConversations.customerId, customerId),
        eq(aiConversations.assistant, assistant),
        isNull(aiConversations.archivedAt),
      ),
      orderBy: desc(aiConversations.createdAt),
    });

  const listMessages = (conversationId: string) =>
    db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(asc(aiMessages.createdAt));

  /** Documentos do cliente que podem ir como anexo (verifica o dono). */
  async function documentFileIds(officeId: string, customerId: string, documentIds: string[]) {
    if (!documentIds.length) return [];
    const rows = await db
      .select({ id: documents.id, fileId: documents.fileId })
      .from(documents)
      .where(and(eq(documents.officeId, officeId), eq(documents.customerId, customerId), inArray(documents.id, documentIds)));
    if (rows.length !== new Set(documentIds).size) throw badRequest('Documento não encontrado para este cliente.');
    return rows.map((r) => r.fileId);
  }

  async function contextFor(officeId: string, customer: { id: string; name: string }, assistant: AssistantKey, year: number) {
    const base = await clientContextText(app.ctx, officeId, customer, year);
    if (assistant !== 'copilot') return base;
    return `${base}\n\n${await copilotContextText(app.ctx, officeId, customer.id, new Date().getFullYear())}`;
  }

  // ------------------------------------------------------------------ conversa
  app.get('/customers/:id/ai/:assistant', async (req) => {
    const { id, assistant } = parse(assistantParams, req.params);
    const { user, customer } = await assistantAccess(req, id, assistant);
    const conv = await activeConversation(user.officeId, customer.id, assistant);
    return {
      assistant,
      label: ASSISTANTS[assistant].label,
      conversation: conv ? { id: conv.id, title: conv.title, createdAt: conv.createdAt } : null,
      messages: conv ? await listMessages(conv.id) : [],
    };
  });

  app.post('/customers/:id/ai/:assistant/messages', async (req) => {
    const { id, assistant } = parse(assistantParams, req.params);
    const body = parse(
      z.object({
        content: z.string().trim().min(1, 'Digite sua pergunta').max(8000),
        year: yearSchema,
        attachments: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
        documentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
      }),
      req.body,
    );
    const { user, customer } = await assistantAccess(req, id, assistant);
    const fileIds = [...new Set([...body.attachments, ...(await documentFileIds(user.officeId, customer.id, body.documentIds))])];
    if (fileIds.length > MAX_ATTACHMENTS) throw badRequest(`Envie no máximo ${MAX_ATTACHMENTS} anexos por mensagem.`);
    const att = await attachmentsForAi(app.ctx, user.officeId, fileIds);

    const conv = await activeConversation(user.officeId, customer.id, assistant);
    const history = conv ? (await listMessages(conv.id)).slice(-20) : [];
    const messages: AiMessage[] = history.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.attachments.length ? `${m.content}\n[anexos enviados: ${m.attachments.map((a) => a.filename).join(', ')}]` : m.content,
    }));
    messages.push({
      role: 'user',
      content: att.texts.length ? `${body.content}\n\n${att.texts.join('\n\n')}` : body.content,
      files: att.files.length ? att.files : undefined,
    });
    const system = systemPrompt(assistant, await contextFor(user.officeId, customer, assistant, body.year));
    const reply = await completeWithTimeout(app.ctx, user.officeId, { system, messages, maxTokens: 4000 });

    const conversation =
      conv ??
      (
        await db
          .insert(aiConversations)
          .values({ officeId: user.officeId, customerId: customer.id, assistant, title: body.content.slice(0, 80), createdByUserId: user.userId })
          .returning()
      )[0];
    const [userMessage] = await db.insert(aiMessages).values({ conversationId: conversation.id, role: 'user', content: body.content, attachments: att.names }).returning();
    const [assistantMessage] = await db
      .insert(aiMessages)
      .values({ conversationId: conversation.id, role: 'assistant', content: reply.text, inputTokens: reply.inputTokens ?? null, outputTokens: reply.outputTokens ?? null })
      .returning();
    return { conversationId: conversation.id, userMessage, assistantMessage };
  });

  app.post('/customers/:id/ai/:assistant/restart', async (req) => {
    const { id, assistant } = parse(assistantParams, req.params);
    const { user, customer } = await assistantAccess(req, id, assistant);
    const conv = await activeConversation(user.officeId, customer.id, assistant);
    if (conv) {
      await db.update(aiConversations).set({ archivedAt: new Date() }).where(eq(aiConversations.id, conv.id));
      await audit(req, 'archive', 'ai_conversation', conv.id, { assistant });
    }
    return { ok: true, archived: Boolean(conv) };
  });

  app.put('/ai/messages/:id/rating', async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { rating } = parse(ratingBody, req.body);
    const [row] = await db
      .select({ m: aiMessages, c: aiConversations })
      .from(aiMessages)
      .innerJoin(aiConversations, eq(aiConversations.id, aiMessages.conversationId))
      .where(and(eq(aiMessages.id, id), eq(aiConversations.officeId, user.officeId)));
    if (!row || row.m.role !== 'assistant') throw notFound('Mensagem');
    const perms = ASSISTANTS[row.c.assistant as AssistantKey]?.perms ?? ['ai.use'];
    if (!perms.every((p) => can(user, p))) throw forbidden();
    if (row.c.customerId) await getCustomerForUser(app.ctx, user, row.c.customerId);
    const [updated] = await db.update(aiMessages).set({ rating }).where(eq(aiMessages.id, id)).returning();
    return updated;
  });

  // ------------------------------------------------------------------ anexos e documentos
  app.post('/customers/:id/ai/attachments', async (req, reply) => {
    const user = requireUser(req);
    if (!AI_ANY.some((p) => can(user, p))) throw forbidden();
    const { id } = parse(uuidParam, req.params);
    await getCustomerForUser(app.ctx, user, id);
    const saved: { fileId: string; filename: string; mimeType: string; size: number }[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const data = await part.toBuffer();
      if (!isSupportedAttachment(part.filename, part.mimetype)) throw badRequest(`Tipo de arquivo não aceito: ${part.filename}. Use PDF, imagem, CSV, TXT ou XLSX.`);
      if (data.length > MAX_ATTACHMENT_BYTES) throw badRequest(`${part.filename} passa de 15 MB.`);
      const row = await app.ctx.files.save({ officeId: user.officeId, data, filename: part.filename, mimeType: part.mimetype, userId: user.userId });
      saved.push({ fileId: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size });
      if (saved.length > MAX_ATTACHMENTS) throw badRequest(`Envie no máximo ${MAX_ATTACHMENTS} arquivos.`);
    }
    if (!saved.length) throw badRequest('Selecione ao menos um arquivo.');
    reply.status(201);
    return saved;
  });

  app.get('/customers/:id/ai/documents', async (req) => {
    const user = requireUser(req);
    if (!AI_ANY.some((p) => can(user, p))) throw forbidden();
    const { id } = parse(uuidParam, req.params);
    const customer = await getCustomerForUser(app.ctx, user, id);
    return db
      .select({
        id: documents.id,
        fileId: documents.fileId,
        filename: files.filename,
        mimeType: files.mimeType,
        size: files.size,
        category: documents.category,
        exerciseYear: declarations.exerciseYear,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .leftJoin(declarations, eq(declarations.id, documents.declarationId))
      .where(and(eq(documents.officeId, user.officeId), eq(documents.customerId, customer.id)))
      .orderBy(desc(documents.createdAt));
  });

  // ------------------------------------------------------------------ defesa administrativa (malha fina)
  app.post('/customers/:id/ai/fine_mesh/defense', async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ year: yearSchema, notes: z.string().trim().max(4000).optional() }), req.body);
    const { user, customer } = await assistantAccess(req, id, 'fine_mesh');
    const conv = await activeConversation(user.officeId, customer.id, 'fine_mesh');
    const history = conv ? (await listMessages(conv.id)).slice(-20) : [];
    const messages: AiMessage[] = history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    messages.push({ role: 'user', content: `Gere agora a minuta da defesa administrativa.${body.notes ? `\nObservações do contador: ${body.notes}` : ''}` });
    const system = `${systemPrompt('fine_mesh', await clientContextText(app.ctx, user.officeId, customer, body.year))}\n\n${DEFENSE_PROMPT}`;
    const out = await completeWithTimeout(app.ctx, user.officeId, { system, messages, maxTokens: 6000 });
    // o CPF não vai para a IA: os marcadores são preenchidos aqui
    const text = out.text.replaceAll('[NOME DO CONTRIBUINTE]', customer.name).replaceAll('[CPF DO CONTRIBUINTE]', formatCpfCnpj(customer.cpfCnpj));
    const [row] = await db
      .insert(aiAnalyses)
      .values({ officeId: user.officeId, customerId: customer.id, kind: 'fine_mesh_defense', status: 'done', result: text, createdByUserId: user.userId })
      .returning();
    await audit(req, 'generate', 'ai_defense', row.id);
    reply.status(201);
    return row;
  });

  // ------------------------------------------------------------------ análises (assessor financeiro e defesas)
  const kindQuery = z.object({ kind: z.enum(['financial_advisor', 'fine_mesh_defense']).default('financial_advisor') });

  app.get('/customers/:id/ai/analyses', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { kind } = parse(kindQuery, req.query);
    const user = requireAll(req, 'ai.use');
    const customer = await getCustomerForUser(app.ctx, user, id);
    return db
      .select()
      .from(aiAnalyses)
      .where(and(eq(aiAnalyses.officeId, user.officeId), eq(aiAnalyses.customerId, customer.id), eq(aiAnalyses.kind, kind)))
      .orderBy(desc(aiAnalyses.createdAt))
      .limit(50);
  });

  async function createAnalysis(officeId: string, customerId: string, userId: string, documentIds: string[]) {
    const [row] = await db
      .insert(aiAnalyses)
      .values({ officeId, customerId, kind: 'financial_advisor', documentIds, status: 'queued', createdByUserId: userId })
      .returning();
    await app.ctx.jobs.enqueue('ai.financial_analysis', { analysisId: row.id }, { officeId, userId, maxAttempts: 1 });
    return row;
  }

  app.post('/customers/:id/ai/analyses', async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ documentIds: z.array(z.uuid()).min(1, 'Selecione ao menos um documento').max(10, 'Selecione no máximo 10 documentos') }), req.body);
    const user = requireAll(req, 'ai.use');
    const customer = await getCustomerForUser(app.ctx, user, id);
    const ids = [...new Set(body.documentIds)];
    await documentFileIds(user.officeId, customer.id, ids);
    const row = await createAnalysis(user.officeId, customer.id, user.userId, ids);
    await audit(req, 'create', 'ai_analysis', row.id, { documents: ids.length });
    reply.status(202);
    return row;
  });

  async function loadAnalysis(req: FastifyRequest) {
    const user = requireAll(req, 'ai.use');
    const { id } = parse(uuidParam, req.params);
    const row = await db.query.aiAnalyses.findFirst({ where: and(eq(aiAnalyses.id, id), eq(aiAnalyses.officeId, user.officeId)) });
    if (!row) throw notFound('Análise');
    const customer = await getCustomerForUser(app.ctx, user, row.customerId);
    return { user, row, customer };
  }

  app.get('/ai/analyses/:id', async (req) => (await loadAnalysis(req)).row);

  app.post('/ai/analyses/:id/regenerate', async (req, reply) => {
    const { user, row, customer } = await loadAnalysis(req);
    if (row.kind !== 'financial_advisor') throw badRequest('Só a análise do assessor financeiro pode ser gerada novamente.');
    await documentFileIds(user.officeId, customer.id, row.documentIds);
    reply.status(202);
    return createAnalysis(user.officeId, customer.id, user.userId, row.documentIds);
  });

  app.put('/ai/analyses/:id/rating', async (req) => {
    const { row } = await loadAnalysis(req);
    const { rating } = parse(ratingBody, req.body);
    const [updated] = await db.update(aiAnalyses).set({ rating }).where(eq(aiAnalyses.id, row.id)).returning();
    return updated;
  });

  app.get('/ai/analyses/:id/pdf', async (req, reply) => {
    const { user, row, customer } = await loadAnalysis(req);
    if (row.status !== 'done' || !row.result) throw badRequest('A análise ainda não foi concluída.');
    const title = row.kind === 'fine_mesh_defense' ? 'Minuta de defesa administrativa' : 'Análise financeira';
    const pdf = new PdfBuilder(await loadBranding(app.ctx, user.officeId), title, `${customer.name} · ${formatDate(row.createdAt)}`);
    if (row.kind === 'fine_mesh_defense') writePlainText(pdf, row.result);
    else writeMarkdown(pdf, row.result);
    pdf.rule().paragraph('Conteúdo gerado por inteligência artificial. Deve ser conferido pelo contador antes de qualquer uso.', { muted: true, size: 8 });
    const buf = await pdf.finish();
    const name = row.kind === 'fine_mesh_defense' ? 'minuta-defesa' : 'analise-financeira';
    return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${name}.pdf"`).send(buf);
  });
}
