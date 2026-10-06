import type { ReactNode } from 'react';
import { Link, Navigate } from 'react-router';
import { Compass, Lock } from 'lucide-react';
import { DASHBOARD_PERMISSIONS } from '@verifco/shared';
import { Card, EmptyState } from '../ds';
import { useAuth } from '../lib/auth';
import { firstNavPath } from './nav';
import { PageHeader } from './Shell';

const ASK_ADMIN = 'Peça a quem administra o escritório para incluir a permissão na sua função.';

/** Link para o primeiro destino do menu que o usuário vê (nada, se não vê nenhum). */
function FirstPageLink() {
  const { can } = useAuth();
  const to = firstNavPath(can);
  if (!to) return null;
  return (
    <Link to={to} className="vf-btn vf-btn--secondary">
      Ir para uma página liberada
    </Link>
  );
}

/**
 * Página que exige ao menos uma das permissões (as mesmas que a API confere na rota que ela usa).
 * Sem elas, quem chega pelo endereço (favorito, link antigo) vê "sem permissão" em vez de uma
 * página quebrada por 403.
 */
export function RequirePermission({ perms, title, children }: { perms: string[]; title: string; children: ReactNode }) {
  const { can } = useAuth();
  if (!perms.length || can(...perms)) return <>{children}</>;
  return (
    <>
      <PageHeader title={title} crumbs={[{ label: 'Início', to: '/' }, { label: title }]} />
      <Card>
        <EmptyState icon={<Lock />} title="Sem permissão para esta página" description={`Sua função não dá acesso a ${title}. ${ASK_ADMIN}`} action={<FirstPageLink />} />
      </Card>
    </>
  );
}

/**
 * Página inicial ("/", para onde o login e os endereços desconhecidos levam): o dashboard para quem
 * pode abri-lo; os demais vão ao primeiro destino do menu que veem. Quem não vê nenhum recebe um
 * aviso (sem redirecionar, para não entrar em laço).
 */
export function HomeRoute({ children }: { children: ReactNode }) {
  const { can } = useAuth();
  if (can(...DASHBOARD_PERMISSIONS)) return <>{children}</>;
  const to = firstNavPath(can);
  if (to && to !== '/') return <Navigate to={to} replace />;
  return (
    <Card>
      <EmptyState
        icon={<Compass />}
        title="Nenhuma área liberada para você"
        description={`Sua função ainda não dá acesso a nenhuma página do Verifco. ${ASK_ADMIN}`}
      />
    </Card>
  );
}
