/** Relatório de faturamento (Relatórios › Faturamento) e exportação para Excel. */
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BUDGET_CATEGORIES, INSTALLMENT_STATUS, formatCpfCnpj, todayIso, type BudgetCategory } from '@verifco/shared';
import { budgets, customers, users } from '../../db/schema';
import { guard, parse, requireUser, yearSchema } from '../../lib/http';
import { customerScope } from '../../services/customers';
import { buildWorkbook } from '../../services/xlsx';
import { serializeBudgets, type SerializedBudget } from './service';
import { budgetStatusLabel, budgetTypeLabel, categoryLabel } from './text';

const bool = z.preprocess((v) => v === true || v === 'true' || v === '1', z.boolean()).default(false);

const reportQuery = z.object({
  year: yearSchema,
  category: z.enum(Object.keys(BUDGET_CATEGORIES) as [BudgetCategory, ...BudgetCategory[]]).optional(),
  responsible: z.uuid().optional(),
  type: z.enum(['fixed', 'variable', 'integration']).optional(),
  paymentStatus: z.enum(['not_billed', 'open', 'overdue', 'paid']).optional(),
  approvedOnly: bool,
  overdueOnly: bool,
});
type ReportQuery = z.infer<typeof reportQuery>;

export const PAYMENT_STATUS_LABELS: Record<SerializedBudget['paymentStatus'], string> = {
  not_billed: 'Sem faturamento',
  open: 'Em aberto',
  overdue: 'Com parcelas vencidas',
  paid: 'Pago',
};

export async function reportRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  const build = async (req: FastifyRequest, q: ReportQuery) => {
    const user = requireUser(req);
    const conds: SQL[] = [await customerScope(ctx, user), eq(budgets.officeId, user.officeId), eq(budgets.exerciseYear, q.year)];
    if (q.category) conds.push(eq(budgets.category, q.category));
    if (q.type) conds.push(eq(budgets.type, q.type));
    if (q.responsible) conds.push(eq(customers.responsibleUserId, q.responsible));
    if (q.approvedOnly) conds.push(eq(budgets.status, 'approved'));
    else conds.push(inArray(budgets.status, ['draft', 'sent', 'approved', 'rejected']));
    const rows = await db
      .select({ b: budgets, customerName: customers.name, cpfCnpj: customers.cpfCnpj, responsibleName: users.name })
      .from(budgets)
      .innerJoin(customers, eq(customers.id, budgets.customerId))
      .leftJoin(users, eq(users.id, customers.responsibleUserId))
      .where(and(...conds))
      .orderBy(asc(customers.name), desc(budgets.createdAt));
    const serialized = await serializeBudgets(ctx, rows.map((r) => r.b));
    const data = rows
      .map((r, i) => {
        const s = serialized[i];
        return {
          budgetId: s.id,
          customerId: s.customerId,
          customerName: r.customerName,
          cpfCnpj: r.cpfCnpj,
          responsibleName: r.responsibleName,
          category: s.category,
          categoryLabel: s.categoryLabel,
          type: s.type,
          status: s.status,
          paymentMethodName: s.paymentMethodName,
          installmentsCount: s.installments,
          budgetedCents: s.totalCents,
          billedCents: s.billing?.totalCents ?? 0,
          receivedCents: s.billing?.paidCents ?? 0,
          openCents: s.billing?.openCents ?? 0,
          overdueCents: s.billing?.overdueCents ?? 0,
          paymentStatus: s.paymentStatus,
          externalSyncFailed: s.billing?.externalSync?.state === 'failed' || s.billing?.externalSync?.state === 'missing',
          installments: s.billing?.installments ?? [],
        };
      })
      .filter((r) => (!q.paymentStatus || r.paymentStatus === q.paymentStatus) && (!q.overdueOnly || r.overdueCents > 0));
    const totals = data.reduce(
      (a, r) => ({
        budgetedCents: a.budgetedCents + r.budgetedCents,
        billedCents: a.billedCents + r.billedCents,
        receivedCents: a.receivedCents + r.receivedCents,
        openCents: a.openCents + r.openCents,
        overdueCents: a.overdueCents + r.overdueCents,
      }),
      { budgetedCents: 0, billedCents: 0, receivedCents: 0, openCents: 0, overdueCents: 0 },
    );
    return { data, totals, customers: new Set(data.map((r) => r.customerId)).size, generatedAt: new Date().toISOString(), today: todayIso() };
  };

  app.get('/finance/reports/billing', { preHandler: guard('report.billing') }, async (req) => build(req, parse(reportQuery, req.query)));

  app.get('/finance/reports/billing.xlsx', { preHandler: guard('report.billing') }, async (req, reply) => {
    const q = parse(reportQuery, req.query);
    const report = await build(req, q);
    const xlsx = await buildWorkbook([
      {
        name: 'Faturamento',
        columns: [
          { header: 'Cliente', key: 'customer', width: 34 },
          { header: 'CPF/CNPJ', key: 'doc', width: 18 },
          { header: 'Responsável', key: 'responsible', width: 22 },
          { header: 'Categoria', key: 'category', width: 26 },
          { header: 'Tipo', key: 'type', width: 24 },
          { header: 'Status do orçamento', key: 'status', width: 18 },
          { header: 'Forma de pagamento', key: 'method', width: 20 },
          { header: 'Parcelas', key: 'installments', type: 'number', width: 10 },
          { header: 'Orçado', key: 'budgeted', type: 'money', width: 14 },
          { header: 'Faturado', key: 'billed', type: 'money', width: 14 },
          { header: 'Recebido', key: 'received', type: 'money', width: 14 },
          { header: 'Em aberto', key: 'open', type: 'money', width: 14 },
          { header: 'Vencido', key: 'overdue', type: 'money', width: 14 },
          { header: 'Pagamento', key: 'paymentStatus', width: 22 },
        ],
        rows: [
          ...report.data.map((r) => ({
            customer: r.customerName,
            doc: formatCpfCnpj(r.cpfCnpj),
            responsible: r.responsibleName ?? '',
            category: r.categoryLabel,
            type: budgetTypeLabel(r.type),
            status: budgetStatusLabel(r.status),
            method: r.paymentMethodName ?? '',
            installments: r.installmentsCount,
            budgeted: r.budgetedCents,
            billed: r.billedCents,
            received: r.receivedCents,
            open: r.openCents,
            overdue: r.overdueCents,
            paymentStatus: PAYMENT_STATUS_LABELS[r.paymentStatus],
          })),
          {
            customer: `Total (${report.customers} cliente(s))`,
            budgeted: report.totals.budgetedCents,
            billed: report.totals.billedCents,
            received: report.totals.receivedCents,
            open: report.totals.openCents,
            overdue: report.totals.overdueCents,
          },
        ],
      },
      {
        name: 'Parcelas',
        columns: [
          { header: 'Cliente', key: 'customer', width: 34 },
          { header: 'Categoria', key: 'category', width: 26 },
          { header: 'Parcela', key: 'number', type: 'number', width: 10 },
          { header: 'Vencimento', key: 'dueDate', type: 'date', width: 14 },
          { header: 'Valor', key: 'amount', type: 'money', width: 14 },
          { header: 'Situação', key: 'status', width: 14 },
          { header: 'Pago em', key: 'paidAt', type: 'date', width: 14 },
          { header: 'Valor pago', key: 'paid', type: 'money', width: 14 },
          { header: 'Recibo', key: 'receipt', type: 'number', width: 10 },
        ],
        rows: report.data.flatMap((r) =>
          r.installments.map((i) => ({
            customer: r.customerName,
            category: categoryLabel(r.category),
            number: i.number,
            dueDate: i.dueDate,
            amount: i.amountCents,
            status: INSTALLMENT_STATUS[i.status as keyof typeof INSTALLMENT_STATUS] ?? i.status,
            paidAt: i.paidAt ?? '',
            paid: i.paidAmountCents ?? '',
            receipt: i.receiptNumber ?? '',
          })),
        ),
      },
    ]);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="faturamento-${q.year}.xlsx"`)
      .send(xlsx);
  });
}
