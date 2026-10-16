import { ClipboardList, FileSpreadsheet, FolderOpen, LayoutDashboard, Receipt } from 'lucide-react';
import { KANBAN_PERMISSIONS } from '@verifco/shared';
import { HomeRoute, RequirePermission } from '../../app/access';
import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';

const BacklogsStep = lazyPage(() => import('./BacklogsStep'), 'BacklogsStep');
const CustomerDashboardTab = lazyPage(() => import('./CustomerDashboardTab'), 'CustomerDashboardTab');
const DarfStep = lazyPage(() => import('./DarfStep'), 'DarfStep');
const DashboardPage = lazyPage(() => import('./DashboardPage'), 'DashboardPage');
const DeclarationStep = lazyPage(() => import('./DeclarationStep'), 'DeclarationStep');
const DocumentsStep = lazyPage(() => import('./DocumentsStep'), 'DocumentsStep');
const KanbanPage = lazyPage(() => import('./KanbanPage'), 'KanbanPage');

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
