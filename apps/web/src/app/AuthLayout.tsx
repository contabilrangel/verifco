import type { ReactNode } from 'react';
import './auth.css';

/**
 * Moldura das telas de acesso: painel da marca à esquerda e formulário à direita.
 * Abaixo de 900px o painel vira um cabeçalho compacto com o logo.
 * Usada pelo login do escritório (módulo auth) e pela administração do sistema (módulo platform).
 */
export interface AuthFeature {
  icon: ReactNode;
  title: string;
  text: string;
}

export function AuthLayout({
  variant = 'office',
  badge,
  eyebrow,
  title,
  lead,
  features,
  children,
}: {
  /** "system" identifica a administração do sistema (selo no cabeçalho e acentos próprios). */
  variant?: 'office' | 'system';
  /** Selo ao lado do logo; aparece também no cabeçalho compacto do celular. */
  badge?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
  lead: ReactNode;
  features: AuthFeature[];
  children: ReactNode;
}) {
  return (
    <div className={`auth-page auth-page--${variant}`}>
      <aside className="auth-page__aside">
        <div className="auth-page__brand">
          <img className="auth-page__logo" src="/verifco-logo-negativo.svg" alt="Verifco" />
          {badge && <span className="auth-page__badge">{badge}</span>}
        </div>
        <div className="auth-page__pitch">
          {eyebrow && <p className="auth-page__eyebrow">{eyebrow}</p>}
          <h1 className="auth-page__title">{title}</h1>
          <p className="auth-page__lead">{lead}</p>
          <ul className="auth-page__features">
            {features.map((f) => (
              <li key={f.title}>
                <span className="auth-page__feature-icon" aria-hidden>{f.icon}</span>
                <span>
                  <strong>{f.title}</strong>
                  <span>{f.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <small className="auth-page__legal">© {new Date().getFullYear()} Verifco</small>
      </aside>
      <main className="auth-page__main">
        <div className="auth-page__panel">{children}</div>
      </main>
    </div>
  );
}

/** Título e subtítulo do formulário, com ícone opcional. */
export function AuthHeading({ icon, title, subtitle }: { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode }) {
  return (
    <header className="auth-page__heading">
      {icon && <span className="auth-page__heading-icon" aria-hidden>{icon}</span>}
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
    </header>
  );
}

/** Links secundários no pé do formulário (criar conta, voltar ao login...). */
export function AuthFooter({ children }: { children: ReactNode }) {
  return <div className="auth-page__alt">{children}</div>;
}
