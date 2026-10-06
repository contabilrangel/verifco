import type { FastifyInstance } from 'fastify';
import { aiRoutes } from './ai';
import { backupRoutes } from './backup';
import { cashbookRoutes } from './cashbook';
import { copilotRoutes } from './copilot';
import { holdingRoutes } from './holding';
import { irpfmRoutes } from './irpfm';
import { radarRoutes } from './radar';

/**
 * Consultoria e IA: IRPFM, holding, Radar de oportunidades, assistentes de IA,
 * livro caixa (Carnê-Leão), Copiloto Financeiro e backup do escritório.
 */
export async function advisoryRoutes(app: FastifyInstance) {
  await app.register(irpfmRoutes);
  await app.register(holdingRoutes);
  await app.register(radarRoutes);
  await app.register(aiRoutes);
  await app.register(cashbookRoutes);
  await app.register(copilotRoutes);
  await app.register(backupRoutes);
}
