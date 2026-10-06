import { useRef, useState, type CSSProperties } from 'react';
import { FileText, History, MoreHorizontal, Paperclip, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { CHECKLIST_FILLABLE_SECTIONS, CHECKLIST_ITEM_STATUS, CHECKLIST_SECTIONS, CHECKLIST_SECTION_STATUS, CHECKLIST_UPLOAD_ACCEPT } from '@verifco/shared';
import { Button, Card, ConfirmDialog, IconButton, Input, Menu, MenuItem, Modal, Select, Tag, Textarea, useToast, type Tone } from '../../ds';
import { ApiError, api, isViewableType } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fieldErrors, useAction } from '../../lib/hooks';
import { formatCpfCnpj, formatDateTime } from '../../lib/format';
import { checkFiles, formatBytes } from './customerApi';
import type { ChecklistFile, ChecklistItem, ChecklistSectionView, OfficeChecklistResponse } from './types';

export const sectionTone = (s: string): Tone => (s === 'done' ? 'success' : s === 'pending_documents' ? 'warning' : s === 'no_documents' ? 'neutral' : 'primary');
export const itemTone = (s: string): Tone => (s === 'sent' ? 'success' : s === 'pending' ? 'warning' : 'neutral');
const sectionStatusLabel = (s: string) => CHECKLIST_SECTION_STATUS[s as keyof typeof CHECKLIST_SECTION_STATUS] ?? s;
const itemStatusLabel = (s: string) => CHECKLIST_ITEM_STATUS[s as keyof typeof CHECKLIST_ITEM_STATUS] ?? s;

/** Seções e itens do checklist, para o escritório acompanhar e ajustar. */
export function OfficeSections({ data, queryKey }: { data: OfficeChecklistResponse; queryKey: unknown[] }) {
  const c = data.checklist!;
  const [editing, setEditing] = useState<{ item?: ChecklistItem; section: string } | null>(null);
  return (
    <div className="vf-stack">
      {c.sections.map((s) => (
        <SectionCard key={s.section} checklistId={c.id} section={s} queryKey={queryKey} onEdit={(item) => setEditing({ item, section: s.section })} onAdd={() => setEditing({ section: s.section })} />
      ))}
      {editing && <ItemModal checklistId={c.id} queryKey={queryKey} initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SectionCard({
  checklistId,
  section,
  queryKey,
  onEdit,
  onAdd,
}: {
  checklistId: string;
  section: ChecklistSectionView;
  queryKey: unknown[];
  onEdit: (item: ChecklistItem) => void;
  onAdd: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [removing, setRemoving] = useState<ChecklistItem | null>(null);
  const uploadTarget = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const reopen = useAction(() => api.post(`/checklists/${checklistId}/sections/${section.section}/reopen`), { success: 'Seção reaberta para o cliente.', invalidate: [queryKey] });
  const remove = useAction((id: string) => api.del(`/checklists/${checklistId}/items/${id}`), { success: 'Item removido.', invalidate: [queryKey], onSuccess: () => setRemoving(null) });
  const upload = useAction((v: { itemId: string; files: File[] }) => api.upload(`/checklists/${checklistId}/items/${v.itemId}/files`, v.files), {
    success: 'Arquivo anexado.',
    invalidate: [queryKey],
  });
  const delFile = useAction((id: string) => api.del(`/checklists/${checklistId}/files/${id}`), { success: 'Arquivo excluído.', invalidate: [queryKey] });

  const openFile = (f: ChecklistFile) => {
    const path = `/checklists/${checklistId}/files/${f.id}`;
    const p = isViewableType(f.mimeType) ? api.open(`${path}?inline=1`) : api.download(path, f.filename);
    p.catch((e) => toast.error(e instanceof ApiError ? e.message : 'Não foi possível abrir o arquivo.'));
  };

  const finished = section.status !== 'open';
  return (
    <Card
      flush
      title={
        <span className="vf-inline">
          {section.label}
          <Tag tone={sectionTone(section.status)}>{sectionStatusLabel(section.status)}</Tag>
          <span className="vf-muted vf-text-xs">
            {section.progress.resolved}/{section.progress.total} resolvidos
          </span>
        </span>
      }
      actions={
        <>
          {finished && can('checklist_digital.edit') && (
            <Button kind="tertiary" size="sm" icon={<RotateCcw />} loading={reopen.isPending} onClick={() => reopen.mutate(undefined)}>
              Reabrir seção
            </Button>
          )}
          {can('checklist_digital.edit') && (
            <Button kind="secondary" size="sm" icon={<Plus />} onClick={onAdd}>
              Adicionar item
            </Button>
          )}
        </>
      }
    >
      {(finished || section.note) && (
        <div className="ck-meta" style={{ padding: '0 24px 12px' }}>
          {section.finishedAt && <span>Finalizada pelo cliente em {formatDateTime(section.finishedAt)}</span>}
          {section.note && <span>Recado do cliente: “{section.note}”</span>}
        </div>
      )}
      <div className="vf-table-wrap">
        <table className="vf-table ck-items-table">
          <colgroup>
            <col style={{ width: '42%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '21%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: 56 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Documento</th>
              <th>Situação</th>
              <th>Observação do cliente</th>
              <th>Arquivos</th>
              <th className="actions" aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {section.items.length === 0 && (
              <tr>
                <td colSpan={5} className="vf-muted">
                  Nenhum item nesta seção.
                </td>
              </tr>
            )}
            {section.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <div className="ck-office-item">
                    <span className="vf-text-sm-bold">{item.title}</span>
                    {item.description && <span className="vf-muted vf-text-xs">{item.description}</span>}
                    <span className="vf-inline" style={{ '--gap': '4px', marginTop: 4 } as CSSProperties}>
                      {item.fromPreviousYear && (
                        <Tag icon={<History size={12} />} tone="highlight">
                          Ano anterior
                        </Tag>
                      )}
                      {item.ownerName && <Tag>{item.ownerCpf ? `${item.ownerName} · ${formatCpfCnpj(item.ownerCpf)}` : item.ownerName}</Tag>}
                      {item.createdBy === 'customer' && <Tag tone="primary">Incluído pelo cliente</Tag>}
                    </span>
                  </div>
                </td>
                <td>
                  <Tag tone={itemTone(item.status)}>{itemStatusLabel(item.status)}</Tag>
                </td>
                <td>{item.customerNote ? <span className="vf-text-sm">{item.customerNote}</span> : <span className="vf-muted">—</span>}</td>
                <td>
                  {item.files.length ? (
                    <div className="vf-stack" style={{ '--gap': '4px' } as CSSProperties}>
                      {item.files.map((f) => (
                        <span key={f.id} className="vf-inline" style={{ '--gap': '4px', flexWrap: 'nowrap', minWidth: 0 } as CSSProperties}>
                          {can('checklist_digital.download') ? (
                            <button type="button" className="vf-btn vf-btn--tertiary vf-btn--sm" style={{ minWidth: 0, paddingLeft: 4, paddingRight: 4 }} onClick={() => openFile(f)} title={`${f.filename} · ${formatBytes(f.size)} · ${f.uploadedBy === 'customer' ? 'enviado pelo cliente' : 'enviado pelo escritório'}`}>
                              <Paperclip />
                              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.filename}</span>
                            </button>
                          ) : (
                            <span className="vf-text-xs">{f.filename}</span>
                          )}
                          {can('checklist_digital.upload') && (
                            <IconButton label={`Excluir ${f.filename}`} onClick={() => delFile.mutate(f.id)} style={{ width: 28, height: 28, flexShrink: 0 }}>
                              <Trash2 size={14} />
                            </IconButton>
                          )}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="vf-muted">—</span>
                  )}
                </td>
                <td className="actions">
                  {(can('checklist_digital.edit') || can('checklist_digital.upload')) && (
                    <Menu
                      trigger={(toggle) => (
                        <IconButton label="Ações do item" onClick={toggle}>
                          <MoreHorizontal />
                        </IconButton>
                      )}
                    >
                      {(close) => (
                        <>
                          {can('checklist_digital.edit') && (
                            <MenuItem icon={<Pencil />} onClick={() => (close(), onEdit(item))}>
                              Editar
                            </MenuItem>
                          )}
                          {can('checklist_digital.upload') && (
                            <MenuItem
                              icon={<Upload />}
                              onClick={() => {
                                close();
                                uploadTarget.current = item.id;
                                fileInput.current?.click();
                              }}
                            >
                              Anexar arquivo
                            </MenuItem>
                          )}
                          {can('checklist_digital.edit') && (
                            <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setRemoving(item))}>
                              Remover item
                            </MenuItem>
                          )}
                        </>
                      )}
                    </Menu>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept={CHECKLIST_UPLOAD_ACCEPT}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          const err = checkFiles(files);
          if (err) return toast.error(err);
          if (uploadTarget.current && files.length) upload.mutate({ itemId: uploadTarget.current, files });
        }}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        danger
        title="Remover este item?"
        message={
          <>
            “{removing?.title}” sai do checklist do cliente.
            {removing?.files.length ? ' Os arquivos enviados continuam guardados nos documentos do cliente.' : ''}
          </>
        }
        confirmLabel="Remover"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}

function ItemModal({ checklistId, queryKey, initial, onClose }: { checklistId: string; queryKey: unknown[]; initial: { item?: ChecklistItem; section: string }; onClose: () => void }) {
  const it = initial.item;
  const [form, setForm] = useState({
    section: it?.section ?? initial.section,
    title: it?.title ?? '',
    description: it?.description ?? '',
    ownerName: it?.ownerName ?? '',
    ownerCpf: it?.ownerCpf ? formatCpfCnpj(it.ownerCpf) : '',
    status: it?.status ?? 'pending',
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useAction(() => (it ? api.put(`/checklists/${checklistId}/items/${it.id}`, form) : api.post(`/checklists/${checklistId}/items`, form)), {
    success: it ? 'Item atualizado.' : 'Item adicionado.',
    invalidate: [queryKey],
    onSuccess: onClose,
  });
  const errors = fieldErrors(save.error);
  return (
    <Modal
      open
      title={it ? 'Editar item' : 'Adicionar item'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button icon={<FileText />} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <div className="vf-grid">
          <Select label="Seção" value={form.section} onChange={set('section')} options={CHECKLIST_FILLABLE_SECTIONS.map((s) => ({ value: s, label: CHECKLIST_SECTIONS[s] }))} />
          <Select label="Situação" value={form.status} onChange={set('status')} options={Object.entries(CHECKLIST_ITEM_STATUS).map(([value, label]) => ({ value, label }))} />
        </div>
        <Input label="Documento" required placeholder="Ex.: Informe de rendimentos do banco" value={form.title} onChange={set('title')} error={errors.title} maxLength={200} />
        <Textarea label="Orientação para o cliente" placeholder="Explique o que enviar (opcional)" value={form.description} onChange={set('description')} error={errors.description} maxLength={1000} />
        <div className="vf-grid">
          <Input label="Em nome de (dependente)" placeholder="Vazio = titular" value={form.ownerName} onChange={set('ownerName')} error={errors.ownerName} />
          <Input label="CPF do dependente" value={form.ownerCpf} onChange={set('ownerCpf')} error={errors.ownerCpf} inputMode="numeric" />
        </div>
      </div>
    </Modal>
  );
}
