import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { EmptyState } from '../../ds';
import { useAuth } from '../../lib/auth';

/** Mostra a tela só para quem tem ao menos uma das permissões (o servidor também bloqueia). */
export function Guard({ perms, children }: { perms: string[]; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(...perms)) return <EmptyState icon={<Lock />} title="Sem acesso" description="Seu perfil não tem permissão para esta área. Fale com o administrador do escritório." />;
  return <>{children}</>;
}
