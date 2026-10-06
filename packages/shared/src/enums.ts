/** Rótulos e valores de domínio usados no backend e no frontend. */

export type Option<T extends string = string> = { value: T; label: string };

const opts = <T extends string>(o: Record<T, string>): Option<T>[] =>
  (Object.entries(o) as [T, string][]).map(([value, label]) => ({ value, label }));

// ---------------------------------------------------------------------------
// Declaração: etapas do Kanban e subestados
// ---------------------------------------------------------------------------
export const DECLARATION_STAGES = {
  not_started: 'Não iniciado',
  negotiation: 'Negociação - orçamento',
  filling: 'Em preenchimento',
  transmitted: 'Transmitida - status eCAC',
  finished: 'Finalizado',
} as const;
export type DeclarationStage = keyof typeof DECLARATION_STAGES;
export const DECLARATION_STAGE_OPTIONS = opts(DECLARATION_STAGES);

export const DECLARATION_SUBSTATUS = {
  not_started: 'Não iniciado',
  budget_sent: 'Orçamento enviado',
  budget_approved: 'Orçamento aprovado',
  started: 'Iniciado',
  elaboration: 'Em elaboração',
  missing_documents: 'Documentos faltantes',
  review: 'Em revisão',
  ecac_unknown: 'Desconhecido',
  ecac_waiting: 'Aguardando',
  ecac_processing: 'Em processamento',
  ecac_fine_mesh: 'Malha fina',
  ecac_refund: 'Restituição',
  ecac_processed: 'Processada',
  finished: 'Finalizado',
} as const;
export type DeclarationSubstatus = keyof typeof DECLARATION_SUBSTATUS;

export const STAGE_SUBSTATUS: Record<DeclarationStage, DeclarationSubstatus[]> = {
  not_started: ['not_started'],
  negotiation: ['budget_sent', 'budget_approved'],
  filling: ['started', 'elaboration', 'missing_documents', 'review'],
  transmitted: ['ecac_unknown', 'ecac_waiting', 'ecac_processing', 'ecac_fine_mesh', 'ecac_refund', 'ecac_processed'],
  finished: ['finished'],
};

export function stageOfSubstatus(s: DeclarationSubstatus): DeclarationStage {
  for (const [stage, list] of Object.entries(STAGE_SUBSTATUS) as [DeclarationStage, DeclarationSubstatus[]][]) {
    if (list.includes(s)) return stage;
  }
  return 'not_started';
}

/** Situação da declaração processada no eCAC. */
export const ECAC_DECLARATION_STATUS = {
  unknown: 'Desconhecido',
  waiting: 'Aguardando',
  processing: 'Em processamento',
  fine_mesh: 'Malha fina',
  refund_lot: 'Restituição liberada',
  processed: 'Processada',
  pending_issues: 'Com pendências',
} as const;
export type EcacDeclarationStatus = keyof typeof ECAC_DECLARATION_STATUS;

export const TAXATION_TYPES = {
  complete: 'Completa (deduções legais)',
  simplified: 'Simplificada (desconto padrão)',
} as const;

// ---------------------------------------------------------------------------
// Clientes, procurações, CND
// ---------------------------------------------------------------------------
export const PROCURATION_STATUS = {
  none: 'Sem procurador',
  validating: 'Aguardando validação',
  valid: 'Válida',
  invalid: 'Inválida',
  invalid_permissions: 'Inválida sem permissões',
  expired: 'Expirada',
  canceled: 'Cancelada',
  denied: 'Negada',
  pending: 'Pendente',
} as const;
export type ProcurationStatus = keyof typeof PROCURATION_STATUS;

export const CND_STATUS = {
  not_requested: 'Não consultada',
  success: 'Emitida com sucesso',
  invalid_cpf: 'CPF inválido',
  cpf_not_found: 'CPF não encontrado',
  pending_issues: 'Analisar pendências no eCAC',
} as const;
export type CndStatus = keyof typeof CND_STATUS;

export const GOVBR_LEVELS = { bronze: 'Bronze', silver: 'Prata', gold: 'Ouro' } as const;

export const SEX_OPTIONS = opts({ F: 'Feminino', M: 'Masculino', O: 'Outro / não informado' });

// ---------------------------------------------------------------------------
// Financeiro
// ---------------------------------------------------------------------------
export const PAYMENT_METHOD_TYPES = {
  pix: 'Pix',
  boleto: 'Boleto',
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  bank_transfer: 'Transferência',
  cash: 'Dinheiro',
  asaas: 'Cobrança Asaas',
  omie: 'Cobrança Omie',
  other: 'Outro',
} as const;
export type PaymentMethodType = keyof typeof PAYMENT_METHOD_TYPES;
export const PAYMENT_METHOD_TYPE_OPTIONS = opts(PAYMENT_METHOD_TYPES);

export const PRICE_TABLE_TYPES = {
  fixed: 'Fixa',
  hourly: 'Variável por hora',
  items: 'Variável por itens',
  percentage: 'Percentual',
} as const;
export type PriceTableType = keyof typeof PRICE_TABLE_TYPES;
export const PRICE_TABLE_TYPE_OPTIONS = opts(PRICE_TABLE_TYPES);

export const BUDGET_TYPES = {
  fixed: 'Fixo',
  variable: 'Variável (tabela de cobrança)',
  integration: 'Integrado (Asaas/Omie)',
} as const;
export type BudgetType = keyof typeof BUDGET_TYPES;

export const BUDGET_STATUS = {
  draft: 'Rascunho',
  sent: 'Enviado',
  approved: 'Aprovado',
  rejected: 'Recusado',
  canceled: 'Cancelado',
} as const;
export type BudgetStatus = keyof typeof BUDGET_STATUS;

export const BUDGET_CATEGORIES = {
  irpf: 'Declaração IRPF',
  irpf_rectification: 'Retificação IRPF',
  capital_gain: 'Ganho de capital',
  carne_leao: 'Carnê-Leão',
  holding: 'Holding / planejamento patrimonial',
  consulting: 'Consultoria',
  other: 'Outros serviços',
} as const;
export type BudgetCategory = keyof typeof BUDGET_CATEGORIES;

export const INSTALLMENT_STATUS = {
  open: 'Em aberto',
  paid: 'Pago',
  overdue: 'Vencido',
  canceled: 'Cancelado',
} as const;
export type InstallmentStatus = keyof typeof INSTALLMENT_STATUS;

// ---------------------------------------------------------------------------
// DARF
// ---------------------------------------------------------------------------
export const DARF_STATUS = {
  open: 'Em aberto',
  paid: 'Pago',
  overdue: 'Vencido',
} as const;
export const DARF_SEND_STATUS = {
  not_sent: 'Não enviado',
  sent: 'Enviado',
  failed: 'Falha no envio',
} as const;

// ---------------------------------------------------------------------------
// Elaboração
// ---------------------------------------------------------------------------
export const ELABORATION_STATUS = {
  no_files: 'Sem arquivos',
  not_processed: 'Arquivos não processados',
  conflict: 'Conflito nas informações',
  awaiting_validation: 'Aguardando validação',
  ok: 'Processamento OK',
  exported: 'Exportada',
} as const;
export type ElaborationStatus = keyof typeof ELABORATION_STATUS;

// ---------------------------------------------------------------------------
// Radar de oportunidades
// ---------------------------------------------------------------------------
export const OPPORTUNITY_CATEGORIES = {
  high_net_worth: 'Alto patrimônio',
  crypto: 'Criptoativos',
  variable_income: 'Renda variável',
  rural: 'Atividade rural',
  carne_leao: 'Carnê-Leão',
  company_opening: 'Possível abertura de empresa',
  irpfm: 'Sujeito ao IRPFM',
  holding: 'Potencial para holding',
} as const;
export type OpportunityCategory = keyof typeof OPPORTUNITY_CATEGORIES;

export const OPPORTUNITY_STATUS = {
  open: 'Aberto',
  in_progress: 'Em andamento',
  done: 'Concluído',
  dismissed: 'Dispensado',
} as const;
export type OpportunityStatus = keyof typeof OPPORTUNITY_STATUS;

// ---------------------------------------------------------------------------
// Jobs, envios e integrações
// ---------------------------------------------------------------------------
export const JOB_STATUS = { queued: 'Na fila', running: 'Executando', done: 'Concluído', failed: 'Falhou' } as const;
export type JobStatus = keyof typeof JOB_STATUS;

export const DELIVERY_CHANNELS = { email: 'E-mail', whatsapp: 'WhatsApp' } as const;
export type DeliveryChannel = keyof typeof DELIVERY_CHANNELS;

export const DELIVERY_STATUS = {
  queued: 'Na fila',
  sent: 'Enviado',
  delivered: 'Entregue',
  failed: 'Falhou',
} as const;
export type DeliveryStatus = keyof typeof DELIVERY_STATUS;

export const INTEGRATION_PROVIDERS = {
  asaas: 'Asaas',
  omie: 'Omie',
  whatsapp: 'WhatsApp',
  smtp: 'E-mail (SMTP)',
  serpro: 'SERPRO Integra Contador',
  ai: 'Inteligência artificial',
} as const;
export type IntegrationProvider = keyof typeof INTEGRATION_PROVIDERS;

export const AUTH_TYPES = {
  govbr: 'Gov.br',
  certificate_local: 'Certificado instalado no computador',
  certificate_cloud: 'Certificado A1 enviado ao Verifco',
} as const;
export type AuthType = keyof typeof AUTH_TYPES;

// ---------------------------------------------------------------------------
// Checklist digital
// ---------------------------------------------------------------------------
export const CHECKLIST_SECTIONS = {
  identification: 'Identificação',
  family: 'Familiares e dependentes',
  income: 'Rendimentos',
  payments: 'Pagamentos',
  assets_debts: 'Bens e dívidas',
  rural: 'Atividade rural',
  files: 'Arquivos',
  summary: 'Resumo',
} as const;
export type ChecklistSection = keyof typeof CHECKLIST_SECTIONS;

export const CHECKLIST_SECTION_STATUS = {
  open: 'Em aberto',
  done: 'Concluída',
  pending_documents: 'Com documentos pendentes',
  no_documents: 'Sem documentos',
} as const;
export type ChecklistSectionStatus = keyof typeof CHECKLIST_SECTION_STATUS;

export const CHECKLIST_ITEM_STATUS = {
  pending: 'Pendente',
  sent: 'Enviado',
  not_applicable: 'Não se aplica',
  removed: 'Removido neste ano',
} as const;
export type ChecklistItemStatus = keyof typeof CHECKLIST_ITEM_STATUS;

// ---------------------------------------------------------------------------
// Bens e direitos (grupos da DIRPF)
// ---------------------------------------------------------------------------
export const ASSET_GROUPS = {
  '01': 'Bens imóveis',
  '02': 'Bens móveis',
  '03': 'Participações societárias',
  '04': 'Aplicações e investimentos',
  '05': 'Créditos',
  '06': 'Depósitos à vista e numerário',
  '07': 'Fundos',
  '08': 'Criptoativos',
  '99': 'Outros bens e direitos',
} as const;
export type AssetGroup = keyof typeof ASSET_GROUPS;

export const optionsOf = opts;
