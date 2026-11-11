import type { VerifcoModule } from '../../app/modules';
import { RequirePermission } from '../../app/access';
import { lazyPage } from '../../lib/lazy';
import './messages.css';

const MessagesPage = lazyPage(() => import('./MessagesPage'), 'MessagesPage');

/** A mesma permissão que a API pede para ler as conversas (GET /messages/threads). */
export const MESSAGES_PERMS = ['customer.list'];

/** Caixa de mensagens do escritório: /mensagens (lista) e /mensagens/:customerId (conversa aberta). */
export const module: VerifcoModule = {
  routes: [
    {
      path: 'mensagens/:customerId?',
      element: (
        <RequirePermission perms={MESSAGES_PERMS} title="Mensagens">
          <MessagesPage />
        </RequirePermission>
      ),
    },
  ],
};
