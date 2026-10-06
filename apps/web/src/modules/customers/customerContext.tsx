import { createContext, useContext } from 'react';

export interface CustomerDetail {
  id: string;
  name: string;
  cpfCnpj: string;
  voterTitle: string | null;
  birthDate: string | null;
  sex: string | null;
  email: string | null;
  mobileCountry: string | null;
  mobile: string | null;
  phoneCountry: string | null;
  phone: string | null;
  status: string;
  responsibleUserId: string | null;
  responsibleName: string | null;
  procuratorId: string | null;
  procurator: { id: string; name: string; cpfCnpj: string } | null;
  notes: string | null;
  address: Record<string, string | undefined>;
  secondaryAddress: Record<string, string | undefined>;
  procurationStatus: string;
  procurationExpiresAt: string | null;
  govbrLevel: string | null;
  ecacMailboxMessages: number;
  cndStatus: string;
  hasEcacCredentials: boolean;
  hasInssPassword: boolean;
  portalEnabled: boolean;
  groups: { id: string; name: string }[];
}

export const CustomerCtx = createContext<{ customer: CustomerDetail; refetch: () => void } | null>(null);

/** Cliente aberto no perfil (disponível para todas as abas). */
export function useCustomer() {
  const v = useContext(CustomerCtx);
  if (!v) throw new Error('useCustomer fora do perfil do cliente');
  return v;
}

