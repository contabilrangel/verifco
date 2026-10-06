import { and, asc, between, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { cashAnalysis, declarationTotals, isSpouseDependent, dependentCpf, onlyDigits, type CashAnalysisResult, type DeclarationItem } from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { customers, darfs, declarationItems, declarations, type OfficeSettings } from '../../db/schema';
import { notFound } from '../../lib/errors';
import { customerScope, getCustomerForUser, type CustomerRow } from '../../services/customers';
import type { DeclarationRow } from '../../services/declarations';
import { getOfficeSettings } from '../../services/settings';

export type DarfRow = typeof darfs.$inferSelect;

const toItem = (r: typeof declarationItems.$inferSelect): DeclarationItem => ({ ...r, kind: r.kind as DeclarationItem['kind'] });

/** Declaração do escritório que o usuário pode ver (respeita a restrição por responsável). */
export async function getDeclarationForUser(ctx: AppContext, user: AuthUser, declarationId: string): Promise<{ declaration: DeclarationRow; customer: CustomerRow }> {
  const declaration = await ctx.db.query.declarations.findFirst({ where: and(eq(declarations.id, declarationId), eq(declarations.officeId, user.officeId)) });
  if (!declaration) throw notFound('Declaração');
  const customer = await getCustomerForUser(ctx, user, declaration.customerId);
  return { declaration, customer };
}

export async function loadItems(ctx: AppContext, declarationId: string): Promise<DeclarationItem[]> {
  const rows = await ctx.db.select().from(declarationItems).where(eq(declarationItems.declarationId, declarationId)).orderBy(asc(declarationItems.createdAt));
  return rows.map(toItem);
}

export interface HistoryYear {
  exerciseYear: number;
  declarationId: string | null;
  hasItems: boolean;
  assetsCents: number;
  debtsCents: number;
  netWorthCents: number;
  /** Bens por grupo (código do grupo → valor em 31/12). */
  assetsByGroup: Record<string, number>;
  cash: CashAnalysisResult | null;
  totalIncomeCents: number;
  taxDueCents: number;
  refundCents: number;
}

/** Últimos `span` exercícios do cliente (até o exercício informado), com totais e análise de caixa. */
export async function loadHistory(ctx: AppContext, customerId: string, exerciseYear: number, settings: Required<OfficeSettings>, span = 5): Promise<HistoryYear[]> {
  const decls = await ctx.db
    .select()
    .from(declarations)
    .where(and(eq(declarations.customerId, customerId), between(declarations.exerciseYear, exerciseYear - span + 1, exerciseYear)))
    .orderBy(asc(declarations.exerciseYear));
  const rows = decls.length ? await ctx.db.select().from(declarationItems).where(inArray(declarationItems.declarationId, decls.map((d) => d.id))) : [];
  const byDecl = new Map<string, DeclarationItem[]>();
  for (const r of rows) byDecl.set(r.declarationId, [...(byDecl.get(r.declarationId) ?? []), toItem(r)]);
  const out: HistoryYear[] = [];
  for (let y = exerciseYear - span + 1; y <= exerciseYear; y++) {
    const d = decls.find((x) => x.exerciseYear === y);
    const items = d ? (byDecl.get(d.id) ?? []) : [];
    if (items.length) {
      const t = declarationTotals(items);
      const assetsByGroup: Record<string, number> = {};
      for (const a of items.filter((i) => i.kind === 'asset' || i.kind === 'rural_asset')) {
        const g = a.kind === 'rural_asset' ? 'rural' : String(a.groupCode ?? '99').padStart(2, '0');
        assetsByGroup[g] = (assetsByGroup[g] ?? 0) + (a.valueCents ?? 0);
      }
      out.push({
        exerciseYear: y,
        declarationId: d!.id,
        hasItems: true,
        assetsCents: t.assetsTotalCents,
        debtsCents: t.debtsTotalCents,
        netWorthCents: t.assetsTotalCents - t.debtsTotalCents,
        assetsByGroup,
        cash: cashAnalysis({
          exerciseYear: y,
          taxation: (d!.taxation as 'complete' | 'simplified' | null) ?? null,
          items,
          otherExpenses: d!.otherExpenses,
          simplifiedDiscountMode: settings.cashAnalysisSimplifiedDiscount,
        }),
        totalIncomeCents: t.totalIncomeCents,
        taxDueCents: d!.taxDueCents,
        refundCents: d!.refundCents,
      });
    } else {
      // sem linhas: usa os totais gravados na declaração (se houver)
      out.push({
        exerciseYear: y,
        declarationId: d?.id ?? null,
        hasItems: false,
        assetsCents: d?.assetsTotalCents ?? 0,
        debtsCents: d?.debtsTotalCents ?? 0,
        netWorthCents: (d?.assetsTotalCents ?? 0) - (d?.debtsTotalCents ?? 0),
        assetsByGroup: {},
        cash: null,
        totalIncomeCents: d?.totalIncomeCents ?? 0,
        taxDueCents: d?.taxDueCents ?? 0,
        refundCents: d?.refundCents ?? 0,
      });
    }
  }
  return out;
}

export async function loadDarfs(ctx: AppContext, declaration: DeclarationRow): Promise<DarfRow[]> {
  return ctx.db
    .select()
    .from(darfs)
    .where(and(eq(darfs.officeId, declaration.officeId), eq(darfs.declarationId, declaration.id)))
    .orderBy(asc(darfs.quotaNumber), asc(darfs.dueDate));
}

export interface SpouseInfo {
  available: boolean;
  reason: string;
  customer?: CustomerRow;
  declaration?: DeclarationRow;
}

/**
 * Cônjuge que também é cliente do escritório: dependente com relação "cônjuge" nesta declaração
 * ou declaração de outro cliente que tem este cliente como cônjuge dependente (mesmo exercício).
 */
export async function findSpouse(ctx: AppContext, user: AuthUser, declaration: DeclarationRow, customer: CustomerRow, items: DeclarationItem[]): Promise<SpouseInfo> {
  const scope = await customerScope(ctx, user);
  const notFoundReason = 'Disponível quando o cônjuge (dependente com relação "cônjuge") também é cliente do escritório.';
  let spouse: CustomerRow | undefined;

  const spouseCpfs = items.filter(isSpouseDependent).map(dependentCpf).filter((c) => c.length === 11);
  if (spouseCpfs.length) {
    spouse = await ctx.db.query.customers.findFirst({ where: and(scope, inArray(customers.cpfCnpj, spouseCpfs), ne(customers.id, customer.id)) });
  }
  if (!spouse) {
    const cpf = onlyDigits(customer.cpfCnpj);
    // CPF e documento das linhas já são gravados só com dígitos (normalizeItem nas fichas, parseAiExtraction
    // na elaboração): a comparação é direta, sem regexp_replace por linha. As declarações do escritório no
    // exercício saem do índice (office_id, exercise_year) e os dependentes de cada uma, do (declaration_id, kind).
    const rows = await ctx.db
      .select({ item: declarationItems, customerId: declarations.customerId })
      .from(declarationItems)
      .innerJoin(declarations, eq(declarations.id, declarationItems.declarationId))
      .where(
        and(
          eq(declarations.officeId, user.officeId),
          eq(declarations.exerciseYear, declaration.exerciseYear),
          eq(declarationItems.officeId, user.officeId),
          eq(declarationItems.kind, 'dependent'),
          ne(declarations.customerId, customer.id),
          or(eq(declarationItems.counterpartyDoc, cpf), eq(declarationItems.ownerCpf, cpf), sql`${declarationItems.extra}->>'cpf' = ${cpf}`),
        ),
      );
    const match = rows.find((r) => isSpouseDependent(toItem(r.item)));
    if (match) spouse = await ctx.db.query.customers.findFirst({ where: and(scope, eq(customers.id, match.customerId)) });
  }
  if (!spouse) return { available: false, reason: notFoundReason };
  const spouseDecl = await ctx.db.query.declarations.findFirst({
    where: and(eq(declarations.customerId, spouse.id), eq(declarations.exerciseYear, declaration.exerciseYear)),
  });
  if (!spouseDecl) return { available: false, reason: `${spouse.name} é cliente, mas não tem declaração no exercício ${declaration.exerciseYear}.`, customer: spouse };
  return { available: true, reason: `Inclui a declaração de ${spouse.name}.`, customer: spouse, declaration: spouseDecl };
}

export async function officeSettings(ctx: AppContext, officeId: string) {
  return getOfficeSettings(ctx.db, officeId);
}
