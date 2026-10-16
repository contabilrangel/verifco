import { Building2, FileText, Folders, KeyRound, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';
import './admin.css';

const AccountPage = lazyPage(() => import('./AccountPages'), 'AccountPage');
const AccountPreferencesPage = lazyPage(() => import('./AccountPages'), 'AccountPreferencesPage');
const ContractsTab = lazyPage(() => import('./ContractsTab'), 'ContractsTab');
const EmployeesTab = lazyPage(() => import('./EmployeesTab'), 'EmployeesTab');
const GroupsTab = lazyPage(() => import('./GroupsTab'), 'GroupsTab');
const ImportPage = lazyPage(() => import('./ImportPage'), 'ImportPage');
const OfficeTab = lazyPage(() => import('./OfficeTab'), 'OfficeTab');
const PreferencesTab = lazyPage(() => import('./PreferencesTab'), 'PreferencesTab');
const ProcuratorsTab = lazyPage(() => import('./ProcuratorsTab'), 'ProcuratorsTab');
const RolesTab = lazyPage(() => import('./RolesTab'), 'RolesTab');

/** Administração do escritório, conta do usuário e importações em lote. */
export const module: VerifcoModule = {
  routes: [
    { path: 'conta', element: <AccountPage /> },
    { path: 'conta/preferencias', element: <AccountPreferencesPage /> },
    // `importacoes/orcamentos` é do módulo financeiro (rota estática tem prioridade sobre esta)
    { path: 'importacoes/:tipo', element: <ImportPage /> },
  ],
  adminTabs: [
    { path: 'empresa', label: 'Empresa', icon: Building2, element: OfficeTab, perms: ['office.edit'], order: 10 },
    { path: 'preferencias', label: 'Preferências', icon: SlidersHorizontal, element: PreferencesTab, perms: ['settings.view', 'settings.edit'], order: 20 },
    { path: 'colaboradores', label: 'Colaboradores', icon: Users, element: EmployeesTab, perms: ['employee.list'], order: 30 },
    { path: 'funcoes', label: 'Funções', icon: ShieldCheck, element: RolesTab, perms: ['role.list'], order: 40 },
    {
      path: 'grupos',
      label: 'Grupos',
      icon: Folders,
      element: GroupsTab,
      perms: ['customer_group.list', 'customer_group.create', 'customer_group.edit', 'customer_group.delete'],
      order: 50,
    },
    {
      path: 'procuradores',
      label: 'Procuradores',
      icon: KeyRound,
      element: ProcuratorsTab,
      perms: ['procuration.list', 'procuration.edit', 'procuration.certificate'],
      order: 60,
    },
    { path: 'contratos', label: 'Contratos', icon: FileText, element: ContractsTab, perms: ['contracts.view'], order: 70 },
  ],
};
