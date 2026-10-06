import { useEffect, useState, type ReactNode } from 'react';
import { EllipsisVertical, Search } from 'lucide-react';
import { IconButton, Input, Menu } from '../../ds';
import { getToken } from '../../lib/api';

export interface OfficeData {
  id: string;
  name: string;
  cpfCnpj: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  logoFileId: string | null;
  settings: OfficeSettings;
}

export interface OfficeSettings {
  restrictCustomersToResponsible: boolean;
  autoSendDarfEmail: boolean;
  notifyMainEmailOnEcacChanges: boolean;
  simplifiedQueryWithoutProcurator: boolean;
  autoGenerateCnd: boolean;
  receiptTwoCopies: boolean;
  receiptShowDetails: boolean;
  authorizationShowDetails: boolean;
  allowAuthorizationWithoutBudget: boolean;
  cashAnalysisSimplifiedDiscount: 'standard' | 'proportional';
  checklistReadOnlyAfterStart: boolean;
  lockChecklistFromSubstatus: string | null;
  highNetWorthBaseCents: number;
  reportTitleColor: string;
  reportSubtitleColor: string;
  reportLineColor: string;
  whatsappServiceNumber: string;
}

export interface RoleRow {
  id: string;
  name: string;
  permissions: string[];
  isSystem: boolean;
  users: number;
}

export interface EmployeeRow {
  id: string;
  name: string;
  email: string;
  roleId: string | null;
  roleName: string | null;
  isOwner: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  invitePending: boolean;
}

export interface ProcuratorRow {
  id: string;
  name: string;
  cpfCnpj: string;
  authType: 'govbr' | 'certificate_local' | 'certificate_cloud';
  userId: string | null;
  certificateExpiresAt: string | null;
  loginStatus: string;
  lastValidatedAt: string | null;
  hasCertificate: boolean;
  customers: number;
}

export const AUTH_TYPES: Record<ProcuratorRow['authType'], string> = {
  govbr: 'Conta gov.br',
  certificate_local: 'Certificado no computador',
  certificate_cloud: 'Certificado A1 na nuvem',
};

/** Busca um arquivo autenticado e devolve uma URL local (para <img>). */
export function useAuthedFileUrl(fileId: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!fileId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    const base = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
    const token = getToken();
    fetch(`${base}/api/files/${fileId}?inline=1`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => !cancelled && setUrl(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);
  return url;
}

/** Busca local em listas pequenas (sem acento e sem diferenciar maiúsculas). */
export const matches = (term: string, ...fields: (string | null | undefined)[]) => {
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  const t = norm(term.trim());
  if (!t) return true;
  const digits = t.replace(/\D/g, '');
  return fields.some((f) => f && (norm(f).includes(t) || (digits.length >= 3 && f.replace(/\D/g, '').includes(digits))));
};

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="adm-toolbar__search">
      <Input aria-label={placeholder} placeholder={placeholder} icon={<Search />} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Menu de ações de uma linha de tabela. */
export function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  return (
    <Menu
      trigger={(toggle) => (
        <IconButton label={label} onClick={toggle}>
          <EllipsisVertical />
        </IconButton>
      )}
    >
      {children}
    </Menu>
  );
}

/** Texto de rótulo + ajuda para Switch/Checkbox. */
export function SettingLabel({ title, help }: { title: ReactNode; help?: ReactNode }) {
  return (
    <span className="adm-setting">
      <span>{title}</span>
      {help && <span className="adm-setting__help">{help}</span>}
    </span>
  );
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
