import type { ReactNode } from 'react';
import { formatPhone } from '../../lib/format';

/** Contato do escritório mostrado no rodapé do portal (`GET /portal/me`). */
export interface OfficeContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
}

/** Link "wa.me" do número de atendimento (só dígitos; número nacional sem código do país ganha o 55). */
export const whatsappLink = (number: string) => {
  const digits = number.replace(/\D+/g, '');
  return `https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}`;
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((p) => p.length > 2 || /^[A-Z]/.test(p))
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || 'V';

/** Moldura das telas do cliente final: marca do escritório no topo, conteúdo centralizado. */
export function PublicFrame({
  officeName,
  subtitle,
  right,
  nav,
  contact,
  children,
}: {
  officeName?: string;
  subtitle: string;
  right?: ReactNode;
  nav?: ReactNode;
  contact?: OfficeContact | null;
  children: ReactNode;
}) {
  const hasContact = Boolean(contact && (contact.email || contact.phone || contact.whatsapp));
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
        {hasContact && contact && (
          <address className="ck-contact" aria-label="Contato do escritório">
            <span className="ck-contact__title">Fale com {contact.name || officeName || 'o escritório'}</span>
            <span className="ck-contact__items">
              {contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
              {contact.phone && <a href={`tel:${contact.phone.replace(/\D+/g, '')}`}>{formatPhone(contact.phone)}</a>}
              {contact.whatsapp && (
                <a href={whatsappLink(contact.whatsapp)} target="_blank" rel="noopener noreferrer">
                  WhatsApp {formatPhone(contact.whatsapp) || contact.whatsapp}
                </a>
              )}
            </span>
          </address>
        )}
        <p className="ck-footer">Ambiente seguro · Verifco</p>
      </main>
    </div>
  );
}
