import { ClipboardList, FileSpreadsheet, FolderOpen, LayoutDashboard, Receipt } from 'lucide-react';
import { KANBAN_PERMISSIONS } from '@verifco/shared';
import { HomeRoute, RequirePermission } from '../../app/access';
import type { VerifcoModule } from '../../app/modules';
import { BacklogsStep } from './BacklogsStep';
import { CustomerDashboardTab } from './CustomerDashboardTab';
import { DarfStep } from './DarfStep';
import { DashboardPage } from './DashboardPage';
import { DeclarationStep } from './DeclarationStep';
import { DocumentsStep } from './DocumentsStep';
import { KanbanPage } from './KanbanPage';

/** Núcleo do IRPF: dashboard, Kanban, painel do cliente e etapas da declaração. */
export const module: VerifcoModule = {
  routes: [
    // "/" é a página inicial: sem as permissões do dashboard, leva ao primeiro destino do menu
    {
      index: true,
      element: (
        <HomeRoute>
          <DashboardPage />
        </HomeRoute>
      ),
    },
    {
      path: 'kanban',
      element: (
        <RequirePermission perms={KANBAN_PERMISSIONS} title="Kanban">
          <KanbanPage />
        </RequirePermission>
      ),
    },
  ],
  profileTabs: [{ path: '', label: 'Painel', icon: LayoutDashboard, element: CustomerDashboardTab, order: 10, perms: ['declaration.view'] }],
  irpfSteps: [
    { path: 'declaracao', label: 'Declaração', icon: FileSpreadsheet, element: DeclarationStep, order: 20, perms: ['declaration.view'] },
    { path: 'darf', label: 'DARF', icon: Receipt, element: DarfStep, order: 40, perms: ['darf.view'] },
    { path: 'pendencias', label: 'Documentos faltantes', icon: ClipboardList, element: BacklogsStep, order: 60, perms: ['declaration.view'] },
    { path: 'documentos', label: 'Documentos', icon: FolderOpen, element: DocumentsStep, order: 65, perms: ['declaration.view', 'customer.download_documents'] },
  ],
};
