import { Plug } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { IntegrationsPage } from './IntegrationsPage';
import './integrations.css';

export const module: VerifcoModule = {
  adminTabs: [{ path: 'integracoes', label: 'Integrações', icon: Plug, element: IntegrationsPage, perms: ['integrations.manage'], order: 80 }],
};
