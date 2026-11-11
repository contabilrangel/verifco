import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';

const NotificationsPage = lazyPage(() => import('./NotificationsPage'), 'NotificationsPage');

/** Notificações do usuário: a página "Ver todas" do sino da barra superior. */
export const module: VerifcoModule = {
  routes: [{ path: 'notificacoes', element: <NotificationsPage /> }],
};
