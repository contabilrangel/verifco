import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, MessagesSquare, Paperclip, RefreshCw, Search } from 'lucide-react';
import { Avatar, Button, Card, EmptyState, Input, Loading, Pagination, Tabs, cx } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api, errorMessage, qs } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { OfficeConversation } from './Conversation';
import { THREADS_KEY, useUnreadMessages, type Thread, type ThreadFilter, type ThreadPage } from './api';

/** Conversas por página na caixa de mensagens. */
export const THREADS_PAGE_SIZE = 20;

/** Hora da última mensagem: de hoje, a hora; de ontem, "Ontem"; antes disso, a data. */
export function threadTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, new Date(now.getTime() - 86400_000))) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
}

const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || 'Escritório';
const unreadLabel = (n: number) => (n === 1 ? '1 mensagem não lida' : `${n} mensagens não lidas`);

function ThreadRow({ thread, active }: { thread: Thread; active: boolean }) {
  const { customer, lastMessage: last, unread } = thread;
  return (
    <li>
      <Link to={`/mensagens/${customer.id}`} className={cx('msg-thread', active && 'msg-thread--active', unread > 0 && 'msg-thread--unread')} aria-current={active ? 'true' : undefined}>
        <Avatar name={customer.name} size={36} />
        <span className="msg-thread__main">
          <span className="msg-thread__line">
            <span className="msg-thread__name">{customer.name}</span>
            <time className="msg-thread__time" dateTime={last.createdAt}>
              {threadTime(last.createdAt)}
            </time>
          </span>
          <span className="msg-thread__line">
            <span className="msg-thread__preview">
              {last.hasAttachments && <Paperclip aria-label="Com anexo" />}
              {last.direction === 'out' ? `${firstName(last.authorName)}: ` : ''}
              {last.preview}
              {last.channel === 'whatsapp' ? ' · WhatsApp' : ''}
            </span>
            {unread > 0 && (
              <span className="vf-badge" title={unreadLabel(unread)}>
                {unread > 99 ? '99+' : unread}
                <span className="sr-only"> {unread === 1 ? 'não lida' : 'não lidas'}</span>
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * Caixa de mensagens do escritório: as conversas de todos os clientes que o usuário enxerga, com
 * as não lidas em destaque. Clicar abre a conversa ao lado (no celular, no lugar da lista), o que
 * marca as mensagens do cliente como lidas.
 */
export function MessagesPage() {
  const { customerId } = useParams<{ customerId?: string }>();
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(text.trim(), 300);
  const unread = useUnreadMessages();

  useEffect(() => setPage(1), [filter, term]);

  const q = useQuery({
    queryKey: [...THREADS_KEY, { filter, q: term, page }],
    queryFn: () => api.get<ThreadPage>(`/messages/threads${qs({ filter, q: term, page, pageSize: THREADS_PAGE_SIZE })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
    retry: false,
  });
  const threads = Array.isArray(q.data?.data) ? q.data.data : [];
  const total = q.data?.total ?? 0;
  const pages = q.data?.pages ?? 1;
  // a última página esvaziou (conversas lidas saem de "Não lidas"): volta para a que existe
  useEffect(() => {
    if (q.data && page > pages) setPage(pages);
  }, [q.data, page, pages]);

  return (
    <>
      <PageHeader
        title="Mensagens"
        description="Conversas com os clientes pelo portal e pelo WhatsApp. Abrir uma conversa marca as mensagens do cliente como lidas."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Mensagens' }]}
      />
      <div className={cx('msg-layout', customerId && 'msg-layout--open')}>
        <Card flush className="msg-layout__list">
          <div className="msg-filters">
            <Tabs<ThreadFilter>
              value={filter}
              onChange={setFilter}
              items={[
                { value: 'all', label: 'Todas' },
                { value: 'unread', label: unread.threads ? `Não lidas (${unread.threads})` : 'Não lidas' },
              ]}
            />
            <Input aria-label="Buscar conversa" placeholder="Busque por nome ou CPF/CNPJ" icon={<Search />} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          {q.isLoading ? (
            <Loading />
          ) : q.isError ? (
            // erro não é "nenhuma conversa": diz o que houve e deixa tentar de novo
            <EmptyState
              icon={<MessagesSquare />}
              title="Não foi possível carregar as conversas"
              description={errorMessage(q.error)}
              action={
                <Button kind="secondary" icon={<RefreshCw />} loading={q.isFetching} onClick={() => void q.refetch()}>
                  Tentar de novo
                </Button>
              }
            />
          ) : threads.length === 0 ? (
            <EmptyState
              icon={<MessagesSquare />}
              title={term ? 'Nenhuma conversa encontrada' : filter === 'unread' ? 'Nenhuma mensagem por ler' : 'Nenhuma conversa ainda'}
              description={
                term
                  ? `Nenhum cliente com conversa corresponde a “${term}”${filter === 'unread' ? ' entre as não lidas' : ''}.`
                  : filter === 'unread'
                    ? 'As mensagens dos clientes que ninguém do escritório abriu aparecem aqui.'
                    : 'As conversas aparecem aqui depois da primeira mensagem. Para começar uma, abra o cliente e use a aba Mensagens.'
              }
            />
          ) : (
            <ul className="msg-list" aria-label="Conversas">
              {threads.map((t) => (
                <ThreadRow key={t.customer.id} thread={t} active={t.customer.id === customerId} />
              ))}
            </ul>
          )}
          {pages > 1 && <Pagination page={Math.min(page, pages)} pages={pages} total={total} onChange={setPage} />}
        </Card>

        <div className="msg-layout__thread">
          {customerId ? (
            <>
              <Link to="/mensagens" className="vf-btn vf-btn--tertiary vf-btn--sm msg-back">
                <ArrowLeft />
                Voltar às conversas
              </Link>
              <OfficeConversation
                key={customerId}
                customerId={customerId}
                title={(name) => name}
                actions={
                  <Link to={`/clientes/${customerId}`} className="vf-btn vf-btn--secondary vf-btn--sm">
                    Abrir cliente
                  </Link>
                }
              />
            </>
          ) : (
            <Card className="msg-layout__placeholder">
              <EmptyState icon={<MessagesSquare />} title="Escolha uma conversa" description="Clique num cliente da lista para ler e responder." />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
