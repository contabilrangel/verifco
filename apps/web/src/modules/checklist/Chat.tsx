import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageCircle, Send } from 'lucide-react';
import { Button, Checkbox, EmptyState, Textarea } from '../../ds';

export interface ChatEntry {
  id: string;
  mine: boolean;
  body: string;
  createdAt: string;
  meta: ReactNode;
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

/** Conversa no formato de bolhas, agrupada por dia, rolando para a última mensagem. */
export function ChatThread({ entries, empty }: { entries: ChatEntry[]; empty: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [entries.length]);
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

/** Caixa de texto para escrever e enviar (Ctrl/⌘ + Enter também envia). */
export function Composer({
  onSend,
  sending,
  placeholder = 'Escreva sua mensagem...',
  whatsapp,
}: {
  onSend: (text: string, viaWhatsApp: boolean) => Promise<unknown>;
  sending: boolean;
  placeholder?: string;
  whatsapp?: { available: boolean; hint?: string };
}) {
  const [text, setText] = useState('');
  const [viaWhatsApp, setViaWhatsApp] = useState(false);
  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    try {
      await onSend(t, viaWhatsApp);
      setText('');
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
      <div className="vf-inline vf-between">
        {whatsapp ? (
          <span title={whatsapp.available ? undefined : whatsapp.hint}>
            <Checkbox label="Enviar também por WhatsApp" checked={viaWhatsApp} disabled={!whatsapp.available} onChange={(e) => setViaWhatsApp(e.target.checked)} />
          </span>
        ) : (
          <span />
        )}
        <Button icon={<Send />} loading={sending} disabled={!text.trim()} onClick={() => void submit()}>
          Enviar
        </Button>
      </div>
    </div>
  );
}
