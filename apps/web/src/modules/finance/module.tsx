import { Receipt, Wallet } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { BillingReportPage } from './BillingReport';
import { BudgetImportPage } from './BudgetImportPage';
import { BudgetStep } from './BudgetStep';
import { PaymentMethodsPage } from './PaymentMethodsPage';
import { PriceTablesPage } from './PriceTablesPage';
import { PublicBudgetPage } from './PublicBudgetPage';
import './finance.css';

/** Financeiro: métodos, tabelas, orçamento/faturamento do cliente, relatório e lote. */
export const module: VerifcoModule = {
  routes: [
    { path: 'financeiro/metodos', element: <PaymentMethodsPage /> },
    { path: 'financeiro/tabelas', element: <PriceTablesPage /> },
    { path: 'importacoes/orcamentos', element: <BudgetImportPage /> },
  ],
  publicRoutes: [{ path: '/orcamento/:token', element: <PublicBudgetPage /> }],
  irpfSteps: [{ path: 'orcamento', label: 'Orçamento', icon: Wallet, element: BudgetStep, perms: ['budget.list'], order: 10 }],
  reportTabs: [{ path: 'faturamento', label: 'Faturamento', icon: Receipt, element: BillingReportPage, perms: ['report.billing'], order: 10 }],
};
