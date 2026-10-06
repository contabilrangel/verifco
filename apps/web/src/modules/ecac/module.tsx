import { Bot, Landmark, MousePointerClick } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { DownloadsPage } from './DownloadsPage';
import { EcacActionsTab } from './EcacActionsTab';
import { EcacTab } from './EcacTab';
import { ElaborationPage } from './ElaborationPage';
import { PrefilledPage } from './PrefilledPage';
import { RobotAdminTab } from './RobotAdminTab';
import './ecac.css';

/** eCAC, robô (extensão e sincronizador), pré-preenchidas, elaboração e central de downloads. */
export const module: VerifcoModule = {
  routes: [
    { path: 'pre-preenchidas', element: <PrefilledPage /> },
    { path: 'elaboracao', element: <ElaborationPage /> },
    { path: 'downloads', element: <DownloadsPage /> },
  ],
  profileTabs: [
    { path: 'ecac', label: 'eCAC', icon: Landmark, element: EcacTab, order: 40, perms: ['ecac.view'] },
    { path: 'acoes-ecac', label: 'Ações eCAC', icon: MousePointerClick, element: EcacActionsTab, order: 45, perms: ['ecac.actions'] },
  ],
  adminTabs: [{ path: 'robo', label: 'Robô', icon: Bot, element: RobotAdminTab, order: 85, perms: ['ecac.robot', 'ecac.sync'] }],
};
