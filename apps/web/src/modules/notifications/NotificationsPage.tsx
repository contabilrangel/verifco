import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CheckCheck, RefreshCw } from 'lucide-react';
import { Button, Card, EmptyState, Loading, Pagination, Tabs, Tag, usePagination, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import { NOTIFICATIONS_API_LIMIT, NOTIFICATIONS_KEY, fetchNotifications, markAllNotificationsRead, markNotificationRead, notificationPath, type AppNotification } from './api';

/** Notificações por página (a lista inteira já está no navegador). */
export const NOTIFICATIONS_PAGE_SIZE = 10;

type Filter = 'all' | 'unread';

/** Todas as notificações que a API devolve, com filtro de não lidas e paginação. */
export function NotificationsPage() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: NOTIFICATIONS_KEY, queryFn: fetchNotifications, retry: false });
  const all = Array.isArray(q.data) ? q.data : [];
  const unread = all.filter((n) => !n.readAt);
  const list = filter === 'unread' ? unread : all;
  const pg = usePagination(list, { pageSize: NOTIFICATIONS_PAGE_SIZE, resetKey: filter });
  const disabled = me?.user.notificationPrefs?.enabled === false;
  const refresh = () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });

  const markAll = async () => {
    setBusy(true);
    try {
      await markAllNotificationsRead();
      await refresh();
      toast.success('Notificações marcadas como lidas.');
    } catch (e) {
      toast.error(errorMessage(e, 'Não foi possível marcar as notificações como lidas. Tente de novo.'));
    } finally {
      setBusy(false);
    }
  };

  const markOne = async (n: AppNotification) => {
    try {
      await markNotificationRead(n.id);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e, 'Não foi possível marcar a notificação como lida. Tente de novo.'));
    }
  };

  const open = async (n: AppNotification) => {
    // abrir não depende de conseguir marcar como lida
    if (!n.readAt) await markNotificationRead(n.id).catch(() => {});
    void refresh();
    const to = notificationPath(n);
    if (to) navigate(to);
  };

  return (
    <>
      <PageHeader
        title="Notificações"
        description="Avisos do Verifco para você e para o escritório: sincronizações, importações, mensagens de clientes e prazos."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Notificações' }]}
        actions={
          <Button kind="secondary" icon={<CheckCheck />} disabled={!unread.length} loading={busy} onClick={() => void markAll()}>
            Marcar todas como lidas
          </Button>
        }
      />
      <Card flush>
        <div style={{ padding: '8px 16px 0' }}>
          <Tabs<Filter>
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'all', label: `Todas (${all.length})` },
              { value: 'unread', label: `Não lidas (${unread.length})` },
            ]}
          />
        </div>
        {q.isLoading ? (
          <Loading label="Carregando notificações..." />
        ) : q.isError && !all.length ? (
          <EmptyState
            icon={<BellOff />}
            title="Não foi possível carregar as notificações"
            description={errorMessage(q.error, 'Tente de novo em instantes.')}
            action={
              <Button kind="secondary" icon={<RefreshCw />} loading={q.isFetching} onClick={() => void q.refetch()}>
                Tentar de novo
              </Button>
            }
          />
        ) : !list.length ? (
          <EmptyState
            icon={disabled ? <BellOff /> : <Bell />}
            title={filter === 'unread' && all.length ? 'Nenhuma notificação não lida' : 'Nenhuma notificação'}
            description={
              disabled ? (
                <>
                  As notificações estão desligadas para o seu usuário. Ligue em <Link to="/conta/preferencias">Conta › Preferências</Link>.
                </>
              ) : filter === 'unread' && all.length ? (
                'Você já leu todos os avisos.'
              ) : (
                'Os avisos do Verifco aparecem aqui e no sino da barra superior.'
              )
            }
          />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Notificação</th>
                  <th>Recebida em</th>
                  <th className="actions">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((n) => (
                  <tr key={n.id}>
                    <td>
                      <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                        <span className="vf-inline">
                          <span className={n.readAt ? 'vf-text-sm' : 'vf-text-sm-bold'}>{n.title}</span>
                          {!n.readAt && <Tag tone="primary">Não lida</Tag>}
                        </span>
                        {n.body && <span className="vf-text-xs vf-muted">{n.body}</span>}
                      </div>
                    </td>
                    <td className="vf-muted" style={{ whiteSpace: 'nowrap' }}>
                      {formatDateTime(n.createdAt)}
                    </td>
                    <td className="actions">
                      <div className="vf-inline vf-end" style={{ flexWrap: 'nowrap' }}>
                        {!n.readAt && (
                          <Button kind="tertiary" size="sm" aria-label={`Marcar como lida: ${n.title}`} onClick={() => void markOne(n)}>
                            Marcar como lida
                          </Button>
                        )}
                        {notificationPath(n) && (
                          <Button kind="secondary" size="sm" aria-label={`Abrir: ${n.title}`} onClick={() => void open(n)}>
                            Abrir
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.length > 0 && <Pagination page={pg.page} pages={pg.pages} total={pg.total} onChange={pg.setPage} />}
      </Card>
      {all.length >= NOTIFICATIONS_API_LIMIT && (
        <p className="vf-text-xs vf-muted" style={{ marginTop: 12 }}>
          Aparecem aqui as {NOTIFICATIONS_API_LIMIT} notificações mais recentes; as mais antigas não são listadas.
        </p>
      )}
    </>
  );
}
