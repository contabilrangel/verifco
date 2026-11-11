import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Compass } from 'lucide-react';
import { Card, EmptyState } from '../ds';

/** Moldura das telas sem o Shell (404 de quem não entrou, erro geral do aplicativo). */
export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="shell-fallback">
      <div className="shell-fallback__box">
        <img className="shell-fallback__logo" src="/verifco-logo.svg" alt="Verifco" />
        {children}
      </div>
    </div>
  );
}

/**
 * Página não encontrada (404), no lugar do antigo redirecionamento silencioso para o início.
 * - `page`: endereço desconhecido dentro do Shell;
 * - `tab`: aba desconhecida de uma página com abas (`backTo`/`backLabel` levam à página);
 * - `public`: endereço desconhecido para quem não entrou (tela inteira, com o logo).
 */
export function NotFound({ variant = 'page', backTo = '/', backLabel = 'Voltar ao início' }: { variant?: 'page' | 'tab' | 'public'; backTo?: string; backLabel?: string }) {
  const location = useLocation();
  const body = (
    <EmptyState
      icon={<Compass />}
      title={<h1 className="vf-text-md-bold">{variant === 'tab' ? 'Aba não encontrada' : 'Página não encontrada'}</h1>}
      description={
        <>
          O endereço <span className="vf-mono" style={{ overflowWrap: 'anywhere' }}>{location.pathname}</span> não existe no Verifco. Confira o link ou o favorito que trouxe você até aqui.
        </>
      }
      action={
        <Link to={backTo} className="vf-btn">
          {backLabel}
        </Link>
      }
    />
  );
  return variant === 'public' ? <PublicFrame>{body}</PublicFrame> : <Card>{body}</Card>;
}
