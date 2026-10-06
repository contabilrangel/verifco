/**
 * Orçamentos em lote: modelo .xlsx pré-preenchido com os clientes e orçamentos do ano,
 * e importação que cria/atualiza orçamentos por CPF/CNPJ com resultado por linha. A importação
 * roda na fila de tarefas (`budget-import.ts`); a requisição só confere e guarda a planilha.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BUDGET_CATEGORIES, formatCpfCnpj } from '@verifco/shared';
import { budgets, customers, importBatches, paymentMethods } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { audit, guard, parse, requireUser, uuidParam, yearSchema } from '../../lib/http';
import { customerScope } from '../../services/customers';
import { SHEET_TYPES, readUploads } from '../../services/uploads';
import { buildWorkbook, readSheet } from '../../services/xlsx';
import { BUDGET_IMPORT_JOB, hasAmount, type BudgetImportPayload } from './budget-import';
import { brDate, budgetStatusLabel, categoryLabel } from './text';

const COLUMNS = [
  { header: 'CPF/CNPJ', key: 'doc', width: 18 },
  { header: 'Cliente', key: 'name', width: 34 },
  { header: 'Categoria', key: 'category', width: 26 },
  { header: 'Descrição', key: 'description', width: 36 },
  { header: 'Valor', key: 'amount', width: 14, type: 'money' as const },
  { header: 'Desconto (%)', key: 'discount', width: 14, type: 'number' as const },
  { header: 'Forma de pagamento', key: 'method', width: 22 },
  { header: 'Parcelas', key: 'installments', width: 10, type: 'number' as const },
  { header: 'Início da cobrança', key: 'start', width: 18 },
  { header: 'Status', key: 'status', width: 14 },
  { header: 'Observação interna', key: 'note', width: 36 },
];

export async function importRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  app.get('/finance/budget-import/template', { preHandler: guard('worksheet.budget') }, async (req, reply) => {
    const user = requireUser(req);
    const { year } = parse(z.object({ year: yearSchema }), req.query);
    const scope = await customerScope(ctx, user);
    const list = await db.select().from(customers).where(and(scope, eq(customers.status, 'active'))).orderBy(asc(customers.name));
    const ids = list.map((c) => c.id);
    const existing = ids.length
      ? await db
          .select()
          .from(budgets)
          .where(and(eq(budgets.officeId, user.officeId), eq(budgets.exerciseYear, year), inArray(budgets.customerId, ids), inArray(budgets.status, ['draft', 'sent', 'approved', 'rejected'])))
          .orderBy(asc(budgets.createdAt))
      : [];
    const methods = await db.select().from(paymentMethods).where(eq(paymentMethods.officeId, user.officeId)).orderBy(asc(paymentMethods.name));
    const rows: Record<string, unknown>[] = [];
    for (const c of list) {
      const mine = existing.filter((b) => b.customerId === c.id);
      if (!mine.length) {
        rows.push({ doc: formatCpfCnpj(c.cpfCnpj), name: c.name });
        continue;
      }
      for (const b of mine) {
        rows.push({
          doc: formatCpfCnpj(c.cpfCnpj),
          name: c.name,
          category: categoryLabel(b.category),
          description: b.description ?? '',
          amount: b.amountCents,
          discount: Number(b.discountPercent),
          method: methods.find((m) => m.id === b.paymentMethodId)?.name ?? '',
          installments: b.installments,
          start: brDate(b.billingStartDate),
          status: budgetStatusLabel(b.status),
          note: b.internalNote ?? '',
        });
      }
    }
    const help = [
      { field: 'CPF/CNPJ', rule: 'Obrigatório. Identifica o cliente já cadastrado.' },
      { field: 'Valor', rule: 'Valor do orçamento antes do desconto (ex.: 450,00). Linhas sem valor são ignoradas.' },
      { field: 'Categoria', rule: `Uma de: ${Object.values(BUDGET_CATEGORIES).join('; ')}. Vazio = Declaração IRPF.` },
      { field: 'Desconto (%)', rule: 'De 0 a 100. Vazio = sem desconto.' },
      { field: 'Forma de pagamento', rule: `Nome da forma cadastrada: ${methods.filter((m) => m.active).map((m) => `${m.name} (até ${m.maxInstallments}x)`).join('; ') || 'nenhuma cadastrada'}.` },
      { field: 'Parcelas', rule: 'Até o máximo da forma de pagamento. Vazio = 1.' },
      { field: 'Início da cobrança', rule: 'Data da 1ª parcela (DD/MM/AAAA). As demais vencem mês a mês.' },
      { field: 'Status', rule: 'Rascunho, Aprovado, Recusado ou Cancelado. Aprovar gera o faturamento. O envio ao cliente é feito pelo sistema.' },
      { field: 'Atualização', rule: 'Se o cliente já tem orçamento da mesma categoria no ano, ele é atualizado; senão, um novo é criado. Orçamentos aprovados não mudam de valor.' },
    ];
    const xlsx = await buildWorkbook([
      { name: `Orçamentos ${year}`, columns: COLUMNS, rows },
      { name: 'Instruções', columns: [{ header: 'Coluna', key: 'field', width: 24 }, { header: 'Como preencher', key: 'rule', width: 110 }], rows: help },
    ]);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="orcamentos-${year}.xlsx"`)
      .send(xlsx);
  });

  app.get('/finance/budget-import/batches', { preHandler: guard('worksheet.budget') }, async (req) => {
    const user = requireUser(req);
    return db
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.officeId, user.officeId), eq(importBatches.kind, 'budget')))
      .orderBy(desc(importBatches.createdAt))
      .limit(10);
  });

  /** Um lote do escritório: a tela acompanha a importação até o resultado. */
  app.get('/finance/budget-import/batches/:id', { preHandler: guard('worksheet.budget') }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const batch = await db.query.importBatches.findFirst({ where: and(eq(importBatches.id, id), eq(importBatches.officeId, user.officeId), eq(importBatches.kind, 'budget')) });
    if (!batch) throw notFound('Importação');
    return batch;
  });

  /**
   * Recebe a planilha: confere se ela abre, guarda o arquivo, registra o lote ("processing") e põe
   * a importação na fila. As linhas são gravadas pelo job; a tela acompanha o lote até o resultado.
   */
  app.post('/finance/budget-import', { preHandler: guard('worksheet.budget') }, async (req) => {
    const user = requireUser(req);
    // o tipo gravado sai da extensão conferida com o conteúdo, nunca do que o navegador informa
    const { files, fields } = await readUploads(req, { types: SHEET_TYPES, maxFiles: 1, accepted: 'a planilha em .xlsx ou .csv' });
    const file = files[0];
    let year: number | null = fields.year ? parse(yearSchema, fields.year) : null;
    const q = (req.query as Record<string, unknown>)?.year;
    if (!year && q) year = parse(yearSchema, q);
    if (!year) throw badRequest('Informe o ano-exercício.');
    if (!file) throw badRequest('Envie a planilha em .xlsx ou .csv.');
    let sheet: Awaited<ReturnType<typeof readSheet>>;
    try {
      sheet = await readSheet(file.data, file.filename);
    } catch {
      throw badRequest('Não foi possível ler a planilha. Use o modelo baixado do sistema.');
    }
    if (sheet.length > 5000) throw badRequest('A planilha tem linhas demais (máximo de 5.000).');
    const total = sheet.filter(hasAmount).length;

    const saved = await ctx.files.save({ officeId: user.officeId, data: file.data, filename: file.filename, mimeType: file.mimeType, userId: user.userId });
    const [batch] = await db
      .insert(importBatches)
      .values({ officeId: user.officeId, kind: 'budget', fileId: saved.id, status: 'processing', total, createdByUserId: user.userId })
      .returning();
    const payload: BudgetImportPayload = { batchId: batch.id, officeId: user.officeId, userId: user.userId, year };
    // uma tentativa só: a importação refeita do zero mudaria as mensagens das linhas já gravadas
    await ctx.jobs.enqueue(BUDGET_IMPORT_JOB, payload, { officeId: user.officeId, idempotencyKey: batch.id, userId: user.userId, maxAttempts: 1 });
    await audit(req, 'import', 'budget', batch.id, { year, total });
    return { ...batch, skipped: sheet.length - total, year };
  });
}
