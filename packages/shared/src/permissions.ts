/**
 * Catálogo de permissões do Verifco.
 *
 * Cada permissão é uma string `recurso.operacao`. As funções (perfis) do escritório
 * guardam uma lista dessas chaves; o servidor confere a chave em cada rota.
 * As categorias espelham os grupos exibidos no formulário de funções.
 */
export interface PermissionDef {
  key: string;
  label: string;
}

export interface PermissionCategory {
  id: string;
  label: string;
  permissions: PermissionDef[];
}

const p = (key: string, label: string): PermissionDef => ({ key, label });

export const PERMISSION_CATEGORIES: PermissionCategory[] = [
  {
    id: 'customer',
    label: 'Clientes',
    permissions: [
      p('customer.list', 'Listagem de clientes'),
      p('customer.create', 'Criação de clientes'),
      p('customer.edit', 'Edição de clientes'),
      p('customer.delete', 'Remoção de clientes'),
      p('customer.download_documents', 'Baixar documentos'),
      p('customer.portal_access', 'Gerar acesso ao portal do cliente'),
    ],
  },
  {
    id: 'checklist_digital',
    label: 'Checklist DIRPF digital',
    permissions: [
      p('checklist_digital.create', 'Criação do checklist digital'),
      p('checklist_digital.view', 'Visualização do checklist digital'),
      p('checklist_digital.edit', 'Edição do checklist digital'),
      p('checklist_digital.upload', 'Upload no checklist digital'),
      p('checklist_digital.download', 'Download no checklist digital'),
      p('checklist_digital.send', 'Envio do checklist digital'),
    ],
  },
  {
    id: 'checklist_pdf',
    label: 'Checklist DIRPF PDF',
    permissions: [
      p('checklist_pdf.view', 'Visualização do checklist PDF'),
      p('checklist_pdf.download', 'Download do checklist PDF'),
      p('checklist_pdf.send', 'Envio do checklist PDF'),
    ],
  },
  {
    id: 'declaration',
    label: 'Declaração e pré-declaração',
    permissions: [
      p('declaration.view', 'Visualização da declaração'),
      p('declaration.edit', 'Edição da declaração e status'),
      p('declaration.finish', 'Finalização da declaração'),
      p('pre_declaration.view', 'Visualização da pré-declaração'),
      p('pre_declaration.create', 'Criação da pré-declaração'),
      p('pre_declaration.edit', 'Edição da pré-declaração'),
      p('elaboration.export', 'Exportação na elaboração'),
      p('prefilled.download', 'Download das pré-preenchidas'),
    ],
  },
  {
    id: 'post_declaration',
    label: 'Pós-declaração',
    permissions: [p('post_declaration.send_kit', 'Envio do kit pós-declaração')],
  },
  {
    id: 'mailing',
    label: 'Mala direta',
    permissions: [
      p('mailing.send_checklist_digital', 'Envio de checklist digital'),
      p('mailing.send_checklist_pdf', 'Envio de checklist PDF'),
      p('mailing.send_planning', 'Envio do planejamento'),
      p('mailing.send_marketing', 'Envio de e-mail marketing'),
      p('mailing.send_budget', 'Envio de orçamento'),
      p('mailing.send_monthly', 'Envio de e-mail mensal'),
      p('mailing.list', 'Consulta de e-mails enviados'),
      p('message.send', 'Envio de mensagens ao cliente'),
    ],
  },
  {
    id: 'budget',
    label: 'Orçamentos e faturamento',
    permissions: [
      p('budget.list', 'Listagem de orçamentos'),
      p('budget.create', 'Criação de orçamentos'),
      p('budget.edit', 'Edição de orçamentos'),
      p('budget.delete', 'Remoção de orçamentos'),
      p('budget.approve', 'Aprovação de orçamentos'),
      p('budget.send', 'Envio de orçamentos'),
      p('billing.edit', 'Edição dos faturamentos'),
      p('billing.receive', 'Recebimento dos faturamentos'),
      p('billing.receipt_generate', 'Geração do recibo'),
      p('billing.receipt_send', 'Envio do recibo'),
    ],
  },
  {
    id: 'report',
    label: 'Relatórios',
    permissions: [
      p('report.cash_analysis', 'Relatório de análise de caixa'),
      p('report.cash_details', 'Relatório de detalhes de caixa'),
      p('report.patrimony_history', 'Relatório de histórico patrimonial'),
      p('report.cash_history', 'Relatório de histórico de caixa'),
      p('report.assets', 'Relatório de bens e direitos'),
      p('report.tax_planning', 'Relatório de planejamento tributário'),
      p('report.fine_mesh', 'Planilha de aviso de malha fina'),
      p('report.results', 'Relatório de resultados'),
      p('report.billing', 'Relatório de faturamento'),
      p('report.backlogs', 'Relatório de documentos faltantes'),
      p('report.refund', 'Relatório de restituição'),
    ],
  },
  {
    id: 'ecac',
    label: 'eCAC',
    permissions: [
      p('ecac.view', 'Consulta dos painéis eCAC'),
      p('ecac.credentials', 'Edição das credenciais eCAC/gov.br'),
      p('ecac.sync', 'Solicitar sincronização eCAC'),
      p('ecac.actions', 'Ações eCAC pela extensão'),
    ],
  },
  {
    id: 'procuration',
    label: 'Procurações',
    permissions: [
      p('procuration.list', 'Listagem de procuradores'),
      p('procuration.edit', 'Associação de procurador'),
      p('procuration.certificate', 'Gestão do certificado do procurador'),
    ],
  },
  {
    id: 'payment_method',
    label: 'Métodos de pagamento',
    permissions: [
      p('payment_method.list', 'Listagem de métodos de pagamento'),
      p('payment_method.create', 'Criação de métodos de pagamento'),
      p('payment_method.edit', 'Edição de métodos de pagamento'),
      p('payment_method.delete', 'Remoção de métodos de pagamento'),
    ],
  },
  {
    id: 'price_table',
    label: 'Tabelas de cobrança',
    permissions: [
      p('price_table.list', 'Listagem de tabelas de cobrança'),
      p('price_table.create', 'Criação de tabelas de cobrança'),
      p('price_table.edit', 'Edição de tabelas de cobrança'),
      p('price_table.delete', 'Remoção de tabelas de cobrança'),
    ],
  },
  {
    id: 'email_template',
    label: 'Templates de e-mail',
    permissions: [
      p('email_template.list', 'Listagem de templates'),
      p('email_template.edit', 'Edição de templates'),
    ],
  },
  {
    id: 'worksheet',
    label: 'Importação de planilhas',
    permissions: [
      p('worksheet.new_customers', 'Planilha de novos clientes'),
      p('worksheet.update_customers', 'Planilha de atualização de clientes'),
      p('worksheet.budget', 'Planilha de orçamentos'),
      p('worksheet.procuration', 'Planilha de procurações'),
      p('worksheet.inss', 'Planilha de login INSS'),
      p('worksheet.ecac', 'Planilha de login eCAC'),
    ],
  },
  {
    id: 'office',
    label: 'Escritório',
    permissions: [
      p('office.edit', 'Edição de dados do escritório'),
      p('settings.view', 'Visualização de configurações'),
      p('settings.edit', 'Edição de configurações'),
      p('integrations.manage', 'Gestão de integrações'),
      p('contracts.view', 'Consulta de contratos e pacotes'),
      p('backup.download', 'Download de backup'),
    ],
  },
  {
    id: 'employee',
    label: 'Colaboradores',
    permissions: [
      p('employee.list', 'Listagem de colaboradores'),
      p('employee.create', 'Criação de colaboradores'),
      p('employee.edit', 'Edição de colaboradores'),
      p('employee.delete', 'Exclusão de colaboradores'),
    ],
  },
  {
    id: 'role',
    label: 'Funções e permissões',
    permissions: [
      p('role.list', 'Listagem de funções'),
      p('role.create', 'Criação de funções'),
      p('role.edit', 'Edição de funções e permissões'),
      p('role.delete', 'Exclusão de funções'),
    ],
  },
  {
    id: 'customer_group',
    label: 'Grupos de clientes',
    permissions: [
      p('customer_group.list', 'Listagem dos grupos'),
      p('customer_group.create', 'Criação de grupos'),
      p('customer_group.edit', 'Edição de grupos'),
      p('customer_group.delete', 'Exclusão de grupos'),
    ],
  },
  {
    id: 'advisory',
    label: 'Consultoria e IA',
    permissions: [
      p('ai.use', 'Uso dos assistentes de IA'),
      p('irpfm.view', 'Cálculo do IRPFM'),
      p('holding.view', 'Simulação de holding'),
      p('radar.view', 'Radar de oportunidades'),
      p('copilot.use', 'Copiloto financeiro'),
      p('copilot.manage', 'Gestão do plano do copiloto'),
      p('cashbook.use', 'Livro caixa / Carnê-Leão'),
    ],
  },
];

export const ALL_PERMISSIONS: string[] = PERMISSION_CATEGORIES.flatMap((c) => c.permissions.map((x) => x.key));

export type Permission = string;

const PERMISSION_SET = new Set(ALL_PERMISSIONS);

export function isPermission(key: string): boolean {
  return PERMISSION_SET.has(key);
}

/** Função padrão de quem cria o escritório: todas as permissões. */
export const ADMIN_ROLE_NAME = 'Administrador';

/** Perfil sugerido para colaboradores operacionais. */
export const DEFAULT_OPERATOR_PERMISSIONS: string[] = ALL_PERMISSIONS.filter(
  (k) =>
    !k.startsWith('role.') &&
    !k.startsWith('employee.') &&
    !k.startsWith('office.') &&
    !['settings.edit', 'integrations.manage', 'backup.download', 'copilot.manage', 'customer.delete'].includes(k),
);
