import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Eye, Filter, Mail, MessageCircle, Paperclip, RefreshCw, Search, Send } from 'lucide-react';
import { DELIVERY_CHANNELS, DELIVERY_STATUS, TEMPLATES, formatPhone, type DeliveryStatus } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, Drawer, EmptyState, IconButton, Input, Loading, Pagination, Select, Tag, type Tone } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi, useDebounced } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { MailPreview } from './TemplatesPage';
import './communication.css';

interface DeliveryRow {
  id: string;
  customerId: string | null;
  customerName: string | null;
  channel: 'email' | 'whatsapp';
  templateKey: string | null;
  subject: string | null;
  toAddress: string;
  toName: string | null;
  status: DeliveryStatus;
  error: string | null;
  attachments: number;
  sentAt: string | null;
  createdAt: string;
}

interface DeliveryDetail extends Omit<DeliveryRow, 'attachments'> {
  body: string;
  attachments: { fileId: string; filename: string }[];
  templateName: string | null;
  canResend: boolean;
}

type Filters = { templateKey: string; channel: string; status: string; from: string; to: string };
const EMPTY: Filters = { templateKey: '', channel: '', status: '', from: '', to: '' };
const SEND_PERMS = ['mailing.send_checklist_digital', 'mailing.send_checklist_pdf', 'mailing.send_planning', 'mailing.send_marketing', 'mailing.send_budget', 'mailing.send_monthly', 'post_declaration.send_kit', 'message.send'];

export const statusTone = (s: string): Tone => (s === 'sent' || s === 'delivered' ? 'success' : s === 'failed' ? 'danger' : 'warning');
const templateName = (k: string | null) => (k ? (TEMPLATES.find((t) => t.key === k)?.name ?? k) : 'Mensagem avulsa');
const address = (d: { channel: string; toAddress: string }) => (d.channel === 'whatsapp' ? `+${d.toAddress.slice(0, 2)} ${formatPhone(d.toAddress.slice(2))}` : d.toAddress);

export function DeliveriesPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [resendId, setResendId] = useState<string | null>(null);
  useEffect(() => setPage(1), [debounced, filters]);

  const query = qs({ search: debounced, page, pageSize: 25, ...filters });
  const [poll, setPoll] = useState(false);
  const list = useApi<{ data: DeliveryRow[]; total: number; page: number; pages: number }>(['deliveries', query], `/deliveries${query}`, { refetchInterval: poll ? 5000 : undefined });
  const rows = list.data?.data ?? [];
  // atualiza sozinho enquanto houver envios na fila
  useEffect(() => setPoll(Boolean(list.data?.data.some((r) => r.status === 'queued'))), [list.data]);
  const active = useMemo(() => Object.values(filters).filter(Boolean).length, [filters]);
  const canResend = can(...SEND_PERMS);

  const resend = useAction((id: string) => api.post(`/deliveries/${id}/resend`), {
    success: 'Envio colocado na fila novamente.',
    invalidate: [['deliveries']],
    onSuccess: () => setResendId(null),
  });

  return (
    <>
      <PageHeader
        title="E-mails enviados"
        description="Histórico dos e-mails e mensagens de WhatsApp enviados aos clientes, com a situação de cada envio."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Comunicação' }, { label: 'E-mails enviados' }]}
        actions={
          can('mailing.send_marketing', 'mailing.send_monthly', 'mailing.send_planning', 'mailing.send_checklist_digital', 'mailing.send_checklist_pdf', 'mailing.send_budget', 'post_declaration.send_kit') && (
            <Link to="/comunicacao/mala-direta" className="vf-btn">
              <Send />
              Nova mala direta
            </Link>
          )
        }
      />
      <Card flush>
        <div className="vf-inline" style={{ padding: 16, borderBottom: '1px solid var(--color-border)' }}>
          <div className="vf-grow" style={{ maxWidth: 420 }}>
            <Input aria-label="Pesquisar" placeholder="Pesquisar por cliente, e-mail ou telefone" icon={<Search />} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button
            kind="secondary"
            icon={<Filter />}
            onClick={() => {
              setDraft(filters);
              setShowFilters(true);
            }}
          >
            Filtros{active ? ` (${active})` : ''}
          </Button>
          {active > 0 && (
            <Button kind="tertiary" onClick={() => setFilters(EMPTY)}>
              Limpar filtros
            </Button>
          )}
          <div className="vf-grow" />
          <IconButton label="Atualizar" onClick={() => void list.refetch()}>
            <RefreshCw />
          </IconButton>
        </div>
        {list.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Mail />}
            title={debounced || active ? 'Nenhum envio encontrado' : 'Nenhum envio ainda'}
            description={debounced || active ? 'Revise a busca ou os filtros.' : 'Os e-mails e mensagens enviados pela mala direta e pelas telas do cliente aparecem aqui.'}
          />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Assunto</th>
                  <th>Nome</th>
                  <th>E-mail / telefone</th>
                  <th>Data de envio</th>
                  <th>Situação</th>
                  <th className="actions">Opções</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td style={{ maxWidth: 340 }}>
                      <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                        <span className="vf-text-sm-bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.subject ?? ''}>
                          {d.subject || '(sem assunto)'}
                        </span>
                        <span className="vf-inline vf-text-xs vf-muted" style={{ '--gap': '6px' } as React.CSSProperties}>
                          {d.channel === 'whatsapp' ? <MessageCircle size={14} /> : <Mail size={14} />}
                          {templateName(d.templateKey)}
                          {d.attachments > 0 && (
                            <>
                              <Paperclip size={14} />
                              {d.attachments}
                            </>
                          )}
                        </span>
                      </div>
                    </td>
                    <td>{d.customerId ? <Link to={`/clientes/${d.customerId}`}>{d.customerName ?? d.toName}</Link> : (d.toName ?? '—')}</td>
                    <td className="vf-muted">{address(d)}</td>
                    <td className="vf-muted">{formatDateTime(d.sentAt ?? d.createdAt)}</td>
                    <td>
                      <Tag tone={statusTone(d.status)}>{DELIVERY_STATUS[d.status] ?? d.status}</Tag>
                    </td>
                    <td className="actions">
                      <div className="vf-inline" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <IconButton label="Ver conteúdo" onClick={() => setOpenId(d.id)}>
                          <Eye />
                        </IconButton>
                        {d.status === 'failed' && canResend && (
                          <IconButton label="Reenviar" onClick={() => setResendId(d.id)}>
                            <RefreshCw />
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && list.data.total > 0 && <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onChange={setPage} />}
      </Card>

      <Drawer
        open={showFilters}
        title="Filtros"
        onClose={() => setShowFilters(false)}
        footer={
          <>
            <Button kind="secondary" onClick={() => setDraft(EMPTY)}>
              Limpar
            </Button>
            <Button
              onClick={() => {
                setFilters(draft);
                setShowFilters(false);
              }}
            >
              Aplicar filtros
            </Button>
          </>
        }
      >
        <div className="vf-stack">
          <Select
            label="Tipo de e-mail"
            placeholder="Todos"
            value={draft.templateKey}
            onChange={(e) => setDraft({ ...draft, templateKey: e.target.value })}
            options={[...TEMPLATES.map((t) => ({ value: t.key, label: t.name })), { value: 'none', label: 'Mensagem avulsa' }]}
          />
          <Select label="Canal" placeholder="Todos" value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value })} options={Object.entries(DELIVERY_CHANNELS).map(([value, label]) => ({ value, label }))} />
          <Select label="Situação" placeholder="Todas" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} options={Object.entries(DELIVERY_STATUS).map(([value, label]) => ({ value, label }))} />
          <div className="vf-grid">
            <Input label="Data inicial" type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <Input label="Data final" type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </div>
        </div>
      </Drawer>

      <DeliveryDrawer id={openId} canResend={canResend} onClose={() => setOpenId(null)} onResend={(id) => setResendId(id)} />
      <ConfirmDialog
        open={resendId !== null}
        title="Reenviar"
        message="O envio volta para a fila e será tentado de novo com o mesmo conteúdo e destinatário."
        confirmLabel="Reenviar"
        loading={resend.isPending}
        onConfirm={() => resendId && resend.mutate(resendId)}
        onClose={() => setResendId(null)}
      />
    </>
  );
}

function DeliveryDrawer({ id, canResend, onClose, onResend }: { id: string | null; canResend: boolean; onClose: () => void; onResend: (id: string) => void }) {
  const q = useApi<DeliveryDetail>(['deliveries', 'detail', id], id ? `/deliveries/${id}` : null);
  const d = q.data;
  return (
    <Drawer
      open={id !== null}
      title="Conteúdo do envio"
      width={640}
      onClose={onClose}
      footer={
        d?.canResend && canResend ? (
          <Button icon={<RefreshCw />} onClick={() => onResend(d.id)}>
            Reenviar
          </Button>
        ) : undefined
      }
    >
      {q.isLoading || !d ? (
        <Loading />
      ) : (
        <div className="vf-stack">
          <div className="vf-inline">
            <Tag tone={statusTone(d.status)}>{DELIVERY_STATUS[d.status] ?? d.status}</Tag>
            <Tag>{DELIVERY_CHANNELS[d.channel]}</Tag>
            <Tag tone="primary">{d.templateName ?? 'Mensagem avulsa'}</Tag>
          </div>
          {d.error && (
            <Alert tone="danger" title="Falha no envio">
              {d.error}
            </Alert>
          )}
          <dl className="vf-grid" style={{ margin: 0 }}>
            <div>
              <dt className="vf-text-xs vf-muted">Destinatário</dt>
              <dd style={{ margin: 0 }}>{d.customerName ?? d.toName ?? '—'}</dd>
            </div>
            <div>
              <dt className="vf-text-xs vf-muted">{d.channel === 'email' ? 'E-mail' : 'WhatsApp'}</dt>
              <dd style={{ margin: 0 }}>{address(d)}</dd>
            </div>
            <div>
              <dt className="vf-text-xs vf-muted">Criado em</dt>
              <dd style={{ margin: 0 }}>{formatDateTime(d.createdAt)}</dd>
            </div>
            <div>
              <dt className="vf-text-xs vf-muted">Enviado em</dt>
              <dd style={{ margin: 0 }}>{d.sentAt ? formatDateTime(d.sentAt) : '—'}</dd>
            </div>
          </dl>
          {d.attachments.length > 0 && (
            <div className="vf-stack" style={{ '--gap': '6px' } as React.CSSProperties}>
              <span className="vf-text-xs-bold vf-muted">ANEXOS</span>
              {d.attachments.map((a) => (
                <button key={a.fileId} type="button" className="vf-btn vf-btn--tertiary vf-btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => void api.download(`/files/${a.fileId}`, a.filename)}>
                  <Paperclip />
                  {a.filename}
                </button>
              ))}
            </div>
          )}
          {d.channel === 'email' ? (
            <MailPreview subject={d.subject ?? ''} html={d.body} to={d.toAddress} />
          ) : (
            <div className="vf-wa-preview">
              <div className="vf-bubble vf-bubble--other">{d.body}</div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
