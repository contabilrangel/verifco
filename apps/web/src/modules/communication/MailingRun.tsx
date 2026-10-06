import type { CSSProperties, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, Clock, Loader2, XCircle } from 'lucide-react';
import { MAILING_RUN_STATUS, type MailingRunStatus } from '@verifco/shared';
import { Alert, Button, Card, Loading, Progress, Stat, Tag, type Tone } from '../../ds';
import { api, errorMessage, type ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

interface SkipCount {
  reason: string;
  label: string;
  count: number;
  names: string[];
}

/** Mala direta registrada (job na fila), como `GET /mailing/runs/:id` devolve. */
export interface MailingRun {
  id: string;
  status: MailingRunStatus;
  progress: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  type: { key: string; label: string; attachment: string | null };
  channel: 'email' | 'whatsapp' | 'both' | null;
  year: number | null;
  customers: number;
  deliveries: { email: number; whatsapp: number; total: number };
  skipped: SkipCount[];
  progressDetail: { total: number; processed: number; queued: number; skipped: SkipCount[]; errorCount: number; errors: { customerId: string; name: string; message: string }[] };
  alreadyRequested?: boolean;
}

const STATUS_TONE: Record<MailingRunStatus, Tone> = { queued: 'neutral', running: 'primary', done: 'success', failed: 'danger' };
const finished = (s: string) => s === 'done' || s === 'failed';
const names = (list: string[], count: number) => (count > list.length ? `${list.join(', ')} e mais ${count - list.length}` : list.join(', '));
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

export function MailingStatusTag({ status }: { status: MailingRunStatus }) {
  return <Tag tone={STATUS_TONE[status] ?? 'neutral'}>{MAILING_RUN_STATUS[status] ?? status}</Tag>;
}

/** Acompanha uma mala direta: consulta o andamento a cada 1,5 s até concluir. */
export function useMailingRun(id: string | null, initial?: MailingRun | null) {
  return useQuery<MailingRun, ApiError>({
    queryKey: ['mailing', 'run', id],
    queryFn: () => api.get<MailingRun>(`/mailing/runs/${id}`),
    enabled: Boolean(id),
    initialData: initial && initial.id === id ? initial : undefined,
    refetchInterval: (q) => (q.state.data && finished(q.state.data.status) ? false : 1500),
  });
}

/** Andamento de uma mala direta: clientes processados, envios na fila, quem ficou de fora e erros. */
export function MailingRunCard({ id, initial, actions }: { id: string; initial?: MailingRun | null; actions: ReactNode }) {
  const q = useMailingRun(id, initial);
  const run = q.data;
  if (!run) return <Card>{q.error ? <Alert tone="danger">{errorMessage(q.error)}</Alert> : <Loading label="Carregando o andamento..." />}</Card>;
  const d = run.progressDetail;
  const icon =
    run.status === 'done' ? <CircleCheck className="vf-success-text" /> : run.status === 'failed' ? <XCircle className="vf-danger-text" /> : run.status === 'running' ? <Loader2 /> : <Clock />;
  const title =
    run.status === 'done'
      ? 'Mala direta concluída'
      : run.status === 'failed'
        ? 'A mala direta parou com erro'
        : run.status === 'running'
          ? `Enviando… ${run.progress}%`
          : 'Mala direta na fila';
  const skippedOnSend = d.skipped.filter((s) => s.count > 0);
  return (
    <Card
      title={
        <span className="vf-inline">
          {icon}
          {title}
        </span>
      }
      actions={<MailingStatusTag status={run.status} />}
    >
      <div className="vf-stack" style={{ '--gap': '20px' } as CSSProperties}>
        {run.alreadyRequested && <Alert>Este envio já tinha sido pedido; abaixo está o andamento dele (nada foi enviado de novo).</Alert>}
        <span className="vf-muted vf-text-sm">
          <strong>{run.type.label}</strong>
          {run.year ? ` · exercício ${run.year}` : ''} · pedida em {formatDateTime(run.createdAt)}
          {run.finishedAt ? ` · concluída em ${formatDateTime(run.finishedAt)}` : ''}
        </span>
        <Progress value={run.status === 'done' ? 100 : run.progress} />
        <div className="vf-grid" style={{ '--cols': 4 } as CSSProperties}>
          <Stat label="Clientes processados" value={`${d.processed.toLocaleString('pt-BR')} de ${d.total.toLocaleString('pt-BR')}`} />
          <Stat label="Envios gerados" value={d.queued.toLocaleString('pt-BR')} hint={`${run.deliveries.email} e-mail(s) e ${run.deliveries.whatsapp} WhatsApp previstos`} />
          <Stat label="Ficaram de fora" value={skippedOnSend.reduce((a, s) => a + s.count, 0) + run.skipped.reduce((a, s) => a + s.count, 0)} hint="Na revisão e na hora do envio" />
          <Stat label="Erros" value={d.errorCount} tone={d.errorCount ? 'danger' : undefined} />
        </div>
        {!finished(run.status) && (
          <span className="vf-text-xs vf-muted">
            Você pode sair desta tela: a mala direta continua sendo enviada e o andamento fica em “Malas diretas recentes”.
            {run.type.attachment && ' Os anexos em PDF são gerados um a um e podem levar alguns minutos.'}
          </span>
        )}
        {run.error && <Alert tone="danger">{run.error}</Alert>}
        {run.skipped.length > 0 && (
          <SkipList title={`Sem envio desde a revisão (${plural(run.skipped.reduce((a, s) => a + s.count, 0), 'situação', 'situações')})`} items={run.skipped} />
        )}
        {skippedOnSend.length > 0 && <SkipList title="Ficaram de fora na hora do envio (os dados mudaram depois da revisão)" items={skippedOnSend} />}
        {d.errors.length > 0 && (
          <Alert tone="danger" title={`${plural(d.errorCount, 'cliente com erro', 'clientes com erro')}`}>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {d.errors.map((e) => (
                <li key={e.customerId}>
                  <strong>{e.name}</strong>: {e.message}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        <div className="vf-inline">{actions}</div>
      </div>
    </Card>
  );
}

function SkipList({ title, items }: { title: string; items: SkipCount[] }) {
  return (
    <Alert tone="warning" title={title}>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {items.map((s) => (
          <li key={s.reason}>
            <strong>
              {s.count} — {s.label.toLowerCase()}
            </strong>
            {s.names.length > 0 && <>: {names(s.names, s.count)}</>}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** Malas diretas recentes do usuário (ou do escritório, para quem vê os e-mails enviados). */
export function RecentMailings({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery<MailingRun[], ApiError>({
    queryKey: ['mailing', 'runs'],
    queryFn: () => api.get<MailingRun[]>('/mailing/runs'),
    refetchInterval: (query) => (query.state.data?.some((r) => !finished(r.status)) ? 3000 : false),
  });
  if (!q.data?.length) return null;
  return (
    <Card flush title="Malas diretas recentes">
      <div className="vf-table-wrap">
        <table className="vf-table">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Pedida em</th>
              <th>Situação</th>
              <th>Andamento</th>
              <th className="actions" aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.id}>
                <td className="vf-text-sm-bold">
                  {r.type.label}
                  {r.year ? <span className="vf-muted"> · {r.year}</span> : null}
                </td>
                <td>{formatDateTime(r.createdAt)}</td>
                <td>
                  <MailingStatusTag status={r.status} />
                </td>
                <td style={{ minWidth: 180 }}>
                  <div className="vf-stack" style={{ '--gap': '4px' } as CSSProperties}>
                    <Progress value={r.status === 'done' ? 100 : r.progress} />
                    <span className="vf-text-xs vf-muted">
                      {r.progressDetail.processed.toLocaleString('pt-BR')} de {r.progressDetail.total.toLocaleString('pt-BR')} cliente(s) · {r.progressDetail.queued.toLocaleString('pt-BR')} envio(s)
                      {r.progressDetail.errorCount > 0 && ` · ${r.progressDetail.errorCount} erro(s)`}
                    </span>
                  </div>
                </td>
                <td className="actions">
                  <Button size="sm" kind="tertiary" onClick={() => onOpen(r.id)}>
                    Ver
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
