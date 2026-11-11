import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ChatAttachment } from '../checklist/Chat';

/**
 * Chaves do React Query das mensagens do escritório. Tudo começa por `messages`: enviar ou marcar
 * como lida invalida a conversa, a caixa de mensagens e o selo do menu de uma vez.
 */
export const MESSAGES_KEY = ['messages'] as const;
export const conversationKey = (customerId: string) => ['messages', customerId] as const;
export const THREADS_KEY = ['messages', 'threads'] as const;
export const UNREAD_KEY = ['messages', 'unread-count'] as const;

/** Mensagem da conversa na visão do escritório (GET /customers/:id/messages). */
export interface OfficeMessage {
  id: string;
  direction: 'in' | 'out';
  channel: 'portal' | 'whatsapp' | string;
  body: string;
  createdAt: string;
  readAt: string | null;
  authorName: string | null;
  deliveryStatus: string | null;
  attachments?: ChatAttachment[];
}

export interface Conversation {
  customer?: { id: string; name: string };
  messages: OfficeMessage[];
  unread: number;
  portalEnabled: boolean;
  hasMobile: boolean;
}

/** Linha da caixa de mensagens (GET /messages/threads): um cliente e a última mensagem da conversa. */
export interface Thread {
  customer: { id: string; name: string };
  unread: number;
  lastMessage: {
    id: string;
    direction: 'in' | 'out';
    channel: string;
    preview: string;
    authorName: string | null;
    createdAt: string;
    hasAttachments: boolean;
  };
}

export interface ThreadPage {
  data: Thread[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export type ThreadFilter = 'unread' | 'all';

/** Não lidas do escritório: `count` mensagens em `threads` conversas. */
export interface UnreadCount {
  count: number;
  threads: number;
}

/**
 * Mensagens de clientes ainda não lidas (selo do menu e aba "Não lidas"). Uma resposta fora do
 * formato esperado conta como zero: o selo nunca derruba o menu.
 */
export function useUnreadMessages(enabled = true): UnreadCount {
  const q = useQuery({ queryKey: UNREAD_KEY, queryFn: () => api.get<UnreadCount>('/messages/unread-count'), enabled, refetchInterval: 60_000, retry: false });
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
  return { count: n(q.data?.count), threads: n(q.data?.threads) };
}

export const attachmentPath = (customerId: string, messageId: string, fileId: string) => `/customers/${customerId}/messages/${messageId}/attachments/${fileId}`;
