import type { RouteObject } from 'react-router';
import { Navigate, useParams } from 'react-router';
import { FileText } from 'lucide-react';
import { CustomerProfileLayout } from '../modules/customers/CustomerProfile';
import { ADMIN_TABS, IRPF_STEPS, MODULE_PUBLIC_ROUTES, MODULE_ROUTES, PROFILE_TABS, REPORT_TABS, type ProfileTab, type SubTab } from './modules';
import { useAuth } from '../lib/auth';
import { NotFound } from './NotFound';
import { RequireTabPermission } from './TabGuard';
import { IrpfTab, TabbedPage } from './TabbedPage';

const IrpfTabElement = () => <IrpfTab steps={IRPF_STEPS} />;

/** A aba IRPF do cliente agrega as etapas que os módulos registram. */
const profileTabs: ProfileTab[] = [
  ...PROFILE_TABS,
  ...(IRPF_STEPS.length ? [{ path: 'irpf', label: 'IRPF', icon: FileText, element: IrpfTabElement, order: 20 }] : []),
].sort((a, b) => a.order - b.order);

/** Conteúdo de uma aba, só para quem tem as permissões do registro da aba (`perms`). */
const guarded = (t: Pick<SubTab, 'perms' | 'label' | 'element'>) => (
  <RequireTabPermission perms={t.perms} label={t.label}>
    <t.element />
  </RequireTabPermission>
);

/** Abas de uma página com abas e, por último, a aba desconhecida (/admin/<x>, /relatorios/<x>): 404. */
const tabChildren = (tabs: SubTab[], base: string, backLabel: string): RouteObject[] => [
  ...tabs.map((t) => ({ path: `${t.path}/*`, element: guarded(t) })),
  { path: '*', element: <NotFound variant="tab" backTo={base} backLabel={backLabel} /> },
];

/** Aba desconhecida do perfil do cliente (/clientes/:id/<x>). */
function ProfileTabNotFound() {
  const { id } = useParams();
  return <NotFound variant="tab" backTo={`/clientes/${id}`} backLabel="Abrir o painel do cliente" />;
}

/**
 * Aba inicial do perfil (/clientes/:id). Quem não pode abri-la (ex.: o Painel exige ver declarações)
 * vai para a primeira aba que vê, em vez de parar num "sem permissão" logo ao abrir o cliente.
 */
function ProfileIndex({ tab }: { tab: ProfileTab }) {
  const { can } = useAuth();
  const { id } = useParams();
  const allowed = (t: ProfileTab) => !t.perms?.length || can(...t.perms);
  const other = allowed(tab) ? null : profileTabs.find((t) => t.path !== '' && allowed(t));
  if (other) return <Navigate to={`/clientes/${id}/${other.path}`} replace />;
  return guarded(tab);
}

/** Rotas autenticadas (dentro do Shell). */
export const APP_ROUTES: RouteObject[] = [
  ...MODULE_ROUTES,
  {
    path: 'clientes/:id',
    element: <CustomerProfileLayout tabs={profileTabs} />,
    children: [
      ...profileTabs.map((t) => (t.path === '' ? { index: true, element: <ProfileIndex tab={t} /> } : { path: `${t.path}/*`, element: guarded(t) })),
      { path: '*', element: <ProfileTabNotFound /> },
    ],
  },
  {
    path: 'admin',
    element: <TabbedPage title="Meu escritório" description="Dados do escritório, equipe, permissões, preferências e integrações." base="/admin" tabs={ADMIN_TABS} />,
    children: tabChildren(ADMIN_TABS, '/admin', 'Abrir Meu escritório'),
  },
  {
    path: 'relatorios',
    element: <TabbedPage title="Relatórios" description="Relatórios gerais da carteira no exercício selecionado." base="/relatorios" tabs={REPORT_TABS} />,
    children: tabChildren(REPORT_TABS, '/relatorios', 'Abrir Relatórios'),
  },
];

export const PUBLIC_ROUTES: RouteObject[] = MODULE_PUBLIC_ROUTES;
