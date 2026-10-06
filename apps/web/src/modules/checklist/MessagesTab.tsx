import { useEffect } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Card, Loading, Tag } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { useCustomer } from '../customers/customerContext';
import { ChatThread, Composer, timeOf, type ChatEntry } from './Chat';
import type { OfficeMessage } from './types';

interface Conversation {
  messages: OfficeMessage[];
  unread: number;
  portalEnabled: boolean;
  hasMobile: boolean;
}

const deliveryLabel = (s: string | null) => (s === 'failed' ? 'falhou' : s === 'queued' ? 'na fila' : s ? 'enviado' : null);

/** Aba "Mensagens" do perfil do cliente: conversa pelo portal (e WhatsApp, se escolhido). */
export function MessagesTab() {
  const { customer } = useCustomer();
  const { can } = useAuth();
  const qc = useQueryClient();
  const key = ['messages', customer.id];
  const q = useApi<Conversation>(key, `/customers/${customer.id}/messages`, { refetchInterval: 20_000 });
  const unread = q.data?.unread ?? 0;

  useEffect(() => {
    if (!unread) return;
    void api.post(`/customers/${customer.id}/messages/read`).then(() => qc.invalidateQueries({ queryKey: key }));
  }, [unread, customer.id]);

  const send = useAction((v: { body: string; whatsapp: boolean }) => api.post<{ messages: OfficeMessage[] }>(`/customers/${customer.id}/messages`, v), {
    success: (r) => (r.messages.at(-1)?.channel === 'whatsapp' ? 'Mensagem enviada pelo portal e WhatsApp.' : 'Mensagem enviada.'),
    invalidate: [key],
  });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <Alert tone="danger">Não foi possível carregar as mensagens.</Alert>;
  const c = q.data;

  const entries: ChatEntry[] = c.messages.map((m) => {
    const mine = m.direction === 'out';
    const parts = [mine ? (m.authorName ?? 'Escritório') : customer.name.split(' ')[0], timeOf(m.createdAt)];
    if (m.channel === 'whatsapp') parts.push(`WhatsApp${deliveryLabel(m.deliveryStatus) ? ` (${deliveryLabel(m.deliveryStatus)})` : ''}`);
    if (mine) parts.push(m.readAt ? 'lida' : 'não lida');
    return { id: m.id, mine, body: m.body, createdAt: m.createdAt, meta: parts.join(' · ') };
  });

  return (
    <Card
      title="Mensagens"
      actions={<Tag tone={c.portalEnabled ? 'success' : 'neutral'}>{c.portalEnabled ? 'Cliente com acesso ao portal' : 'Sem acesso ao portal'}</Tag>}
    >
      <div className="vf-stack">
        {!c.portalEnabled && (
          <Alert tone="warning" title="O cliente ainda não acessa o portal">
            As mensagens ficam guardadas, mas ele só consegue ler e responder depois de receber o acesso. Gere o acesso na aba{' '}
            <Link to={`/clientes/${customer.id}/identificacao`}>Identificação</Link>
            {c.hasMobile ? ' ou envie também por WhatsApp.' : '.'}
          </Alert>
        )}
        <ChatThread entries={entries} empty="Envie a primeira mensagem. O cliente lê e responde pelo portal." />
        {can('message.send') ? (
          <Composer
            sending={send.isPending}
            onSend={(body, whatsapp) => send.mutateAsync({ body, whatsapp })}
            whatsapp={{ available: c.hasMobile, hint: 'Cadastre o celular do cliente para enviar por WhatsApp.' }}
          />
        ) : (
          <p className="vf-muted vf-text-sm">Seu perfil pode ler, mas não enviar mensagens.</p>
        )}
      </div>
    </Card>
  );
}
