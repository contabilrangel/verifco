import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  DECLARATION_SUBSTATUS,
  INCOME_NATURES,
  ITEM_KINDS,
  TAXATION_TYPES,
  cashAnalysis,
  compareTaxation,
  computeIrpfm,
  formatMoney,
  irpfmFromItems,
  regularTaxFromDeclaration,
  type DeclarationItem,
  type DeclarationSubstatus,
  type IrpfmDividendPayer,
} from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { declarations } from '../../db/schema';
import { forbidden } from '../../lib/errors';
import { can, requireUser } from '../../lib/http';
import { listItems, type DeclarationRow } from '../../services/declarations';
import { getOfficeSettings } from '../../services/settings';

/** Exige TODAS as permissões informadas (o `guard` padrão aceita qualquer uma). */
export function requireAll(req: FastifyRequest, ...permissions: string[]): AuthUser {
  const user = requireUser(req);
  if (!permissions.every((p) => can(user, p))) throw forbidden();
  return user;
}

/** Declaração do exercício (sem criar) e suas linhas. */
export async function loadDeclaration(ctx: AppContext, officeId: string, customerId: string, exerciseYear: number) {
  const declaration = await ctx.db.query.declarations.findFirst({
    where: and(eq(declarations.officeId, officeId), eq(declarations.customerId, customerId), eq(declarations.exerciseYear, exerciseYear)),
  });
  const items: DeclarationItem[] = declaration ? await listItems(ctx.db, declaration.id) : [];
  return { declaration: declaration ?? null, items };
}

export interface IrpfmAdjustments {
  regularTaxDueCents?: number | null;
  law14754TaxCents?: number | null;
  definitiveTaxPaidCents?: number | null;
  dividendWithholdingCents?: number | null;
  dividendPayers?: IrpfmDividendPayer[];
  /** Resultado tributável da atividade rural (com a opção de 20% e a compensação de prejuízos). */
  ruralTaxableResultCents?: number | null;
}

/**
 * IR devido na declaração de ajuste (dedução I do IRPFM, art. 16-A, § 3º, I): apurado na
 * declaração ou, sem saldo, estimado pelo mesmo cálculo do comparativo completa × simplificada
 * (deduções legais de verdade: INSS, dependentes, saúde, instrução limitada, pensão e PGBL até
 * 12%; aluguel e outros pagamentos não deduzem), com a redução da Lei 15.270/2025. Rendimentos
 * com exigibilidade suspensa não entram no IR devido.
 */
export function regularTaxFor(declaration: DeclarationRow | null, items: DeclarationItem[], exerciseYear: number, ruralTaxableResultCents?: number | null) {
  const fromDecl = declaration ? regularTaxFromDeclaration({ taxDueCents: declaration.taxDueCents, refundCents: declaration.refundCents, items }) : null;
  if (fromDecl !== null) return { cents: fromDecl, source: 'declaration' as const };
  const taxation = declaration?.taxation === 'complete' || declaration?.taxation === 'simplified' ? declaration.taxation : null;
  const cmp = compareTaxation({ exerciseYear, items, currentTaxation: taxation, ruralTaxableResultCents });
  const chosen = taxation ? cmp[taxation] : cmp[cmp.best];
  return { cents: chosen.taxCents, source: 'estimated' as const };
}

/** IRPFM do cliente no exercício a partir da declaração, com os ajustes informados na tela. */
export function irpfmForDeclaration(declaration: DeclarationRow | null, items: DeclarationItem[], exerciseYear: number, adj: IrpfmAdjustments = {}) {
  const parsed = irpfmFromItems(items, { ruralTaxableResultCents: adj.ruralTaxableResultCents });
  const regular =
    adj.regularTaxDueCents !== undefined && adj.regularTaxDueCents !== null
      ? { cents: adj.regularTaxDueCents, source: 'manual' as const }
      : regularTaxFor(declaration, items, exerciseYear, adj.ruralTaxableResultCents);
  const result = computeIrpfm({
    calendarYear: exerciseYear - 1,
    incomes: parsed.incomes,
    regularTaxDueCents: regular.cents,
    exclusiveWithheldCents: parsed.exclusiveWithheldCents,
    law14754TaxCents: adj.law14754TaxCents ?? parsed.law14754TaxCents,
    definitiveTaxPaidCents: adj.definitiveTaxPaidCents ?? parsed.definitiveTaxPaidCents,
    dividendWithholdingCents: adj.dividendWithholdingCents ?? parsed.dividendWithholdingCents,
    dividendPayers: adj.dividendPayers,
    notes: parsed.warnings,
  });
  return { result, regularTaxSource: regular.source };
}

const natureLabel = (n: unknown) => (typeof n === 'string' && n in INCOME_NATURES ? INCOME_NATURES[n as keyof typeof INCOME_NATURES] : null);

/**
 * Resumo da declaração para o prompt de sistema da IA. Não inclui CPF/CNPJ do cliente;
 * os documentos de terceiros (fontes pagadoras) aparecem só pelo nome.
 */
export async function clientContextText(ctx: AppContext, officeId: string, customer: { id: string; name: string }, exerciseYear: number) {
  const { declaration: d, items } = await loadDeclaration(ctx, officeId, customer.id, exerciseYear);
  const lines: string[] = [];
  lines.push(`Cliente: ${customer.name}.`);
  lines.push(`Exercício ${exerciseYear} (ano-calendário ${exerciseYear - 1}).`);
  if (!d) {
    lines.push('Ainda não há declaração deste exercício cadastrada no Verifco.');
    return lines.join('\n');
  }
  lines.push(
    `Status: ${DECLARATION_SUBSTATUS[d.substatus as DeclarationSubstatus] ?? d.substatus}. Tributação: ${d.taxation ? (TAXATION_TYPES[d.taxation as keyof typeof TAXATION_TYPES] ?? d.taxation) : 'não definida'}.${d.isRectification ? ' Declaração retificadora.' : ''}`,
  );
  lines.push(
    `Totais: rendimentos tributáveis ${formatMoney(d.taxableIncomeCents)}; isentos ${formatMoney(d.exemptIncomeCents)}; exclusivos ${formatMoney(d.exclusiveIncomeCents)}; ` +
      `pagamentos efetuados ${formatMoney(d.deductionsCents)}; IR retido ${formatMoney(d.withheldTaxCents)}; bens ${formatMoney(d.assetsPrevTotalCents)} → ${formatMoney(d.assetsTotalCents)}; ` +
      `dívidas ${formatMoney(d.debtsPrevTotalCents)} → ${formatMoney(d.debtsTotalCents)}; imposto a pagar ${formatMoney(d.taxDueCents)}; restituição ${formatMoney(d.refundCents)}.`,
  );
  if (items.length) {
    lines.push(`Linhas da declaração (${items.length}${items.length > 80 ? ', as 80 de maior valor' : ''}):`);
    const sorted = [...items].sort((a, b) => Math.abs(b.valueCents ?? 0) - Math.abs(a.valueCents ?? 0)).slice(0, 80);
    for (const i of sorted) {
      const parts = [`- [${ITEM_KINDS[i.kind]?.label ?? i.kind}${i.code ? ` cód. ${i.code}` : ''}${i.groupCode ? ` grupo ${i.groupCode}` : ''}]`];
      const nat = natureLabel(i.extra?.nature);
      if (nat) parts.push(`(${nat})`);
      parts.push(i.description || i.counterpartyName || 'sem descrição');
      if (i.counterpartyName && i.description) parts.push(`— ${i.counterpartyName}`);
      if (i.kind === 'asset' || i.kind === 'debt' || i.kind === 'rural_asset' || i.kind === 'rural_debt') {
        parts.push(`: ${formatMoney(i.prevValueCents ?? 0)} → ${formatMoney(i.valueCents ?? 0)}`);
      } else if (i.kind !== 'dependent') {
        parts.push(`: ${formatMoney(i.valueCents ?? 0)}`);
      }
      if (i.withheldCents) parts.push(`(retido ${formatMoney(i.withheldCents)})`);
      lines.push(parts.join(' '));
    }
  } else {
    lines.push('A declaração ainda não tem linhas lançadas.');
  }
  const settings = await getOfficeSettings(ctx.db, officeId);
  const cash = cashAnalysis({
    exerciseYear,
    taxation: d.taxation as 'complete' | 'simplified' | null,
    items,
    otherExpenses: d.otherExpenses,
    simplifiedDiscountMode: settings.cashAnalysisSimplifiedDiscount,
  });
  lines.push(`Análise de caixa: recursos ${formatMoney(cash.totalSourcesCents)}, aplicações ${formatMoney(cash.totalUsesCents)}, saldo ${formatMoney(cash.balanceCents)}.`);
  const { result } = irpfmForDeclaration(d, items, exerciseYear);
  lines.push(
    `IRPFM (${result.inForce ? 'apuração' : 'simulação'} para o ano-calendário ${result.calendarYear}): rendimentos totais ${formatMoney(result.totalIncomeCents)}, ` +
      `base ${formatMoney(result.baseCents)}, alíquota ${result.ratePercent.toFixed(2)}%, devido ${formatMoney(result.dueCents)}.`,
  );
  return lines.join('\n');
}

export const yearQuery = (q: unknown) => {
  const y = Number((q as Record<string, unknown>)?.year);
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
};
