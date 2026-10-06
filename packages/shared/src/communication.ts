/**
 * Catálogos da comunicação (mala direta) e dos relatórios individuais da declaração.
 */

export type MailingTypeKey = 'checklist_digital' | 'checklist_pdf' | 'planning' | 'marketing' | 'monthly' | 'budget' | 'kit';

export interface MailingType {
  key: MailingTypeKey;
  label: string;
  description: string;
  /** Permissão exigida para enviar este tipo. */
  permission: string;
  /** Template de e-mail usado no envio. */
  templateKey: string;
  /** Anexo gerado por cliente. */
  attachment: 'checklist_pdf' | 'kit' | null;
  /** Observação exibida na revisão do envio. */
  note?: string;
}

export const MAILING_TYPES: MailingType[] = [
  {
    key: 'checklist_digital',
    label: 'Checklist digital',
    description: 'Convite para o cliente preencher o checklist e enviar os documentos.',
    permission: 'mailing.send_checklist_digital',
    templateKey: 'checklist_digital',
    attachment: null,
    note: 'Cria o checklist do exercício de quem ainda não tem e gera um link e um código individuais para cada cliente (os anteriores deixam de valer). No histórico de envios, o link e o código ficam mascarados. Clientes com o checklist só para consulta ficam de fora.',
  },
  {
    key: 'checklist_pdf',
    label: 'Checklist em PDF',
    description: 'Lista de documentos em PDF: a do checklist digital do cliente ou, se ainda não houver, a montada com base na declaração do ano anterior.',
    permission: 'mailing.send_checklist_pdf',
    templateKey: 'checklist_pdf',
    attachment: 'checklist_pdf',
  },
  {
    key: 'planning',
    label: 'Planejamento DIRPF',
    description: 'Orientações de planejamento para o próximo exercício.',
    permission: 'mailing.send_planning',
    templateKey: 'planning',
    attachment: null,
  },
  {
    key: 'marketing',
    label: 'Marketing',
    description: 'Campanhas e oferta de serviços do escritório.',
    permission: 'mailing.send_marketing',
    templateKey: 'marketing',
    attachment: null,
  },
  {
    key: 'monthly',
    label: 'E-mail mensal',
    description: 'Comunicado mensal para a carteira.',
    permission: 'mailing.send_monthly',
    templateKey: 'monthly',
    attachment: null,
  },
  {
    key: 'budget',
    label: 'Orçamento',
    description: 'Proposta de honorários do exercício (orçamento já cadastrado).',
    permission: 'mailing.send_budget',
    templateKey: 'budget_digital',
    attachment: null,
    note: 'Usa o orçamento mais recente do exercício, se estiver em rascunho ou já enviado (aprovados e recusados ficam de fora). Cada cliente recebe um novo link de aprovação online (o anterior deixa de valer); o orçamento passa a “Enviado” e a declaração avança para “Orçamento enviado”.',
  },
  {
    key: 'kit',
    label: 'Kit pós-declaração',
    description: 'Resumo da declaração transmitida, DARFs, evolução patrimonial e lembretes, em PDF.',
    permission: 'post_declaration.send_kit',
    templateKey: 'customer_document',
    attachment: 'kit',
  },
];

export function getMailingType(key: string): MailingType | undefined {
  return MAILING_TYPES.find((t) => t.key === key);
}

/** Tipo de mala direta correspondente a um template (para links vindos de outras telas). */
export function mailingTypeForTemplate(templateKey: string): MailingType | undefined {
  // o template "Orçamento" (sem link) é o antigo da mala direta de orçamento
  if (templateKey === 'budget') return getMailingType('budget');
  return MAILING_TYPES.find((t) => t.templateKey === templateKey && t.key !== 'kit');
}

export const MAILING_SKIP_REASONS = {
  no_email: 'Sem e-mail cadastrado',
  no_mobile: 'Sem celular cadastrado',
  no_declaration: 'Sem declaração no exercício',
  not_transmitted: 'Declaração ainda não transmitida',
  no_budget: 'Sem orçamento no exercício',
  budget_approved: 'Orçamento já aprovado',
  budget_rejected: 'Orçamento recusado',
  checklist_locked: 'Checklist só para consulta',
  customer_removed: 'Cliente excluído antes do envio',
} as const;
export type MailingSkipReason = keyof typeof MAILING_SKIP_REASONS;

/** Clientes por mala direta. Acima disso, o envio é recusado e o escritório divide pelos filtros. */
export const MAILING_MAX_RECIPIENTS = 5000;

/** Valor mostrado na prévia no lugar do link e do código, que só são gerados no envio. */
export const MAILING_GENERATED_ON_SEND = '(gerado no envio)';

/** Situação de uma mala direta (job na fila). */
export const MAILING_RUN_STATUS = {
  queued: 'Na fila',
  running: 'Enviando',
  done: 'Concluída',
  failed: 'Falhou',
} as const;
export type MailingRunStatus = keyof typeof MAILING_RUN_STATUS;

// ---------------------------------------------------------------------------
// Relatórios individuais
// ---------------------------------------------------------------------------
export type IndividualReportKey = 'cash_analysis' | 'cash_details' | 'patrimony_history' | 'cash_history' | 'fine_mesh' | 'tax_planning' | 'assets';

export interface IndividualReport {
  key: IndividualReportKey;
  label: string;
  description: string;
  permission: string;
}

export const INDIVIDUAL_REPORTS: IndividualReport[] = [
  { key: 'cash_analysis', label: 'Análise de caixa', description: 'Recursos e aplicações do ano e o saldo resultante.', permission: 'report.cash_analysis' },
  { key: 'cash_details', label: 'Detalhes do caixa', description: 'Composição de cada linha da análise de caixa.', permission: 'report.cash_details' },
  { key: 'patrimony_history', label: 'Histórico patrimonial', description: 'Bens, dívidas e patrimônio líquido dos últimos 5 exercícios.', permission: 'report.patrimony_history' },
  { key: 'cash_history', label: 'Histórico do caixa', description: 'Saldo de caixa dos últimos 5 exercícios.', permission: 'report.cash_history' },
  { key: 'fine_mesh', label: 'Planilha de aviso de malha fina', description: 'Pontos de atenção encontrados nas linhas da declaração.', permission: 'report.fine_mesh' },
  { key: 'tax_planning', label: 'Planejamento tributário', description: 'Comparativo completa × simplificada e sugestões.', permission: 'report.tax_planning' },
  { key: 'assets', label: 'Bens e direitos', description: 'Bens e dívidas com a situação no ano anterior e no atual.', permission: 'report.assets' },
];

export const INDIVIDUAL_REPORT_KEYS = INDIVIDUAL_REPORTS.map((r) => r.key) as [IndividualReportKey, ...IndividualReportKey[]];

export function getIndividualReport(key: string): IndividualReport | undefined {
  return INDIVIDUAL_REPORTS.find((r) => r.key === key);
}

/** Valores de exemplo para a pré-visualização dos templates. */
export function sampleTemplateValues(year: number): Record<string, string | number> {
  return {
    CLIENTE: 'Maria Aparecida Souza',
    ESCRITORIO: 'Escritório Exemplo Contabilidade',
    CONTADOR: 'João Pereira',
    ANO_EXERCICIO: year,
    ANO_CALENDARIO: year - 1,
    ANO_ANTERIOR: year - 1,
    PROXIMO_ANO: year + 1,
    ANO_REFERENCIA: year,
    LINK: 'https://app.verifco.com.br/exemplo',
    CODIGO: '482913',
    VALOR: 'R$ 450,00',
    VALOR_EXTENSO: 'quatrocentos e cinquenta reais',
    VENCIMENTO: `30/05/${year}`,
    DATA: new Date().toLocaleDateString('pt-BR'),
    CATEGORIA: 'Declaração IRPF',
    DESCRICAO: 'Elaboração e transmissão da declaração de ajuste anual.',
    PENDENCIAS: '<ul><li>Informe de rendimentos do banco (até 15/04)</li><li>Recibos de despesas médicas</li></ul>',
    CPF_CLIENTE: '529.982.247-25',
    CPF_CONTADOR: '12.345.678/0001-95',
    CPF_PROCURADOR: '123.456.789-09',
    CIDADE_CLIENTE: 'Belo Horizonte',
    EMAIL_CLIENTE: 'maria@exemplo.com.br',
    ENDERECO_CLIENTE: 'Rua das Flores, 100 - Centro',
    TELEFONE_CLIENTE: '(31) 99999-0000',
    WHATSAPP: '(31) 98888-0000',
  };
}
