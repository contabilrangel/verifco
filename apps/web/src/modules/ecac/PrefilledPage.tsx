import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Download, FileStack, HelpCircle, Search, Upload } from 'lucide-react';
import { Alert, Button, Card, DropFile, EmptyState, IconButton, Input, Loading, Modal, Pagination, Select, Stat, Tag, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { ApiError, api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi, useDebounced } from '../../lib/hooks';
import { formatCpfCnpj, formatDateTime } from '../../lib/format';
import { useYear } from '../../lib/year';
import type { PrefilledRow } from './types';

interface ListResponse {
  data: PrefilledRow[];
  total: number;
  page: number;
  pages: number;
  summary: { customers: number; withFiles: number; newFiles: number; withoutProcurator: number };
}

const FILTERS = [
  { value: '', label: 'Todos os clientes' },
  { value: 'with_files', label: 'Com arquivos' },
  { value: 'new', label: 'Com arquivos novos' },
  { value: 'without_files', label: 'Sem arquivos' },
  { value: 'without_procurator', label: 'Sem procurador associado' },
];

const STEPS: { title: string; body: React.ReactNode }[] = [
  { title: 'Cadastro do procurador', body: <>Cadastre quem tem a procuração eletrônica dos clientes em <Link to="/admin/procuradores">Administração › Procuradores</Link>.</> },
  { title: 'Associação de clientes', body: <>Associe o procurador a cada cliente (na identificação ou em lote na lista de clientes). Clientes sem procurador associado são ignorados pela busca.</> },
  { title: 'Busca pelo robô', body: <>A extensão do navegador ou o sincronizador buscam os arquivos e os enviam ao Verifco com um token (<Link to="/admin/robo">Administração › Robô</Link>). Também é possível enviar o arquivo à mão em cada cliente.</> },
  { title: 'Download dos arquivos', body: <>Baixe um arquivo por vez, só os novos (ainda não baixados) ou todos do exercício em um .zip.</> },
  { title: 'Restaurar no programa IRPF', body: <>No programa IRPF do exercício, inicie a declaração do cliente a partir do arquivo da pré-preenchida baixado e confira os dados importados antes de transmitir.</> },
];

export function PrefilledPage() {
  const { can } = useAuth();
  const { year } = useYear();
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [tutorial, setTutorial] = useState(false);
  const [uploadFor, setUploadFor] = useState<PrefilledRow | null>(null);
  const [busy, setBusy] = useState<'new' | 'all' | null>(null);
  useEffect(() => setPage(1), [debounced, filter, year]);
  const query = qs({ year, search: debounced, filter, page, pageSize: 25 });
  const list = useApi<ListResponse>(['prefilled', query], `/prefilled${query}`);
  const s = list.data?.summary;

  const downloadZip = async (mode: 'new' | 'all') => {
    setBusy(mode);
    try {
      await api.download('/prefilled/download', `pre-preenchidas-${year}.zip`, { year, mode });
      toast.success(mode === 'new' ? 'Arquivos novos baixados e marcados como baixados.' : 'Todos os arquivos do exercício baixados.');
      void qc.invalidateQueries({ queryKey: ['prefilled'] });
    } catch (e) {
      toast.error(e instanceof ApiError && e.status === 404 ? (mode === 'new' ? 'Não há arquivos novos para baixar.' : 'Não há arquivos neste exercício.') : 'Falha no download.');
    } finally {
      setBusy(null);
    }
  };

  const downloadOne = async (id: string, filename: string) => {
    try {
      await api.download(`/prefilled/${id}/download`, filename);
      void qc.invalidateQueries({ queryKey: ['prefilled'] });
    } catch {
      toast.error('Falha no download.');
    }
  };

  return (
    <>
      <PageHeader
        title="Pré-preenchidas IRPF"
        description={`Arquivos das declarações pré-preenchidas do exercício ${year} obtidos pelo robô a partir das procurações.`}
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Pré-preenchidas IRPF' }]}
        actions={
          <>
            <Button kind="tertiary" icon={<HelpCircle />} onClick={() => setTutorial((t) => !t)}>
              Tutorial pré-preenchida
            </Button>
            <Button kind="secondary" icon={<Download />} loading={busy === 'all'} disabled={!s?.withFiles} onClick={() => void downloadZip('all')}>
              Baixar todos
            </Button>
            <Button icon={<Download />} loading={busy === 'new'} disabled={!s?.newFiles} onClick={() => void downloadZip('new')}>
              Baixar novos{s?.newFiles ? ` (${s.newFiles})` : ''}
            </Button>
          </>
        }
      />
      <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
        {tutorial && (
          <Card title="Tutorial pré-preenchida">
            <ol className="vf-ecac-timeline">
              {STEPS.map((st, i) => (
                <li key={st.title}>
                  <span className="vf-ecac-timeline__n">{i + 1}</span>
                  <div>
                    <div className="vf-text-sm-bold">{st.title}</div>
                    <div className="vf-muted">{st.body}</div>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        )}
        <Card>
          {!s ? (
            <Loading />
          ) : (
            <div className="vf-grid" style={{ '--cols': 4 } as React.CSSProperties}>
              <Stat label="Clientes ativos" value={s.customers} />
              <Stat label="Com arquivo no exercício" value={s.withFiles} />
              <Stat label="Arquivos novos" value={s.newFiles} hint="Ainda não baixados" />
              <Stat label="Sem procurador" value={s.withoutProcurator} hint="Ignorados pela busca do robô" tone={s.withoutProcurator ? 'danger' : undefined} />
            </div>
          )}
        </Card>
        <Card flush>
          <div className="vf-inline" style={{ padding: 16, borderBottom: '1px solid var(--color-border)' }}>
            <div className="vf-grow" style={{ maxWidth: 420 }}>
              <Input aria-label="Buscar" placeholder="Buscar por nome ou CPF" icon={<Search />} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select aria-label="Filtro" value={filter} onChange={(e) => setFilter(e.target.value)} options={FILTERS} />
          </div>
          {list.isLoading ? (
            <Loading />
          ) : !list.data?.data.length ? (
            <EmptyState icon={<FileStack />} title="Nenhum cliente encontrado" description={debounced || filter ? 'Revise a busca ou o filtro.' : 'Cadastre clientes e associe um procurador para o robô buscar as pré-preenchidas.'} />
          ) : (
            <div className="vf-table-wrap">
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>CPF</th>
                    <th>Documentos</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((r) => (
                    <tr key={r.customerId}>
                      <td>
                        <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                          <Link to={`/clientes/${r.customerId}/ecac`} className="vf-text-sm-bold">
                            {r.name}
                          </Link>
                          {r.procuratorName ? (
                            <span className="vf-text-xs vf-muted">Procurador: {r.procuratorName}</span>
                          ) : (
                            <span>
                              <Tag tone="warning">Sem procurador associado — ignorado pela busca</Tag>
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="vf-mono">{formatCpfCnpj(r.cpfCnpj)}</td>
                      <td>
                        {r.documents.length === 0 ? (
                          <span className="vf-muted">Nenhum arquivo</span>
                        ) : (
                          <div className="vf-stack" style={{ '--gap': '4px' } as React.CSSProperties}>
                            {r.documents.map((doc) => (
                              <div key={doc.id} className="vf-inline" style={{ flexWrap: 'nowrap' }}>
                                <button type="button" className="vf-ecac-link" onClick={() => void downloadOne(doc.id, doc.filename)} title="Baixar">
                                  <Download size={14} /> {doc.filename}
                                </button>
                                {doc.downloadedAt ? (
                                  <span className="vf-text-xs vf-muted">baixado em {formatDateTime(doc.downloadedAt)}</span>
                                ) : (
                                  <Tag tone="success">Novo</Tag>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="actions">
                        {can('ecac.sync') && (
                          <IconButton label="Enviar arquivo manualmente" onClick={() => setUploadFor(r)}>
                            <Upload />
                          </IconButton>
                        )}
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
      <UploadModal row={uploadFor} year={year} onClose={() => setUploadFor(null)} />
    </>
  );
}

function UploadModal({ row, year, onClose }: { row: PrefilledRow | null; year: number; onClose: () => void }) {
  const upload = useAction((file: File) => api.upload<{ duplicate: boolean }>('/prefilled/upload', file, { customerId: row!.customerId, year: String(year) }), {
    success: (r) => (r.duplicate ? 'Este arquivo já estava cadastrado.' : 'Arquivo enviado.'),
    invalidate: [['prefilled']],
    onSuccess: onClose,
  });
  return (
    <Modal open={Boolean(row)} title={`Enviar pré-preenchida — ${row?.name ?? ''}`} onClose={onClose} width={520}>
      <div className="vf-stack">
        <Alert>Use quando o arquivo foi baixado fora do robô. Ele fica disponível para download junto dos demais do exercício {year}.</Alert>
        <DropFile onFiles={(fs) => fs[0] && upload.mutate(fs[0])} disabled={upload.isPending} title="Arraste o arquivo da pré-preenchida ou clique em 'Selecionar'" hint="Até 25 MB" />
      </div>
    </Modal>
  );
}
