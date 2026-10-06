import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, FolderOpen, Paperclip, RotateCcw, SendHorizontal, Sparkles, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { Alert, Button, ConfirmDialog, EmptyState, IconButton, Input, Loading, Modal, Spinner, cx, useToast } from '../../ds';
import { ApiError, api, getToken } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { formatDate, formatDateTime } from '../../lib/format';
import './advisory.css';

export const pct = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? '—' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;

export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente novamente.');

/** Selo dos recursos de IA. */
export function AiBadge({ children = 'IA' }: { children?: ReactNode }) {
  return (
    <span className="vf-ai-badge">
      <Sparkles />
      {children}
    </span>
  );
}

/** Aviso curto exigido nas telas de IA. */
export function AiNotice({ children }: { children?: ReactNode }) {
  return (
    <div className="vf-ai-notice" role="note">
      <Sparkles />
      <span>{children ?? 'Conteúdo gerado por inteligência artificial: confira com a legislação e os documentos antes de usar com o cliente.'}</span>
    </div>
  );
}

export function SimulationNotice({ children }: { children?: ReactNode }) {
  return <Alert tone="warning" title="Simulação — confira com a legislação vigente.">{children}</Alert>;
}

export function Kpi({ label, value, hint, strong }: { label: ReactNode; value: ReactNode; hint?: ReactNode; strong?: boolean }) {
  return (
    <div className={cx('vf-kpi', strong && 'vf-kpi--strong')}>
      <span className="vf-kpi__label">{label}</span>
      <span className="vf-kpi__value">{value}</span>
      {hint && <span className="vf-kpi__hint">{hint}</span>}
    </div>
  );
}

/** Baixa um conteúdo gerado no navegador. */
export function downloadText(filename: string, content: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Busca um arquivo autenticado (GET, ou POST com corpo JSON). */
export async function fetchBlob(path: string, body?: unknown): Promise<Blob> {
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
  const token = getToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}/api${path}`, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* sem JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return res.blob();
}

/** Abre a impressão de um PDF sem sair da tela. */
export function printBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  };
  document.body.appendChild(frame);
  setTimeout(() => {
    frame.remove();
    URL.revokeObjectURL(url);
  }, 120_000);
}

// ---------------------------------------------------------------- Markdown seguro
/** Renderiza negrito, itálico, código e links como elementos React (sem HTML bruto). */
function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${n++}`;
    if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      const href = /^https?:\/\//i.test(lm[2]) ? lm[2] : undefined;
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {lm[1]}
          </a>
        ) : (
          lm[1]
        ),
      );
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = h[1].length <= 2 ? 'h3' : 'h4';
      blocks.push(<Tag key={b++}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={b++} className="vf-table-wrap">
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^([-*•])\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      const ordered = /^\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\d+[.)]\s+/ : /^([-*•])\s+/).test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^([-*•]|\d+[.)])\s+/, ''));
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      blocks.push(
        <L key={b++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${b}-${j}`)}</li>
          ))}
        </L>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\||[-*•]\s|\d+[.)]\s)/.test(lines[i].trim())) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={b++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `${b}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="vf-md">{blocks}</div>;
}

// ---------------------------------------------------------------- Documentos do cliente
export interface CustomerDocument {
  id: string;
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  category: string;
  exerciseYear: number | null;
  createdAt: string;
}

/** Seleção de documentos do cliente (checklist e demais envios). */
export function DocumentPicker({
  open,
  customerId,
  max,
  selected,
  onClose,
  onConfirm,
  title = 'Arquivos do checklist',
}: {
  open: boolean;
  customerId: string;
  max: number;
  selected: string[];
  onClose: () => void;
  onConfirm: (docs: CustomerDocument[]) => void;
  title?: string;
}) {
  const docs = useApi<CustomerDocument[]>(['ai-documents', customerId], open ? `/customers/${customerId}/ai/documents` : null);
  const [picked, setPicked] = useState<string[]>(selected);
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (open) setPicked(selected);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = (docs.data ?? []).filter((d) => d.filename.toLowerCase().includes(search.toLowerCase()));
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      width={620}
      footer={
        <>
          <span className="vf-muted vf-text-xs" style={{ marginRight: 'auto' }}>
            {picked.length}/{max} selecionado(s)
          </span>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => onConfirm((docs.data ?? []).filter((d) => picked.includes(d.id)))}>Usar selecionados</Button>
        </>
      }
    >
      <div className="vf-stack">
        <Input placeholder="Pesquisar arquivo..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Pesquisar arquivo" />
        {docs.isLoading ? (
          <Loading />
        ) : !list.length ? (
          <EmptyState icon={<FolderOpen />} title="Nenhum documento" description="Os arquivos enviados pelo cliente no checklist aparecem aqui." />
        ) : (
          <div className="vf-doc-list">
            {list.map((d) => {
              const on = picked.includes(d.id);
              return (
                <label key={d.id}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && picked.length >= max}
                    onChange={() => setPicked((p) => (on ? p.filter((x) => x !== d.id) : [...p, d.id]))}
                  />
                  <FileText size={18} color="var(--color-text-low)" />
                  <span className="vf-grow">
                    <span className="vf-text-sm-bold" style={{ display: 'block', overflowWrap: 'anywhere' }}>
                      {d.filename}
                    </span>
                    <span className="vf-text-xs vf-muted">
                      {d.exerciseYear ? `Exercício ${d.exerciseYear} · ` : ''}
                      {formatDate(d.createdAt)} · {Math.max(1, Math.round(d.size / 1024))} KB
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Chat
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments: { fileId: string; filename: string }[];
  rating: number | null;
  createdAt: string;
}

type Pending = { content: string; attachments: { fileId: string; filename: string }[] };

/**
 * Conversa com um assistente de IA do cliente: histórico persistido, anexos do computador,
 * arquivos do checklist, reinício (arquiva a conversa) e avaliação de cada resposta.
 */
export function ChatPanel({
  customerId,
  assistant,
  year,
  shortcuts = [],
  placeholder = 'Digite sua pergunta...',
  height = 460,
  intro,
  extraActions,
}: {
  customerId: string;
  assistant: string;
  year: number;
  shortcuts?: string[];
  placeholder?: string;
  height?: number;
  intro?: ReactNode;
  extraActions?: ReactNode;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['ai-chat', customerId, assistant];
  const conv = useApi<{ label: string; conversation: { id: string } | null; messages: ChatMessage[] }>(key, `/customers/${customerId}/ai/${assistant}`);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ fileId: string; filename: string }[]>([]);
  const [docs, setDocs] = useState<CustomerDocument[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [picker, setPicker] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const messages = conv.data?.messages ?? [];

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, pending]);

  const attachFromComputer = async (list: File[]) => {
    if (!list.length) return;
    setUploading(true);
    try {
      const saved = await api.upload<{ fileId: string; filename: string }[]>(`/customers/${customerId}/ai/attachments`, list);
      setFiles((f) => [...f, ...saved.map((s) => ({ fileId: s.fileId, filename: s.filename }))]);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const send = async (content: string) => {
    const body = content.trim();
    if (!body || pending) return;
    const att = [...files, ...docs.map((d) => ({ fileId: d.fileId, filename: d.filename }))];
    setPending({ content: body, attachments: att });
    setError(null);
    setText('');
    try {
      await api.post(`/customers/${customerId}/ai/${assistant}/messages`, { content: body, year, attachments: files.map((f) => f.fileId), documentIds: docs.map((d) => d.id) });
      setFiles([]);
      setDocs([]);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setText(body);
      setError(errorMessage(e));
    } finally {
      setPending(null);
    }
  };

  const restart = async () => {
    try {
      await api.post(`/customers/${customerId}/ai/${assistant}/restart`);
      setConfirmRestart(false);
      await qc.invalidateQueries({ queryKey: key });
      toast.success('Conversa reiniciada. A anterior ficou arquivada.');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const rate = async (m: ChatMessage, value: 1 | -1) => {
    try {
      await api.put(`/ai/messages/${m.id}/rating`, { rating: m.rating === value ? null : value });
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const canChecklist = can('customer.download_documents', 'ai.use', 'irpfm.view', 'copilot.use');
  const attachments = [...files.map((f) => ({ id: f.fileId, name: f.filename, kind: 'file' as const })), ...docs.map((d) => ({ id: d.id, name: d.filename, kind: 'doc' as const }))];

  return (
    <div className="vf-stack" style={{ '--gap': '12px' } as React.CSSProperties}>
      <div className="vf-chat-scroll" ref={scroller} style={{ height }} aria-live="polite">
        {conv.isLoading ? (
          <Loading />
        ) : !messages.length && !pending ? (
          <div className="vf-chat-empty">
            <span className="vf-chat-empty__icon">
              <Sparkles />
            </span>
            <strong style={{ color: 'var(--color-text-high)' }}>{conv.data?.label ?? 'Assistente'}</strong>
            <span className="vf-text-sm">{intro ?? 'Pergunte sobre o cliente: o assistente recebe o resumo da declaração do exercício selecionado.'}</span>
          </div>
        ) : (
          <div className="vf-chat">
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="vf-bubble vf-bubble--me">
                  {m.content}
                  {m.attachments.length > 0 && <div className="vf-bubble__meta">📎 {m.attachments.map((a) => a.filename).join(', ')}</div>}
                </div>
              ) : (
                <div key={m.id} className="vf-bubble vf-bubble--ai">
                  <Markdown text={m.content} />
                  <div className="vf-bubble__actions">
                    <AiBadge />
                    <span className="vf-text-xs vf-muted">{formatDateTime(m.createdAt)}</span>
                    <span className="vf-grow" />
                    <IconButton label="Resposta útil" aria-pressed={m.rating === 1} onClick={() => rate(m, 1)}>
                      <ThumbsUp />
                    </IconButton>
                    <IconButton label="Resposta não ajudou" aria-pressed={m.rating === -1} onClick={() => rate(m, -1)}>
                      <ThumbsDown />
                    </IconButton>
                  </div>
                </div>
              ),
            )}
            {pending && (
              <>
                <div className="vf-bubble vf-bubble--me">
                  {pending.content}
                  {pending.attachments.length > 0 && <div className="vf-bubble__meta">📎 {pending.attachments.map((a) => a.filename).join(', ')}</div>}
                </div>
                <div className="vf-bubble vf-bubble--ai vf-inline">
                  <Spinner size={18} />
                  <span className="vf-muted">Analisando... (até 60 segundos)</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {shortcuts.length > 0 && (
        <div className="vf-inline">
          {shortcuts.map((s) => (
            <Button key={s} kind="secondary" size="sm" disabled={Boolean(pending)} onClick={() => void send(s)}>
              {s}
            </Button>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="vf-inline" style={{ '--gap': '6px' } as React.CSSProperties}>
          {attachments.map((a) => (
            <span key={a.id} className="vf-chip">
              {a.kind === 'doc' ? <FolderOpen /> : <Paperclip />}
              <span title={a.name}>{a.name}</span>
              <button
                type="button"
                aria-label={`Remover ${a.name}`}
                onClick={() => (a.kind === 'doc' ? setDocs((d) => d.filter((x) => x.id !== a.id)) : setFiles((f) => f.filter((x) => x.fileId !== a.id)))}
              >
                <X />
              </button>
            </span>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
        className="vf-stack"
        style={{ '--gap': '8px' } as React.CSSProperties}
      >
        <textarea
          className="vf-textarea"
          style={{ minHeight: 72 }}
          placeholder={placeholder}
          aria-label="Mensagem para o assistente"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
          disabled={Boolean(pending)}
        />
        <div className="vf-inline">
          <Button kind="tertiary" size="sm" icon={<Paperclip />} loading={uploading} onClick={() => fileInput.current?.click()}>
            Adicionar arquivos deste computador
          </Button>
          {canChecklist && (
            <Button kind="tertiary" size="sm" icon={<FolderOpen />} onClick={() => setPicker(true)}>
              Arquivos do checklist
            </Button>
          )}
          {extraActions}
          <span className="vf-grow" />
          <Button kind="tertiary" size="sm" icon={<RotateCcw />} disabled={!conv.data?.conversation || Boolean(pending)} onClick={() => setConfirmRestart(true)}>
            Reiniciar conversa
          </Button>
          <Button kind="ai" type="submit" icon={<SendHorizontal />} disabled={!text.trim() || Boolean(pending)}>
            Enviar
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.txt,.xlsx"
          onChange={(e) => {
            void attachFromComputer(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </form>
      <AiNotice />

      <DocumentPicker
        open={picker}
        customerId={customerId}
        max={10}
        selected={docs.map((d) => d.id)}
        onClose={() => setPicker(false)}
        onConfirm={(d) => {
          setDocs(d);
          setPicker(false);
        }}
      />
      <ConfirmDialog
        open={confirmRestart}
        title="Reiniciar conversa"
        message="A conversa atual será arquivada e o assistente começa do zero. Deseja continuar?"
        confirmLabel="Reiniciar"
        onConfirm={() => void restart()}
        onClose={() => setConfirmRestart(false)}
      />
    </div>
  );
}
