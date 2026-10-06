import type { ReactNode } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useParams } from 'react-router';
import { EmptyState, TabBar, cx } from '../ds';
import { useAuth } from '../lib/auth';
import { useYear } from '../lib/year';
import { useCustomer } from '../modules/customers/customerContext';
import type { SubTab } from './modules';
import { PageHeader } from './Shell';

const allowed = (tabs: SubTab[], can: (...p: string[]) => boolean) => tabs.filter((t) => !t.perms?.length || can(...t.perms));

/** Página com abas (Administração, Relatórios). Sem aba na URL, abre a primeira permitida. */
export function TabbedPage({ title, description, base, tabs }: { title: string; description?: ReactNode; base: string; tabs: SubTab[] }) {
  const { can } = useAuth();
  const location = useLocation();
  const visible = allowed(tabs, can);
  const atRoot = location.pathname.replace(/\/$/, '') === base;
  const current = visible.find((t) => location.pathname === `${base}/${t.path}` || location.pathname.startsWith(`${base}/${t.path}/`));
  if (atRoot && visible[0]) return <Navigate to={`${base}/${visible[0].path}`} replace />;
  return (
    <>
      <PageHeader title={title} section={current?.label} description={description} crumbs={[{ label: 'Início', to: '/' }, { label: title }]} />
      <TabBar label={title} activeKey={location.pathname} style={{ marginBottom: 24 }}>
        {visible.map((t) => (
          <NavLink key={t.path} to={`${base}/${t.path}`} className={({ isActive }) => cx('vf-tab', isActive && 'active')}>
            {t.icon && <t.icon />}
            {t.label}
          </NavLink>
        ))}
      </TabBar>
      {visible.length ? <Outlet /> : <EmptyState title="Nada disponível" description="Seu perfil não tem acesso a esta área." />}
    </>
  );
}

/** Aba IRPF do perfil do cliente: etapas (orçamento, declaração, documentação, DARF...). */
export function IrpfTab({ steps }: { steps: SubTab[] }) {
  const { can } = useAuth();
  const { year } = useYear();
  const { customer } = useCustomer();
  const params = useParams();
  const visible = allowed(steps, can);
  const current = params['*']?.split('/')[0] ?? '';
  const step = visible.find((s) => s.path === current);
  if (!step && visible[0]) return <Navigate to={`/clientes/${customer.id}/irpf/${visible[0].path}`} replace />;
  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
      <div className="vf-inline vf-between">
        <nav className="vf-steps" aria-label="Etapas do IRPF">
          {visible.map((s, i) => (
            <NavLink key={s.path} to={`/clientes/${customer.id}/irpf/${s.path}`} className={({ isActive }) => cx('vf-step', isActive && 'active')}>
              <span className="vf-step__n">{i + 1}</span>
              {s.label}
            </NavLink>
          ))}
        </nav>
        <span className="vf-muted">Exercício {year} · ano-calendário {year - 1}</span>
      </div>
      {step ? <step.element /> : <EmptyState title="Nenhuma etapa disponível" />}
    </div>
  );
}
