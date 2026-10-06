import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardList, Cpu, Download, FileArchive, FileCheck, HelpCircle, ListChecks, Search, Wand2, X } from 'lucide-react';
import { ELABORATION_STATUS } from '@verifco/shared';
import { Alert, Button, Card, Drawer, EmptyState, IconButton, Input, Loading, Pagination, Select, Tag, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { ApiError, api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi, useDebounced } from '../../lib/hooks';
import { formatCpfCnpj, formatDateTime, formatMoney } from '../../lib/format';
import { useYear } from '../../lib/year';
import type { ElaborationDetail, ElaborationRow, JobView } from './types';
import { JobAlert, ViewFileButton, elaborationLabel, elaborationTone, isRunning } from './ui';

interface ListResponse {
  data: ElaborationRow[];
  total: number;
  page: number;
  pages: number;
  statusCounts: Record<string, number>;
}

/** Significado de cada situação, exibido no painel de ajuda. */
export const STATUS_HELP: Record<keyof typeof ELABORATION_STATUS, string> = {
  no_files: 'O cliente ainda não tem documentos no exercício (checklist, envio manual ou sincronizador).',
  not_processed: 'Há documentos em PDF ou imagem que ainda não passaram pela IA (ou falharam na leitura).',
  conflict: 'Algum documento traz valores diferentes das linhas já lançadas. Confira e decida qual vale.',
  awaiting_validation: 'Linhas extraídas prontas para conferência. “Validar” aplica as aceitas na declaração.',
  ok: 'Tudo processado e aplicado. A declaração está pronta para exportar o pacote de conferência.',
  exported: 'Pacote de conferência gerado e disponível para download. Um documento novo volta a situação.',
};

type Action = 'process' | 'validate' | 'export';

export function ElaborationPage() {
  const { can } = useAuth();
  const { year } = useYear();
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState<'how' | 'status' | null>(null);
  const [review, setReview] = useState<ElaborationRow | null>(null);
  useEffect(() => setPage(1), [debounced, status, year]);
  useEffect(() => setSelected(new Set()), [year]);

  const query = qs({ year, search: debounced, status, page, pageSize: 25 });
  const list = useApi<ListResponse>(['elaboration', 'list', query], `/elaboration${query}`);
  const jobs = useApi<JobView[]>(['elaboration', 'jobs'], '/elaboration/jobs');
  const lastJob = jobs.data?.[0] ?? null;
  const running = isRunning(lastJob);
  const { refetch: refetchJobs } = jobs;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      const t = setInterval(() => void refetchJobs(), 2000);
      return () => clearInterval(t);
    }
    if (wasRunning.current) {
      wasRunning.current = false;
      void qc.invalidateQueries({ queryKey: ['elaboration', 'list'] });
    }
  }, [running, refetchJobs, qc]);

  const rows = list.data?.data ?? [];
  const ids = [...selected];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.customerId));

  const run = useAction(
    (action: Action) => api.post<{ job?: JobView; results?: { name: string; inserted: number; updated: number; pendingConflicts: number }[] }>(`/elaboration/${action}`, { year, customerIds: ids }),
    {
      invalidate: [['elaboration']],
      onSuccess: (r, action) => {
        if (action === 'validate') {
          const res = r.results ?? [];
          const applied = res.reduce((n, x) => n + x.inserted + x.updated, 0);
          const pending = res.reduce((n, x) => n + x.pendingConflicts, 0);
          toast.success(`${applied} linha(s) aplicada(s) em ${res.length} declaração(ões)${pending ? `; ${pending} conflito(s) aguardando decisão` : ''}.`);
        } else toast.success(action === 'process' ? 'Processamento solicitado. Acompanhe o andamento acima.' : 'Exportação solicitada. Acompanhe o andamento acima.');
      },
    },
  );

  const downloadSelected = async () => {
    try {
      await api.download('/elaboration/download', `conferencia-${year}.zip`, { year, customerIds: ids });
    } catch (e) {
      toast.error(e instanceof ApiError && e.status === 404 ? 'Nenhuma das declarações selecionadas foi exportada ainda.' : 'Falha no download.');
    }
  };

  const statusOptions = useMemo(
    () => [
      { value: '', label: `Todos os status${list.data ? ` (${Object.values(list.data.statusCounts).reduce((a, b) => a + b, 0)})` : ''}` },
      ...Object.entries(ELABORATION_STATUS).map(([value, label]) => ({ value, label: `${label}${list.data ? ` (${list.data.statusCounts[value] ?? 0})` : ''}` })),
    ],
    [list.data],
  );

  return (
    <>
      <PageHeader
        title="Elaboração"
        description="Documentos dos clientes lidos com IA, conferidos contra as linhas da declaração e exportados como pacote de conferência."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Elaboração' }]}
        actions={
          <>
            <Button kind={help === 'how' ? 'secondary' : 'tertiary'} icon={<HelpCircle />} onClick={() => setHelp((h) => (h === 'how' ? null : 'how'))}>
              Como exportar a declaração
            </Button>
            <Button kind={help === 'status' ? 'secondary' : 'tertiary'} icon={<ListChecks />} onClick={() => setHelp((h) => (h === 'status' ? null : 'status'))}>
              Significado dos status
            </Button>
          </>
        }
      />
      <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
        {help === 'how' && (
          <Card title="Como exportar a declaração">
            <ol className="vf-ecac-timeline">
              <HowStep n={1} title="Reúna os documentos">Os documentos chegam pelo checklist do cliente, por envio manual na documentação ou pelo sincronizador.</HowStep>
              <HowStep n={2} title="Processar documentos">A IA lê cada PDF ou imagem e devolve as linhas da DIRPF (rendimentos, pagamentos, bens…), comparando com as linhas já lançadas.</HowStep>
              <HowStep n={3} title="Conferir e validar">Em “Conferir”, aceite ou recuse as linhas em conflito. “Validar” aplica as linhas aceitas na declaração do cliente.</HowStep>
              <HowStep n={4} title="Exportar selecionados">Gera, em segundo plano, um pacote .zip por declaração com as linhas em CSV/JSON e os documentos usados.</HowStep>
              <HowStep n={5} title="Baixar e digitar">Baixe o pacote e use-o para preencher e conferir a declaração no programa IRPF.</HowStep>
            </ol>
            <Alert tone="warning" title="Pacote de conferência, não arquivo do programa">
              O pacote exportado não é uma cópia de segurança (.DBK) para restaurar no programa IRPF: o formato desses arquivos não é público. Ele serve para conferir e digitar a declaração com segurança.
            </Alert>
          </Card>
        )}
        {help === 'status' && (
          <Card title="Significado dos status">
            <div className="vf-ecac-legend">
              {Object.entries(STATUS_HELP).map(([k, text]) => (
                <div key={k} className="vf-ecac-legend__row">
                  <Tag tone={elaborationTone(k)}>{elaborationLabel(k)}</Tag>
                  <span className="vf-muted">{text}</span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {lastJob && (
          <JobAlert
            job={lastJob}
            title={lastJob.type === 'elaboration.export' ? 'Exportação' : 'Processamento de documentos'}
            done={jobSummary(lastJob)}
          />
        )}

        <Card flush title={`Declarações em elaboração · exercício ${year}`}>
          <div className="vf-inline" style={{ padding: 16, borderBottom: '1px solid var(--color-border)' }}>
            <div className="vf-grow" style={{ maxWidth: 360 }}>
              <Input aria-label="Pesquisar cliente" placeholder="Pesquisar cliente" icon={<Search />} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={statusOptions} />
          </div>
          <div className="vf-inline" style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface-low)' }}>
            <span className="vf-text-sm-bold">{ids.length} selecionado(s)</span>
            <div className="vf-grow" />
            {/* o servidor aceita elaboration.process ou pre_declaration.create (processar e validar) */}
            {can('elaboration.process', 'pre_declaration.create') && (
              <>
                <Button kind="secondary" size="sm" icon={<Cpu />} disabled={!ids.length || running} loading={run.isPending && run.variables === 'process'} onClick={() => run.mutate('process')}>
                  Processar documentos
                </Button>
                <Button kind="secondary" size="sm" icon={<FileCheck />} disabled={!ids.length} loading={run.isPending && run.variables === 'validate'} onClick={() => run.mutate('validate')}>
                  Validar
                </Button>
              </>
            )}
            {can('elaboration.export') && (
              <>
                <Button size="sm" icon={<FileArchive />} disabled={!ids.length || running} loading={run.isPending && run.variables === 'export'} onClick={() => run.mutate('export')}>
                  Exportar selecionados ({ids.length})
                </Button>
                <Button kind="secondary" size="sm" icon={<Download />} disabled={!ids.length} onClick={() => void downloadSelected()}>
                  Baixar selecionados ({ids.length})
                </Button>
              </>
            )}
          </div>
          {list.isLoading ? (
            <Loading />
          ) : rows.length === 0 ? (
            <EmptyState icon={<Wand2 />} title="Nenhuma declaração encontrada" description={debounced || status ? 'Revise a pesquisa ou o filtro de status.' : 'Cadastre clientes para acompanhar a elaboração das declarações.'} />
          ) : (
            <div className="vf-table-wrap">
              <table className="vf-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>
                      <input
                        type="checkbox"
                        aria-label="Selecionar todos"
                        checked={allOnPage}
                        onChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            rows.forEach((r) => (allOnPage ? n.delete(r.customerId) : n.add(r.customerId)));
                            return n;
                          })
                        }
                      />
                    </th>
                    <th>Cliente</th>
                    <th>CPF</th>
                    <th>Arquivos processados</th>
                    <th>Status</th>
                    <th>Exportação</th>
                    <th className="actions">Opções</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.customerId}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Selecionar ${r.name}`}
                          checked={selected.has(r.customerId)}
                          onChange={() =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (n.has(r.customerId)) n.delete(r.customerId);
                              else n.add(r.customerId);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td>
                        <Link to={`/clientes/${r.customerId}`} className="vf-text-sm-bold">
                          {r.name}
                        </Link>
                      </td>
                      <td className="vf-mono">{formatCpfCnpj(r.cpfCnpj)}</td>
                      <td>
                        <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                          <span className="vf-mono">
                            {r.counts.processed}/{r.counts.eligible}
                            {r.counts.errors > 0 && <span className="vf-danger-text"> · {r.counts.errors} com erro</span>}
                          </span>
                          {r.counts.programFiles > 0 && <span className="vf-text-xs vf-muted">{r.counts.programFiles} arquivo(s) do programa IRPF</span>}
                        </div>
                      </td>
                      <td>
                        <Tag tone={elaborationTone(r.status)}>{elaborationLabel(r.status)}</Tag>
                        {r.counts.conflicts > 0 && <div className="vf-text-xs vf-danger-text">{r.counts.conflicts} conflito(s)</div>}
                      </td>
                      <td>
                        {r.exported ? (
                          <span className="vf-inline" style={{ flexWrap: 'nowrap' }}>
                            <ViewFileButton fileId={r.exported.fileId} label="Baixar pacote" />
                            <span className="vf-text-xs vf-muted">{r.exported.at ? formatDateTime(r.exported.at) : ''}</span>
                          </span>
                        ) : (
                          <span className="vf-muted">—</span>
                        )}
                      </td>
                      <td className="actions">
                        <span className="vf-inline" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                          <Button kind="tertiary" size="sm" disabled={!r.counts.total} onClick={() => setReview(r)}>
                            Conferir
                          </Button>
                          <Link to={`/clientes/${r.customerId}/irpf/documentacao`} title="Documentação do cliente" aria-label="Documentação do cliente" className="vf-icon-btn">
                            <ClipboardList />
                          </Link>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list.data && list.data.total > 0 && <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onChange={setPage} />}
        </Card>
      </div>
      <ReviewDrawer row={review} year={year} onClose={() => setReview(null)} />
    </>
  );
}

function HowStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li>
      <span className="vf-ecac-timeline__n">{n}</span>
      <div>
        <div className="vf-text-sm-bold">{title}</div>
        <div className="vf-muted">{children}</div>
      </div>
    </li>
  );
}

function jobSummary(job: JobView) {
  const r = job.result ?? {};
  if (job.type === 'elaboration.export') {
    const skipped = (r.skipped as unknown[] | undefined)?.length ?? 0;
    return `${Number(r.exported ?? 0)} pacote(s) gerado(s)${skipped ? `; ${skipped} sem conteúdo para exportar` : ''}.`;
  }
  return `${Number(r.processed ?? 0)} documento(s) processado(s)${Number(r.failed ?? 0) ? `, ${Number(r.failed)} com erro` : ''}${Number(r.conflicts ?? 0) ? `, ${Number(r.conflicts)} conflito(s)` : ''}.`;
}

// ---------------------------------------------------------------- conferência
const MATCH: Record<string, { label: string; tone: 'success' | 'neutral' | 'danger' }> = {
  new: { label: 'Nova', tone: 'success' },
  duplicate: { label: 'Já lançada', tone: 'neutral' },
  conflict: { label: 'Conflito', tone: 'danger' },
};

function ReviewDrawer({ row, year, onClose }: { row: ElaborationRow | null; year: number; onClose: () => void }) {
  const { can } = useAuth();
  const key = ['elaboration', 'detail', row?.customerId, year];
  const q = useApi<ElaborationDetail>(key, row ? `/elaboration/customers/${row.customerId}?year=${year}` : null);
  const decide = useAction(
    (v: { docId: string; index: number; decision: 'accept' | 'reject' | null }) => api.put(`/elaboration/documents/${v.docId}/lines/${v.index}`, { decision: v.decision }),
    { invalidate: [key, ['elaboration', 'list']] },
  );
  const validate = useAction(() => api.post('/elaboration/validate', { year, customerIds: [row!.customerId] }), { success: 'Linhas aceitas aplicadas na declaração.', invalidate: [['elaboration']] });
  const d = q.data;
  // mesmas permissões do servidor: decidir linhas (pre_declaration.edit) e validar (pre_declaration.create)
  const editable = can('elaboration.process', 'pre_declaration.edit');
  const canValidate = can('elaboration.process', 'pre_declaration.create');
  return (
    <Drawer
      open={Boolean(row)}
      title={`Conferência · ${row?.name ?? ''}`}
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Fechar
          </Button>
          {canValidate && (
            <Button icon={<FileCheck />} loading={validate.isPending} disabled={!d?.counts.pendingLines} onClick={() => validate.mutate(undefined)}>
              Validar
            </Button>
          )}
        </>
      }
    >
      {!d ? (
        <Loading />
      ) : (
        <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
          <div className="vf-inline">
            <Tag tone={elaborationTone(d.status)}>{elaborationLabel(d.status)}</Tag>
            <span className="vf-muted">
              {d.counts.processed}/{d.counts.eligible} documento(s) processado(s) · {d.itemsCount} linha(s) na declaração
            </span>
          </div>
          {d.documents.map((doc) => (
            <Card key={doc.id} title={doc.filename} actions={<ViewFileButton fileId={doc.fileId} />}>
              <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
                <div className="vf-inline">
                  {!doc.extractable ? (
                    <Tag>Arquivo do programa IRPF ou outro formato — não lido pela IA</Tag>
                  ) : doc.processingStatus === 'processed' ? (
                    <Tag tone="success">Processado</Tag>
                  ) : doc.processingStatus === 'error' ? (
                    <Tag tone="danger">Erro na leitura</Tag>
                  ) : (
                    <Tag tone="warning">Não processado</Tag>
                  )}
                  <span className="vf-text-xs vf-muted">Enviado em {formatDateTime(doc.createdAt)}</span>
                </div>
                {doc.error && <Alert tone="danger">{doc.error}</Alert>}
                {doc.notes && <span className="vf-text-xs vf-muted">Observação da IA: {doc.notes}</span>}
                {doc.discarded > 0 && <span className="vf-text-xs vf-muted">{doc.discarded} linha(s) fora do formato foram descartadas.</span>}
                {doc.processingStatus === 'processed' && doc.lines.length === 0 && <span className="vf-muted">Nenhuma linha aproveitável encontrada.</span>}
                {doc.lines.length > 0 && (
                  <table className="vf-table">
                    <thead>
                      <tr>
                        <th>Linha</th>
                        <th className="num">Valor</th>
                        <th className="num">Retido</th>
                        <th>Situação</th>
                        <th className="actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {doc.lines.map((l) => (
                        <tr key={l.index}>
                          <td>
                            <div className="vf-text-sm-bold">{l.kindLabel}</div>
                            <div className="vf-text-xs vf-muted">
                              {[l.item.counterpartyName, l.item.counterpartyDoc ? formatCpfCnpj(l.item.counterpartyDoc) : null, l.item.description].filter(Boolean).join(' · ')}
                            </div>
                            {l.match === 'conflict' && l.existing && (
                              <div className="vf-text-xs vf-danger-text">
                                Lançado hoje: {formatMoney(l.existing.valueCents)} (retido {formatMoney(l.existing.withheldCents)})
                              </div>
                            )}
                          </td>
                          <td className="num">{formatMoney(l.item.valueCents)}</td>
                          <td className="num">{l.item.withheldCents !== undefined ? formatMoney(l.item.withheldCents) : '—'}</td>
                          <td>
                            <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                              <Tag tone={MATCH[l.match].tone}>{MATCH[l.match].label}</Tag>
                              {l.appliedAt ? (
                                <span className="vf-text-xs vf-success-text">Aplicada</span>
                              ) : l.decision === 'accept' ? (
                                <span className="vf-text-xs">Aceita</span>
                              ) : l.decision === 'reject' ? (
                                <span className="vf-text-xs vf-muted">Recusada</span>
                              ) : null}
                            </div>
                          </td>
                          <td className="actions">
                            {editable && !l.appliedAt && l.match !== 'duplicate' && (
                              <span className="vf-inline" style={{ flexWrap: 'nowrap' }}>
                                <IconButton label="Aceitar linha" onClick={() => decide.mutate({ docId: doc.id, index: l.index, decision: l.decision === 'accept' ? null : 'accept' })}>
                                  <Check color={l.decision === 'accept' ? 'var(--color-success)' : undefined} />
                                </IconButton>
                                <IconButton label="Recusar linha" onClick={() => decide.mutate({ docId: doc.id, index: l.index, decision: l.decision === 'reject' ? null : 'reject' })}>
                                  <X color={l.decision === 'reject' ? 'var(--color-danger)' : undefined} />
                                </IconButton>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </Drawer>
  );
}
