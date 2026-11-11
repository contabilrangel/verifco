import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Card, EmptyState } from '../ds';
import { useAuth } from '../lib/auth';

/**
 * Aba (de Meu escritório, Relatórios ou do perfil do cliente) que exige ao menos uma das permissões
 * do registro da aba, as mesmas que a API confere. A barra de abas já esconde a aba de quem não
 * pode; quem chega pelo endereço (favorito, link de outra pessoa) vê o estado "sem permissão" de
 * `RequirePermission`, sem repetir o cabeçalho que a página com abas já mostra, em vez de a tela
 * abrir e estourar em erros 403.
 */
export function RequireTabPermission({ perms, label, children }: { perms?: string[]; label: string; children: ReactNode }) {
  const { can } = useAuth();
  if (!perms?.length || can(...perms)) return <>{children}</>;
  return (
    <Card>
      <EmptyState
        icon={<Lock />}
        title="Sem permissão para esta página"
        description={`Sua função não dá acesso a ${label}. Peça a quem administra o escritório para incluir a permissão na sua função.`}
      />
    </Card>
  );
}
