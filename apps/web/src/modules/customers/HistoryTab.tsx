import { History } from 'lucide-react';
import { Alert, Card, EmptyState, Loading } from '../../ds';
import { useApi } from '../../lib/hooks';
import { actionLabel, auditActor, auditDetail, entityLabel, type AuditRow } from '../../lib/audit';
import { formatDateTime } from '../../lib/format';
import { useCustomer } from './customerContext';

/** Histórico do cliente: o que foi feito no cadastro, nas declarações, documentos e cobranças dele. */
export function HistoryTab() {
  const { customer } = useCustomer();
  const events = useApi<AuditRow[]>(['customer-events', customer.id], `/customers/${customer.id}/events`);
  return (
    <Card flush title="Histórico">
      <div style={{ padding: '0 24px 16px' }} className="vf-muted">
        As últimas 300 ações registradas para este cliente, da mais recente para a mais antiga.
      </div>
      {events.isLoading ? (
        <Loading />
      ) : events.isError ? (
        <div style={{ padding: 24 }}>
          <Alert tone="danger">Não foi possível carregar o histórico.</Alert>
        </div>
      ) : !events.data?.length ? (
        <EmptyState icon={<History />} title="Nada registrado ainda" />
      ) : (
        <div className="vf-table-wrap">
          <table className="vf-table">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Quem</th>
                <th>O quê</th>
                <th>Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((r) => (
                <tr key={r.id}>
                  <td className="vf-mono">{formatDateTime(r.createdAt)}</td>
                  <td>{auditActor(r)}</td>
                  <td>
                    <span className="vf-text-sm-bold">{entityLabel(r.entity)}</span> <span className="vf-muted">· {actionLabel(r.action)}</span>
                  </td>
                  <td className="vf-muted">{auditDetail(r) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
