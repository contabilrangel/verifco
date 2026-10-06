/**
 * Componentes do design system Verifco, seguindo os padrões do Tangram
 * (Button, Card, Input, Select, Modal, Drawer, Tabs, Tag, Alert, Toast, EmptyState, DropFile...).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Inbox, UploadCloud, X, XCircle } from 'lucide-react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- Button
type ButtonKind = 'primary' | 'secondary' | 'tertiary' | 'danger' | 'ai';
export function Button({
  kind = 'primary',
  size,
  block,
  loading,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: ButtonKind; size?: 'sm'; block?: boolean; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      className={cx('vf-btn', kind !== 'primary' && `vf-btn--${kind}`, size && `vf-btn--${size}`, block && 'vf-btn--block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="vf-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, dot, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; dot?: boolean }) {
  return (
    <button type="button" className={cx('vf-icon-btn', className)} aria-label={label} title={label} {...rest}>
      {children}
      {dot && <span className="vf-dot" />}
    </button>
  );
}

// ---------------------------------------------------------------- Card
export function Card({
  title,
  actions,
  children,
  flush,
  elevated,
  className,
  style,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  elevated?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={cx('vf-card', flush && 'vf-card--flush', elevated && 'vf-card--elevated', className)} style={style}>
      {(title || actions) && (
        <header className="vf-card__header" style={flush ? { padding: '20px 24px 0' } : undefined}>
          {title && <h2 className="vf-card__title">{title}</h2>}
          {actions && <div className="vf-inline">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- Form
export function Field({
  label,
  help,
  error,
  required,
  children,
  htmlFor,
  style,
}: {
  label?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
  style?: CSSProperties;
}) {
  return (
    <div className="vf-field" style={style}>
      {label && (
        <label className="vf-field__label" htmlFor={htmlFor}>
          {label}
          {required && <span className="req">*</span>}
        </label>
      )}
      {children}
      {error ? <span className="vf-field__error">{error}</span> : help ? <span className="vf-field__help">{help}</span> : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; help?: ReactNode; error?: ReactNode; icon?: ReactNode; suffix?: ReactNode };
export function Input({ label, help, error, icon, suffix, id, required, style, className, ...rest }: InputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const input = <input id={inputId} className={cx('vf-input', className)} aria-invalid={error ? true : undefined} required={required} {...rest} />;
  const control =
    icon || suffix ? (
      <div className="vf-input-group">
        {icon}
        {input}
        {suffix && <span className="vf-input-group__suffix">{suffix}</span>}
      </div>
    ) : (
      input
    );
  if (!label && !help && !error) return <div style={style}>{control}</div>;
  return (
    <Field label={label} help={help} error={error} required={required} htmlFor={inputId} style={style}>
      {control}
    </Field>
  );
}

export function Textarea({ label, help, error, id, required, style, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; help?: ReactNode; error?: ReactNode }) {
  const auto = useId();
  const tid = id ?? auto;
  return (
    <Field label={label} help={help} error={error} required={required} htmlFor={tid} style={style}>
      <textarea id={tid} className="vf-textarea" aria-invalid={error ? true : undefined} required={required} {...rest} />
    </Field>
  );
}

export type SelectOption = { value: string; label: string };
export function Select({
  label,
  help,
  error,
  options,
  placeholder,
  id,
  required,
  style,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode; help?: ReactNode; error?: ReactNode; options: SelectOption[]; placeholder?: string }) {
  const auto = useId();
  const sid = id ?? auto;
  const select = (
    <select id={sid} className="vf-select" aria-invalid={error ? true : undefined} required={required} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (!label && !help && !error) return <div style={style}>{select}</div>;
  return (
    <Field label={label} help={help} error={error} required={required} htmlFor={sid} style={style}>
      {select}
    </Field>
  );
}

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="vf-check">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

export function Switch({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="vf-switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="vf-switch__track" />
      <span>{label}</span>
    </label>
  );
}

/** Campo monetário: o usuário digita em reais, o valor trafega em centavos. */
export function MoneyInput({
  value,
  onChange,
  ...rest
}: Omit<InputProps, 'value' | 'onChange' | 'type'> & { value: number | null | undefined; onChange: (cents: number) => void }) {
  const fmt = (c: number | null | undefined) =>
    c === null || c === undefined ? '' : (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);
  return (
    <Input
      {...rest}
      inputMode="decimal"
      icon={<span style={{ position: 'absolute', left: 12, color: 'var(--color-text-low)', fontSize: 14 }}>R$</span>}
      value={text}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        setText(fmt(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const digits = e.target.value.replace(/[^\d,]/g, '').replace(',', '.');
        const n = Number(digits);
        if (!Number.isNaN(n)) onChange(Math.round(n * 100));
      }}
    />
  );
}

// ---------------------------------------------------------------- Tag / Alert
export type Tone = 'neutral' | 'primary' | 'success' | 'danger' | 'warning' | 'highlight';
export function Tag({ tone = 'neutral', children, icon }: { tone?: Tone; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={cx('vf-tag', tone !== 'neutral' && `vf-tag--${tone}`)}>
      {icon}
      {children}
    </span>
  );
}

export function Alert({ tone = 'primary', children, title }: { tone?: 'primary' | 'success' | 'danger' | 'warning'; children?: ReactNode; title?: ReactNode }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'danger' ? XCircle : tone === 'warning' ? AlertTriangle : Info;
  return (
    <div className={cx('vf-alert', tone !== 'primary' && `vf-alert--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon />
      <div className="vf-stack" style={{ '--gap': '2px' } as CSSProperties}>
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Overlays
function useEscape(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, active]);
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEscape(onClose, open);
  if (!open) return null;
  return createPortal(
    <div className="vf-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vf-modal" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={{ '--modal-w': width ? `${width}px` : undefined } as CSSProperties}>
        <div className="vf-modal__header">
          <h2 className="vf-modal__title">{title}</h2>
          <IconButton label="Fechar" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className="vf-modal__body">{children}</div>
        {footer && <div className="vf-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEscape(onClose, open);
  if (!open) return null;
  return createPortal(
    <div className="vf-overlay vf-drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="vf-drawer" role="dialog" aria-modal="true" style={{ '--drawer-w': width ? `${width}px` : undefined } as CSSProperties}>
        <div className="vf-modal__header">
          <h2 className="vf-modal__title">{title}</h2>
          <IconButton label="Fechar" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className="vf-modal__body" style={{ flex: 1 }}>
          {children}
        </div>
        {footer && <div className="vf-modal__footer">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}

/** Diálogo de confirmação para ações destrutivas ou que disparam envios. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  danger,
  loading,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button kind={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="vf-muted">{message}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Dropdown menu
export function Menu({ trigger, children, align = 'right' }: { trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  useEscape(() => setOpen(false), open);
  return (
    <div className="vf-menu" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div className={cx('vf-menu__list', align === 'left' && 'vf-menu__list--left')} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger, disabled }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" className={cx('vf-menu__item', danger && 'vf-menu__item--danger')} onClick={onClick} disabled={disabled} style={disabled ? { opacity: 0.45 } : undefined}>
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Tabs
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; icon?: ReactNode }[] }) {
  return (
    <div className="vf-tabs" role="tablist">
      {items.map((it) => (
        <button key={it.value} type="button" role="tab" className="vf-tab" aria-selected={it.value === value} onClick={() => onChange(it.value)}>
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Feedback
export function Spinner({ size = 24 }: { size?: number }) {
  return <span className="vf-spinner" style={{ width: size, height: size }} role="status" aria-label="Carregando" />;
}

export function Loading({ label = 'Carregando...' }: { label?: string }) {
  return (
    <div className="vf-inline" style={{ padding: 32, justifyContent: 'center', color: 'var(--color-text-low)' }}>
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="vf-empty">
      <div className="vf-empty__icon">{icon ?? <Inbox />}</div>
      <div className="vf-empty__title">{title}</div>
      {description && <div style={{ maxWidth: 440 }}>{description}</div>}
      {action}
    </div>
  );
}

export function Avatar({ name, size }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  return (
    <span className="vf-avatar" style={size ? ({ '--size': `${size}px` } as CSSProperties) : undefined} aria-hidden>
      {initials || '?'}
    </span>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'success' | 'danger' }) {
  return (
    <div className="vf-stat">
      <span className="vf-stat__label">{label}</span>
      <span className={cx('vf-stat__value', tone === 'success' && 'vf-success-text', tone === 'danger' && 'vf-danger-text')}>{value}</span>
      {hint && <span className="vf-stat__hint">{hint}</span>}
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="vf-progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Pagination({ page, pages, total, onChange }: { page: number; pages: number; total: number; onChange: (p: number) => void }) {
  return (
    <div className="vf-pagination">
      <span className="vf-muted vf-text-xs">{total.toLocaleString('pt-BR')} registro(s)</span>
      <div className="vf-inline">
        <IconButton label="Página anterior" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeft />
        </IconButton>
        <span className="vf-text-sm">
          {page} de {pages}
        </span>
        <IconButton label="Próxima página" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          <ChevronRight />
        </IconButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- DropFile
export function DropFile({
  onFiles,
  accept,
  multiple,
  title = "Arraste seus arquivos ou clique em 'Selecionar'",
  hint,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  title?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={cx('vf-dropfile', over && 'vf-dropfile--over')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <UploadCloud />
      <Button icon={<UploadCloud />} onClick={() => input.current?.click()} disabled={disabled}>
        Selecionar
      </Button>
      <div>{title}</div>
      {hint && <div className="vf-text-xs vf-muted">{hint}</div>}
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Toast
type ToastItem = { id: number; message: ReactNode; tone: 'neutral' | 'success' | 'danger' };
const ToastCtx = createContext<(message: ReactNode, tone?: ToastItem['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((message: ReactNode, tone: ToastItem['tone'] = 'neutral') => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, message, tone }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="vf-toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('vf-toast', t.tone !== 'neutral' && `vf-toast--${t.tone}`)}>
            {t.tone === 'success' ? <CheckCircle2 /> : t.tone === 'danger' ? <XCircle /> : <Info />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    success: (m: ReactNode) => push(m, 'success'),
    error: (m: ReactNode) => push(m, 'danger'),
    info: (m: ReactNode) => push(m, 'neutral'),
  };
}

export { cx };
