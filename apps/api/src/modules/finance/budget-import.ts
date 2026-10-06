/**
 * Importação de orçamentos em lote, executada na fila de tarefas: a requisição só confere e guarda
 * a planilha e registra o lote ("processing"); o job lê as linhas, cria ou atualiza os orçamentos
 * e grava o resultado linha a linha no lote, que a tela acompanha.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  BUDGET_CATEGORIES,
  BUDGET_STATUS,
  formatCpfCnpj,
  isValidCpfCnpj,
  onlyDigits,
  type BudgetCategory,
  type BudgetStatus,
} from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { budgets, customers, declarations, importBatches, paymentMethods, roles, users } from '../../db/schema';
import type { JobRow } from '../../jobs/queue';
import { HttpError } from '../../lib/errors';
import { can } from '../../lib/http';
import { customerScope, type CustomerRow } from '../../services/customers';
import { getOrCreateDeclaration, type DeclarationRow } from '../../services/declarations';
import { notify } from '../../services/notify';
import { parseDate, readSheet, sheetMoneyToCents, type SheetRow } from '../../services/xlsx';
import { applyStatus, resolveBudgetValues, type BudgetRow, type PaymentMethodRow } from './service';

export const BUDGET_IMPORT_JOB = 'finance.budget_import';

export interface BudgetImportPayload {
  [k: string]: unknown;
  batchId: string;
  officeId: string;
  userId: string;
  year: number;
}

type LineResult = { row: number; ok: boolean; message: string };

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

/** Linhas com valor são importadas; as sem valor são ignoradas (contadas à parte). */
export const hasAmount = (line: SheetRow) => Boolean((line.values.valor ?? '').trim());

/** Quem enviou a planilha, com as permissões atuais (o job roda fora da requisição). */
async function requester(ctx: AppContext, officeId: string, userId: string): Promise<AuthUser | null> {
  const user = await ctx.db.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.officeId, officeId)) });
  if (!user?.isActive) return null;
  const role = user.roleId ? await ctx.db.query.roles.findFirst({ where: eq(roles.id, user.roleId) }) : null;
  return {
    kind: 'user',
    userId: user.id,
    officeId: user.officeId,
    name: user.name,
    email: user.email,
    isOwner: user.isOwner,
    roleId: user.roleId,
    permissions: new Set(role?.permissions ?? []),
  };
}

/** Linhas processadas entre uma atualização do andamento e outra. */
const PROGRESS_EVERY = 50;

/**
 * Executor do job. Clientes, orçamentos e declarações do exercício são carregados de uma vez
 * (não uma consulta por linha); cada linha grava o próprio orçamento (e o aprova, se pedido).
 */
export async function runBudgetImport(ctx: AppContext, job: JobRow, progress: (pct: number) => Promise<void>) {
  const { db } = ctx;
  const p = job.payload as BudgetImportPayload;
  const batch = await db.query.importBatches.findFirst({ where: and(eq(importBatches.id, p.batchId), eq(importBatches.officeId, p.officeId)) });
  if (!batch || batch.status !== 'processing') return { skipped: true };
  const finish = async (status: 'done' | 'failed', results: LineResult[]) => {
    const succeeded = results.filter((r) => r.ok).length;
    await db.update(importBatches).set({ status, total: results.length, succeeded, failed: results.length - succeeded, results }).where(eq(importBatches.id, batch.id));
    return succeeded;
  };
  const user = await requester(ctx, p.officeId, p.userId);
  if (!user || !can(user, 'worksheet.budget')) {
    await finish('failed', [{ row: 1, ok: false, message: 'Quem enviou a planilha não tem mais acesso à importação de orçamentos.' }]);
    return { failed: 'user' };
  }
  let lines: SheetRow[] = [];
  const results: LineResult[] = [];
  try {
    const { row: fileRow, data } = await ctx.files.get(p.officeId, batch.fileId!);
    lines = (await readSheet(data, fileRow.filename)).filter(hasAmount);
    const errors: { row: number; error: string }[] = [];
    await processLines(ctx, user, p.year, lines, results, errors, async (done) => {
      if (done % PROGRESS_EVERY) return;
      const succeeded = results.filter((r) => r.ok).length;
      await db.update(importBatches).set({ succeeded, failed: results.length - succeeded }).where(eq(importBatches.id, batch.id));
      await progress((done / Math.max(1, lines.length)) * 100);
    });
    const succeeded = await finish('done', results);
    await notify(db, {
      officeId: p.officeId,
      userId: p.userId,
      title: 'Importação de orçamentos concluída',
      body: `${succeeded} linha(s) gravada(s)${results.length - succeeded ? `, ${results.length - succeeded} com erro` : ''}.`,
      link: '/importacoes/orcamentos',
    });
    // erros inesperados ficam só no job (a tela mostra a mensagem genérica)
    return { total: results.length, succeeded, errors };
  } catch (err) {
    // as linhas já gravadas ficam no resultado; a última diz onde a importação parou
    const stop = lines[results.length]?.rowNumber ?? 1;
    const message = results.length
      ? 'A importação parou nesta linha. As anteriores já foram gravadas; envie a planilha de novo para concluir (o que já foi gravado é atualizado, não duplicado).'
      : 'Não foi possível concluir a importação. Envie a planilha de novo.';
    await finish('failed', [...results, { row: stop, ok: false, message }]);
    throw err;
  }
}

/** Cria ou atualiza os orçamentos linha a linha, com as mesmas regras e mensagens da importação. */
async function processLines(
  ctx: AppContext,
  user: AuthUser,
  year: number,
  lines: SheetRow[],
  results: LineResult[],
  errors: { row: number; error: string }[],
  afterLine: (done: number) => Promise<void>,
) {
  const { db } = ctx;
  const scope = await customerScope(ctx, user);
  const methods = await db.select().from(paymentMethods).where(eq(paymentMethods.officeId, user.officeId));
  const defaultMethod = methods.find((m) => m.isDefault && m.active) ?? null;
  const canApprove = can(user, 'budget.approve');

  // clientes, orçamentos e declarações do exercício de uma vez
  const docs = [...new Set(lines.map((l) => onlyDigits((l.values.cpf_cnpj ?? '').trim())).filter((d) => d && isValidCpfCnpj(d)))];
  const byDoc = new Map<string, CustomerRow>();
  for (let i = 0; i < docs.length; i += 1000) {
    for (const c of await db.select().from(customers).where(and(scope, inArray(customers.cpfCnpj, docs.slice(i, i + 1000))))) byDoc.set(c.cpfCnpj, c);
  }
  const ids = [...byDoc.values()].map((c) => c.id);
  const budgetsBy = new Map<string, BudgetRow[]>();
  const declBy = new Map<string, DeclarationRow>();
  for (let i = 0; i < ids.length; i += 1000) {
    const slice = ids.slice(i, i + 1000);
    const rows = await db
      .select()
      .from(budgets)
      .where(and(eq(budgets.officeId, user.officeId), eq(budgets.exerciseYear, year), inArray(budgets.customerId, slice)))
      .orderBy(desc(budgets.createdAt));
    for (const b of rows) budgetsBy.set(`${b.customerId}|${b.category}`, [...(budgetsBy.get(`${b.customerId}|${b.category}`) ?? []), b]);
    for (const d of await db.select().from(declarations).where(and(eq(declarations.officeId, user.officeId), eq(declarations.exerciseYear, year), inArray(declarations.customerId, slice)))) {
      declBy.set(d.customerId, d);
    }
  }
  const declarationOf = async (customer: CustomerRow) => {
    let d = declBy.get(customer.id);
    if (!d) {
      d = await getOrCreateDeclaration(db, user.officeId, customer.id, year);
      declBy.set(customer.id, d);
    }
    return d;
  };
  /** Mantém o mapa em dia (do mais novo para o mais antigo): a mesma planilha pode ter duas linhas do mesmo orçamento. */
  const remember = (row: BudgetRow) => {
    const key = `${row.customerId}|${row.category}`;
    const list = budgetsBy.get(key) ?? [];
    budgetsBy.set(key, list.some((b) => b.id === row.id) ? list.map((b) => (b.id === row.id ? row : b)) : [row, ...list]);
  };

  for (const [index, line] of lines.entries()) {
    const { rowNumber, values: v } = line;
    const cell = (k: string) => (v[k] ?? '').trim();
    const fail = (message: string) => results.push({ row: rowNumber, ok: false, message });
    try {
      await importLine();
    } catch (err) {
      // erros de regra (HttpError) já vêm em português; erro de banco não vai para o resultado
      if (err instanceof HttpError) fail(err.message);
      else {
        errors.push({ row: rowNumber, error: err instanceof Error ? err.message : String(err) });
        fail('Erro ao gravar a linha. Confira os valores e tente novamente.');
      }
    }
    await afterLine(index + 1);

    async function importLine() {
      const amountText = cell('valor');
      const doc = onlyDigits(cell('cpf_cnpj'));
      if (!doc || !isValidCpfCnpj(doc)) return fail('CPF/CNPJ inválido.');
      const customer = byDoc.get(doc);
      if (!customer) return fail(`Cliente ${formatCpfCnpj(doc)} não encontrado.`);
      // célula numérica do .xlsx pelo número cru ("104.895" é R$ 104,90, não 104 mil); texto e CSV pelo parser de reais
      const amountCents = sheetMoneyToCents(line, 'valor');
      if (amountCents === null || amountCents <= 0) return fail(`Valor "${amountText}" inválido. Use o formato 1.500,00 (ou 1500,00).`);
      const category: BudgetCategory | null = cell('categoria') ? matchOption(cell('categoria'), BUDGET_CATEGORIES) : 'irpf';
      if (!category) return fail(`Categoria "${cell('categoria')}" não reconhecida.`);
      const discountText = cell('desconto').replace('%', '').replace(',', '.');
      const discount = discountText ? Number(discountText) : 0;
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) return fail('Desconto deve estar entre 0 e 100.');
      let method: PaymentMethodRow | null = defaultMethod;
      if (cell('forma_de_pagamento')) {
        const name = fold(cell('forma_de_pagamento'));
        method = methods.find((m) => fold(m.name) === name) ?? methods.find((m) => fold(m.type) === name) ?? null;
        if (!method) return fail(`Forma de pagamento "${cell('forma_de_pagamento')}" não cadastrada.`);
      }
      const installmentsText = cell('parcelas');
      const installments = installmentsText ? Number(installmentsText) : 1;
      if (!Number.isInteger(installments) || installments < 1 || installments > 60) return fail('Parcelas inválidas.');
      const startText = cell('inicio_da_cobranca');
      const start = startText ? parseDate(startText) : null;
      if (startText && !start) return fail(`Início da cobrança "${startText}" inválido: use uma data que exista, no formato DD/MM/AAAA.`);
      const statusText = cell('status');
      const status = statusText ? matchOption(statusText, BUDGET_STATUS) : null;
      if (statusText && !status) return fail(`Status "${statusText}" não reconhecido.`);

      const candidates = budgetsBy.get(`${customer.id}|${category}`) ?? [];
      const current: BudgetRow | undefined = candidates.find((b) => b.status !== 'canceled') ?? candidates[0];
      const target = (status ?? current?.status ?? 'draft') as BudgetStatus;
      if (target === 'sent' && current?.status !== 'sent') return fail('O status "Enviado" só é definido pelo envio ao cliente no sistema.');
      if (!IMPORT_STATUSES.includes(target) && target !== 'sent') return fail('Status inválido.');
      if (target === 'approved' && current?.status !== 'approved' && !canApprove) return fail('Você não tem permissão para aprovar orçamentos.');
      const description = cell('descricao') || null;
      const internalNote = cell('observacao_interna') || null;

      if (current?.status === 'approved') {
        const changed =
          current.amountCents !== amountCents ||
          Number(current.discountPercent) !== discount ||
          (current.paymentMethodId ?? null) !== (method?.id ?? null) ||
          current.installments !== installments ||
          (start !== null && current.billingStartDate !== start) ||
          target !== 'approved';
        if (changed) return fail('Orçamento já aprovado: valores e status não podem ser alterados.');
        if ((current.description ?? null) !== description || (current.internalNote ?? null) !== internalNote) {
          const [row] = await db.update(budgets).set({ description, internalNote, updatedAt: new Date() }).where(eq(budgets.id, current.id)).returning();
          remember(row);
          results.push({ row: rowNumber, ok: true, message: 'Orçamento aprovado: descrição e observação atualizadas.' });
        } else {
          results.push({ row: rowNumber, ok: true, message: 'Sem alterações.' });
        }
        return;
      }
      const decl = await declarationOf(customer);
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
      remember(row);
      if (target !== row.status) {
        row = await applyStatus(ctx, row, target, user.name);
        remember(row);
      }
      const verb = current ? 'atualizado' : 'criado';
      results.push({ row: rowNumber, ok: true, message: row.status === 'approved' && current?.status !== 'approved' ? `Orçamento ${verb} e aprovado (faturamento gerado).` : `Orçamento ${verb}.` });
    }
  }
}
