import { Navigate } from 'react-router';
import { MessagesSquare } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';
import './checklist.css';

const ChecklistLinkPage = lazyPage(() => import('./ChecklistLinkPage'), 'ChecklistLinkPage');
const DocumentationStep = lazyPage(() => import('./DocumentationStep'), 'DocumentationStep');
const MessagesTab = lazyPage(() => import('./MessagesTab'), 'MessagesTab');
const PortalChecklist = lazyPage(() => import('./Portal'), 'PortalChecklist');
const PortalHome = lazyPage(() => import('./Portal'), 'PortalHome');
const PortalLayout = lazyPage(() => import('./Portal'), 'PortalLayout');
const PortalMessages = lazyPage(() => import('./Portal'), 'PortalMessages');

/** Checklist DIRPF (digital e PDF), portal do cliente e mensagens. */
export const module: VerifcoModule = {
  irpfSteps: [
    { path: 'documentacao', label: 'Documentação', element: DocumentationStep, order: 30, perms: ['checklist_digital.view', 'checklist_pdf.view', 'checklist_pdf.download', 'checklist_pdf.send'] },
  ],
  profileTabs: [{ path: 'mensagens', label: 'Mensagens', icon: MessagesSquare, element: MessagesTab, order: 95 }],
  publicRoutes: [
    { path: '/checklist/:token', element: <ChecklistLinkPage /> },
    {
      path: '/portal',
      element: <PortalLayout />,
      children: [
        { index: true, element: <PortalHome /> },
        { path: 'checklist/:checklistId', element: <PortalChecklist /> },
        { path: 'mensagens', element: <PortalMessages /> },
        { path: '*', element: <Navigate to="/portal" replace /> },
      ],
    },
  ],
};
