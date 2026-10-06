import { MAILING_TYPES } from '@verifco/shared';
import type { VerifcoModule } from '../../app/modules';
import { DeliveriesPage } from './DeliveriesPage';
import { Guard } from './Guard';
import { HelpPage } from './HelpPage';
import { MailingPage } from './MailingPage';
import { TemplateEditorPage, TemplatesPage } from './TemplatesPage';

const MAILING_PERMS = MAILING_TYPES.map((t) => t.permission);

export const module: VerifcoModule = {
  routes: [
    {
      path: 'comunicacao/templates',
      element: (
        <Guard perms={['email_template.list']}>
          <TemplatesPage />
        </Guard>
      ),
    },
    {
      path: 'comunicacao/templates/:key',
      element: (
        <Guard perms={['email_template.list']}>
          <TemplateEditorPage />
        </Guard>
      ),
    },
    {
      path: 'comunicacao/envios',
      element: (
        <Guard perms={['mailing.list']}>
          <DeliveriesPage />
        </Guard>
      ),
    },
    {
      path: 'comunicacao/mala-direta',
      element: (
        <Guard perms={MAILING_PERMS}>
          <MailingPage />
        </Guard>
      ),
    },
    { path: 'ajuda', element: <HelpPage /> },
  ],
};
