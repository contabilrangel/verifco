import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { STAGE_SUBSTATUS, declarationTotals, stageOfSubstatus, type DeclarationItem, type DeclarationSubstatus } from '@verifco/shared';
import type { Db } from '../db/client';
import { contracts, customers, declarationItems, declarations } from '../db/schema';
import { conflict, notFound } from '../lib/errors';

export type DeclarationRow = typeof declarations.$inferSelect;

/** Busca o cliente garantindo que pertence ao escritório (e não foi excluído). */
export async function getCustomerOr404(db: Db, officeId: string, customerId: string) {
  const c = await db.query.customers.findFirst({
    where: and(eq(customers.id, customerId), eq(customers.officeId, officeId), isNull(customers.deletedAt)),
  });
  if (!c) throw notFound('Cliente');
  return c;
}

/** A declaração de um cliente num exercício é criada na primeira vez que alguém a usa. */
export async function getOrCreateDeclaration(db: Db, officeId: string, customerId: string, exerciseYear: number): Promise<DeclarationRow> {
  await getCustomerOr404(db, officeId, customerId);
  const existing = await db.query.declarations.findFirst({
    where: and(eq(declarations.customerId, customerId), eq(declarations.exerciseYear, exerciseYear)),
  });
  if (existing) return existing;
  await assertContractAllowsDeclaration(db, officeId, exerciseYear);
  const [row] = await db
    .insert(declarations)
    .values({ officeId, customerId, exerciseYear })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  // corrida: outra requisição criou ao mesmo tempo
  const again = await db.query.declarations.findFirst({
    where: and(eq(declarations.customerId, customerId), eq(declarations.exerciseYear, exerciseYear)),
  });
  if (!again) throw new Error('Falha ao criar a declaração.');
  return again;
}

export async function getDeclarationOr404(db: Db, officeId: string, declarationId: string) {
  const d = await db.query.declarations.findFirst({ where: and(eq(declarations.id, declarationId), eq(declarations.officeId, officeId)) });
  if (!d) throw notFound('Declaração');
  return d;
}

/** Atualiza o subestado e a etapa do Kanban de forma consistente. */
export async function setDeclarationSubstatus(db: Db, declarationId: string, substatus: DeclarationSubstatus, extra: Partial<DeclarationRow> = {}) {
  const stage = stageOfSubstatus(substatus);
  const [row] = await db
    .update(declarations)
    .set({
      ...extra,
      substatus,
      stage,
      finishedAt: stage === 'finished' ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(declarations.id, declarationId))
    .returning();
  return row;
}

/**
 * Avança o status só se a declaração estiver num ponto anterior do fluxo.
 * Ex.: aprovar o orçamento move de "Não iniciado" para "Orçamento aprovado",
 * mas não puxa de volta uma declaração que já está em preenchimento.
 */
export async function advanceDeclaration(db: Db, decl: DeclarationRow, substatus: DeclarationSubstatus) {
  if (substatusRank(substatus) > substatusRank(decl.substatus as DeclarationSubstatus)) {
    return setDeclarationSubstatus(db, decl.id, substatus);
  }
  return decl;
}

const STAGE_ORDER = ['not_started', 'negotiation', 'filling', 'transmitted', 'finished'] as const;
function substatusRank(s: DeclarationSubstatus) {
  const stage = stageOfSubstatus(s);
  return STAGE_ORDER.indexOf(stage) * 100 + STAGE_SUBSTATUS[stage].indexOf(s);
}

export async function listItems(db: Db, declarationId: string): Promise<DeclarationItem[]> {
  const rows = await db.select().from(declarationItems).where(eq(declarationItems.declarationId, declarationId));
  return rows.map((r) => ({ ...r, kind: r.kind as DeclarationItem['kind'] }));
}

/** Recalcula os totais gravados na declaração a partir das linhas. */
export async function recomputeTotals(db: Db, declarationId: string) {
  const items = await listItems(db, declarationId);
  const totals = declarationTotals(items);
  const [row] = await db.update(declarations).set({ ...totals, updatedAt: new Date() }).where(eq(declarations.id, declarationId)).returning();
  return row;
}

// ---------------------------------------------------------------------------
// Contrato do escritório: validade e limite de declarações
// ---------------------------------------------------------------------------
export type ContractRow = typeof contracts.$inferSelect;

export interface DeclarationQuota {
  /** Exercício do pacote. */
  year: number;
  /** Soma dos limites dos pacotes vigentes do exercício; `null` = ilimitado. */
  limit: number | null;
  /** Declarações do exercício já criadas (clientes não excluídos). */
  used: number;
  remaining: number | null;
}

export interface ContractStatus {
  /** O escritório tem algum contrato registrado (sem contratos, nada é limitado). */
  hasContracts: boolean;
  /** Pacotes vigentes hoje (não cancelados nem suspensos, dentro do período). */
  active: ContractRow[];
  /** Tem contratos, mas nenhum vigente. */
  blocked: boolean;
  /** Maior data de expiração entre os contratos (para a mensagem de renovação). */
  lastExpiresAt: string | null;
  /** Próximo início, quando o único pacote ainda não começou. */
  nextStartsAt: string | null;
  quotas: DeclarationQuota[];
}

const brDate = (iso: string) => iso.split('-').reverse().join('/');

/** Situação do contrato: pacotes vigentes e o uso do limite de declarações de cada exercício. */
export async function officeContractStatus(db: Db, officeId: string, today = new Date().toISOString().slice(0, 10)): Promise<ContractStatus> {
  const rows = await db.select().from(contracts).where(eq(contracts.officeId, officeId));
  const live = rows.filter((c) => c.status !== 'canceled' && c.status !== 'suspended');
  const active = live.filter((c) => c.startsAt <= today && c.expiresAt >= today);
  const years = [...new Set(active.map((c) => c.year))].sort();
  const usage = years.length
    ? await db
        .select({ year: declarations.exerciseYear, n: count() })
        .from(declarations)
        .innerJoin(customers, eq(customers.id, declarations.customerId))
        .where(and(eq(declarations.officeId, officeId), inArray(declarations.exerciseYear, years), isNull(customers.deletedAt)))
        .groupBy(declarations.exerciseYear)
    : [];
  const quotas = years.map((year) => {
    const of = active.filter((c) => c.year === year);
    const limit = of.some((c) => c.declarationLimit === null) ? null : of.reduce((a, c) => a + (c.declarationLimit ?? 0), 0);
    const used = usage.find((u) => u.year === year)?.n ?? 0;
    return { year, limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
  });
  const future = live.filter((c) => c.startsAt > today).map((c) => c.startsAt).sort();
  return {
    hasContracts: rows.length > 0,
    active,
    blocked: rows.length > 0 && active.length === 0,
    lastExpiresAt: rows.map((c) => c.expiresAt).sort().at(-1) ?? null,
    nextStartsAt: future[0] ?? null,
    quotas,
  };
}

/**
 * Bloqueia a criação de declaração quando o contrato não permite (COB-12):
 * - escritório com contratos, mas nenhum vigente (vencido, cancelado, suspenso ou ainda não iniciado);
 * - limite de declarações do exercício atingido (soma dos pacotes vigentes daquele exercício).
 * Declarações de exercícios sem pacote vigente (ex.: retificar o ano anterior) não consomem o
 * limite, mas também exigem contrato vigente. Escritórios sem nenhum contrato não são limitados.
 */
export async function assertContractAllowsDeclaration(db: Db, officeId: string, exerciseYear: number, today = new Date().toISOString().slice(0, 10)) {
  const status = await officeContractStatus(db, officeId, today);
  if (!status.hasContracts) return;
  if (status.blocked) {
    throw conflict(
      status.nextStartsAt && (!status.lastExpiresAt || status.lastExpiresAt >= today)
        ? `O pacote do escritório começa em ${brDate(status.nextStartsAt)}. Até lá, não é possível criar novas declarações.`
        : `O contrato do escritório venceu${status.lastExpiresAt ? ` em ${brDate(status.lastExpiresAt)}` : ''}. Para criar novas declarações, renove o pacote com o suporte do Verifco (veja Administração › Contratos). As declarações já criadas continuam disponíveis.`,
    );
  }
  const quota = status.quotas.find((q) => q.year === exerciseYear);
  if (quota && quota.limit !== null && quota.used >= quota.limit) {
    throw conflict(
      `Limite do contrato atingido: o escritório já tem ${quota.used} declaração(ões) do exercício ${exerciseYear}, o máximo do pacote (${quota.limit}). Para criar novas, amplie o pacote com o suporte do Verifco (veja Administração › Contratos).`,
    );
  }
}
