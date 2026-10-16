import { Plug } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';
import './integrations.css';

const IntegrationsPage = lazyPage(() => import('./IntegrationsPage'), 'IntegrationsPage');

export const module: VerifcoModule = {
  adminTabs: [{ path: 'integracoes', label: 'Integrações', icon: Plug, element: IntegrationsPage, perms: ['integrations.manage'], order: 80 }],
};
