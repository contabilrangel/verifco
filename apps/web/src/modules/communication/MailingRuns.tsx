import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleCheck, Send, XCircle } from 'lucide-react';
import { MAILING_MAX_RECIPIENTS, getMailingType, type MailingTypeKey } from '@verifco/shared';
import { Alert, Button, Card, EmptyState, Loading, Progress, Tag, type Tone } from '../../ds';
import { api, errorMessage, type ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';

type RunStatus = 'queued' | 'running' | 'done' | 'failed';
type DeliveryChannel = 'email' | 'whatsapp';
type SkipCount = { reason: string; label: string; count: number; names: string[] };

/** Pedido de mala direta: preparado na fila de tarefas, acompanhado pela tela. */
export interface MailingRequest {
  requestId: string;
  jobId: string;
  type: MailingTypeKey;
  channel: DeliveryChannel | 'both';
  year: number;
  status: RunStatus;
  progress: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  customers: number;
  deliveries: { email: number; whatsapp: number; total: number };
  skipped: SkipCount[];
  truncated: boolean;
  matched: number;
  result: null | { queued: number; alreadyQueued: number; failed: { customerId: string; name: string; message: string }[] };
  /** Anexos em PDF (um job por cliente), contados depois da preparação. */
  attachments: null | { total: number; done: number; failed: number };
  repeated?: boolean;
}

/** Mala direta na lista de recentes (`GET /mailing/runs`): sem nomes de clientes. */
export interface MailingRunItem extends Omit<MailingRequest, 'skipped' | 'result' | 'attachments' | 'repeated'> {
  id: string;
  label: string;
  createdBy: string | null;
  skippedCount: number;
}

type StatusCount = { queued: number; sent: number; failed: number; total: number };

/** Detalhe de uma mala direta (`GET /mailing/runs/:id`): andamento, envios por situação e falhas. */
export interface MailingRunDetail extends MailingRequest {
  id: string;
  label: string;
  createdBy: string | null;
  sending: { email: StatusCount; whatsapp: StatusCount; total: StatusCount };
  failures: {
    count: number;
    items: { customerId: string | null; name: string; channel: DeliveryChannel | null; stage: 'preparation' | 'attachment' | 'delivery'; message: string }[];
  };
}

/** Terminou a preparação e, com anexo, a geração dos PDFs? */
export const finished = (r: Pick<MailingRequest, 'status' | 'attachments'>) =>
  r.status === 'failed' || (r.status === 'done' && (!r.attachments || r.attachments.done + r.attachments.failed >= r.attachments.total));

export const int = (n: number) => n.toLocaleString('pt-BR');

/** Aviso de corte: acima do limite, o envio vai só para os primeiros em ordem alfabética. */
export const truncatedText = (matched: number, limit: number) =>
  `A seleção tem ${int(matched)} clientes, mais que o limite de ${int(limit)} por envio. Esta mala direta vai para os ${int(limit)} primeiros em ordem alfabética; refine os filtros e faça outro envio para os demais.`;

export const names = (list: string[], count: number) => (count > list.length ? `${list.join(', ')} e mais ${count - list.length}` : list.join(', '));

const STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Na fila', tone: 'neutral' },
  running: { label: 'Preparando', tone: 'primary' },
  done: { label: 'Preparada', tone: 'success' },
  failed: { label: 'Com erro', tone: 'danger' },
};
const CHANNELS: Record<MailingRequest['channel'], string> = { email: 'E-mail', whatsapp: 'WhatsApp', both: 'E-mail e WhatsApp' };
const STAGES: Record<MailingRunDetail['failures']['items'][number]['stage'], string> = {
  preparation: 'Preparação',
  attachment: 'Anexo em PDF',
  delivery: 'Entrega',
};

function RunStatusTag({ status }: { status: RunStatus }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Tag tone={s.tone}>{s.label}</Tag>;
}

/** Andamento do pedido: preparação na fila, anexos em PDF e o resumo final. */
export function MailingProgress({
  request: r,
  withAttachment,
  retrying,
  onRetry,
  onTrack,
  onRestart,
  showFailures = true,
}: {
  request: MailingRequest;
  withAttachment: boolean;
  retrying: boolean;
  onRetry: () => void;
  onTrack: () => void;
  onRestart: () => void;
  /** Os clientes com falha na preparação (o detalhe da mala direta já os lista à parte). */
  showFailures?: boolean;
}) {
  const done = finished(r);
  const att = r.attachments;
  const generating = r.status === 'done' && !done;
  const title =
    r.status === 'failed'
      ? 'Não foi possível preparar os envios'
      : r.status !== 'done'
        ? 'Preparando os envios...'
        : generating
          ? 'Gerando os anexos em PDF...'
          : r.result?.queued
            ? `${int(r.result.queued)} envio(s) na fila para ${int(r.customers)} cliente(s)`
            : 'Este envio já tinha sido feito';
  const progress = generating && att ? ((att.done + att.failed) / Math.max(1, att.total)) * 100 : r.progress;
  const failed = showFailures ? (r.result?.failed ?? []) : [];
  return (
    <Card>
      <EmptyState
        icon={r.status === 'failed' ? <XCircle /> : done ? <CircleCheck /> : <Send />}
        title={title}
        description={
          <div className="vf-stack" style={{ '--gap': '8px' } as CSSProperties}>
            {!done && <Progress value={progress} />}
            {r.error && <span>{r.error}</span>}
            <span>
              {int(r.deliveries.email)} por e-mail e {int(r.deliveries.whatsapp)} por WhatsApp.
              {r.result && r.result.alreadyQueued > 0 && ` ${int(r.result.alreadyQueued)} já estavam na fila e não foram duplicados.`}
              {!done && ' Você pode sair desta tela: a preparação continua e os envios aparecem em E-mails enviados.'}
            </span>
            {withAttachment &&
              (att ? (
                <span>
                  Anexos em PDF gerados: {int(att.done)} de {int(att.total)}
                  {att.failed > 0 && ` (${int(att.failed)} com erro)`}.
                </span>
              ) : (
                !done && <span>Os anexos em PDF são gerados um a um e podem levar alguns minutos.</span>
              ))}
            {r.truncated && <span className="vf-text-xs">{truncatedText(r.matched, MAILING_MAX_RECIPIENTS)}</span>}
            {r.skipped.map((s) => (
              <span key={s.reason} className="vf-text-xs">
                {s.count} sem envio — {s.label.toLowerCase()}
                {s.names.length > 0 && `: ${names(s.names, s.count)}`}
              </span>
            ))}
            {failed.length > 0 && (
              <span className="vf-text-xs">
                {failed.length} sem envio por erro: {names(failed.slice(0, 8).map((f) => `${f.name} (${f.message})`), failed.length)}
              </span>
            )}
          </div>
        }
        action={
          <div className="vf-inline">
            {r.status === 'failed' ? (
              <Button loading={retrying} onClick={onRetry}>
                Tentar de novo
              </Button>
            ) : (
              <Button onClick={onTrack}>Acompanhar envios</Button>
            )}
            <Button kind="secondary" onClick={onRestart}>
              Nova mala direta
            </Button>
          </div>
        }
      />
    </Card>
  );
}

/** Malas diretas recentes do escritório (ou só as próprias, para quem não vê todos os envios). */
export function RecentMailings({ onOpen }: { onOpen: (id: string) => void }) {
  const runs = useQuery<MailingRunItem[], ApiError>({
    queryKey: ['mailing', 'runs'],
    queryFn: () => api.get<MailingRunItem[]>('/mailing/runs'),
    // acompanha enquanto alguma ainda está sendo preparada
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : false),
  });
  return (
    <Card flush title="Malas diretas recentes">
      {runs.isLoading ? (
        <Loading />
      ) : runs.error ? (
        <div style={{ padding: '0 24px 24px' }}>
          <Alert tone="danger">{errorMessage(runs.error)}</Alert>
        </div>
      ) : !runs.data?.length ? (
        <EmptyState icon={<Send />} title="Nenhuma mala direta enviada ainda" description="As malas diretas enviadas aparecem aqui, com o andamento de cada uma." />
      ) : (
        <div className="vf-table-wrap">
          <table className="vf-table">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Pedida em</th>
                <th>Canal</th>
                <th>Clientes</th>
                <th>Situação</th>
                <th className="actions" aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="vf-text-sm-bold">{r.label}</span>
                    <span className="vf-muted"> · {r.year}</span>
                  </td>
                  <td>
                    {formatDateTime(r.createdAt)}
                    {r.createdBy && <div className="vf-text-xs vf-muted">por {r.createdBy}</div>}
                  </td>
                  <td>{CHANNELS[r.channel] ?? r.channel}</td>
                  <td>
                    {int(r.customers)}
                    <div className="vf-text-xs vf-muted">{int(r.deliveries.total)} envio(s)</div>
                  </td>
                  <td style={{ minWidth: 140 }}>
                    <div className="vf-stack" style={{ '--gap': '4px' } as CSSProperties}>
                      <RunStatusTag status={r.status} />
                      {(r.status === 'queued' || r.status === 'running') && <Progress value={r.progress} />}
                    </div>
                  </td>
                  <td className="actions">
                    <Button size="sm" kind="tertiary" aria-label={`Ver ${r.label} de ${formatDateTime(r.createdAt)}`} onClick={() => onOpen(r.id)}>
                      Ver
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Uma mala direta aberta pela lista: andamento, envios por canal e situação e quem teve falha. */
export function MailingRunView({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const run = useQuery<MailingRunDetail, ApiError>({
    queryKey: ['mailing', 'run', id],
    queryFn: () => api.get<MailingRunDetail>(`/mailing/runs/${id}`),
    // até a preparação terminar, a cada 1,5 s; depois, mais devagar enquanto há envios na fila
    refetchInterval: (q) => {
      const r = q.state.data;
      if (!r) return false;
      if (!finished(r)) return 1500;
      return r.sending.total.queued > 0 ? 5000 : false;
    },
  });
  const r = run.data;
  // repetir o pedido que falhou (mesmo requestId): volta para a fila sem duplicar o que já foi gravado
  const retry = useAction(() => api.post('/mailing/send', { type: r!.type, channel: r!.channel, year: r!.year, requestId: r!.requestId }), {
    invalidate: [['mailing', 'run', id], ['mailing', 'runs']],
  });

  const back = (
    <div>
      <Button kind="tertiary" icon={<ArrowLeft />} onClick={onClose}>
        Malas diretas recentes
      </Button>
    </div>
  );
  if (!r) {
    return (
      <div className="vf-stack" style={{ '--gap': '16px' } as CSSProperties}>
        {back}
        <Card>{run.error ? <Alert tone="danger">{errorMessage(run.error)}</Alert> : <Loading label="Carregando a mala direta..." />}</Card>
      </div>
    );
  }
  const channels: DeliveryChannel[] = r.channel === 'both' ? ['email', 'whatsapp'] : [r.channel];
  const rows: [string, StatusCount][] = [...channels.map((c): [string, StatusCount] => [CHANNELS[c], r.sending[c]]), ...(channels.length > 1 ? [['Total', r.sending.total] as [string, StatusCount]] : [])];
  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as CSSProperties}>
      {back}
      <Card title={`${r.label} · exercício ${r.year}`} actions={<RunStatusTag status={r.status} />}>
        <div className="vf-stack">
          <span className="vf-text-sm vf-muted">
            Pedida em {formatDateTime(r.createdAt)}
            {r.createdBy ? ` por ${r.createdBy}` : ''} · {CHANNELS[r.channel]} · {int(r.customers)} cliente(s)
          </span>
          <div className="vf-table-wrap">
            <table className="vf-table" aria-label="Envios por canal">
              <thead>
                <tr>
                  <th>Canal</th>
                  <th>Na fila</th>
                  <th>Enviados</th>
                  <th>Com falha</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, c]) => (
                  <tr key={label}>
                    <td className="vf-text-sm-bold">{label}</td>
                    <td>{int(c.queued)}</td>
                    <td>{int(c.sent)}</td>
                    <td>{c.failed > 0 ? <Tag tone="danger">{int(c.failed)}</Tag> : 0}</td>
                    <td>{int(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.sending.total.queued > 0 && finished(r) && <span className="vf-text-xs vf-muted">Os envios na fila saem em instantes; esta tela se atualiza sozinha.</span>}
        </div>
      </Card>

      <MailingProgress
        request={r}
        withAttachment={Boolean(getMailingType(r.type)?.attachment)}
        retrying={retry.isPending}
        onRetry={() => retry.mutate(undefined)}
        onTrack={() => navigate('/comunicacao/envios')}
        onRestart={onClose}
        showFailures={false}
      />

      {r.failures.count > 0 && (
        <Card flush title={`Clientes com falha (${int(r.failures.count)})`}>
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Canal</th>
                  <th>Etapa</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {r.failures.items.map((f, i) => (
                  <tr key={`${f.customerId ?? i}-${f.stage}-${f.channel ?? ''}`}>
                    <td className="vf-text-sm-bold">{f.name}</td>
                    <td>{f.channel ? CHANNELS[f.channel] : '—'}</td>
                    <td>{STAGES[f.stage]}</td>
                    <td>{f.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.failures.count > r.failures.items.length && (
            <div className="vf-text-xs vf-muted" style={{ padding: 16 }}>
              Mostrando {int(r.failures.items.length)} de {int(r.failures.count)}.{can('mailing.list') && ' Veja todos e reenvie em E-mails enviados.'}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
