import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Lock, X } from 'lucide-react';
import { formatDate, todayIso } from '@verifco/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Resposta de GET /plan/status (qualquer usuário do escritório). */
export interface PlanStatus {
  /** O escritório tem contratos cadastrados (sem nenhum, não há restrição). */
  hasContracts: boolean;
  /** Nenhum contrato vigente: a API recusa as escritas (403) e o escritório só consulta. */
  readOnly: boolean;
  /** Último dia de vigência (AAAA-MM-DD) dos contratos vigentes. */
  validUntil: string | null;
  /** Dias até `validUntil` (0 = vence hoje). */
  daysLeft: number | null;
  /** Dia em que o último contrato venceu (AAAA-MM-DD), quando `readOnly`. */
  lastExpiredAt: string | null;
  supportEmail: string | null;
}

/** A partir de quantos dias do vencimento o aviso aparece. */
export const PLAN_WARNING_DAYS = 15;
const DISMISS_KEY = 'verifco.planBanner.dismissed';

const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
};

const isStatus = (d: unknown): d is PlanStatus => Boolean(d) && typeof d === 'object' && typeof (d as PlanStatus).readOnly === 'boolean';

/**
 * Faixa no topo do conteúdo sobre o contrato do escritório:
 * - vencido: o Verifco está em modo de consulta (não dá para dispensar);
 * - vence em até 15 dias: aviso, que pode ser dispensado até o dia seguinte.
 * Sem a rota no servidor (versão antiga) ou com erro na consulta, não mostra nada.
 */
export function PlanBanner() {
  const { can } = useAuth();
  const [dismissed, setDismissed] = useState(readDismissed);
  const q = useQuery({
    queryKey: ['plan', 'status'],
    queryFn: () => api.get<PlanStatus>('/plan/status'),
    retry: false,
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
  });
  const plan = q.data;
  if (q.isError || !isStatus(plan) || !plan.hasContracts) return null;

  const contracts = can('contracts.view') ? <Link to="/admin/contratos">Ver contratos</Link> : null;
  const support = plan.supportEmail ? <a href={`mailto:${plan.supportEmail}`}>Falar com o suporte</a> : null;

  if (plan.readOnly) {
    return (
      <div className="shell-banner shell-banner--danger" role="alert">
        <Lock aria-hidden />
        <span className="shell-banner__text">
          {plan.lastExpiredAt ? `O contrato do escritório venceu em ${formatDate(plan.lastExpiredAt)}` : 'O contrato do escritório venceu'}: o Verifco está em modo de consulta. Dá para ver e
          exportar os dados, mas não para cadastrar nem alterar.
        </span>
        <span className="shell-banner__actions">
          {contracts}
          {support}
        </span>
      </div>
    );
  }

  const days = plan.daysLeft;
  if (typeof days !== 'number' || days < 0 || days > PLAN_WARNING_DAYS) return null;
  const today = todayIso();
  if (dismissed === today) return null;
  const when = days === 0 ? 'vence hoje' : days === 1 ? 'vence em 1 dia' : `vence em ${days} dias`;
  return (
    <div className="shell-banner shell-banner--warning" role="status">
      <AlertTriangle aria-hidden />
      <span className="shell-banner__text">
        O contrato {when}
        {plan.validUntil ? ` (${formatDate(plan.validUntil)})` : ''}. Depois do vencimento, o Verifco fica em modo de consulta até a renovação.
      </span>
      <span className="shell-banner__actions">
        {contracts}
        {support}
        <button
          type="button"
          className="shell-banner__close"
          aria-label="Dispensar aviso até amanhã"
          title="Dispensar aviso até amanhã"
          onClick={() => {
            try {
              localStorage.setItem(DISMISS_KEY, today);
            } catch {
              /* sem armazenamento: vale só até recarregar */
            }
            setDismissed(today);
          }}
        >
          <X aria-hidden />
        </button>
      </span>
    </div>
  );
}
