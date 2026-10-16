import { BookOpen, Building2, Compass, Landmark, Sparkles } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';

const AiTab = lazyPage(() => import('./AiTab'), 'AiTab');
const BackupPage = lazyPage(() => import('./BackupPage'), 'BackupPage');
const CashbookTab = lazyPage(() => import('./CashbookTab'), 'CashbookTab');
const CopilotAdminTab = lazyPage(() => import('./CopilotAdminTab'), 'CopilotAdminTab');
const CopilotTab = lazyPage(() => import('./CopilotTab'), 'CopilotTab');
const HoldingStep = lazyPage(() => import('./HoldingStep'), 'HoldingStep');
const IrpfmTab = lazyPage(() => import('./IrpfmTab'), 'IrpfmTab');
const RadarPage = lazyPage(() => import('./RadarPage'), 'RadarPage');

/** Consultoria e IA: Radar, backup, IA, IRPFM, Copiloto, livro caixa e holding. */
export const module: VerifcoModule = {
  routes: [
    { path: 'radar', element: <RadarPage /> },
    { path: 'backup', element: <BackupPage /> },
  ],
  profileTabs: [
    { path: 'ia', label: 'IA', icon: Sparkles, element: AiTab, order: 30, perms: ['ai.use'] },
    { path: 'irpfm', label: 'IRPFM', icon: Landmark, element: IrpfmTab, order: 80, perms: ['irpfm.view'] },
    { path: 'copiloto', label: 'Copiloto Financeiro', icon: Compass, element: CopilotTab, order: 85, perms: ['copilot.use'], badge: 'Novo' },
    { path: 'livro-caixa', label: 'Livro Caixa', icon: BookOpen, element: CashbookTab, order: 90, perms: ['cashbook.use'] },
  ],
  irpfSteps: [{ path: 'holding', label: 'Holding', icon: Building2, element: HoldingStep, order: 70, perms: ['holding.view'] }],
  adminTabs: [{ path: 'copiloto', label: 'Copiloto Financeiro', icon: Compass, element: CopilotAdminTab, order: 90, perms: ['copilot.manage'] }],
};
