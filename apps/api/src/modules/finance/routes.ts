import type { FastifyInstance } from 'fastify';
import { budgetRoutes } from './budget-routes';
import { catalogRoutes } from './catalog-routes';
import { importRoutes } from './import-routes';
import { publicRoutes } from './public-routes';
import { reportRoutes } from './report-routes';

/**
 * Financeiro: métodos de pagamento, tabelas de cobrança, orçamentos, faturamento,
 * recibos, autorização, aprovação pelo cliente, relatório e importação em lote.
 */
export async function financeRoutes(app: FastifyInstance) {
  await catalogRoutes(app);
  await budgetRoutes(app);
  await publicRoutes(app);
  await reportRoutes(app);
  await importRoutes(app);
}
