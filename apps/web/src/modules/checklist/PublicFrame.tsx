import type { ReactNode } from 'react';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((p) => p.length > 2 || /^[A-Z]/.test(p))
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || 'V';

/** Moldura das telas do cliente final: marca do escritório no topo, conteúdo centralizado. */
export function PublicFrame({ officeName, subtitle, right, nav, children }: { officeName?: string; subtitle: string; right?: ReactNode; nav?: ReactNode; children: ReactNode }) {
  return (
    <div className="public-page ck-public">
      <header className="public-page__header">
        <div className="ck-brand">
          {officeName ? <span className="ck-brand__mark" aria-hidden>{initials(officeName)}</span> : <img src="/verifco-simbolo.svg" alt="" style={{ height: 32 }} />}
          <div style={{ minWidth: 0 }}>
            <div className="ck-brand__name">{officeName || 'Verifco'}</div>
            <div className="ck-brand__sub">{subtitle}</div>
          </div>
        </div>
        {right}
      </header>
      {nav}
      <main className="public-page__body">
        {children}
        <p className="ck-footer">Ambiente seguro · Verifco</p>
      </main>
    </div>
  );
}
