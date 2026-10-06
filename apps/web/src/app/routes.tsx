import type { RouteObject } from 'react-router';
import { CustomerProfileLayout } from '../modules/customers/CustomerProfile';
import { MODULE_PUBLIC_ROUTES, MODULE_ROUTES, PROFILE_TABS } from './modules';

/** Rotas autenticadas (dentro do Shell): as dos módulos + o perfil do cliente com as abas de todos eles. */
export const APP_ROUTES: RouteObject[] = [
  ...MODULE_ROUTES,
  {
    path: 'clientes/:id',
    element: <CustomerProfileLayout tabs={PROFILE_TABS} />,
    children: PROFILE_TABS.map((t) => (t.path === '' ? { index: true, element: <t.element /> } : { path: `${t.path}/*`, element: <t.element /> })),
  },
];

export const PUBLIC_ROUTES: RouteObject[] = MODULE_PUBLIC_ROUTES;
