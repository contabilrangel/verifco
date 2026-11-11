import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageCircle, Paperclip, Send, X } from 'lucide-react';
import { CHECKLIST_UPLOAD_ACCEPT, checklistUploadMime } from '@verifco/shared';
import { Button, Checkbox, EmptyState, Textarea } from '../../ds';
import { formatBytes } from './customerApi';

/** Arquivo de uma mensagem, como a API devolve nas conversas. */
export interface ChatAttachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ChatEntry {
  id: string;
  mine: boolean;
  body: string;
  createdAt: string;
  meta: ReactNode;
  attachments?: ChatAttachment[];
}

/** Limites dos anexos de uma mensagem (os mesmos que a API confere). */
export const CHAT_MAX_FILES = 5;
export const CHAT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_LABEL = 'PDF, imagem (JPG, PNG, HEIC) ou planilha (XLSX, XLS, ODS, CSV)';
export const CHAT_ATTACH_HINT = `Até ${CHAT_MAX_FILES} arquivos de 10 MB cada: ${ACCEPTED_LABEL}.`;

/** Motivo para não anexar o arquivo (tipo, tamanho ou vazio), ou `null` se ele pode ir. */
export function chatFileError(file: File): string | null {
  if (!checklistUploadMime(file.name)) return `“${file.name}” não é aceito. Envie ${ACCEPTED_LABEL}.`;
  if (file.size > CHAT_MAX_FILE_BYTES) return `“${file.name}” passa de 10 MB. Envie um arquivo menor.`;
  if (!file.size) return `“${file.name}” está vazio.`;
  return null;
}

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Hoje';
  if (same(d, yesterday)) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * Conversa no formato de bolhas, agrupada por dia, rolando para a última mensagem.
 * Os anexos de cada mensagem aparecem como links; `onDownload` baixa o arquivo com a sessão de
 * quem está vendo (painel ou portal) e avisa o erro, se houver.
 */
export function ChatThread({ entries, empty, onDownload }: { entries: ChatEntry[]; empty: ReactNode; onDownload?: (entry: ChatEntry, file: ChatAttachment) => Promise<unknown> | void }) {
  const box = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [entries.length]);
  const download = async (entry: ChatEntry, file: ChatAttachment) => {
    setDownloading(`${entry.id}:${file.fileId}`);
    try {
      await onDownload?.(entry, file);
    } catch {
      /* quem baixa já avisa o erro */
    } finally {
      setDownloading(null);
    }
  };
  return (
    <div className="ck-chat-box" ref={box} aria-live="polite">
      {entries.length === 0 ? (
        <EmptyState icon={<MessageCircle />} title="Nenhuma mensagem ainda" description={empty} />
      ) : (
        <div className="vf-chat">
          {entries.map((m, i) => {
            const showDay = i === 0 || new Date(entries[i - 1].createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            return (
              <Fragment key={m.id}>
                {showDay && <span className="ck-chat-day">{dayLabel(m.createdAt)}</span>}
                <div className={`vf-bubble ${m.mine ? 'vf-bubble--me' : 'vf-bubble--other'}`}>
                  {m.body}
                  {m.attachments?.length ? (
                    <ul className="ck-chat-files" aria-label="Anexos">
                      {m.attachments.map((a) => (
                        <li key={a.fileId}>
                          <button
                            type="button"
                            className="ck-chat-file"
                            title={`Baixar ${a.filename}`}
                            aria-label={`Baixar ${a.filename} (${formatBytes(a.size)})`}
                            disabled={!onDownload || downloading === `${m.id}:${a.fileId}`}
                            onClick={() => void download(m, a)}
                          >
                            <Paperclip aria-hidden />
                            <span className="ck-chat-file__name">{a.filename}</span>
                            <span className="ck-chat-file__size">{formatBytes(a.size)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="vf-bubble__meta">{m.meta}</div>
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Caixa para escrever e enviar (Ctrl/⌘ + Enter também envia), com anexos: a pessoa escolhe os
 * arquivos, vê a lista, tira o que não quiser e envia. Mensagem só com anexo vale. Tipo, tamanho e
 * quantidade são conferidos aqui, com o motivo na tela, e de novo na API.
 */
export function Composer({
  onSend,
  sending,
  placeholder = 'Escreva sua mensagem...',
  whatsapp,
}: {
  onSend: (text: string, viaWhatsApp: boolean, files: File[]) => Promise<unknown>;
  sending: boolean;
  placeholder?: string;
  whatsapp?: { available: boolean; hint?: string };
}) {
  const [text, setText] = useState('');
  const [viaWhatsApp, setViaWhatsApp] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const addFiles = (picked: File[]) => {
    if (!picked.length) return;
    const next = [...files];
    let problem: string | null = null;
    for (const f of picked) {
      const reason = chatFileError(f);
      if (reason) problem ??= reason;
      else if (next.length >= CHAT_MAX_FILES) problem ??= `Cada mensagem leva no máximo ${CHAT_MAX_FILES} arquivos. “${f.name}” ficou de fora.`;
      else next.push(f);
    }
    setFiles(next);
    setError(problem);
  };
  const removeFile = (index: number) => {
    setFiles((list) => list.filter((_, i) => i !== index));
    setError(null);
  };

  const submit = async () => {
    const t = text.trim();
    if ((!t && !files.length) || sending) return;
    if (viaWhatsApp && files.length > 1) return setError('Pelo WhatsApp vai um anexo por mensagem. Envie os arquivos um a um ou desmarque o WhatsApp.');
    if (viaWhatsApp && !t) return setError('Para enviar por WhatsApp, escreva a mensagem.');
    setError(null);
    try {
      await onSend(t, viaWhatsApp, files);
      setText('');
      setFiles([]);
    } catch {
      /* o erro já aparece no aviso */
    }
  };
  return (
    <div className="ck-composer">
      <Textarea
        aria-label="Mensagem"
        placeholder={placeholder}
        value={text}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {files.length > 0 && (
        <ul className="ck-composer-files" aria-label="Arquivos para enviar">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="ck-composer-file">
              <Paperclip aria-hidden />
              <span className="ck-composer-file__name">{f.name}</span>
              <span className="vf-muted vf-text-xs">{formatBytes(f.size)}</span>
              <button type="button" className="ck-composer-file__remove" aria-label={`Remover ${f.name}`} title="Remover" disabled={sending} onClick={() => removeFile(i)}>
                <X aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <span className="vf-field__error" role="alert">
          {error}
        </span>
      )}
      <div className="vf-inline vf-between ck-composer-actions">
        <div className="vf-inline">
          <Button kind="secondary" icon={<Paperclip />} title={CHAT_ATTACH_HINT} disabled={sending} onClick={() => picker.current?.click()}>
            Anexar
          </Button>
          <input
            ref={picker}
            type="file"
            hidden
            multiple
            accept={CHECKLIST_UPLOAD_ACCEPT}
            aria-label="Anexar arquivos"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          {whatsapp && (
            <span title={whatsapp.available ? undefined : whatsapp.hint}>
              <Checkbox label="Enviar também por WhatsApp" checked={viaWhatsApp} disabled={!whatsapp.available} onChange={(e) => setViaWhatsApp(e.target.checked)} />
            </span>
          )}
        </div>
        <Button icon={<Send />} loading={sending} disabled={!text.trim() && !files.length} onClick={() => void submit()}>
          Enviar
        </Button>
      </div>
    </div>
  );
}
