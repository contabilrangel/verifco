import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Download, ExternalLink, FileSpreadsheet, ListChecks, Trash2, Undo2 } from 'lucide-react';
import {
  CARNE_LEAO_MODELS_URL,
  CARNE_LEAO_TABLES_URL,
  CASHBOOK_GUIDE,
  CASHBOOK_MAX_ROWS,
  CASHBOOK_MODELS,
  cashbookModelCsv,
  type CashbookKind,
  type CashbookMonth,
} from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, DropFile, EmptyState, IconButton, Loading, Modal, Select, Tabs, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { formatCpfCnpj, formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { downloadText, errorMessage } from './ui';

interface Entry {
  id: string;
  kind: CashbookKind;
  entryDate: string;
  code: string;
  description: string | null;
  valueCents: number;
  counterpartyCpf: string | null;
  extra: { receivedFrom?: string; deductionCents?: number | null; cnpj?: string | null; occupationCode?: string | null; irrfCents?: number | null; competence?: string | null };
  importBatchId: string | null;
}
interface Totals {
  incomeCents: number;
  deductionCents: number;
  irrfCents: number;
  deductibleCents: number;
  nonDeductibleCents: number;
  generalPaymentsCents: number;
  count: number;
}
interface CashbookData {
  year: number;
  entries: Entry[];
  months: CashbookMonth[];
  totals: Totals;
  batches: { id: string; total: number; succeeded: number; failed: number; createdAt: string }[];
}
interface ImportResult {
  batchId: string;
  total: number;
  succeeded: number;
  failed: number;
  results: { file: string; row: number; ok: boolean; message: string }[];
}

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

export function CashbookTab() {
  const { customer } = useCustomer();
  const { year: exercise } = useYear();
  const toast = useToast();
  const qc = useQueryClient();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(exercise - 1);
  const [guide, setGuide] = useState<CashbookKind>('income');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [month, setMonth] = useState<number | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const key = ['cashbook', customer.id, year];
  const q = useApi<CashbookData>(key, `/customers/${customer.id}/cashbook?year=${year}`);

  const convert = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const r = await api.upload<ImportResult>(`/customers/${customer.id}/cashbook/import?year=${year}`, files);
      setResult(r);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const exportCsv = async (params: { kind?: CashbookKind; month?: number }) => {
    const qs = new URLSearchParams({ year: String(year), ...(params.kind ? { kind: params.kind } : {}), ...(params.month ? { month: String(params.month) } : {}) });
    try {
      await api.download(`/customers/${customer.id}/cashbook/export?${qs}`, `carne-leao-${year}.csv`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const removeEntry = async (id: string) => {
    try {
      await api.del(`/cashbook/entries/${id}`);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const doUndo = async () => {
    if (!undo) return;
    try {
      const r = await api.del<{ removed: number }>(`/customers/${customer.id}/cashbook/batches/${undo}`);
      toast.success(`${r.removed} lançamento(s) removido(s).`);
      setUndo(null);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const data = q.data;
  const monthEntries = (data?.entries ?? []).filter((e) => month && Number(e.entryDate.slice(5, 7)) === month);

  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="vf-inline vf-between">
        <div className="vf-inline">
          <BookOpen size={20} />
          <strong className="vf-text-md-bold">Livro caixa e Carnê-Leão</strong>
        </div>
        <div className="vf-inline">
          <span className="vf-muted vf-text-sm">Ano-calendário</span>
          <Select
            aria-label="Ano-calendário"
            value={String(year)}
            onChange={(e) => {
              setYear(Number(e.target.value));
              setMonth(null);
            }}
            options={Array.from({ length: 6 }, (_, i) => thisYear - i).map((y) => ({ value: String(y), label: String(y) }))}
          />
        </div>
      </div>

      <div className="vf-grid">
        <Card title="1. Modelos para baixar">
          <div className="vf-stack">
            {(['income', 'payment'] as const).map((kind) => (
              <div key={kind} className="vf-stack" style={{ '--gap': '6px' } as React.CSSProperties}>
                <span className="vf-text-xs-bold vf-muted">{kind === 'income' ? 'MODELOS PARA RENDIMENTOS' : 'MODELOS PARA PAGAMENTOS'}</span>
                {CASHBOOK_MODELS.filter((m) => m.kind === kind).map((m) => (
                  <div key={m.key} className="vf-inline vf-between" style={{ flexWrap: 'nowrap' }}>
                    <span className="vf-stack" style={{ '--gap': '0' } as React.CSSProperties}>
                      <span className="vf-text-sm-bold">{m.label}</span>
                      <span className="vf-text-xs vf-muted">{m.description}</span>
                    </span>
                    <Button
                      kind="tertiary"
                      size="sm"
                      icon={<Download />}
                      onClick={() => {
                        const f = cashbookModelCsv(m.key)!;
                        downloadText(f.filename, '﻿' + f.content);
                      }}
                    >
                      Baixar
                    </Button>
                  </div>
                ))}
              </div>
            ))}
            <p className="vf-text-xs vf-muted">
              Layout baseado nos modelos oficiais da Receita Federal para importação da escrituração no Carnê-Leão Web.{' '}
              <a href={CARNE_LEAO_MODELS_URL} target="_blank" rel="noopener noreferrer">
                Modelos oficiais <ExternalLink size={12} />
              </a>{' '}
              ·{' '}
              <a href={CARNE_LEAO_TABLES_URL} target="_blank" rel="noopener noreferrer">
                Tabelas de códigos de rendimentos, pagamentos e ocupações <ExternalLink size={12} />
              </a>
            </p>
          </div>
        </Card>

        <Card title="2. Guia de preenchimento">
          <div className="vf-stack">
            <Tabs
              value={guide}
              onChange={setGuide}
              items={[
                { value: 'income', label: 'Rendimentos' },
                { value: 'payment', label: 'Pagamentos' },
              ]}
            />
            <div className="vf-table-wrap" style={{ maxHeight: 330, overflowY: 'auto' }}>
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Formato</th>
                    <th>Obrigatório</th>
                  </tr>
                </thead>
                <tbody>
                  {CASHBOOK_GUIDE.filter((g) => g.kind === guide).map((g) => (
                    <tr key={g.field}>
                      <td className="vf-text-sm-bold">{g.field}</td>
                      <td className="vf-text-sm">{g.format}</td>
                      <td className="vf-text-xs vf-muted">{g.required}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="vf-text-xs vf-muted">Os códigos são conferidos só pelo formato: escolha o código certo nas tabelas oficiais do Carnê-Leão Web.</p>
          </div>
        </Card>
      </div>

      <Card title="3. Conversão">
        <div className="vf-stack">
          <DropFile
            accept=".csv,.xlsx,.txt"
            multiple
            disabled={uploading}
            onFiles={(f) => void convert(f)}
            title={uploading ? 'Convertendo...' : 'Selecione as planilhas preenchidas (.csv ou .xlsx no layout do modelo)'}
            hint={`Ano-calendário ${year}`}
          />
          <Alert tone="primary" title="Importante">
            Até {CASHBOOK_MAX_ROWS.toLocaleString('pt-BR')} linhas por envio. Cada linha é validada e o resultado aparece por linha; os lançamentos válidos são acrescentados, sem
            sobrescrever os anteriores. Linhas do modelo com 99/99/9999 são ignoradas.
          </Alert>
          {(data?.batches ?? []).length > 0 && (
            <div className="vf-table-wrap">
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Envio</th>
                    <th className="num">Linhas</th>
                    <th className="num">Incluídas</th>
                    <th className="num">Com erro</th>
                    <th className="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {data!.batches.map((b) => (
                    <tr key={b.id}>
                      <td>{formatDateTime(b.createdAt)}</td>
                      <td className="num">{b.total}</td>
                      <td className="num">{b.succeeded}</td>
                      <td className="num">{b.failed ? <Tag tone="danger">{b.failed}</Tag> : 0}</td>
                      <td className="actions">
                        <Button
                          kind="tertiary"
                          size="sm"
                          icon={<ListChecks />}
                          onClick={async () => {
                            try {
                              const batch = await api.get<{ total: number; succeeded: number; failed: number; results: { row: number; ok: boolean; message: string }[] }>(
                                `/customers/${customer.id}/cashbook/batches/${b.id}`,
                              );
                              setResult({
                                batchId: b.id,
                                total: batch.total,
                                succeeded: batch.succeeded,
                                failed: batch.failed,
                                results: batch.results.map((r) => {
                                  const [file, ...rest] = r.message.split(': ');
                                  return { file, row: r.row, ok: r.ok, message: rest.join(': ') };
                                }),
                              });
                            } catch (e) {
                              toast.error(errorMessage(e));
                            }
                          }}
                        >
                          Resultado
                        </Button>
                        <Button kind="tertiary" size="sm" icon={<Undo2 />} onClick={() => setUndo(b.id)}>
                          Desfazer
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <Card
        flush
        title="4. Lançamentos por mês"
        actions={
          <>
            <Button kind="secondary" size="sm" icon={<FileSpreadsheet />} disabled={!data?.totals.count} onClick={() => void exportCsv({ kind: 'income' })}>
              Só rendimentos
            </Button>
            <Button kind="secondary" size="sm" icon={<FileSpreadsheet />} disabled={!data?.totals.count} onClick={() => void exportCsv({ kind: 'payment' })}>
              Só pagamentos
            </Button>
            <Button size="sm" icon={<Download />} disabled={!data?.totals.count} onClick={() => void exportCsv({})}>
              Exportar para o Carnê-Leão Web
            </Button>
          </>
        }
      >
        {q.isLoading ? (
          <Loading />
        ) : !data?.totals.count ? (
          <EmptyState icon={<BookOpen />} title={`Nenhum lançamento em ${year}`} description="Converta uma planilha preenchida para incluir os lançamentos do livro caixa." />
        ) : (
          <div className="vf-table-wrap" style={{ marginTop: 16 }}>
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Mês</th>
                  <th className="num">Qtd.</th>
                  <th className="num">Rendimentos</th>
                  <th className="num">Deduções</th>
                  <th className="num">IRRF</th>
                  <th className="num" title="Despesas dedutíveis do livro caixa">Dedutíveis (P10)</th>
                  <th className="num" title="Despesas não dedutíveis">Não dedut. (P11)</th>
                  <th className="num" title="Previdência, pensão e imposto">Gerais (P20)</th>
                  <th className="actions"></th>
                </tr>
              </thead>
              <tbody>
                {data.months
                  .filter((m) => m.count)
                  .map((m) => (
                    <tr key={m.month}>
                      <td className="vf-text-sm-bold">{MONTHS[m.month - 1]}</td>
                      <td className="num">{m.count}</td>
                      <td className="num">{formatMoney(m.incomeCents)}</td>
                      <td className="num">{formatMoney(m.deductionCents)}</td>
                      <td className="num">{formatMoney(m.irrfCents)}</td>
                      <td className="num">{formatMoney(m.deductibleCents)}</td>
                      <td className="num">{formatMoney(m.nonDeductibleCents)}</td>
                      <td className="num">{formatMoney(m.generalPaymentsCents)}</td>
                      <td className="actions">
                        <Button kind="tertiary" size="sm" onClick={() => setMonth(m.month)}>
                          Ver
                        </Button>
                        <IconButton label={`Exportar ${MONTHS[m.month - 1]}`} onClick={() => void exportCsv({ month: m.month })}>
                          <Download />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                <tr className="tot">
                  <td>Total</td>
                  <td className="num">{data.totals.count}</td>
                  <td className="num">{formatMoney(data.totals.incomeCents)}</td>
                  <td className="num">{formatMoney(data.totals.deductionCents)}</td>
                  <td className="num">{formatMoney(data.totals.irrfCents)}</td>
                  <td className="num">{formatMoney(data.totals.deductibleCents)}</td>
                  <td className="num">{formatMoney(data.totals.nonDeductibleCents)}</td>
                  <td className="num">{formatMoney(data.totals.generalPaymentsCents)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={Boolean(month)} title={month ? `${MONTHS[month - 1]} de ${year}` : ''} width={980} onClose={() => setMonth(null)}>
        <div className="vf-table-wrap">
          <table className="vf-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Código</th>
                <th>Histórico</th>
                <th>Origem</th>
                <th className="num">Valor</th>
                <th className="actions"></th>
              </tr>
            </thead>
            <tbody>
              {monthEntries.map((e) => (
                <tr key={e.id}>
                  <td>{formatDate(e.entryDate)}</td>
                  <td className="vf-mono">
                    <Tag tone={e.kind === 'income' ? 'success' : 'neutral'}>{e.code}</Tag>
                  </td>
                  <td className="vf-text-sm">{e.description}</td>
                  <td className="vf-text-xs vf-muted">
                    {e.kind === 'income'
                      ? `${e.extra.receivedFrom ?? ''} ${e.counterpartyCpf ? formatCpfCnpj(e.counterpartyCpf) : e.extra.cnpj ? formatCpfCnpj(e.extra.cnpj) : ''}`
                      : e.extra.competence
                        ? `Competência ${e.extra.competence}`
                        : ''}
                  </td>
                  <td className="num">{formatMoney(e.valueCents)}</td>
                  <td className="actions">
                    <IconButton label="Excluir lançamento" onClick={() => void removeEntry(e.id)}>
                      <Trash2 />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>

      <Modal open={Boolean(result)} title="Resultado da conversão" width={860} onClose={() => setResult(null)} footer={<Button onClick={() => setResult(null)}>Fechar</Button>}>
        {result && (
          <div className="vf-stack">
            <div className="vf-inline">
              <Tag>{result.total} linha(s)</Tag>
              <Tag tone="success">{result.succeeded} incluída(s)</Tag>
              {result.failed > 0 && <Tag tone="danger">{result.failed} com erro</Tag>}
            </div>
            <div className="vf-table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Arquivo</th>
                    <th className="num">Linha</th>
                    <th>Situação</th>
                    <th>Mensagem</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r, i) => (
                    <tr key={i}>
                      <td className="vf-text-xs">{r.file}</td>
                      <td className="num">{r.row}</td>
                      <td>{r.ok ? <Tag tone="success">Incluída</Tag> : <Tag tone="danger">Erro</Tag>}</td>
                      <td className="vf-text-sm">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(undo)}
        title="Desfazer envio"
        message="Os lançamentos incluídos por este envio serão removidos. Os demais continuam."
        confirmLabel="Desfazer envio"
        danger
        onConfirm={() => void doUndo()}
        onClose={() => setUndo(null)}
      />
    </div>
  );
}
