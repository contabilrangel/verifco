import {
  BRAZIL_TIME_ZONE,
  CND_STATUS,
  DECLARATION_STAGES,
  DECLARATION_SUBSTATUS,
  PROCURATION_STATUS,
  formatCpfCnpj,
  formatDate,
  formatMoney,
  formatPhone,
  type DeclarationStage,
  type DeclarationSubstatus,
} from '@verifco/shared';
import type { Tone } from '../ds';

export { formatCpfCnpj, formatDate, formatMoney, formatPhone };

/** Data e hora no horário de Brasília (o mesmo fuso dos prazos e dos PDFs). */
export const formatDateTime = (v: string | null | undefined) => (v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: BRAZIL_TIME_ZONE }) : '');

export const stageLabel = (s: string) => DECLARATION_STAGES[s as DeclarationStage] ?? s;
export const substatusLabel = (s: string) => DECLARATION_SUBSTATUS[s as DeclarationSubstatus] ?? s;
export const procurationLabel = (s: string) => PROCURATION_STATUS[s as keyof typeof PROCURATION_STATUS] ?? s;
export const cndLabel = (s: string) => CND_STATUS[s as keyof typeof CND_STATUS] ?? s;

export const stageTone = (s: string): Tone =>
  s === 'finished' ? 'success' : s === 'transmitted' ? 'primary' : s === 'filling' ? 'warning' : s === 'negotiation' ? 'highlight' : 'neutral';

export const procurationTone = (s: string): Tone =>
  s === 'valid' ? 'success' : ['invalid', 'invalid_permissions', 'expired', 'canceled', 'denied'].includes(s) ? 'danger' : s === 'none' ? 'neutral' : 'warning';
