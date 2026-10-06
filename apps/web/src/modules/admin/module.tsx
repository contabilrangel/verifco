import { Building2, FileText, Folders, KeyRound, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { AccountPage, AccountPreferencesPage } from './AccountPages';
import { ContractsTab } from './ContractsTab';
import { EmployeesTab } from './EmployeesTab';
import { GroupsTab } from './GroupsTab';
import { ImportPage } from './ImportPage';
import { OfficeTab } from './OfficeTab';
import { PreferencesTab } from './PreferencesTab';
import { ProcuratorsTab } from './ProcuratorsTab';
import { RolesTab } from './RolesTab';
import './admin.css';

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
