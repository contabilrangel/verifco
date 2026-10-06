import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { Bold, CodeXml, Heading2, ImagePlus, Italic, Link2, List, ListOrdered, Palette, Redo2, RemoveFormatting, Underline, Undo2 } from 'lucide-react';
import { Button, Input, Modal } from '../../ds';

/**
 * Editor de HTML para os templates: `contentEditable` + `document.execCommand`
 * (sem dependência externa) e alternância para editar o HTML direto.
 * O HTML é sanitizado no servidor ao salvar.
 */
export interface RichEditorHandle {
  /** Insere texto (ex.: {{CLIENTE}}) na posição do cursor. */
  insertText: (text: string) => void;
}

type Mode = 'visual' | 'html';

const COMMANDS = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList'] as const;

export const RichEditor = forwardRef<RichEditorHandle, { value: string; onChange: (html: string) => void; label?: string; disabled?: boolean }>(function RichEditor(
  { value, onChange, label = 'Conteúdo do e-mail', disabled },
  ref,
) {
  const area = useRef<HTMLDivElement>(null);
  const html = useRef<HTMLTextAreaElement>(null);
  const last = useRef<string | null>(null);
  const saved = useRef<Range | null>(null);
  const [mode, setMode] = useState<Mode>('visual');
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [color, setColor] = useState('#3468e6');
  const [dialog, setDialog] = useState<null | 'link' | 'image'>(null);

  // mantém o conteúdo editável em sincronia quando o valor muda por fora (carregar, restaurar, modo HTML)
  useEffect(() => {
    if (area.current && value !== last.current) {
      area.current.innerHTML = value;
      last.current = value;
    }
  }, [value, mode]);

  const emit = useCallback(() => {
    if (!area.current) return;
    last.current = area.current.innerHTML;
    onChange(last.current);
  }, [onChange]);

  // guarda a seleção dentro do editor (cliques na barra, cor e diálogos tiram o foco)
  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      if (!sel?.rangeCount || !area.current) return;
      const r = sel.getRangeAt(0);
      if (!area.current.contains(r.commonAncestorContainer)) return;
      saved.current = r.cloneRange();
      const next: Record<string, boolean> = {};
      for (const c of COMMANDS) next[c] = document.queryCommandState(c);
      next.heading = /^h[1-3]$/i.test(String(document.queryCommandValue('formatBlock')));
      setActive(next);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const restore = () => {
    const el = area.current;
    if (!el) return;
    el.focus();
    const sel = document.getSelection();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    } else if (sel) {
      // sem seleção anterior: cursor no fim
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  };

  const exec = (cmd: string, arg?: string) => {
    if (disabled) return;
    restore();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, arg);
    emit();
  };

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      if (disabled) return;
      if (mode === 'html' && html.current) {
        const t = html.current;
        const start = t.selectionStart ?? t.value.length;
        const end = t.selectionEnd ?? start;
        const next = t.value.slice(0, start) + text + t.value.slice(end);
        onChange(next);
        requestAnimationFrame(() => {
          t.focus();
          t.setSelectionRange(start + text.length, start + text.length);
        });
        return;
      }
      exec('insertText', text);
    },
  }));

  const btn = (title: string, icon: ReactNode, onClick: () => void, pressed?: boolean) => (
    <button
      type="button"
      className="vf-editor__btn"
      title={title}
      aria-label={title}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled || mode === 'html'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  return (
    <div className="vf-editor">
      <div className="vf-editor__toolbar" role="toolbar" aria-label="Formatação">
        {btn('Desfazer', <Undo2 />, () => exec('undo'))}
        {btn('Refazer', <Redo2 />, () => exec('redo'))}
        <span className="vf-editor__sep" />
        {btn('Negrito', <Bold />, () => exec('bold'), Boolean(active.bold))}
        {btn('Itálico', <Italic />, () => exec('italic'), Boolean(active.italic))}
        {btn('Sublinhado', <Underline />, () => exec('underline'), Boolean(active.underline))}
        {btn('Título', <Heading2 />, () => exec('formatBlock', active.heading ? 'p' : 'h2'), Boolean(active.heading))}
        <span className="vf-editor__sep" />
        {btn('Lista', <List />, () => exec('insertUnorderedList'), Boolean(active.insertUnorderedList))}
        {btn('Lista numerada', <ListOrdered />, () => exec('insertOrderedList'), Boolean(active.insertOrderedList))}
        <span className="vf-editor__sep" />
        {btn('Inserir link', <Link2 />, () => setDialog('link'))}
        <span className="vf-editor__btn vf-editor__color" title="Cor do texto" aria-disabled={disabled || mode === 'html'}>
          <Palette />
          <span className="vf-editor__swatch" style={{ background: color }} />
          <input
            type="color"
            aria-label="Cor do texto"
            value={color}
            disabled={disabled || mode === 'html'}
            onChange={(e) => {
              setColor(e.target.value);
              exec('foreColor', e.target.value);
            }}
          />
        </span>
        {btn('Inserir imagem por URL', <ImagePlus />, () => setDialog('image'))}
        {btn('Limpar formatação', <RemoveFormatting />, () => exec('removeFormat'))}
        <span className="vf-grow" />
        <button
          type="button"
          className="vf-editor__btn"
          aria-pressed={mode === 'html'}
          disabled={disabled}
          onClick={() => {
            if (mode === 'visual') emit();
            setMode(mode === 'visual' ? 'html' : 'visual');
          }}
          title={mode === 'html' ? 'Voltar ao editor visual' : 'Ver e editar o HTML'}
        >
          <CodeXml />
          HTML
        </button>
      </div>
      <div
        ref={area}
        className="vf-editor__area"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        onInput={emit}
        onBlur={emit}
        style={{ display: mode === 'visual' ? undefined : 'none' }}
      />
      {mode === 'html' && (
        <textarea ref={html} className="vf-editor__html" aria-label={`${label} (HTML)`} spellCheck={false} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      )}
      <UrlDialog
        kind={dialog}
        onClose={() => setDialog(null)}
        onConfirm={(url, text) => {
          setDialog(null);
          const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
          if (dialog === 'image') {
            exec('insertHTML', `<img src="${esc(url)}" alt="${esc(text)}" style="max-width: 100%;" />`);
            return;
          }
          const hasSelection = saved.current && !saved.current.collapsed;
          if (hasSelection) exec('createLink', url);
          else exec('insertHTML', `<a href="${esc(url)}">${esc(text || url)}</a>`);
        }}
      />
    </div>
  );
});

function UrlDialog({ kind, onClose, onConfirm }: { kind: null | 'link' | 'image'; onClose: () => void; onConfirm: (url: string, text: string) => void }) {
  const [url, setUrl] = useState('https://');
  const [text, setText] = useState('');
  useEffect(() => {
    if (kind) {
      setUrl('https://');
      setText('');
    }
  }, [kind]);
  const valid = /^(https?:\/\/[^\s]+|mailto:[^\s]+|\{\{[A-Z0-9_]+\}\})$/.test(url.trim());
  return (
    <Modal
      open={kind !== null}
      title={kind === 'image' ? 'Inserir imagem' : 'Inserir link'}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} onClick={() => onConfirm(url.trim(), text.trim())}>
            Inserir
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <Input
          label={kind === 'image' ? 'Endereço da imagem' : 'Endereço do link'}
          value={url}
          autoFocus
          onChange={(e) => setUrl(e.target.value)}
          help={kind === 'image' ? 'Use uma imagem hospedada (https://...). Ela aparece no e-mail como foi publicada.' : 'Aceita https://, mailto: ou uma variável como {{LINK}}.'}
          error={url.length > 8 && !valid ? 'Endereço inválido.' : undefined}
        />
        <Input
          label={kind === 'image' ? 'Descrição da imagem' : 'Texto do link'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          help={kind === 'image' ? 'Exibida quando o leitor bloqueia imagens.' : 'Se houver texto selecionado no editor, ele vira o link.'}
        />
      </div>
    </Modal>
  );
}
