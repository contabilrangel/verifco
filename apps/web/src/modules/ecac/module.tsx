import { Bot, Landmark, MousePointerClick } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';
import './ecac.css';

const DownloadsPage = lazyPage(() => import('./DownloadsPage'), 'DownloadsPage');
const EcacActionsTab = lazyPage(() => import('./EcacActionsTab'), 'EcacActionsTab');
const EcacTab = lazyPage(() => import('./EcacTab'), 'EcacTab');
const ElaborationPage = lazyPage(() => import('./ElaborationPage'), 'ElaborationPage');
const PrefilledPage = lazyPage(() => import('./PrefilledPage'), 'PrefilledPage');
const RobotAdminTab = lazyPage(() => import('./RobotAdminTab'), 'RobotAdminTab');

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
