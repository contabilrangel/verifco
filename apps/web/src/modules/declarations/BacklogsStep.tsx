import { useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, Mail, MessageCircle, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Alert, Button, Card, Checkbox, ConfirmDialog, EmptyState, IconButton, Input, Loading, Modal, Tag, Textarea } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fieldErrors, useAction, useApi } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { declarationKey, useDeclaration } from './data';
import './declarations.css';

interface Backlog {
  id: string;
  description: string;
  dueDate: string | null;
  resolvedAt: string | null;
  createdAt: string;
  overdue: boolean;
}

/** Etapa "Documentos faltantes": pendências da declaração com prazo e baixa. */
export function BacklogsStep() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { declaration, isLoading, ensure } = useDeclaration(customer.id, year);
  const q = useApi<Backlog[]>(['backlogs', declaration?.id], declaration?.id ? `/declarations/${declaration.id}/backlogs` : null);
  const [edit, setEdit] = useState<Backlog | 'new' | null>(null);
  const [remove, setRemove] = useState<Backlog | null>(null);
  const [send, setSend] = useState<'email' | 'whatsapp' | null>(null);
  const [showResolved, setShowResolved] = useState(true);
  const canEdit = can('declaration.edit');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['backlogs'] });
    void qc.invalidateQueries({ queryKey: declarationKey(customer.id, year) });
    void qc.invalidateQueries({ queryKey: ['customer-dashboard', customer.id] });
    void qc.invalidateQueries({ queryKey: ['kanban'] });
  };
  const toggle = useAction((b: Backlog) => api.put(`/backlogs/${b.id}`, { resolved: !b.resolvedAt }), {
    success: (r: any) => (r.resolvedAt ? 'Pendência baixada.' : 'Pendência reaberta.'),
    onSuccess: refresh,
  });
  const del = useAction((b: Backlog) => api.del(`/backlogs/${b.id}`), { success: 'Pendência excluída.', onSuccess: () => (setRemove(null), refresh()) });
  const doSend = useAction((channel: 'email' | 'whatsapp') => api.post<{ count: number }>(`/declarations/${declaration!.id}/backlogs/send`, { channel }), {
    success: (r) => `Lista com ${r.count} documento(s) enviada.`,
    onSuccess: () => setSend(null),
  });

  if (isLoading || (declaration?.id && q.isLoading)) return <Loading />;
  if (q.error) return <Alert tone="danger">Não foi possível carregar os documentos faltantes.</Alert>;
  const all = q.data ?? [];
  const open = all.filter((b) => !b.resolvedAt);
  const rows = showResolved ? all : open;

  return (
    <>
      <Card
        flush
        title={
          <span className="vf-inline">
            Documentos faltantes
            {open.length > 0 && <Tag tone="warning">{open.length} em aberto</Tag>}
          </span>
        }
        actions={
          <>
            {canEdit && (
              <>
                <Button kind="secondary" icon={<Mail />} disabled={!open.length || !customer.email} title={!customer.email ? 'Cliente sem e-mail' : undefined} onClick={() => setSend('email')}>
                  Enviar por e-mail
                </Button>
                <Button kind="secondary" icon={<MessageCircle />} disabled={!open.length || !customer.mobile} title={!customer.mobile ? 'Cliente sem celular' : undefined} onClick={() => setSend('whatsapp')}>
                  Enviar por WhatsApp
                </Button>
                <Button icon={<Plus />} onClick={() => setEdit('new')}>
                  Novo documento faltante
                </Button>
              </>
            )}
          </>
        }
      >
        {all.length > 0 && (
          <div className="vf-inline vf-between" style={{ padding: '0 24px 12px' }}>
            <span className="vf-muted vf-text-sm">
              {all.length} pendência(s) · {open.length} em aberto
            </span>
            <Checkbox label="Mostrar baixadas" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState
            icon={<ClipboardList />}
            title={all.length ? 'Nenhuma pendência em aberto' : 'Nenhum documento faltante'}
            description="Registre aqui o que o cliente ainda precisa entregar, com data limite. A lista em aberto pode ser enviada por e-mail ou WhatsApp."
            action={canEdit && !all.length && <Button onClick={() => setEdit('new')}>Novo documento faltante</Button>}
          />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Descrição</th>
                  <th>Criação</th>
                  <th>Limite</th>
                  <th>Baixa</th>
                  <th className="actions">Opções</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} style={b.resolvedAt ? { color: 'var(--color-text-low)' } : undefined}>
                    <td style={{ whiteSpace: 'pre-wrap', maxWidth: 480 }}>{b.description}</td>
                    <td>{formatDate(b.createdAt)}</td>
                    <td>
                      <span className="vf-inline" style={{ '--gap': '6px' } as CSSProperties}>
                        {b.dueDate ? formatDate(b.dueDate) : <span className="vf-muted">—</span>}
                        {b.overdue && <Tag tone="danger">Atrasado</Tag>}
                      </span>
                    </td>
                    <td>{b.resolvedAt ? <Tag tone="success">{formatDate(b.resolvedAt)}</Tag> : <Tag>Em aberto</Tag>}</td>
                    <td className="actions">
                      {canEdit && (
                        <>
                          <IconButton label={b.resolvedAt ? 'Reabrir' : 'Dar baixa'} onClick={() => toggle.mutate(b)} disabled={toggle.isPending}>
                            {b.resolvedAt ? <RotateCcw /> : <CheckCircle2 />}
                          </IconButton>
                          <IconButton label="Editar" onClick={() => setEdit(b)}>
                            <Pencil />
                          </IconButton>
                          <IconButton label="Excluir" onClick={() => setRemove(b)}>
                            <Trash2 />
                          </IconButton>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="vf-rule" style={{ marginTop: 12 }}>
        Com a declaração em preenchimento, registrar uma pendência muda o status para “Documentos faltantes”; ao dar baixa na última, ela volta para “Em elaboração”.
      </p>

      {edit && (
        <BacklogModal
          backlog={edit === 'new' ? null : edit}
          ensure={ensure}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(remove)}
        danger
        title="Excluir pendência"
        message={remove ? `Excluir “${remove.description.slice(0, 80)}”?` : ''}
        confirmLabel="Excluir"
        loading={del.isPending}
        onConfirm={() => remove && del.mutate(remove)}
        onClose={() => setRemove(null)}
      />
      <ConfirmDialog
        open={Boolean(send)}
        title={send === 'email' ? 'Enviar por e-mail' : 'Enviar por WhatsApp'}
        message={`A lista com ${open.length} documento(s) em aberto será enviada para ${send === 'email' ? customer.email : 'o celular do cliente'}.`}
        confirmLabel="Enviar"
        loading={doSend.isPending}
        onConfirm={() => send && doSend.mutate(send)}
        onClose={() => setSend(null)}
      />
    </>
  );
}

function BacklogModal({ backlog, ensure, onClose, onDone }: { backlog: Backlog | null; ensure: () => Promise<string>; onClose: () => void; onDone: () => void }) {
  const [description, setDescription] = useState(backlog?.description ?? '');
  const [dueDate, setDueDate] = useState(backlog?.dueDate ?? '');
  const save = useAction(
    async () => {
      const body = { description, dueDate: dueDate || null };
      if (backlog) return api.put(`/backlogs/${backlog.id}`, body);
      const id = await ensure();
      return api.post(`/declarations/${id}/backlogs`, body);
    },
    { success: backlog ? 'Pendência atualizada.' : 'Pendência registrada.', onSuccess: onDone },
  );
  const errors = fieldErrors(save.error);
  return (
    <Modal
      open
      title={backlog ? 'Editar documento faltante' : 'Novo documento faltante'}
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} disabled={description.trim().length < 2} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <Textarea label="Descrição" required autoFocus placeholder="Ex.: informe de rendimentos do Banco X" value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} />
        <Input label="Data limite" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} error={errors.dueDate} style={{ maxWidth: 220 }} />
      </div>
    </Modal>
  );
}
