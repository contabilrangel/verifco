/**
 * Orçamentos em lote: modelo .xlsx pré-preenchido com os clientes e orçamentos do ano,
 * e importação que cria/atualiza orçamentos por CPF/CNPJ com resultado por linha.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BUDGET_CATEGORIES,
  BUDGET_STATUS,
  formatCpfCnpj,
  isValidCpfCnpj,
  onlyDigits,
  type BudgetCategory,
  type BudgetStatus,
} from '@verifco/shared';
import { budgets, customers, importBatches, paymentMethods } from '../../db/schema';
import { HttpError, badRequest } from '../../lib/errors';
import { audit, can, guard, parse, requireUser, yearSchema } from '../../lib/http';
import { customerScope } from '../../services/customers';
import { getOrCreateDeclaration } from '../../services/declarations';
import { SHEET_TYPES, readUploads } from '../../services/uploads';
import { buildWorkbook, parseDate, readSheet, sheetMoneyToCents } from '../../services/xlsx';
import { applyStatus, resolveBudgetValues, userName, type BudgetRow, type PaymentMethodRow } from './service';
import { brDate, budgetStatusLabel, categoryLabel } from './text';

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

const IMPORT_STATUSES: BudgetStatus[] = ['draft', 'approved', 'rejected', 'canceled'];

function matchOption<T extends string>(value: string, options: Record<T, string>): T | null {
  const v = fold(value);
  for (const [k, label] of Object.entries(options) as [T, string][]) if (fold(k) === v || fold(label) === v) return k;
  return null;
}

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
    // agrupados por cliente antes do laço (nada de filter/find por cliente: carteiras grandes)
    const byCustomer = new Map<string, BudgetRow[]>();
    for (const b of existing) {
      const mine = byCustomer.get(b.customerId);
      if (mine) mine.push(b);
      else byCustomer.set(b.customerId, [b]);
    }
    const methodName = new Map(methods.map((m) => [m.id, m.name]));
    const rows: Record<string, unknown>[] = [];
    for (const c of list) {
      const mine = byCustomer.get(c.id) ?? [];
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
          method: (b.paymentMethodId && methodName.get(b.paymentMethodId)) || '',
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

    const scope = await customerScope(ctx, user);
    const methods = await db.select().from(paymentMethods).where(eq(paymentMethods.officeId, user.officeId));
    const defaultMethod = methods.find((m) => m.isDefault && m.active) ?? null;
    const approver = await userName(ctx, user.userId);
    const canApprove = can(user, 'budget.approve');
    const results: { row: number; ok: boolean; message: string }[] = [];
    let skipped = 0;

    for (const line of sheet) {
      const { rowNumber, values: v } = line;
      const cell = (k: string) => (v[k] ?? '').trim();
      const fail = (message: string) => results.push({ row: rowNumber, ok: false, message });
      const amountText = cell('valor');
      if (!amountText) {
        skipped++;
        continue;
      }
      const doc = onlyDigits(cell('cpf_cnpj'));
      if (!doc || !isValidCpfCnpj(doc)) {
        fail('CPF/CNPJ inválido.');
        continue;
      }
      const customer = await db.query.customers.findFirst({ where: and(scope, eq(customers.cpfCnpj, doc)) });
      if (!customer) {
        fail(`Cliente ${formatCpfCnpj(doc)} não encontrado.`);
        continue;
      }
      // célula numérica do .xlsx pelo número cru ("104.895" é R$ 104,90, não 104 mil); texto e CSV pelo parser de reais
      const amountCents = sheetMoneyToCents(line, 'valor');
      if (amountCents === null || amountCents <= 0) {
        fail(`Valor "${amountText}" inválido. Use o formato 1.500,00 (ou 1500,00).`);
        continue;
      }
      const category: BudgetCategory | null = cell('categoria') ? matchOption(cell('categoria'), BUDGET_CATEGORIES) : 'irpf';
      if (!category) {
        fail(`Categoria "${cell('categoria')}" não reconhecida.`);
        continue;
      }
      const discountText = cell('desconto').replace('%', '').replace(',', '.');
      const discount = discountText ? Number(discountText) : 0;
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
        fail('Desconto deve estar entre 0 e 100.');
        continue;
      }
      let method: PaymentMethodRow | null = defaultMethod;
      if (cell('forma_de_pagamento')) {
        const name = fold(cell('forma_de_pagamento'));
        method = methods.find((m) => fold(m.name) === name) ?? methods.find((m) => fold(m.type) === name) ?? null;
        if (!method) {
          fail(`Forma de pagamento "${cell('forma_de_pagamento')}" não cadastrada.`);
          continue;
        }
      }
      const installmentsText = cell('parcelas');
      const installments = installmentsText ? Number(installmentsText) : 1;
      if (!Number.isInteger(installments) || installments < 1 || installments > 60) {
        fail('Parcelas inválidas.');
        continue;
      }
      const startText = cell('inicio_da_cobranca');
      const start = startText ? parseDate(startText) : null;
      if (startText && !start) {
        fail(`Início da cobrança "${startText}" inválido: use uma data que exista, no formato DD/MM/AAAA.`);
        continue;
      }
      const statusText = cell('status');
      const status = statusText ? matchOption(statusText, BUDGET_STATUS) : null;
      if (statusText && !status) {
        fail(`Status "${statusText}" não reconhecido.`);
        continue;
      }

      const candidates = await db
        .select()
        .from(budgets)
        .where(and(eq(budgets.officeId, user.officeId), eq(budgets.customerId, customer.id), eq(budgets.exerciseYear, year), eq(budgets.category, category)))
        .orderBy(desc(budgets.createdAt));
      const current: BudgetRow | undefined = candidates.find((b) => b.status !== 'canceled') ?? candidates[0];
      const target = (status ?? current?.status ?? 'draft') as BudgetStatus;
      if (target === 'sent' && current?.status !== 'sent') {
        fail('O status "Enviado" só é definido pelo envio ao cliente no sistema.');
        continue;
      }
      if (!IMPORT_STATUSES.includes(target) && target !== 'sent') {
        fail('Status inválido.');
        continue;
      }
      if (target === 'approved' && current?.status !== 'approved' && !canApprove) {
        fail('Você não tem permissão para aprovar orçamentos.');
        continue;
      }
      const description = cell('descricao') || null;
      const internalNote = cell('observacao_interna') || null;

      try {
        if (current?.status === 'approved') {
          const changed =
            current.amountCents !== amountCents ||
            Number(current.discountPercent) !== discount ||
            (current.paymentMethodId ?? null) !== (method?.id ?? null) ||
            current.installments !== installments ||
            (start !== null && current.billingStartDate !== start) ||
            target !== 'approved';
          if (changed) {
            fail('Orçamento já aprovado: valores e status não podem ser alterados.');
            continue;
          }
          if ((current.description ?? null) !== description || (current.internalNote ?? null) !== internalNote) {
            await db.update(budgets).set({ description, internalNote, updatedAt: new Date() }).where(eq(budgets.id, current.id));
            results.push({ row: rowNumber, ok: true, message: 'Orçamento aprovado: descrição e observação atualizadas.' });
          } else {
            results.push({ row: rowNumber, ok: true, message: 'Sem alterações.' });
          }
          continue;
        }
        const decl = await getOrCreateDeclaration(db, user.officeId, customer.id, year);
        const values = await resolveBudgetValues(
          ctx,
          user.officeId,
          decl,
          {
            type: current?.type === 'integration' ? 'integration' : 'fixed',
            category,
            description,
            priceTableId: current?.priceTableId ?? null,
            pricingInputs: current?.pricingInputs ?? {},
            amountCents,
            discountPercent: discount,
            paymentMethodId: method?.id ?? null,
            billingStartDate: start ?? current?.billingStartDate ?? null,
            installments,
            internalNote,
          },
          current,
        );
        let row: BudgetRow;
        if (current) {
          [row] = await db.update(budgets).set({ ...values, updatedAt: new Date() }).where(eq(budgets.id, current.id)).returning();
        } else {
          [row] = await db
            .insert(budgets)
            .values({ ...values, officeId: user.officeId, customerId: customer.id, declarationId: decl.id, exerciseYear: year, status: 'draft', createdByUserId: user.userId })
            .returning();
        }
        if (target !== row.status) row = await applyStatus(ctx, row, target, approver);
        const verb = current ? 'atualizado' : 'criado';
        results.push({ row: rowNumber, ok: true, message: row.status === 'approved' && current?.status !== 'approved' ? `Orçamento ${verb} e aprovado (faturamento gerado).` : `Orçamento ${verb}.` });
      } catch (err) {
        // erros de regra (HttpError) já vêm em português; erro de banco não vai para o resultado
        if (err instanceof HttpError) fail(err.message);
        else {
          req.log.error({ err, row: rowNumber }, 'Falha ao gravar linha da importação de orçamentos');
          fail('Erro ao gravar a linha. Confira os valores e tente novamente.');
        }
      }
    }

    const saved = await ctx.files.save({ officeId: user.officeId, data: file.data, filename: file.filename, mimeType: file.mimeType, userId: user.userId });
    const succeeded = results.filter((r) => r.ok).length;
    const [batch] = await db
      .insert(importBatches)
      .values({
        officeId: user.officeId,
        kind: 'budget',
        fileId: saved.id,
        status: 'done',
        total: results.length,
        succeeded,
        failed: results.length - succeeded,
        results,
        createdByUserId: user.userId,
      })
      .returning();
    await audit(req, 'import', 'budget', batch.id, { year, total: results.length, succeeded });
    return { ...batch, skipped, year };
  });
}
