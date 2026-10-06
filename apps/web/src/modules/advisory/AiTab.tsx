import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Brain, Copy, FileDown, FileText, Gavel, LineChart, RotateCcw, Scale, Search, Sparkles, ThumbsDown, ThumbsUp, Wallet } from 'lucide-react';
import { Alert, Button, Card, EmptyState, IconButton, Input, Loading, Modal, Spinner, Tag, Textarea, cx, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { formatDate, formatDateTime } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { AiBadge, AiNotice, ChatPanel, Markdown, errorMessage, type CustomerDocument } from './ui';

const SPECIALISTS = [
  { path: 'ir', assistant: 'ir', label: 'Especialista em IR', description: 'Rendimentos, deduções, bens, dependentes e carnê-leão.', icon: Scale },
  { path: 'malha-fina', assistant: 'fine_mesh', label: 'Especialista em Malha Fina', description: 'Notificações, pendências e defesa administrativa.', icon: Gavel },
  { path: 'ganho-de-capital', assistant: 'capital_gain', label: 'Especialista em Ganho de Capital', description: 'Alienação de bens, custos, reduções e isenções.', icon: LineChart },
  { path: 'assessor-financeiro', assistant: null, label: 'Assessor Financeiro', description: 'Análise de até 10 documentos financeiros.', icon: Wallet },
] as const;

interface Analysis {
  id: string;
  kind: string;
  documentIds: string[];
  status: 'queued' | 'running' | 'done' | 'failed';
  result: string | null;
  rating: number | null;
  createdAt: string;
}

export function AiTab() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const params = useParams();
  const navigate = useNavigate();
  const current = SPECIALISTS.find((s) => s.path === params['*']?.split('/')[0]) ?? SPECIALISTS[0];

  return (
    <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="vf-assistant-picker" role="tablist" aria-label="Assistentes de IA">
        {SPECIALISTS.map((s) => (
          <button key={s.path} type="button" role="tab" className="vf-assistant" aria-pressed={s.path === current.path} onClick={() => navigate(`/clientes/${customer.id}/ia/${s.path}`)}>
            <span className="vf-assistant__icon">
              <s.icon />
            </span>
            <span className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
              <span className="vf-text-sm-bold">{s.label}</span>
              <span className="vf-text-xs vf-muted">{s.description}</span>
            </span>
          </button>
        ))}
      </div>
      {current.assistant ? (
        <Card className="vf-ai-card" title={<span className="vf-inline">{current.label} <AiBadge /></span>}>
          <ChatPanel
            key={current.assistant}
            customerId={customer.id}
            assistant={current.assistant}
            year={year}
            height={440}
            intro={`O assistente recebe o resumo da declaração de ${year} de ${customer.name}. Anexe informes, notificações ou recibos para análise.`}
            extraActions={current.assistant === 'fine_mesh' ? <DefenseButton customerId={customer.id} year={year} /> : undefined}
          />
        </Card>
      ) : (
        <FinancialAdvisor customerId={customer.id} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Defesa administrativa
function DefenseButton({ customerId, year }: { customerId: string; year: number }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Analysis | null>(null);
  const list = useApi<Analysis[]>(['ai-defenses', customerId], open ? `/customers/${customerId}/ai/analyses?kind=fine_mesh_defense` : null);

  const generate = async () => {
    setBusy(true);
    try {
      const row = await api.post<Analysis>(`/customers/${customerId}/ai/fine_mesh/defense`, { year, notes: notes || undefined });
      setResult(row);
      await qc.invalidateQueries({ queryKey: ['ai-defenses', customerId] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button kind="ai" size="sm" icon={<Gavel />} onClick={() => setOpen(true)}>
        Gerar defesa administrativa
      </Button>
      <Modal
        open={open}
        title={<span className="vf-inline">Defesa administrativa <AiBadge /></span>}
        width={860}
        onClose={() => setOpen(false)}
        footer={
          result ? (
            <>
              <Button kind="secondary" icon={<Copy />} onClick={() => void navigator.clipboard.writeText(result.result ?? '').then(() => toast.success('Minuta copiada.'))}>
                Copiar texto
              </Button>
              <Button kind="secondary" onClick={() => setResult(null)}>
                Nova minuta
              </Button>
              <Button icon={<FileDown />} onClick={() => void api.download(`/ai/analyses/${result.id}/pdf`, 'minuta-defesa.pdf')}>
                Baixar PDF
              </Button>
            </>
          ) : (
            <>
              <Button kind="secondary" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button kind="ai" icon={<Sparkles />} loading={busy} onClick={() => void generate()}>
                Gerar minuta
              </Button>
            </>
          )
        }
      >
        {result ? (
          <div className="vf-stack">
            <AiNotice>Minuta gerada por IA a partir da conversa. Revise fatos, valores e fundamentação antes de protocolar.</AiNotice>
            <textarea className="vf-textarea" style={{ minHeight: 380, fontFamily: 'inherit' }} readOnly value={result.result ?? ''} aria-label="Minuta da defesa" />
          </div>
        ) : (
          <div className="vf-stack">
            <p className="vf-muted">
              A minuta usa a conversa com o Especialista em Malha Fina e o resumo da declaração. O CPF do cliente não é enviado à IA: ele é preenchido no texto depois da geração.
            </p>
            <Textarea label="Observações para a defesa (opcional)" placeholder="Ex.: número da notificação, despesas glosadas, documentos que serão anexados..." value={notes} onChange={(e) => setNotes(e.target.value)} />
            {busy && (
              <div className="vf-inline vf-muted">
                <Spinner size={18} /> Redigindo a minuta (até 60 segundos)...
              </div>
            )}
            {(list.data ?? []).length > 0 && (
              <>
                <h3 className="vf-text-sm-bold">Minutas anteriores</h3>
                <div className="vf-doc-list">
                  {(list.data ?? []).map((d) => (
                    <div key={d.id} className="vf-doc-row">
                      <FileText size={18} color="var(--color-text-low)" />
                      <span className="vf-grow">Minuta de {formatDateTime(d.createdAt)}</span>
                      <Button kind="tertiary" size="sm" onClick={() => setResult(d)}>
                        Abrir
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- Assessor financeiro
function FinancialAdvisor({ customerId }: { customerId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const docs = useApi<CustomerDocument[]>(['ai-documents', customerId], `/customers/${customerId}/ai/documents`);
  const analyses = useApi<Analysis[]>(['ai-analyses', customerId], `/customers/${customerId}/ai/analyses?kind=financial_advisor`, {
    refetchInterval: undefined,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = analyses.data ?? [];
  const current = list.find((a) => a.id === currentId) ?? list[0] ?? null;
  const running = list.some((a) => a.status === 'queued' || a.status === 'running');

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['ai-analyses', customerId] }), 2500);
    return () => clearInterval(t);
  }, [running, customerId, qc]);

  const generate = async () => {
    setBusy(true);
    try {
      const row = await api.post<Analysis>(`/customers/${customerId}/ai/analyses`, { documentIds: selected });
      setCurrentId(row.id);
      await qc.invalidateQueries({ queryKey: ['ai-analyses', customerId] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const regenerate = async (a: Analysis) => {
    try {
      const row = await api.post<Analysis>(`/ai/analyses/${a.id}/regenerate`);
      setCurrentId(row.id);
      await qc.invalidateQueries({ queryKey: ['ai-analyses', customerId] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const rate = async (a: Analysis, v: 1 | -1) => {
    try {
      await api.put(`/ai/analyses/${a.id}/rating`, { rating: a.rating === v ? null : v });
      await qc.invalidateQueries({ queryKey: ['ai-analyses', customerId] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const filtered = (docs.data ?? []).filter((d) => d.filename.toLowerCase().includes(search.toLowerCase()));
  const docName = (id: string) => (docs.data ?? []).find((d) => d.id === id)?.filename ?? 'documento removido';

  return (
    <div className="vf-split">
      <Card
        title={
          <span className="vf-inline">
            Documentos <Tag>{selected.length}/10</Tag>
          </span>
        }
        actions={
          <Button kind="ai" icon={<Sparkles />} disabled={!selected.length} loading={busy} onClick={() => void generate()}>
            Gerar análise
          </Button>
        }
      >
        <div className="vf-stack">
          <Input placeholder="Pesquisar arquivo..." icon={<Search />} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Pesquisar arquivo" />
          {docs.isLoading ? (
            <Loading />
          ) : !filtered.length ? (
            <EmptyState icon={<FileText />} title="Nenhum documento do cliente" description="Extratos, faturas e informes enviados pelo cliente (checklist ou documentos) aparecem aqui." />
          ) : (
            <div className="vf-doc-list">
              {filtered.map((d) => {
                const on = selected.includes(d.id);
                return (
                  <label key={d.id}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && selected.length >= 10}
                      onChange={() => setSelected((s) => (on ? s.filter((x) => x !== d.id) : [...s, d.id]))}
                    />
                    <FileText size={18} color="var(--color-text-low)" />
                    <span className="vf-grow">
                      <span className="vf-text-sm-bold" style={{ display: 'block', overflowWrap: 'anywhere' }}>
                        {d.filename}
                      </span>
                      <span className="vf-text-xs vf-muted">
                        {d.exerciseYear ? `Exercício ${d.exerciseYear} · ` : ''}
                        {formatDate(d.createdAt)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <AiNotice>Selecione até 10 documentos (PDF, imagem, planilha ou texto). A análise roda em segundo plano.</AiNotice>
        </div>
      </Card>

      <Card className="vf-ai-card" title={<span className="vf-inline">Análise Financeira <AiBadge /></span>}>
        {analyses.isLoading ? (
          <Loading />
        ) : !current ? (
          <EmptyState icon={<Brain />} title="Nenhuma análise ainda" description="Selecione os documentos ao lado e clique em “Gerar análise”." />
        ) : (
          <div className="vf-stack">
            <div className="vf-inline vf-between">
              <span className="vf-text-xs vf-muted" style={{ minWidth: 0 }}>
                {formatDateTime(current.createdAt)}
                {current.documentIds.length > 0 && ` · ${current.documentIds.map(docName).join(', ')}`}
              </span>
              {current.status === 'done' && (
                <span className="vf-inline" style={{ '--gap': '4px' } as React.CSSProperties}>
                  <IconButton label="Análise útil" aria-pressed={current.rating === 1} onClick={() => void rate(current, 1)}>
                    <ThumbsUp />
                  </IconButton>
                  <IconButton label="Análise não ajudou" aria-pressed={current.rating === -1} onClick={() => void rate(current, -1)}>
                    <ThumbsDown />
                  </IconButton>
                  <Button kind="secondary" size="sm" icon={<RotateCcw />} onClick={() => void regenerate(current)}>
                    Gerar novamente
                  </Button>
                  <Button size="sm" icon={<FileDown />} onClick={() => void api.download(`/ai/analyses/${current.id}/pdf`, 'analise-financeira.pdf')}>
                    Gerar PDF
                  </Button>
                </span>
              )}
            </div>
            {current.status === 'queued' || current.status === 'running' ? (
              <div className="vf-inline" style={{ padding: 32, justifyContent: 'center' }}>
                <Spinner />
                <span className="vf-text-md-bold">🧠 Gerando análise...</span>
              </div>
            ) : current.status === 'failed' ? (
              <Alert tone="danger" title="Não foi possível gerar a análise">
                {current.result}
              </Alert>
            ) : (
              <Markdown text={current.result ?? ''} />
            )}
            <AiNotice />
            {list.length > 1 && (
              <div className="vf-stack" style={{ '--gap': '6px' } as React.CSSProperties}>
                <span className="vf-text-xs-bold vf-muted">ANÁLISES ANTERIORES</span>
                <div className="vf-inline">
                  {list.map((a) => (
                    <button key={a.id} type="button" className={cx('vf-chip')} style={{ cursor: 'pointer', paddingRight: 8 }} onClick={() => setCurrentId(a.id)}>
                      <span>
                        {formatDateTime(a.createdAt)} {a.id === current.id ? '•' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
