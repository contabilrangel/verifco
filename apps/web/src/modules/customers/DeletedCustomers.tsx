import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Alert, Button, ConfirmDialog, EmptyState, Input, Loading, Modal } from '../../ds';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { formatCpfCnpj, formatDate } from '../../lib/format';

interface DeletedCustomer {
  id: string;
  name: string;
  cpfCnpj: string;
  deletedAt: string;
  /** Quando a rotina diária elimina o cliente em definitivo. */
  purgeAt: string;
}

/**
 * Clientes excluídos: ficam guardados pelo prazo de retenção e podem voltar para a lista. A
 * eliminação definitiva (pedido do titular, LGPD) apaga também documentos, declarações,
 * cobranças e mensagens, e pede o nome digitado para confirmar.
 */
export function DeletedCustomersModal({ onClose }: { onClose: () => void }) {
  const list = useApi<{ retentionDays: number; data: DeletedCustomer[] }>(['customers', 'deleted'], '/customers/deleted');
  const [purging, setPurging] = useState<DeletedCustomer | null>(null);
  const [restoring, setRestoring] = useState<DeletedCustomer | null>(null);
  const [typed, setTyped] = useState('');
  const restore = useAction((c: DeletedCustomer) => api.post(`/customers/${c.id}/restore`), {
    success: 'Cliente restaurado.',
    invalidate: [['customers']],
    onSuccess: () => setRestoring(null),
  });
  const purge = useAction((c: DeletedCustomer) => api.del(`/customers/${c.id}/purge`), {
    success: 'Cliente eliminado em definitivo.',
    invalidate: [['customers']],
    onSuccess: () => {
      setPurging(null);
      setTyped('');
    },
  });
  const days = list.data?.retentionDays ?? 90;

  return (
    <Modal open title="Clientes excluídos" onClose={onClose} width={760} footer={<Button onClick={onClose}>Fechar</Button>}>
      <div className="vf-stack">
        <span className="vf-muted">
          Um cliente excluído fica guardado por {days} dias e pode ser restaurado. Depois desse prazo ele é eliminado em definitivo, com documentos, declarações, cobranças e mensagens.
        </span>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <Alert tone="danger">Não foi possível carregar os clientes excluídos.</Alert>
        ) : !list.data?.data.length ? (
          <EmptyState icon={<Trash2 />} title="Nenhum cliente excluído" />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Excluído em</th>
                  <th>Eliminação definitiva</th>
                  <th className="actions">Opções</th>
                </tr>
              </thead>
              <tbody>
                {list.data.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="vf-text-sm-bold">{c.name}</span>
                      <div className="vf-text-xs vf-muted vf-mono">{formatCpfCnpj(c.cpfCnpj)}</div>
                    </td>
                    <td>{formatDate(c.deletedAt)}</td>
                    <td>{formatDate(c.purgeAt)}</td>
                    <td className="actions">
                      <span className="vf-inline" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <Button kind="secondary" size="sm" icon={<RotateCcw />} onClick={() => setRestoring(c)}>
                          Restaurar
                        </Button>
                        <Button kind="tertiary" size="sm" icon={<Trash2 />} onClick={() => setPurging(c)}>
                          Eliminar agora
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(restoring)}
        title="Restaurar cliente"
        message={`${restoring?.name ?? ''} volta para a lista de clientes com tudo o que tinha. Propostas canceladas na exclusão e o acesso ao portal não voltam sozinhos.`}
        confirmLabel="Restaurar"
        loading={restore.isPending}
        onConfirm={() => restoring && restore.mutate(restoring)}
        onClose={() => setRestoring(null)}
      />

      <Modal
        open={Boolean(purging)}
        title="Eliminar em definitivo"
        width={520}
        onClose={() => {
          setPurging(null);
          setTyped('');
        }}
        footer={
          <>
            <Button
              kind="secondary"
              onClick={() => {
                setPurging(null);
                setTyped('');
              }}
            >
              Cancelar
            </Button>
            <Button kind="danger" loading={purge.isPending} disabled={!purging || typed.trim().toLowerCase() !== purging.name.trim().toLowerCase()} onClick={() => purging && purge.mutate(purging)}>
              Eliminar em definitivo
            </Button>
          </>
        }
      >
        {purging && (
          <div className="vf-stack">
            <Alert tone="danger" title="Esta ação não tem volta">
              Serão apagados o cadastro de {purging.name}, as credenciais guardadas, documentos e arquivos, declarações, orçamentos, cobranças, recibos, mensagens e envios. Nem o backup do escritório gerado depois disso terá esses dados.
            </Alert>
            <Input label={`Digite o nome do cliente para confirmar: ${purging.name}`} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </div>
        )}
      </Modal>
    </Modal>
  );
}
