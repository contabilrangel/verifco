import { Receipt, Wallet } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';
import './finance.css';

const BillingReportPage = lazyPage(() => import('./BillingReport'), 'BillingReportPage');
const BudgetImportPage = lazyPage(() => import('./BudgetImportPage'), 'BudgetImportPage');
const BudgetStep = lazyPage(() => import('./BudgetStep'), 'BudgetStep');
const PaymentMethodsPage = lazyPage(() => import('./PaymentMethodsPage'), 'PaymentMethodsPage');
const PriceTablesPage = lazyPage(() => import('./PriceTablesPage'), 'PriceTablesPage');
const PublicBudgetPage = lazyPage(() => import('./PublicBudgetPage'), 'PublicBudgetPage');

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
