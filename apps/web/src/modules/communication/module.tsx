import { MAILING_TYPES } from '@verifco/shared';
import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';
import { Guard } from './Guard';

const DeliveriesPage = lazyPage(() => import('./DeliveriesPage'), 'DeliveriesPage');
const HelpPage = lazyPage(() => import('./HelpPage'), 'HelpPage');
const MailingPage = lazyPage(() => import('./MailingPage'), 'MailingPage');
const TemplateEditorPage = lazyPage(() => import('./TemplatesPage'), 'TemplateEditorPage');
const TemplatesPage = lazyPage(() => import('./TemplatesPage'), 'TemplatesPage');

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
