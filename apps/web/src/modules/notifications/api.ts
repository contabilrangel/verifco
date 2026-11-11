import { api } from '../../lib/api';

/** Notificação do sino (GET /notifications). */
export interface AppNotification {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Chave do React Query compartilhada pelo sino (Shell) e pela página de notificações. */
export const NOTIFICATIONS_KEY = ['notifications'] as const;

/**
 * Quantas notificações a API devolve: GET /notifications não tem paginação nem filtro e traz só as
 * mais recentes. A página pagina essa lista no navegador.
 */
export const NOTIFICATIONS_API_LIMIT = 50;

export const fetchNotifications = () => api.get<AppNotification[]>('/notifications');
export const markNotificationRead = (id: string) => api.post(`/notifications/${id}/read`);
export const markAllNotificationsRead = () => api.post('/notifications/read-all');

/** Só caminhos internos abrem pelo roteador ("/clientes/..."); o resto é ignorado. */
export const notificationPath = (n: Pick<AppNotification, 'link'>) => (n.link && /^\/(?![/\\])/.test(n.link) ? n.link : null);
