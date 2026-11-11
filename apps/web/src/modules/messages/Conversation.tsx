import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Card, Loading, Tag, useToast } from '../../ds';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { ChatThread, Composer, timeOf, type ChatEntry } from '../checklist/Chat';
import { MESSAGES_KEY, attachmentPath, conversationKey, type Conversation, type OfficeMessage } from './api';

const deliveryLabel = (s: string | null) => (s === 'failed' ? 'falhou' : s === 'queued' ? 'na fila' : s ? 'enviado' : null);

/**
 * Conversa do escritório com um cliente (portal e, se escolhido, WhatsApp), com anexos. É a mesma
 * na aba "Mensagens" do cliente e na caixa de mensagens: abrir marca as mensagens do cliente como
 * lidas e atualiza a caixa e o selo do menu.
 */
export function OfficeConversation({
  customerId,
  customerName,
  title,
  actions,
}: {
  customerId: string;
  /** Nome já conhecido por quem chama; sem ele, vale o que a conversa devolve. */
  customerName?: string;
  /** Título do cartão a partir do nome do cliente (padrão: "Mensagens"). */
  title?: (customerName: string) => ReactNode;
  actions?: ReactNode;
}) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const path = `/customers/${customerId}/messages`;
  const q = useApi<Conversation>(conversationKey(customerId), path, { refetchInterval: 20_000 });
  const unread = q.data?.unread ?? 0;

  useEffect(() => {
    if (!unread) return;
    void api
      .post(`${path}/read`)
      .then(() => qc.invalidateQueries({ queryKey: MESSAGES_KEY }))
      .catch(() => {
        /* fica como não lida; ao reabrir a conversa, tenta de novo */
      });
  }, [unread, path, qc]);

  const send = useAction(
    (v: { body: string; whatsapp: boolean; files: File[] }) =>
      v.files.length
        ? api.upload<{ messages: OfficeMessage[] }>(path, v.files, { body: v.body, whatsapp: String(v.whatsapp) })
        : api.post<{ messages: OfficeMessage[] }>(path, { body: v.body, whatsapp: v.whatsapp }),
    {
      success: (r) => (r.messages.at(-1)?.channel === 'whatsapp' ? 'Mensagem enviada pelo portal e WhatsApp.' : 'Mensagem enviada.'),
      invalidate: [MESSAGES_KEY],
    },
  );

  if (q.isLoading) return <Loading />;
  if (!q.data) return <Alert tone="danger">{errorMessage(q.error, 'Não foi possível carregar as mensagens.')}</Alert>;
  const c = q.data;
  const name = customerName ?? c.customer?.name ?? 'Cliente';

  const entries: ChatEntry[] = c.messages.map((m) => {
    const mine = m.direction === 'out';
    const parts = [mine ? (m.authorName ?? 'Escritório') : name.split(' ')[0], timeOf(m.createdAt)];
    if (m.channel === 'whatsapp') parts.push(`WhatsApp${deliveryLabel(m.deliveryStatus) ? ` (${deliveryLabel(m.deliveryStatus)})` : ''}`);
    if (mine) parts.push(m.readAt ? 'lida' : 'não lida');
    return { id: m.id, mine, body: m.body, createdAt: m.createdAt, meta: parts.join(' · '), attachments: m.attachments ?? [] };
  });

  return (
    <Card
      title={title ? title(name) : 'Mensagens'}
      actions={
        <>
          <Tag tone={c.portalEnabled ? 'success' : 'neutral'}>{c.portalEnabled ? 'Cliente com acesso ao portal' : 'Sem acesso ao portal'}</Tag>
          {actions}
        </>
      }
    >
      <div className="vf-stack">
        {!c.portalEnabled && (
          <Alert tone="warning" title="O cliente ainda não acessa o portal">
            As mensagens ficam guardadas, mas ele só consegue ler e responder depois de receber o acesso. Gere o acesso na aba{' '}
            <Link to={`/clientes/${customerId}/identificacao`}>Identificação</Link>
            {c.hasMobile ? ' ou envie também por WhatsApp.' : '.'}
          </Alert>
        )}
        <ChatThread
          entries={entries}
          empty="Envie a primeira mensagem. O cliente lê e responde pelo portal."
          onDownload={(m, file) => api.download(attachmentPath(customerId, m.id, file.fileId), file.filename).catch((e) => toast.error(errorMessage(e, 'Não foi possível baixar o anexo. Tente de novo.')))}
        />
        {can('message.send') ? (
          <Composer
            sending={send.isPending}
            onSend={(body, whatsapp, files) => send.mutateAsync({ body, whatsapp, files })}
            whatsapp={{ available: c.hasMobile, hint: 'Cadastre o celular do cliente para enviar por WhatsApp.' }}
          />
        ) : (
          <p className="vf-muted vf-text-sm">Seu perfil pode ler, mas não enviar mensagens.</p>
        )}
      </div>
    </Card>
  );
}
