import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, Eye, FileSpreadsheet, History, Lock } from 'lucide-react';
import { IMPORT_KINDS, IMPORT_KIND_LIST, IMPORT_MAX_ROWS, IMPORT_STATUS, isImportKind, type ImportKindDef, type ImportRowResult } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, DropFile, EmptyState, IconButton, Loading, Menu, MenuItem, Modal, Pagination, Spinner, Tabs, Tag, useToast, type Tone } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api, errorMessage, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { plural } from './shared';

interface BatchSummary {
  id: string;
  kind: string;
  status: keyof typeof IMPORT_STATUS;
  total: number;
  succeeded: number;
  failed: number;
  fileId: string | null;
  filename: string | null;
  createdAt: string;
  createdByName: string | null;
}

interface Batch extends BatchSummary {
  results: ImportRowResult[];
  /** Só na resposta do envio: linhas sem dados a importar ou sem alteração. */
  ignored?: number;
}

const MAX_SIZE = 25 * 1024 * 1024;
const statusTone = (s: string): Tone => (s === 'done' ? 'success' : s === 'partial' ? 'warning' : 'danger');

/** Importação em lote por planilha (novos clientes, atualização, procurações e eCAC). */
export function ImportPage() {
  const { tipo = '' } = useParams();
  const { can } = useAuth();
  if (tipo === 'inss') {
    // COB-7: a importação de senhas gov.br do INSS foi retirada (endereço antigo do menu)
    return (
      <>
        <PageHeader title="Login INSS em lote" crumbs={[{ label: 'Início', to: '/' }, { label: 'Clientes', to: '/clientes' }, { label: 'Login INSS em lote' }]} />
        <Card>
          <EmptyState
            icon={<FileSpreadsheet />}
            title="Importação retirada"
            description="O Verifco não tem integração com o INSS (o Meu INSS não oferece acesso a sistemas de terceiros), então a senha gov.br do INSS não tinha uso. Por segurança, as senhas importadas foram apagadas e a importação saiu do sistema. Os informes do INSS chegam pela pré-preenchida ou pelo checklist do cliente."
          />
        </Card>
      </>
    );
  }
  if (!isImportKind(tipo)) {
    return (
      <>
        <PageHeader title="Importação" crumbs={[{ label: 'Início', to: '/' }, { label: 'Importação' }]} />
        <Card>
          <EmptyState icon={<FileSpreadsheet />} title="Importação não encontrada" description="Confira o endereço ou escolha uma importação no menu Clientes." />
        </Card>
      </>
    );
  }
  const def = IMPORT_KINDS[tipo];
  if (!can(def.permission)) {
    return (
      <>
        <PageHeader title={def.label} crumbs={[{ label: 'Início', to: '/' }, { label: 'Clientes', to: '/clientes' }, { label: def.label }]} />
        <Card>
          <EmptyState icon={<Lock />} title="Sem acesso a esta importação" description="Peça a quem administra o escritório para incluir esta permissão na sua função." />
        </Card>
      </>
    );
  }
  return <ImportScreen key={tipo} def={def} />;
}

function ImportScreen({ def }: { def: ImportKindDef }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [result, setResult] = useState<Batch | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // o resultado aparece abaixo dos passos: leva a tela até ele
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [result]);

  const downloadTemplate = async () => {
    setDownloading(true);
    try {
      await api.download(`/imports/${def.slug}/template`, `modelo-${def.slug}.xlsx`);
    } catch (e) {
      toast.error(errorMessage(e, 'Não foi possível baixar o modelo.'));
    } finally {
      setDownloading(false);
    }
  };

  const pick = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) return toast.error('Envie a planilha em .xlsx ou .csv.');
    if (f.size > MAX_SIZE) return toast.error('O arquivo passa de 25 MB. Divida a planilha em partes menores.');
    setPending(f);
  };

  const send = async () => {
    if (!pending) return;
    setSending(true);
    try {
      const batch = await api.upload<Batch>(`/imports/${def.slug}`, pending);
      setResult(batch);
      setPending(null);
      void qc.invalidateQueries({ queryKey: ['imports', def.slug] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['procurators'] });
      if (batch.total === 0) toast.info('Nenhuma linha com dados a importar.');
      else if (batch.failed === 0) toast.success(`${plural(batch.succeeded, 'linha importada', 'linhas importadas')}.`);
      else toast.error(`${plural(batch.failed, 'linha com erro', 'linhas com erro')}. Veja o resultado abaixo.`);
    } catch (e) {
      setPending(null);
      toast.error(errorMessage(e, 'Não foi possível enviar a planilha.'));
    } finally {
      setSending(false);
    }
  };

  const updates = def.slug !== 'novos-clientes';

  return (
    <>
      <PageHeader
        title={def.label}
        description={def.summary}
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Clientes', to: '/clientes' }, { label: def.label }]}
        actions={<OtherImports current={def.slug} />}
      />
      <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
        <div className="adm-two">
          <Card title={<Step n={1}>Baixe o modelo</Step>}>
            <div className="vf-stack">
              <p className="vf-muted">
                {def.prefilled ? 'O modelo já vem com os clientes que você pode ver, para preencher só o que falta.' : 'Preencha uma linha por cliente na primeira aba do modelo.'}
              </p>
              <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
                <span className="vf-text-sm-bold">Colunas obrigatórias</span>
                <div className="adm-perm-tags">
                  {def.required.map((c) => (
                    <Tag key={c} tone="primary">
                      {c}
                    </Tag>
                  ))}
                </div>
                {def.optional.length > 0 && (
                  <>
                    <span className="vf-text-sm-bold">Colunas opcionais</span>
                    <div className="adm-perm-tags">
                      {def.optional.map((c) => (
                        <Tag key={c}>{c}</Tag>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <ul className="adm-tips">
                {def.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
                <li>Até {IMPORT_MAX_ROWS.toLocaleString('pt-BR')} linhas por arquivo. Linhas idênticas repetidas são recusadas.</li>
              </ul>
              <div>
                <Button kind="secondary" icon={<Download />} loading={downloading} onClick={downloadTemplate}>
                  Baixar modelo (.xlsx)
                </Button>
              </div>
            </div>
          </Card>

          <Card title={<Step n={2}>Envie a planilha preenchida</Step>}>
            <div className="vf-stack">
              {def.hasSecrets && (
                <Alert tone="warning" title="A planilha contém senhas">
                  Guardamos as senhas cifradas e não armazenamos o arquivo. Apague a planilha do seu computador depois de importar.
                </Alert>
              )}
              {sending ? (
                <div className="vf-dropfile">
                  <Spinner size={40} />
                  <div>Processando a planilha, linha a linha...</div>
                  <div className="vf-text-xs vf-muted">Arquivos grandes podem levar alguns segundos.</div>
                </div>
              ) : (
                <DropFile onFiles={pick} accept=".xlsx,.csv" title="Arraste a planilha ou clique em Selecionar" hint="Formatos .xlsx ou .csv (separado por ponto e vírgula)" />
              )}
              <span className="vf-text-xs vf-muted">
                Cada linha é processada separadamente: uma linha com erro não impede as outras. Corrija só as linhas com erro e envie de novo.
              </span>
            </div>
          </Card>
        </div>

        {result && (
          <div ref={resultRef} style={{ scrollMarginTop: 16 }}>
            <Card
              className="adm-card"
              title="Resultado da importação"
              actions={
                <Button kind="tertiary" onClick={() => setResult(null)}>
                  Fechar
                </Button>
              }
            >
              <BatchResult batch={result} />
            </Card>
          </div>
        )}

        <HistoryCard def={def} />
      </div>

      <ConfirmDialog
        open={Boolean(pending)}
        title="Importar planilha?"
        message={
          <div className="vf-stack" style={{ '--gap': '8px' } as React.CSSProperties}>
            <span>
              O arquivo <strong>{pending?.name}</strong> será processado agora.
            </span>
            <span>
              {updates
                ? 'Os clientes encontrados pelo CPF serão alterados conforme a planilha.'
                : 'Os clientes válidos serão cadastrados e as linhas com erro listadas para correção.'}
            </span>
          </div>
        }
        confirmLabel="Importar"
        loading={sending}
        onConfirm={() => void send()}
        onClose={() => !sending && setPending(null)}
      />
    </>
  );
}

/** Atalho para as demais importações que o usuário pode usar (a de login eCAC não fica no menu lateral). */
function OtherImports({ current }: { current: string }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const others = IMPORT_KIND_LIST.filter((k) => k.slug !== current && can(k.permission));
  if (!others.length) return null;
  return (
    <Menu
      trigger={(toggle) => (
        <Button kind="secondary" icon={<ChevronDown />} onClick={toggle}>
          Outras importações
        </Button>
      )}
    >
      {(close) =>
        others.map((k) => (
          <MenuItem key={k.slug} icon={<FileSpreadsheet />} onClick={() => (close(), navigate(`/importacoes/${k.slug}`))}>
            {k.label}
          </MenuItem>
        ))
      }
    </Menu>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <span className="adm-step">
      <span className="adm-step__n">{n}</span>
      {children}
    </span>
  );
}

/** Resumo (total, importadas, erros) e as linhas, com abas para erros e sucessos. */
function BatchResult({ batch }: { batch: Batch }) {
  const errors = batch.results.filter((r) => !r.ok);
  const oks = batch.results.filter((r) => r.ok);
  const [tab, setTab] = useState<'errors' | 'ok'>(errors.length ? 'errors' : 'ok');
  useEffect(() => setTab(errors.length ? 'errors' : 'ok'), [batch.id, errors.length]);
  const shown = tab === 'errors' ? errors : oks;
  const [downloading, setDownloading] = useState(false);
  const toast = useToast();

  return (
    <div className="vf-stack">
      <div className="vf-inline vf-between">
        <span className="vf-muted vf-text-xs">
          {batch.filename ? `${batch.filename} · ` : ''}
          {formatDateTime(batch.createdAt)}
          {batch.createdByName ? ` · por ${batch.createdByName}` : ''}
        </span>
        {batch.total > 0 && (
          <Button
            kind="tertiary"
            size="sm"
            icon={<Download />}
            loading={downloading}
            onClick={async () => {
              setDownloading(true);
              try {
                await api.download(`/imports/${batch.id}/report`, 'resultado.xlsx');
              } catch {
                toast.error('Não foi possível baixar o relatório.');
              } finally {
                setDownloading(false);
              }
            }}
          >
            Baixar resultado (.xlsx)
          </Button>
        )}
      </div>
      <div className="adm-stats">
        <StatBox label="Linhas processadas" value={batch.total} />
        <StatBox label="Importadas" value={batch.succeeded} tone="success" />
        <StatBox label="Com erro" value={batch.failed} tone={batch.failed ? 'danger' : undefined} />
        {batch.ignored !== undefined ? <StatBox label="Ignoradas" value={batch.ignored} hint="Sem dados a importar ou sem alteração" /> : <StatBox label="Situação" text={IMPORT_STATUS[batch.status] ?? batch.status} />}
      </div>
      {batch.total === 0 ? (
        <Alert title="Nenhuma linha com dados a importar">As linhas estavam vazias nas colunas a preencher ou já tinham os mesmos dados.</Alert>
      ) : batch.failed === 0 ? (
        <Alert tone="success" title="Tudo certo">Todas as linhas foram importadas.</Alert>
      ) : (
        <Alert tone={batch.succeeded ? 'warning' : 'danger'} title={batch.succeeded ? 'Importação concluída com erros' : 'Nenhuma linha foi importada'}>
          Corrija as linhas abaixo na planilha e envie de novo. As linhas já importadas não precisam ser reenviadas.
        </Alert>
      )}
      {batch.total > 0 && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'errors', label: `Com erro (${errors.length})` },
              { value: 'ok', label: `Importadas (${oks.length})` },
            ]}
          />
          {shown.length === 0 ? (
            <p className="vf-muted" style={{ padding: '8px 0' }}>
              {tab === 'errors' ? 'Nenhuma linha com erro.' : 'Nenhuma linha importada.'}
            </p>
          ) : (
            <div className="vf-table-wrap adm-scroll">
              <table className="vf-table">
                <thead>
                  <tr>
                    <th style={{ width: 80 }}>Linha</th>
                    <th>{tab === 'errors' ? 'O que corrigir' : 'Resultado'}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 500).map((r) => (
                    <tr key={r.row}>
                      <td className="vf-mono">{r.row}</td>
                      <td className={r.ok ? undefined : 'vf-danger-text'}>{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length > 500 && <p className="vf-muted vf-text-xs" style={{ padding: 12 }}>Mostrando 500 de {shown.length} linhas. Baixe o resultado para ver todas.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatBox({ label, value, text, tone, hint }: { label: string; value?: number; text?: string; tone?: 'success' | 'danger'; hint?: string }) {
  return (
    <div className="adm-stat-box">
      <div className="vf-stat">
        <span className="vf-stat__label">{label}</span>
        <span className={`vf-stat__value${tone === 'success' ? ' vf-success-text' : tone === 'danger' ? ' vf-danger-text' : ''}`} style={text ? { font: 'var(--text-md-bold)' } : undefined}>
          {text ?? (value ?? 0).toLocaleString('pt-BR')}
        </span>
        {hint && <span className="vf-stat__hint">{hint}</span>}
      </div>
    </div>
  );
}

function HistoryCard({ def }: { def: ImportKindDef }) {
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const query = qs({ kind: def.slug, page, pageSize: 10 });
  const history = useApi<{ data: BatchSummary[]; total: number; page: number; pages: number }>(['imports', def.slug, page], `/imports${query}`);
  const detail = useApi<Batch>(['imports', 'detail', openId], openId ? `/imports/${openId}` : null);

  return (
    <Card flush title="Últimas importações">
      {history.isLoading ? (
        <Loading />
      ) : history.isError ? (
        <div style={{ padding: 16 }}>
          <Alert tone="danger" title="Não foi possível carregar o histórico." />
        </div>
      ) : !history.data?.data.length ? (
        <EmptyState icon={<History />} title="Nenhuma importação ainda" description="As planilhas enviadas aparecem aqui, com o resultado de cada linha." />
      ) : (
        <>
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Arquivo</th>
                  <th>Enviado por</th>
                  <th className="num">Linhas</th>
                  <th className="num">Importadas</th>
                  <th className="num">Com erro</th>
                  <th>Situação</th>
                  <th className="actions">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.data.data.map((b) => (
                  <tr key={b.id}>
                    <td>{formatDateTime(b.createdAt)}</td>
                    <td>{b.filename ?? <span className="vf-muted">{def.hasSecrets ? 'Não armazenado (contém senhas)' : '—'}</span>}</td>
                    <td>{b.createdByName ?? '—'}</td>
                    <td className="num">{b.total.toLocaleString('pt-BR')}</td>
                    <td className="num">{b.succeeded.toLocaleString('pt-BR')}</td>
                    <td className={`num${b.failed ? ' vf-danger-text' : ''}`}>{b.failed.toLocaleString('pt-BR')}</td>
                    <td>
                      <Tag tone={b.total === 0 ? 'neutral' : statusTone(b.status)}>{b.total === 0 ? 'Sem alterações' : (IMPORT_STATUS[b.status] ?? b.status)}</Tag>
                    </td>
                    <td className="actions">
                      <IconButton label="Ver detalhes" onClick={() => setOpenId(b.id)}>
                        <Eye />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={history.data.page} pages={history.data.pages} total={history.data.total} onChange={setPage} />
        </>
      )}
      <Modal open={Boolean(openId)} title="Detalhes da importação" onClose={() => setOpenId(null)} width={760}>
        {detail.isLoading || !detail.data ? detail.isError ? <Alert tone="danger" title="Não foi possível carregar a importação." /> : <Loading /> : <BatchResult batch={detail.data} />}
      </Modal>
    </Card>
  );
}
