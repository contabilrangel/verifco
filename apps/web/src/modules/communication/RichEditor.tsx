import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { Bold, CodeXml, Heading2, Highlighter, ImagePlus, Italic, Link2, List, ListOrdered, Palette, Redo2, RemoveFormatting, Underline, Undo2, Video } from 'lucide-react';
import { Alert, Button, DropFile, Input, Modal, Tabs } from '../../ds';
import { escapeHtml, imageFileToDataUrl, imageHtml, isLinkUrl, isPublicUrl, videoHtml } from './editorMedia';

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
  const [background, setBackground] = useState('#fff3b0');
  const [dialog, setDialog] = useState<null | 'link' | 'image' | 'video'>(null);

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
        <span className="vf-editor__btn vf-editor__color" title="Cor de fundo" aria-disabled={disabled || mode === 'html'}>
          <Highlighter />
          <span className="vf-editor__swatch" style={{ background }} />
          <input
            type="color"
            aria-label="Cor de fundo"
            value={background}
            disabled={disabled || mode === 'html'}
            onChange={(e) => {
              setBackground(e.target.value);
              // hiliteColor pinta só o trecho selecionado; backColor é o nome antigo do mesmo comando
              if (!document.queryCommandSupported?.('hiliteColor')) exec('backColor', e.target.value);
              else exec('hiliteColor', e.target.value);
            }}
          />
        </span>
        <span className="vf-editor__sep" />
        {btn('Inserir imagem', <ImagePlus />, () => setDialog('image'))}
        {btn('Inserir vídeo', <Video />, () => setDialog('video'))}
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
        kind={dialog === 'link' || dialog === 'video' ? dialog : null}
        onClose={() => setDialog(null)}
        onConfirm={(url, text) => {
          setDialog(null);
          if (dialog === 'video') {
            exec('insertHTML', videoHtml(url, text));
            return;
          }
          const hasSelection = saved.current && !saved.current.collapsed;
          if (hasSelection) exec('createLink', url);
          else exec('insertHTML', `<a href="${escapeHtml(url)}">${escapeHtml(text || url)}</a>`);
        }}
      />
      <ImageDialog
        open={dialog === 'image'}
        onClose={() => setDialog(null)}
        onConfirm={(src, alt) => {
          setDialog(null);
          exec('insertHTML', imageHtml(src, alt));
        }}
      />
    </div>
  );
});

function UrlDialog({ kind, onClose, onConfirm }: { kind: null | 'link' | 'video'; onClose: () => void; onConfirm: (url: string, text: string) => void }) {
  const [url, setUrl] = useState('https://');
  const [text, setText] = useState('');
  useEffect(() => {
    if (kind) {
      setUrl('https://');
      setText('');
    }
  }, [kind]);
  const valid = kind === 'video' ? isPublicUrl(url) : isLinkUrl(url);
  return (
    <Modal
      open={kind !== null}
      title={kind === 'video' ? 'Inserir vídeo' : 'Inserir link'}
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
        {kind === 'video' && (
          <Alert>Programas de e-mail não tocam vídeo dentro da mensagem. O vídeo entra como link: vídeos do YouTube aparecem com a miniatura, os demais como um botão “Assistir ao vídeo”.</Alert>
        )}
        <Input
          label={kind === 'video' ? 'Endereço do vídeo' : 'Endereço do link'}
          value={url}
          autoFocus
          onChange={(e) => setUrl(e.target.value)}
          help={kind === 'video' ? 'YouTube, Vimeo, Google Drive ou outro endereço público (https://...).' : 'Aceita https://, mailto: ou uma variável como {{LINK}}.'}
          error={url.length > 8 && !valid ? 'Endereço inválido.' : undefined}
        />
        <Input
          label={kind === 'video' ? 'Título do vídeo' : 'Texto do link'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          help={kind === 'video' ? 'Aparece no link. Sem título, fica “Assistir ao vídeo”.' : 'Se houver texto selecionado no editor, ele vira o link.'}
        />
      </div>
    </Modal>
  );
}

/** Imagem por endereço público ou enviada do computador (no envio, vira anexo inline referenciado por `cid:`). */
function ImageDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (src: string, alt: string) => void }) {
  const [source, setSource] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('https://');
  const [alt, setAlt] = useState('');
  const [embedded, setEmbedded] = useState<{ name: string; data: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (open) {
      setSource('url');
      setUrl('https://');
      setAlt('');
      setEmbedded(null);
      setError(null);
    }
  }, [open]);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      setEmbedded({ name: file.name, data: await imageFileToDataUrl(file) });
      if (!alt) setAlt(file.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      setEmbedded(null);
      setError(e instanceof Error ? e.message : 'Não foi possível ler a imagem.');
    } finally {
      setReading(false);
    }
  };
  const src = source === 'url' ? (isPublicUrl(url) ? url.trim() : null) : (embedded?.data ?? null);
  return (
    <Modal
      open={open}
      title="Inserir imagem"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!src || reading} onClick={() => src && onConfirm(src, alt.trim())}>
            Inserir
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <Tabs
          value={source}
          onChange={setSource}
          items={[
            { value: 'url', label: 'Endereço na internet' },
            { value: 'file', label: 'Enviar do computador' },
          ]}
        />
        {source === 'url' ? (
          <Input
            label="Endereço da imagem"
            value={url}
            autoFocus
            onChange={(e) => setUrl(e.target.value)}
            help="Endereço público da imagem (https://...), por exemplo no site do escritório. Ela precisa abrir sem login para aparecer no e-mail do cliente."
            error={url.length > 8 && !isPublicUrl(url) ? 'Use um endereço completo, começando por https://.' : undefined}
          />
        ) : (
          <>
            <Alert>
              A imagem enviada do computador vai junto com o e-mail, como anexo exibido no corpo da mensagem (reduzida para até 640 px de largura), e aparece no Gmail e no Outlook. Ela
              aumenta o tamanho de cada envio; para logo, banner ou assinatura repetidos em muitos e-mails, o endereço público da imagem deixa a mensagem mais leve.
            </Alert>
            {embedded ? (
              <div className="vf-inline vf-between">
                <img src={embedded.data} alt="" className="vf-editor__thumb" />
                <Button kind="tertiary" size="sm" onClick={() => setEmbedded(null)}>
                  Trocar imagem
                </Button>
              </div>
            ) : (
              <DropFile onFiles={(fs) => void pick(fs[0])} accept="image/png,image/jpeg,image/webp,image/gif" title={reading ? 'Lendo a imagem...' : 'Arraste a imagem ou clique em “Selecionar”'} hint="PNG, JPG, WEBP ou GIF" />
            )}
            {error && <Alert tone="danger">{error}</Alert>}
          </>
        )}
        <Input label="Descrição da imagem" value={alt} onChange={(e) => setAlt(e.target.value)} help="Exibida quando o programa de e-mail bloqueia imagens." />
      </div>
    </Modal>
  );
}
