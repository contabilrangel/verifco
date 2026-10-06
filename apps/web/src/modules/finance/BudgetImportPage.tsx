import { useState } from 'react';
import { CheckCircle2, Download, FileSpreadsheet, XCircle } from 'lucide-react';
import { Alert, Button, Card, ConfirmDialog, DropFile, EmptyState, Loading, Select, Stat, Tag, useToast } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { YEAR_OPTIONS, useYear } from '../../lib/year';
import type { ImportBatch } from './types';

const KEY = ['finance', 'budget-import', 'batches'];

/** Importações › Orçamentos em lote. */
export function BudgetImportPage() {
  const { can } = useAuth();
  const { year: globalYear } = useYear();
  const toast = useToast();
  const [year, setYear] = useState(String(globalYear));
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportBatch | null>(null);
  const [downloading, setDownloading] = useState(false);
  const batches = useApi<ImportBatch[]>(KEY, can('worksheet.budget') ? '/finance/budget-import/batches' : null);

  const upload = useAction((f: File) => api.upload<ImportBatch>('/finance/budget-import', f, { year }), {
    success: (r) => `Importação concluída: ${r.succeeded} linha(s) gravada(s)${r.failed ? `, ${r.failed} com erro` : ''}.`,
    invalidate: [KEY, ['finance', 'budgets']],
    onSuccess: (r) => {
      setResult(r);
      setFile(null);
    },
  });

  if (!can('worksheet.budget')) {
    return <EmptyState title="Sem acesso" description="Seu perfil não tem permissão para importar orçamentos em lote." />;
  }

  return (
    <>
      <PageHeader
        title="Orçamentos em lote"
        description="Atualize os orçamentos de vários clientes de uma vez por planilha."
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Financeiro' }, { label: 'Orçamentos em lote' }]}
      />
      <div className="vf-grid vf-fin-import" style={{ '--cols': 2 } as React.CSSProperties}>
        <Card title="1. Baixe a planilha do exercício">
          <div className="vf-stack">
            <p className="vf-muted">
              A planilha vem preenchida com os clientes ativos e os orçamentos que já existem no exercício. Preencha ou ajuste o valor, a forma de pagamento, as parcelas e o
              início da cobrança. Linhas sem valor são ignoradas.
            </p>
            <div className="vf-inline" style={{ alignItems: 'flex-end' }}>
              <Select label="Ano-exercício" value={year} onChange={(e) => setYear(e.target.value)} options={YEAR_OPTIONS} style={{ minWidth: 180 }} />
              <Button
                icon={<Download />}
                loading={downloading}
                onClick={async () => {
                  setDownloading(true);
                  try {
                    await api.download(`/finance/budget-import/template?year=${year}`, `orcamentos-${year}.xlsx`);
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : 'Falha no download.');
                  } finally {
                    setDownloading(false);
                  }
                }}
              >
                Baixar planilha
              </Button>
            </div>
            <ul className="vf-fin-rules">
              <li>O cliente é identificado pelo CPF/CNPJ.</li>
              <li>Se já houver orçamento da mesma categoria no ano, ele é atualizado; senão, um novo é criado.</li>
              <li>Status “Aprovado” gera o faturamento. O envio ao cliente é feito pela tela do orçamento.</li>
              <li>Orçamentos já aprovados não mudam de valor pela planilha.</li>
            </ul>
          </div>
        </Card>
        <Card title="2. Envie a planilha preenchida">
          <div className="vf-stack">
            <DropFile accept=".xlsx,.csv" onFiles={(fs) => fs[0] && setFile(fs[0])} disabled={upload.isPending} hint={`Formatos .xlsx ou .csv · exercício ${year}`} />
            {upload.isPending && <Loading label="Importando orçamentos..." />}
          </div>
        </Card>
      </div>

      {result && <ImportResult key={result.id} batch={result} />}

      <Card title="Importações recentes" flush style={{ marginTop: 24 }}>
        {batches.isLoading ? (
          <Loading />
        ) : !batches.data?.length ? (
          <EmptyState icon={<FileSpreadsheet />} title="Nenhuma importação ainda" description="As importações feitas aparecem aqui com o resultado." />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th className="num">Linhas</th>
                  <th className="num">Gravadas</th>
                  <th className="num">Com erro</th>
                  <th className="actions" aria-label="Ações" />
                </tr>
              </thead>
              <tbody>
                {batches.data.map((b) => (
                  <tr key={b.id}>
                    <td>{formatDateTime(b.createdAt)}</td>
                    <td className="num">{b.total}</td>
                    <td className="num">{b.succeeded}</td>
                    <td className="num">{b.failed ? <Tag tone="danger">{b.failed}</Tag> : 0}</td>
                    <td className="actions">
                      <Button size="sm" kind="tertiary" onClick={() => setResult(b)}>
                        Ver resultado
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(file)}
        title="Importar orçamentos"
        message={`A planilha "${file?.name}" vai criar ou atualizar os orçamentos do exercício ${year}. Linhas com status “Aprovado” geram faturamento. Deseja continuar?`}
        confirmLabel="Importar"
        loading={upload.isPending}
        onConfirm={() => file && upload.mutate(file)}
        onClose={() => setFile(null)}
      />
    </>
  );
}

function ImportResult({ batch }: { batch: ImportBatch }) {
  const [onlyErrors, setOnlyErrors] = useState(batch.failed > 0);
  const rows = onlyErrors ? batch.results.filter((r) => !r.ok) : batch.results;
  return (
    <Card
      title="Resultado da importação"
      style={{ marginTop: 24 }}
      actions={
        batch.failed > 0 && (
          <Button size="sm" kind="tertiary" onClick={() => setOnlyErrors((v) => !v)}>
            {onlyErrors ? 'Mostrar todas as linhas' : 'Mostrar só os erros'}
          </Button>
        )
      }
    >
      <div className="vf-stack">
        <div className="vf-fin-stats">
          <Stat label="Linhas processadas" value={batch.total} />
          <Stat label="Gravadas" value={batch.succeeded} tone="success" />
          <Stat label="Com erro" value={batch.failed} tone={batch.failed ? 'danger' : undefined} />
          {batch.skipped !== undefined && <Stat label="Ignoradas (sem valor)" value={batch.skipped} />}
        </div>
        {batch.total === 0 ? (
          <Alert tone="warning">Nenhuma linha com valor foi encontrada. Confira se a planilha segue o modelo.</Alert>
        ) : (
          <div className="vf-table-wrap vf-fin-subtable">
            <table className="vf-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Linha</th>
                  <th style={{ width: 120 }}>Situação</th>
                  <th>Mensagem</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row}>
                    <td className="vf-mono">{r.row}</td>
                    <td>
                      {r.ok ? (
                        <Tag tone="success" icon={<CheckCircle2 size={12} />}>
                          OK
                        </Tag>
                      ) : (
                        <Tag tone="danger" icon={<XCircle size={12} />}>
                          Erro
                        </Tag>
                      )}
                    </td>
                    <td>{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
