import { useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, ChevronDown, Clock, FileText, History, MessageSquareText, Paperclip, PartyPopper, Plus, RotateCcw, Trash2, Undo2, Upload, X } from 'lucide-react';
import { CHECKLIST_FINISH_OPTIONS, CHECKLIST_ITEM_STATUS_CUSTOMER, CHECKLIST_UPLOAD_ACCEPT } from '@verifco/shared';
import { Alert, Button, Card, IconButton, Input, Loading, Modal, Progress, Tag, Textarea, useToast, type Tone } from '../../ds';
import { ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { checkFiles, formatBytes, isViewable, type CustomerClient } from './customerApi';
import type { ChecklistFile, ChecklistItem, ChecklistSectionView, CustomerChecklistView } from './types';

const SECTION_STATUS_CUSTOMER: Record<string, string> = {
  open: 'Em aberto',
  done: 'Concluída',
  pending_documents: 'Com pendências',
  no_documents: 'Sem documentos',
};
const sectionTone = (s: string): Tone => (s === 'done' ? 'success' : s === 'pending_documents' ? 'warning' : s === 'no_documents' ? 'neutral' : 'primary');
const itemTone = (s: string): Tone => (s === 'sent' ? 'success' : s === 'pending' ? 'warning' : 'neutral');
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente de novo.');

/**
 * Checklist na visão do cliente (link do checklist ou portal).
 * Seções em sanfona; em cada item o cliente envia arquivos, marca “não se aplica” e deixa observações.
 */
export function CustomerChecklist({ checklistId, client }: { checklistId: string; client: CustomerClient }) {
  const key = ['customer-checklist', checklistId];
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: key, queryFn: () => client.get<CustomerChecklistView>(`/portal/checklists/${checklistId}`) });
  const [open, setOpen] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<ChecklistSectionView | null>(null);
  const [adding, setAdding] = useState<ChecklistSectionView | null>(null);

  const apply = (view: CustomerChecklistView) => qc.setQueryData(key, view);
  const run = useMutation({
    mutationFn: (fn: () => Promise<CustomerChecklistView>) => fn(),
    onSuccess: apply,
    onError: (e) => toast.error(errMsg(e)),
  });

  if (q.isLoading) return <Loading label="Abrindo seu checklist..." />;
  if (!q.data) return <Alert tone="danger">{errMsg(q.error)}</Alert>;
  const c = q.data;
  const base = `/portal/checklists/${c.id}`;
  const editable = !c.readOnly;
  const current = open ?? c.sections.find((s) => s.status === 'open')?.section ?? null;

  const actions: ItemActions = {
    busy: run.isPending,
    setStatus: (item, status) => run.mutate(() => client.put(`${base}/items/${item.id}`, { status })),
    saveNote: (item, note) => run.mutateAsync(() => client.put(`${base}/items/${item.id}`, { customerNote: note })),
    upload: (item, files) => {
      const err = checkFiles(files);
      if (err) return toast.error(err);
      run.mutate(() => client.upload(`${base}/items/${item.id}/files`, files), { onSuccess: () => toast.success(files.length > 1 ? 'Arquivos enviados.' : 'Arquivo enviado.') });
    },
    removeFile: (f) => run.mutate(() => client.del(`${base}/files/${f.id}`)),
    removeItem: (item) => run.mutate(() => client.del(`${base}/items/${item.id}`)),
    openFile: (f) => client.open(`${base}/files/${f.id}`, f.filename, isViewable(f.mimeType)).catch((e) => toast.error(errMsg(e))),
  };

  const sectionsDone = c.sections.filter((s) => s.status !== 'open').length;
  const pendingSections = c.sections.filter((s) => s.status === 'pending_documents').length;
  return (
    <div className="vf-stack">
      <Card>
        <div className="vf-stack" style={{ '--gap': '12px' } as CSSProperties}>
          <div>
            <h1 className="ck-hello">Checklist do Imposto de Renda {c.exerciseYear}</h1>
            <p className="vf-muted">
              {c.customerFirstName ? `Olá, ${c.customerFirstName}! ` : ''}
              {c.officeName} precisa destes documentos para preparar sua declaração. Você pode enviar aos poucos: tudo fica salvo.
            </p>
          </div>
          <div className="vf-stack" style={{ '--gap': '6px' } as CSSProperties}>
            <div className="vf-inline vf-between">
              <span className="vf-text-sm-bold">
                {c.progress.resolved} de {c.progress.total} itens resolvidos
              </span>
              <span className="vf-muted vf-text-xs">
                {sectionsDone} de {c.sections.length} seções finalizadas
              </span>
            </div>
            <Progress value={c.progress.percent} />
          </div>
          {c.readOnly && <Alert tone="warning" title="Disponível só para consulta">{c.readOnlyReason}</Alert>}
          {c.finishedAt && (
            <div className="ck-done-banner">
              <PartyPopper />
              <div>
                <strong>Pronto! Você finalizou todas as seções.</strong>
                <div className="vf-muted vf-text-sm">
                  {pendingSections
                    ? `O escritório já foi avisado. Ainda faltam documentos em ${pendingSections} seção(ões): quando tiver, abra a seção e toque em “Enviar o que faltava”.`
                    : 'O escritório já foi avisado. Veja o resumo abaixo.'}
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {c.sections.map((s, i) => (
        <SectionBlock
          key={s.section}
          index={i + 1}
          section={s}
          expanded={current === s.section}
          onToggle={() => setOpen(current === s.section ? '' : s.section)}
          editable={editable}
          actions={actions}
          onFinish={() => setFinishing(s)}
          onAdd={() => setAdding(s)}
          onResume={() => run.mutate(() => client.post(`${base}/sections/${s.section}/reopen`))}
        />
      ))}

      {c.finishedAt && <Summary view={c} />}

      {finishing && (
        <FinishModal
          section={finishing}
          loading={run.isPending}
          onClose={() => setFinishing(null)}
          onConfirm={(status, note) =>
            run.mutate(() => client.post(`${base}/sections/${finishing.section}/finish`, { status, note }), {
              onSuccess: (view) => {
                setFinishing(null);
                toast.success('Seção finalizada. O escritório foi avisado.');
                const next = view.sections.find((x) => x.status === 'open');
                setOpen(next?.section ?? '');
              },
            })
          }
        />
      )}
      {adding && (
        <AddDocumentModal
          section={adding}
          onClose={() => setAdding(null)}
          onCreate={async (title, description, files) => {
            const created = await client.post<{ itemId: string; checklist: CustomerChecklistView }>(`${base}/items`, { section: adding.section, title, description });
            apply(created.checklist);
            if (files.length) apply(await client.upload<CustomerChecklistView>(`${base}/items/${created.itemId}/files`, files));
            setAdding(null);
            toast.success('Documento incluído.');
          }}
        />
      )}
    </div>
  );
}

interface ItemActions {
  busy: boolean;
  setStatus: (item: ChecklistItem, status: ChecklistItem['status']) => void;
  saveNote: (item: ChecklistItem, note: string) => Promise<unknown>;
  upload: (item: ChecklistItem, files: File[]) => void;
  removeFile: (f: ChecklistFile) => void;
  removeItem: (item: ChecklistItem) => void;
  openFile: (f: ChecklistFile) => void;
}

function SectionBlock({
  index,
  section,
  expanded,
  onToggle,
  editable,
  actions,
  onFinish,
  onAdd,
  onResume,
}: {
  index: number;
  section: ChecklistSectionView;
  expanded: boolean;
  onToggle: () => void;
  editable: boolean;
  actions: ItemActions;
  onFinish: () => void;
  onAdd: () => void;
  onResume: () => void;
}) {
  const isOpen = section.status === 'open';
  const canEdit = editable && isOpen;
  const bodyId = `ck-sec-${section.section}`;
  return (
    <section className={`ck-section ${section.status === 'done' ? 'ck-section--done' : ''}`}>
      <button type="button" className="ck-section__head" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <span className={`ck-section__n ${section.status === 'done' || section.status === 'no_documents' ? 'ck-section__n--done' : section.status === 'pending_documents' ? 'ck-section__n--pending' : ''}`}>
          {isOpen ? index : section.status === 'pending_documents' ? <Clock /> : <Check />}
        </span>
        <span className="vf-grow">
          <span className="ck-section__title">{section.label}</span>
          <span className="vf-inline" style={{ '--gap': '6px' } as CSSProperties}>
            <Tag tone={sectionTone(section.status)}>{SECTION_STATUS_CUSTOMER[section.status] ?? section.status}</Tag>
            <span className="vf-muted vf-text-xs">
              {section.progress.resolved} de {section.progress.total}
            </span>
          </span>
        </span>
        <ChevronDown />
      </button>
      {expanded && (
        <div className="ck-section__body" id={bodyId}>
          <p className="vf-muted vf-text-sm">{section.hint}</p>
          {!isOpen && (
            <Alert tone={section.status === 'pending_documents' ? 'warning' : 'success'}>
              {section.status === 'pending_documents' ? 'Você finalizou esta seção com documentos pendentes.' : 'Seção finalizada.'}
              {section.finishedAt ? ` Em ${formatDateTime(section.finishedAt)}.` : ''}
              {section.note ? ` Seu recado: “${section.note}”` : ''}
            </Alert>
          )}
          {section.items.map((item) => (
            <ItemCard key={item.id} item={item} canEdit={canEdit} actions={actions} />
          ))}
          {canEdit && (
            <div className="vf-inline vf-between" style={{ marginTop: 4 }}>
              <Button kind="tertiary" size="sm" icon={<Plus />} onClick={onAdd}>
                Incluir outro documento
              </Button>
              <Button size="sm" icon={<CheckCircle2 />} onClick={onFinish}>
                Finalizar seção
              </Button>
            </div>
          )}
          {editable && section.status === 'pending_documents' && (
            <div>
              <Button kind="secondary" size="sm" icon={<RotateCcw />} loading={actions.busy} onClick={onResume}>
                Enviar o que faltava
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ItemCard({ item, canEdit, actions }: { item: ChecklistItem; canEdit: boolean; actions: ItemActions }) {
  const input = useRef<HTMLInputElement>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(item.customerNote ?? '');
  const resolved = item.status !== 'pending';
  const muted = item.status === 'removed' || item.status === 'not_applicable';
  const hasOwnFiles = item.files.some((f) => f.uploadedBy === 'customer');
  return (
    <div className={`ck-item ${resolved ? 'ck-item--resolved' : ''} ${muted ? 'ck-item--muted' : ''}`}>
      <div className="ck-item__top">
        <div className="vf-stack" style={{ '--gap': '4px', minWidth: 0 } as CSSProperties}>
          <span className="ck-item__title">{item.title}</span>
          {((item.ownerName && item.section !== 'family') || item.fromPreviousYear) && (
            <span className="vf-inline" style={{ '--gap': '4px' } as CSSProperties}>
              {item.ownerName && item.section !== 'family' && <Tag tone="primary">{`Em nome de ${item.ownerName}`}</Tag>}
              {item.fromPreviousYear && (
                <Tag tone="highlight" icon={<History size={12} />}>
                  Do ano passado
                </Tag>
              )}
            </span>
          )}
        </div>
        <Tag tone={itemTone(item.status)}>{CHECKLIST_ITEM_STATUS_CUSTOMER[item.status]}</Tag>
      </div>
      {item.description && !muted && <p className="ck-item__desc">{item.description}</p>}
      {item.files.length > 0 && (
        <div className="ck-files">
          {item.files.map((f) => (
            <span key={f.id} className="ck-file">
              <button type="button" onClick={() => actions.openFile(f)} title={`Abrir ${f.filename}`}>
                <Paperclip />
                <span>{f.filename}</span>
              </button>
              <span className="vf-muted" style={{ fontWeight: 500 }}>
                {f.uploadedBy === 'customer' ? formatBytes(f.size) : 'do escritório'}
              </span>
              {canEdit && f.uploadedBy === 'customer' && (
                <IconButton label={`Excluir ${f.filename}`} onClick={() => actions.removeFile(f)} disabled={actions.busy}>
                  <X />
                </IconButton>
              )}
            </span>
          ))}
        </div>
      )}
      {item.customerNote && !noteOpen && <div className="ck-item__note">Sua observação: {item.customerNote}</div>}
      {canEdit && noteOpen && (
        <div className="vf-stack" style={{ '--gap': '8px' } as CSSProperties}>
          <Textarea aria-label="Observação" placeholder="Escreva aqui algo que o escritório precisa saber" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 72 }} />
          <div className="ck-actions">
            <Button
              size="sm"
              loading={actions.busy}
              onClick={() =>
                actions
                  .saveNote(item, note.trim())
                  .then(() => setNoteOpen(false))
                  .catch(() => undefined)
              }
            >
              Salvar observação
            </Button>
            <Button kind="tertiary" size="sm" onClick={() => (setNote(item.customerNote ?? ''), setNoteOpen(false))}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {canEdit && !noteOpen && (
        <div className="ck-actions">
          {!muted && (
            <Button size="sm" kind={item.status === 'sent' ? 'secondary' : 'primary'} icon={<Upload />} disabled={actions.busy} onClick={() => input.current?.click()}>
              {item.files.length ? 'Enviar mais' : 'Enviar arquivo'}
            </Button>
          )}
          {item.status === 'pending' && (
            <>
              <Button size="sm" kind="secondary" icon={<Check />} disabled={actions.busy} onClick={() => actions.setStatus(item, 'sent')} title="Use se você já entregou este documento de outra forma">
                Já entreguei
              </Button>
              <Button size="sm" kind="tertiary" disabled={actions.busy} onClick={() => actions.setStatus(item, item.fromPreviousYear ? 'removed' : 'not_applicable')}>
                {item.fromPreviousYear ? 'Não tenho mais' : 'Não se aplica'}
              </Button>
            </>
          )}
          {(muted || (item.status === 'sent' && !hasOwnFiles)) && (
            <Button size="sm" kind="tertiary" icon={<Undo2 />} disabled={actions.busy} onClick={() => actions.setStatus(item, 'pending')}>
              Desfazer
            </Button>
          )}
          <Button size="sm" kind="tertiary" icon={<MessageSquareText />} onClick={() => setNoteOpen(true)}>
            {item.customerNote ? 'Editar observação' : 'Observação'}
          </Button>
          {item.createdBy === 'customer' && !item.files.length && (
            <Button size="sm" kind="tertiary" icon={<Trash2 />} disabled={actions.busy} onClick={() => actions.removeItem(item)}>
              Excluir
            </Button>
          )}
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept={CHECKLIST_UPLOAD_ACCEPT}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) actions.upload(item, files);
            }}
          />
        </div>
      )}
    </div>
  );
}

function FinishModal({
  section,
  loading,
  onClose,
  onConfirm,
}: {
  section: ChecklistSectionView;
  loading: boolean;
  onClose: () => void;
  onConfirm: (status: string, note: string) => void;
}) {
  const pending = section.progress.pending;
  const [status, setStatus] = useState<string>(pending ? 'pending_documents' : 'done');
  const [note, setNote] = useState('');
  return (
    <Modal
      open
      title={`Finalizar “${section.label}”`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button icon={<CheckCircle2 />} loading={loading} onClick={() => onConfirm(status, note.trim())}>
            Finalizar seção
          </Button>
        </>
      }
    >
      <div className="vf-stack" role="radiogroup" aria-label="Como ficou esta seção">
        <p className="vf-muted">Como ficou esta seção? O escritório recebe um aviso.</p>
        {CHECKLIST_FINISH_OPTIONS.map((o) => {
          const blocked = o.value === 'done' && pending > 0;
          return (
            <label key={o.value} className="ck-option">
              <input type="radio" name="finish" value={o.value} checked={status === o.value} disabled={blocked} onChange={() => setStatus(o.value)} />
              <span className="vf-stack" style={{ '--gap': '2px' } as CSSProperties}>
                <strong>{o.label}</strong>
                <span className="vf-muted vf-text-sm">{blocked ? `Ainda há ${pending} item(ns) pendente(s). Envie ou marque “Não se aplica” antes.` : o.description}</span>
              </span>
            </label>
          );
        })}
        {status === 'no_documents' && pending > 0 && <p className="vf-text-xs vf-muted">Os itens pendentes desta seção serão marcados como “Não se aplica”.</p>}
        <Textarea label="Recado para o escritório (opcional)" placeholder={status === 'pending_documents' ? 'Ex.: o informe do banco chega semana que vem' : ''} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function AddDocumentModal({ section, onClose, onCreate }: { section: ChecklistSectionView; onClose: () => void; onCreate: (title: string, description: string, files: File[]) => Promise<void> }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (title.trim().length < 2) return toast.error('Diga que documento é este.');
    setSaving(true);
    try {
      await onCreate(title.trim(), description.trim(), files);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      title="Incluir outro documento"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button icon={<Plus />} loading={saving} onClick={() => void submit()}>
            Incluir
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <p className="vf-muted">Na seção “{section.label}”. Use para mandar algo que não está na lista.</p>
        <Input label="Que documento é este?" required placeholder="Ex.: Recibo do dentista" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        <Textarea label="Detalhes (opcional)" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} style={{ minHeight: 72 }} />
        <div className="vf-stack" style={{ '--gap': '8px' } as CSSProperties}>
          <div>
            <Button kind="secondary" size="sm" icon={<Upload />} onClick={() => input.current?.click()}>
              Escolher arquivos
            </Button>
          </div>
          {files.length > 0 && (
            <div className="ck-files">
              {files.map((f) => (
                <span key={f.name + f.size} className="ck-file">
                  <span className="vf-inline" style={{ '--gap': '4px' } as CSSProperties}>
                    <FileText size={14} /> {f.name}
                  </span>
                  <IconButton label={`Tirar ${f.name}`} onClick={() => setFiles((list) => list.filter((x) => x !== f))}>
                    <X />
                  </IconButton>
                </span>
              ))}
            </div>
          )}
          <span className="vf-muted vf-text-xs">PDF, foto ou planilha, até 20 MB cada.</span>
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept={CHECKLIST_UPLOAD_ACCEPT}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = '';
              const err = checkFiles(picked);
              if (err) return toast.error(err);
              setFiles((list) => [...list, ...picked]);
            }}
          />
        </div>
      </div>
    </Modal>
  );
}

function Summary({ view }: { view: CustomerChecklistView }) {
  return (
    <Card title="Resumo">
      <ul className="ck-list ck-summary">
        {view.sections.map((s) => (
          <li key={s.section}>
            <span className="vf-stack" style={{ '--gap': '2px' } as CSSProperties}>
              <span className="vf-text-sm-bold">{s.label}</span>
              <span className="vf-muted vf-text-xs">
                {s.progress.sent} enviado(s) · {s.progress.notApplicable + s.progress.removed} não se aplica · {s.progress.pending} pendente(s)
              </span>
            </span>
            <Tag tone={sectionTone(s.status)}>{SECTION_STATUS_CUSTOMER[s.status] ?? s.status}</Tag>
          </li>
        ))}
      </ul>
    </Card>
  );
}
