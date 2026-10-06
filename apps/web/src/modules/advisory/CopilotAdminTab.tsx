import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Compass, MoreVertical, Plus, Search, UserCheck, UserX, Trash2 } from 'lucide-react';
import { Button, Card, ConfirmDialog, EmptyState, IconButton, Input, Loading, Menu, MenuItem, Modal, Progress, Tag, useToast } from '../../ds';
import { api, qs } from '../../lib/api';
import { useApi, useDebounced } from '../../lib/hooks';
import { formatCpfCnpj } from '../../lib/format';
import { errorMessage } from './ui';

interface Enrollment {
  id: string;
  customerId: string;
  name: string;
  cpfCnpj: string;
  email: string | null;
  status: 'active' | 'inactive';
}
interface AdminData {
  limit: number;
  used: number;
  enrollments: Enrollment[];
}

export function CopilotAdminTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useApi<AdminData>(['copilot-admin'], '/copilot/enrollments');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Enrollment | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['copilot-admin'] });
  const setStatus = async (e: Enrollment, status: 'active' | 'inactive') => {
    try {
      await api.put(`/copilot/enrollments/${e.id}`, { status });
      toast.success(status === 'active' ? 'Cliente habilitado.' : 'Cliente desabilitado.');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const remove = async () => {
    if (!removing) return;
    try {
      await api.del(`/copilot/enrollments/${removing.id}`);
      setRemoving(null);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const d = q.data;
  const full = d ? d.used >= d.limit : false;
  return (
    <Card
      flush
      title={
        <span className="vf-inline">
          <Compass size={20} /> Copiloto Financeiro
        </span>
      }
      actions={
        <Button icon={<Plus />} disabled={!d || full} onClick={() => setAdding(true)} title={full ? 'Limite do plano atingido' : undefined}>
          Habilitar cliente
        </Button>
      }
    >
      {q.isLoading || !d ? (
        <Loading />
      ) : (
        <>
          <div className="vf-stack" style={{ padding: '16px 24px', '--gap': '8px' } as React.CSSProperties}>
            <div className="vf-inline vf-between">
              <span className="vf-text-sm">
                Limite do plano: <strong>{d.used}</strong> de <strong>{d.limit}</strong> clientes habilitados
              </span>
              {full && <Tag tone="warning">Limite atingido</Tag>}
            </div>
            <Progress value={(d.used / Math.max(1, d.limit)) * 100} />
            <span className="vf-text-xs vf-muted">O limite vem do contrato vigente do escritório. Clientes desabilitados não contam no limite e mantêm os lançamentos.</span>
          </div>
          {!d.enrollments.length ? (
            <EmptyState icon={<Compass />} title="Nenhum cliente habilitado" description="Habilite clientes para usar o Copiloto Financeiro no perfil de cada um." />
          ) : (
            <div className="vf-table-wrap">
              <table className="vf-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>CPF / CNPJ</th>
                    <th>E-mail</th>
                    <th>Situação</th>
                    <th className="actions">Opções</th>
                  </tr>
                </thead>
                <tbody>
                  {d.enrollments.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <Link to={`/clientes/${e.customerId}/copiloto`} className="vf-text-sm-bold">
                          {e.name}
                        </Link>
                      </td>
                      <td className="vf-mono">{formatCpfCnpj(e.cpfCnpj)}</td>
                      <td>{e.email ?? <span className="vf-muted">—</span>}</td>
                      <td>{e.status === 'active' ? <Tag tone="success">Habilitado</Tag> : <Tag>Desabilitado</Tag>}</td>
                      <td className="actions">
                        <Menu
                          trigger={(t) => (
                            <IconButton label={`Opções de ${e.name}`} onClick={t}>
                              <MoreVertical />
                            </IconButton>
                          )}
                        >
                          {(close) => (
                            <>
                              {e.status === 'active' ? (
                                <MenuItem icon={<UserX />} onClick={() => (close(), void setStatus(e, 'inactive'))}>
                                  Desabilitar
                                </MenuItem>
                              ) : (
                                <MenuItem icon={<UserCheck />} disabled={full} onClick={() => (close(), void setStatus(e, 'active'))}>
                                  Habilitar
                                </MenuItem>
                              )}
                              <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setRemoving(e))}>
                                Remover do plano
                              </MenuItem>
                            </>
                          )}
                        </Menu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {adding && d && <AddCustomerModal enrolled={new Set(d.enrollments.map((e) => e.customerId))} onClose={() => setAdding(false)} onDone={() => void refresh()} />}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remover do plano"
        message={`Remover ${removing?.name} do Copiloto? Os lançamentos ficam guardados e voltam se o cliente for habilitado de novo.`}
        confirmLabel="Remover"
        danger
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}

function AddCustomerModal({ enrolled, onClose, onDone }: { enrolled: Set<string>; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const list = useApi<{ data: { id: string; name: string; cpfCnpj: string; email: string | null }[] }>(['copilot-candidates', debounced], `/customers${qs({ search: debounced, pageSize: 20 })}`);
  const [busy, setBusy] = useState<string | null>(null);
  const enable = async (id: string) => {
    setBusy(id);
    try {
      await api.post('/copilot/enrollments', { customerId: id });
      toast.success('Cliente habilitado no Copiloto.');
      onDone();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open title="Habilitar cliente no Copiloto" onClose={onClose} width={620}>
      <div className="vf-stack">
        <Input autoFocus placeholder="Buscar por nome, CPF ou e-mail" icon={<Search />} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar cliente" />
        {list.isLoading ? (
          <Loading />
        ) : (
          <div className="vf-doc-list">
            {(list.data?.data ?? []).map((c) => (
              <div key={c.id} className="vf-doc-row">
                <span className="vf-grow">
                  <span className="vf-text-sm-bold">{c.name}</span>
                  <span className="vf-text-xs vf-muted"> · {formatCpfCnpj(c.cpfCnpj)}</span>
                </span>
                {enrolled.has(c.id) ? (
                  <Tag>Já no plano</Tag>
                ) : (
                  <Button size="sm" loading={busy === c.id} onClick={() => void enable(c.id)}>
                    Habilitar
                  </Button>
                )}
              </div>
            ))}
            {!list.data?.data.length && <EmptyState title="Nenhum cliente encontrado" />}
          </div>
        )}
      </div>
    </Modal>
  );
}
