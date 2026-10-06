import type { RouteObject } from 'react-router';
import { FileText } from 'lucide-react';
import { CustomerProfileLayout } from '../modules/customers/CustomerProfile';
import { ADMIN_TABS, IRPF_STEPS, MODULE_PUBLIC_ROUTES, MODULE_ROUTES, PROFILE_TABS, REPORT_TABS, type ProfileTab, type SubTab } from './modules';
import { IrpfTab, TabbedPage } from './TabbedPage';

const IrpfTabElement = () => <IrpfTab steps={IRPF_STEPS} />;

/** A aba IRPF do cliente agrega as etapas que os módulos registram. */
const profileTabs: ProfileTab[] = [
  ...PROFILE_TABS,
  ...(IRPF_STEPS.length ? [{ path: 'irpf', label: 'IRPF', icon: FileText, element: IrpfTabElement, order: 20 }] : []),
].sort((a, b) => a.order - b.order);

const tabChildren = (tabs: SubTab[]): RouteObject[] => tabs.map((t) => ({ path: `${t.path}/*`, element: <t.element /> }));

/** Rotas autenticadas (dentro do Shell). */
export const APP_ROUTES: RouteObject[] = [
  ...MODULE_ROUTES,
  {
    path: 'clientes/:id',
    element: <CustomerProfileLayout tabs={profileTabs} />,
    children: profileTabs.map((t) => (t.path === '' ? { index: true, element: <t.element /> } : { path: `${t.path}/*`, element: <t.element /> })),
  },
  {
    path: 'admin',
    element: <TabbedPage title="Administração" description="Dados do escritório, equipe, permissões, preferências e integrações." base="/admin" tabs={ADMIN_TABS} />,
    children: tabChildren(ADMIN_TABS),
  },
  {
    path: 'relatorios',
    element: <TabbedPage title="Relatórios" description="Relatórios gerais da carteira no exercício selecionado." base="/relatorios" tabs={REPORT_TABS} />,
    children: tabChildren(REPORT_TABS),
  },
];

export const PUBLIC_ROUTES: RouteObject[] = MODULE_PUBLIC_ROUTES;
