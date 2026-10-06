import type { FastifyInstance } from 'fastify';
import { guard, requireUser } from '../../lib/http';
import { officeContractStatus } from '../../services/declarations';

/** Situação do contrato do escritório (validade e uso do limite de declarações). */
export async function contractsRoutes(app: FastifyInstance) {
  app.get('/office/contracts/status', { preHandler: guard('contracts.view') }, async (req) => {
    const user = requireUser(req);
    const s = await officeContractStatus(app.ctx.db, user.officeId);
    return {
      hasContracts: s.hasContracts,
      blocked: s.blocked,
      lastExpiresAt: s.lastExpiresAt,
      nextStartsAt: s.nextStartsAt,
      activeExpiresAt: s.active.map((c) => c.expiresAt).sort().at(-1) ?? null,
      quotas: s.quotas,
    };
  });
}
