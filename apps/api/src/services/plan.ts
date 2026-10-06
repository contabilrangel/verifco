/**
 * Plano do escritório (contratos): vigência, limite de declarações e modo só consulta com o
 * contrato vencido. As datas contam pelo dia de Brasília.
 *
 * - Contrato vigente: ativo e com hoje entre o início e a expiração.
 * - Limite de declarações: soma dos contratos vigentes do exercício (coluna "Exercício" do
 *   contrato); sem limite quando algum deles é ilimitado ou quando nenhum contrato vigente é
 *   daquele exercício (ex.: o histórico de anos anteriores).
 * - Com contratos cadastrados e nenhum vigente, o escritório só consulta: as escritas da equipe
 *   são recusadas (hook em app.ts). Ficam liberados o acesso e a conta do usuário, os avisos, as
 *   consultas feitas por POST (exportações, prévias e cálculos) e a revogação de acessos e segredos
 *   (segurança). As rotas sem usuário da equipe (portal e checklist do cliente, link de orçamento,
 *   webhooks e robô) não passam pelo bloqueio.
 * - Escritório sem nenhum contrato cadastrado não tem restrição.
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { todayIso } from '@verifco/shared';
import type { AppContext } from '../context';
import type { DbOrTx } from '../db/client';
import { contracts, customers, declarations, users } from '../db/schema';
import { HttpError, conflict } from '../lib/errors';

export type ContractRow = typeof contracts.$inferSelect;

/** Contrato vigente: ativo e com hoje (Brasília) entre o início e a expiração. */
export const isContractActive = (c: Pick<ContractRow, 'status' | 'startsAt' | 'expiresAt'>, today = todayIso()) =>
  c.status === 'active' && String(c.startsAt) <= today && String(c.expiresAt) >= today;

export interface PlanStatus {
  /** O escritório tem algum contrato cadastrado. */
  hasContracts: boolean;
  /** Contratos vigentes hoje. */
  active: ContractRow[];
  /** Tem contrato, mas nenhum vigente: só consulta. */
  expired: boolean;
}

export async function planStatus(db: DbOrTx, officeId: string, today = todayIso()): Promise<PlanStatus> {
  const rows = await db.select().from(contracts).where(eq(contracts.officeId, officeId));
  const active = rows.filter((c) => isContractActive(c, today));
  return { hasContracts: rows.length > 0, active, expired: rows.length > 0 && active.length === 0 };
}

/** Contratos vigentes do escritório. */
export async function activeContracts(db: DbOrTx, officeId: string, today = todayIso()): Promise<ContractRow[]> {
  return (await planStatus(db, officeId, today)).active;
}

/** Limite de declarações do exercício pelos contratos vigentes (null = sem limite). */
export function declarationLimit(active: Pick<ContractRow, 'year' | 'declarationLimit'>[], exerciseYear: number): number | null {
  const ofYear = active.filter((c) => c.year === exerciseYear);
  if (!ofYear.length || ofYear.some((c) => c.declarationLimit === null)) return null;
  return ofYear.reduce((sum, c) => sum + (c.declarationLimit ?? 0), 0);
}

/**
 * Confere, antes de criar uma declaração, se o exercício ainda cabe no limite dos contratos
 * vigentes. Contam as declarações do exercício de clientes não excluídos.
 */
export async function assertDeclarationQuota(db: DbOrTx, officeId: string, exerciseYear: number, incoming = 1) {
  const limit = declarationLimit(await activeContracts(db, officeId), exerciseYear);
  if (limit === null) return;
  const [{ n }] = await db
    .select({ n: count() })
    .from(declarations)
    .innerJoin(customers, eq(customers.id, declarations.customerId))
    .where(and(eq(declarations.officeId, officeId), eq(declarations.exerciseYear, exerciseYear), isNull(customers.deletedAt)));
  if (n + incoming > limit) {
    throw conflict(`Limite de declarações do contrato atingido: ${limit} no exercício ${exerciseYear}. Para ampliar o limite, fale com o suporte do Verifco.`);
  }
}

export const PLAN_EXPIRED_MESSAGE =
  'Nenhum contrato do escritório está vigente. Você ainda pode consultar os dados, mas as alterações ficam bloqueadas até a renovação. Para renovar, fale com o suporte do Verifco.';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Acesso e conta do usuário e os avisos do sino continuam com o contrato vencido. */
const OPEN_PREFIXES = ['/api/auth/', '/api/account/', '/api/notifications/'];
/** Consultas feitas por POST (exportações, prévias, cálculos e "marcar como lida") e revogações. */
const OPEN_ROUTES = new Set([
  'POST /api/customers/export',
  'POST /api/customers/labels',
  'POST /api/customers/:id/messages/read',
  'POST /api/customers/:id/holding/pdf',
  'POST /api/customers/:id/irpfm',
  'POST /api/customers/:id/irpfm/pdf',
  'POST /api/declarations/:id/reports/generate',
  'POST /api/documents/zip',
  'POST /api/elaboration/download',
  'POST /api/prefilled/download',
  'POST /api/backups',
  'POST /api/email-templates/:key/preview',
  'POST /api/mailing/preview',
  'POST /api/finance/price-tables/:id/simulate',
  // revogar acessos e apagar segredos nunca fica bloqueado
  'DELETE /api/employees/:id',
  'DELETE /api/robot/tokens/:id',
  'DELETE /api/customers/:id/portal-access',
  'DELETE /api/procurators/:id/certificate',
  'DELETE /api/integrations/:provider',
]);

/** Hook global (app.ts): com todos os contratos vencidos, a equipe do escritório só consulta. */
export async function assertPlanAllowsWrite(ctx: AppContext, req: FastifyRequest) {
  const user = req.auth;
  if (!user || READ_METHODS.has(req.method)) return;
  const url = req.routeOptions?.url;
  if (!url || OPEN_PREFIXES.some((p) => url.startsWith(p)) || OPEN_ROUTES.has(`${req.method} ${url}`)) return;
  if (!(await planStatus(ctx.db, user.officeId)).expired) return;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : null;
  // A exceção é só para remover segredos, sem permitir cadastrar outros com o plano vencido.
  if (req.method === 'PUT' && url === '/api/customers/:id/credentials' && body && Object.keys(body).length &&
      Object.entries(body).every(([k, v]) => ['ecacLogin', 'ecacPassword'].includes(k) && (v === null || v === ''))) return;
  if (req.method === 'PUT' && url === '/api/employees/:id' && body?.isActive === false) {
    const id = (req.params as { id?: string }).id;
    if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      const target = await ctx.db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.officeId, user.officeId)) });
      // O formulário envia todos os campos: só a desativação pode mudar.
      if (target && body.name === target.name && typeof body.email === 'string' && body.email.toLowerCase() === target.email.toLowerCase() && body.roleId === target.roleId) return;
    }
  }
  throw new HttpError(403, PLAN_EXPIRED_MESSAGE, { code: 'plan_expired' });
}
