import { BookOpen, Building2, Compass, Landmark, Sparkles } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { AiTab } from './AiTab';
import { BackupPage } from './BackupPage';
import { CashbookTab } from './CashbookTab';
import { CopilotAdminTab } from './CopilotAdminTab';
import { CopilotTab } from './CopilotTab';
import { HoldingStep } from './HoldingStep';
import { IrpfmTab } from './IrpfmTab';
import { RadarPage } from './RadarPage';

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
