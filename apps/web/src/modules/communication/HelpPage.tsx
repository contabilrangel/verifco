import { useMemo, useState } from 'react';
import { ChevronDown, LifeBuoy, Mail, Search } from 'lucide-react';
import { Card, EmptyState, Input } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { HELP_SECTIONS, SUPPORT } from './help-content';
import './communication.css';

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export function HelpPage() {
  const [search, setSearch] = useState('');
  const sections = useMemo(() => {
    const term = norm(search.trim());
    if (!term) return HELP_SECTIONS;
    return HELP_SECTIONS.map((s) => ({ ...s, faqs: s.faqs.filter((f) => norm(`${f.q} ${f.a}`).includes(term)) })).filter((s) => s.faqs.length);
  }, [search]);

  return (
    <>
      <PageHeader title="Ajuda" description="Perguntas frequentes sobre o Verifco e o contato do suporte." crumbs={[{ label: 'Início', to: '/' }, { label: 'Ajuda' }]} />
      <div className="vf-help-layout">
        <aside className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
          <nav className="vf-help-nav" aria-label="Áreas">
            {HELP_SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                {s.title}
              </a>
            ))}
          </nav>
        </aside>
        <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
          <Input aria-label="Buscar na ajuda" placeholder="Buscar uma dúvida (ex.: mala direta, malha fina, procuração)" icon={<Search />} value={search} onChange={(e) => setSearch(e.target.value)} />
          {sections.length === 0 ? (
            <Card>
              <EmptyState icon={<Search />} title="Nada encontrado" description={`Tente outras palavras ou fale com o suporte pelo e-mail ${SUPPORT.email}.`} />
            </Card>
          ) : (
            sections.map((s) => (
              <Card key={s.id} title={<span id={s.id}>{s.title}</span>}>
                {s.faqs.map((f) => (
                  <details key={f.q} className="vf-faq" open={Boolean(search.trim())}>
                    <summary>
                      {f.q}
                      <ChevronDown />
                    </summary>
                    <p>{f.a}</p>
                  </details>
                ))}
              </Card>
            ))
          )}
          <Card>
            <div className="vf-inline" style={{ '--gap': '16px', alignItems: 'flex-start' } as React.CSSProperties}>
              <span className="vf-choice__icon">
                <LifeBuoy />
              </span>
              <div className="vf-stack vf-grow" style={{ '--gap': '4px' } as React.CSSProperties}>
                <strong>Não encontrou o que precisava?</strong>
                <span className="vf-muted">
                  Escreva para o suporte contando o que tentou fazer e, se possível, o nome do cliente e a tela. {SUPPORT.responseTime}
                </span>
                <span className="vf-text-xs vf-muted">{SUPPORT.hours}</span>
              </div>
              <a className="vf-btn" href={`mailto:${SUPPORT.email}?subject=${encodeURIComponent('Ajuda com o Verifco')}`}>
                <Mail />
                {SUPPORT.email}
              </a>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
