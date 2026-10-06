import { FileWarning, HandCoins, Scale } from 'lucide-react';
import { INDIVIDUAL_REPORTS } from '@verifco/shared';
import type { VerifcoModule } from '../../app/modules';
import { BacklogsReport, RefundsReport, ResultsReport } from './GeneralReports';
import { IrpfReportsStep } from './IrpfReportsStep';

export const module: VerifcoModule = {
  reportTabs: [
    { path: 'resultados', label: 'Resultados', icon: Scale, element: ResultsReport, perms: ['report.results'], order: 20 },
    { path: 'documentos-faltantes', label: 'Documentos faltantes', icon: FileWarning, element: BacklogsReport, perms: ['report.backlogs'], order: 30 },
    { path: 'restituicao', label: 'Restituição', icon: HandCoins, element: RefundsReport, perms: ['report.refund'], order: 40 },
  ],
  irpfSteps: [
    {
      path: 'relatorios',
      label: 'Relatórios',
      element: IrpfReportsStep,
      perms: [...INDIVIDUAL_REPORTS.map((r) => r.permission), 'post_declaration.send_kit'],
      order: 50,
    },
  ],
};
