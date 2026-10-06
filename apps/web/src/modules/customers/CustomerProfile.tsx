import { NavLink, Outlet, useParams } from 'react-router';
import { Alert, Loading, Tag, cx } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/hooks';
import { cndLabel, formatCpfCnpj, procurationLabel, procurationTone } from '../../lib/format';
import { CustomerCtx, type CustomerDetail } from './customerContext';
import type { ProfileTab } from '../../app/modules';

export function CustomerProfileLayout({ tabs: allTabs }: { tabs: ProfileTab[] }) {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useApi<CustomerDetail>(['customer', id], `/customers/${id}`);
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Alert tone="danger">Cliente não encontrado.</Alert>;
  const c = q.data;
  const tabs = allTabs.filter((t) => !t.perms?.length || can(...t.perms));
  return (
    <CustomerCtx.Provider value={{ customer: c, refetch: () => void q.refetch() }}>
      <PageHeader
        title={c.name}
        crumbs={[{ label: 'Clientes', to: '/clientes' }, { label: c.name }]}
        description={
          <span className="vf-inline">
            <span className="vf-mono">{formatCpfCnpj(c.cpfCnpj)}</span>
            {c.email && <span>· {c.email}</span>}
            <Tag tone={procurationTone(c.procurationStatus)}>Procuração: {procurationLabel(c.procurationStatus)}</Tag>
            {c.cndStatus !== 'not_requested' && <Tag tone={c.cndStatus === 'success' ? 'success' : 'warning'}>CND: {cndLabel(c.cndStatus)}</Tag>}
            {c.status === 'inactive' && <Tag tone="danger">Inativo</Tag>}
            {c.groups.map((g) => (
              <Tag key={g.id}>{g.name}</Tag>
            ))}
          </span>
        }
      />
      <nav className="vf-tabs" style={{ marginBottom: 24 }} aria-label="Seções do cliente">
        {tabs.map((t) => (
          <NavLink key={t.path} to={t.path} end={t.path === ''} className={({ isActive }) => cx('vf-tab', isActive && 'active')}>
            <t.icon />
            {t.label}
            {t.badge && <span className="vf-tag vf-tag--highlight" style={{ height: 18 }}>{t.badge}</span>}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </CustomerCtx.Provider>
  );
}

