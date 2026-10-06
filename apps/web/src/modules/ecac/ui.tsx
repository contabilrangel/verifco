import type { ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { ECAC_DECLARATION_STATUS, ECAC_RECORD_SOURCES, ELABORATION_STATUS, JOB_STATUS, TAXATION_TYPES } from '@verifco/shared';
import { Alert, IconButton, Progress, useToast, type Tone } from '../../ds';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { JobView } from './types';

export const pick = <T extends Record<string, string>>(map: T, key: string | null | undefined, fallback = '—') =>
  key ? ((map as Record<string, string>)[key] ?? key) : fallback;

export const ecacStatusLabel = (s: string | null) => pick(ECAC_DECLARATION_STATUS, s);
export const taxationLabel = (s: string | null) => (s ? pick(TAXATION_TYPES, s).split(' (')[0] : '—');
export const sourceLabel = (s: string) => pick(ECAC_RECORD_SOURCES, s);
export const elaborationLabel = (s: string) => pick(ELABORATION_STATUS, s);

export const elaborationTone = (s: string): Tone =>
  s === 'ok' ? 'success' : s === 'exported' ? 'primary' : s === 'conflict' ? 'danger' : s === 'awaiting_validation' ? 'highlight' : s === 'not_processed' ? 'warning' : 'neutral';

export const ecacTone = (s: string | null): Tone =>
  s === 'processed' || s === 'refund_lot' ? 'success' : s === 'fine_mesh' || s === 'pending_issues' ? 'danger' : s === 'processing' || s === 'waiting' ? 'warning' : 'neutral';

/** Abre o arquivo do escritório numa nova aba (PDF/imagem) ou baixa. */
export function ViewFileButton({ fileId, label = 'Visualizar' }: { fileId: string | null; label?: string }) {
  const toast = useToast();
  if (!fileId) return <span className="vf-muted">—</span>;
  return (
    <IconButton
      label={label}
      onClick={() => api.open(`/files/${fileId}?inline=1`).catch((e: Error) => toast.error(e.message || 'Não foi possível abrir o arquivo.'))}
    >
      <Eye />
    </IconButton>
  );
}

/** Situação de uma tarefa da fila (sincronização, processamento, exportação). */
export function JobAlert({ job, title, done }: { job: JobView | null | undefined; title: string; done?: ReactNode }) {
  if (!job) return null;
  const when = formatDateTime(job.finishedAt ?? job.createdAt);
  if (job.status === 'queued' || job.status === 'running') {
    return (
      <Alert title={`${title}: ${JOB_STATUS[job.status]}`}>
        <div className="vf-stack" style={{ '--gap': '6px', minWidth: 240 } as React.CSSProperties}>
          <span>Solicitada em {when}. Esta tela se atualiza sozinha.</span>
          <Progress value={job.progress} />
        </div>
      </Alert>
    );
  }
  if (job.status === 'failed') {
    return (
      <Alert tone="danger" title={`${title}: falhou em ${when}`}>
        {job.error}
      </Alert>
    );
  }
  const failedItems = Number(job.result?.failed ?? 0);
  return (
    <Alert tone={failedItems > 0 ? 'warning' : 'success'} title={`${title}: concluída em ${when}${failedItems > 0 ? ' com erros' : ''}`}>
      {done}
    </Alert>
  );
}

export const isRunning = (job: JobView | null | undefined) => Boolean(job && (job.status === 'queued' || job.status === 'running'));

/** Endereço da API que a extensão e o sincronizador devem usar. */
export const apiBaseUrl = () => ((import.meta.env.VITE_API_URL as string | undefined) || window.location.origin).replace(/\/$/, '');
