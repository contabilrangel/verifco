/**
 * Uso do contrato do escritório (Administração > Contratos): validade dos pacotes vigentes e
 * declarações usadas no limite de cada exercício. Os números vêm de `apps/api/src/services/plan.ts`,
 * as mesmas regras que bloqueiam a criação de declarações e as alterações com o contrato vencido.
 */

/**
 * Situação gravada no contrato, definida pelo painel do sistema. Só "active" conta como vigente
 * (e ainda dentro das datas); a grafia "cancelled" é a que está gravada nos contratos existentes.
 */
export const CONTRACT_STATUS = { active: 'Ativo', expired: 'Expirado', cancelled: 'Cancelado' } as const;
export type ContractStatus = keyof typeof CONTRACT_STATUS;
export const CONTRACT_STATUS_KEYS = Object.keys(CONTRACT_STATUS) as [ContractStatus, ...ContractStatus[]];

/** Rótulo da situação do contrato no dia (cancelado, expirado pela situação ou pela data, a iniciar, ativo). */
export function contractSituation(c: { status: string; startsAt: string; expiresAt: string }, today: string): 'cancelled' | 'expired' | 'upcoming' | 'active' {
  if (c.status === 'cancelled') return 'cancelled';
  if (c.status !== 'active' || c.expiresAt < today) return 'expired';
  if (c.startsAt > today) return 'upcoming';
  return 'active';
}

/** Pacote vigente hoje (dia de Brasília). */
export interface ContractUsageContract {
  id: string;
  name: string;
  plan: string;
  year: number;
  declarationLimit: number | null;
  startsAt: string;
  expiresAt: string;
  /** Dias corridos até a expiração (0 = vence hoje). */
  daysLeft: number;
}

/** Declarações do exercício contadas no limite dos pacotes vigentes. */
export interface ContractUsageExercise {
  year: number;
  /** Soma dos limites dos pacotes vigentes do exercício; null = sem limite. */
  limit: number | null;
  used: number;
  remaining: number | null;
  /** Percentual usado (0 a 100); null sem limite. */
  percent: number | null;
}

export interface ContractUsage {
  /** Dia de referência (Brasília). */
  today: string;
  /** O escritório tem algum contrato cadastrado (sem nenhum, não há restrição). */
  hasContracts: boolean;
  /** Tem contrato, mas nenhum vigente: o escritório só consulta. */
  readOnly: boolean;
  active: ContractUsageContract[];
  /** Maior expiração entre os pacotes vigentes. */
  validUntil: string | null;
  daysLeft: number | null;
  /** Última expiração já passada (para explicar o modo só consulta). */
  lastExpiredAt: string | null;
  /** Próximo pacote ativo que ainda não começou. */
  nextStartsAt: string | null;
  /** Exercício corrente e os exercícios dos pacotes vigentes, do mais recente ao mais antigo. */
  exercises: ContractUsageExercise[];
}

/** A partir deste percentual o uso do limite merece atenção. */
export const CONTRACT_NEAR_LIMIT_PERCENT = 80;
/** Com até estes dias para vencer, o escritório é avisado da renovação. */
export const CONTRACT_EXPIRING_DAYS = 15;

export type QuotaLevel = 'unlimited' | 'ok' | 'near' | 'full';

/** Situação do uso de um exercício: sem limite, normal, perto do limite (80%) ou no limite. */
export function quotaLevel(e: Pick<ContractUsageExercise, 'limit' | 'used'>): QuotaLevel {
  if (e.limit === null) return 'unlimited';
  if (e.used >= e.limit) return 'full';
  return e.used * 100 >= e.limit * CONTRACT_NEAR_LIMIT_PERCENT ? 'near' : 'ok';
}
