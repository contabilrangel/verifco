import { useState } from 'react';
import { History } from 'lucide-react';
import { Card, EmptyState, Input, Loading, Pagination, Select, Alert } from '../../ds';
import { qs } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { AUDIT_ENTITIES, actionLabel, auditActor, auditDetail, entityLabel, type AuditRow } from '../../lib/audit';
import { formatDateTime } from '../../lib/format';
import type { EmployeeRow } from './shared';

interface AuditPage {
  data: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  entities: string[];
}

/** Aba Auditoria: quem fez o quê no escritório, só para consulta. */
export function AuditTab() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ entity: '', userId: '', from: '', to: '' });
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };
  const query = qs({ page, pageSize: 50, entity: filters.entity || undefined, userId: filters.userId || undefined, from: filters.from || undefined, to: filters.to || undefined });
  const list = useApi<AuditPage>(['audit', query], `/audit${query}`);
  const employees = useApi<EmployeeRow[]>(['employees'], '/employees');
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <Card className="adm-card" flush title="Auditoria">
      <div style={{ padding: '0 24px 16px' }} className="vf-muted">
        Registro do que foi feito no Verifco do escritório: quem, quando e o quê. Não pode ser editado nem apagado por aqui.
      </div>
      <div className="adm-toolbar">
        <Select
          aria-label="O que"
          value={filters.entity}
          onChange={set('entity')}
          options={[{ value: '', label: 'Tudo' }, ...(list.data?.entities ?? Object.keys(AUDIT_ENTITIES)).map((e) => ({ value: e, label: entityLabel(e) })).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))]}
        />
        <Select aria-label="Quem" value={filters.userId} onChange={set('userId')} options={[{ value: '', label: 'Todos os colaboradores' }, ...(employees.data ?? []).map((e) => ({ value: e.id, label: e.name }))]} />
        <Input aria-label="De" type="date" value={filters.from} onChange={set('from')} />
        <Input aria-label="Até" type="date" value={filters.to} onChange={set('to')} />
      </div>
      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <div style={{ padding: 24 }}>
          <Alert tone="danger">Não foi possível carregar a auditoria.</Alert>
        </div>
      ) : !list.data?.data.length ? (
        <EmptyState icon={<History />} title="Nenhum registro" description="Nada foi registrado com estes filtros." />
      ) : (
        <>
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
                {list.data.data.map((r) => (
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
          <div style={{ padding: 16 }}>
            <Pagination page={page} pages={pages} total={list.data.total} onChange={setPage} />
          </div>
        </>
      )}
    </Card>
  );
}
