/**
 * Texto do registro de auditoria (GET /audit e GET /customers/:id/events): a API guarda a
 * entidade e a ação em códigos; aqui eles viram frases. Código sem tradução aparece como veio,
 * para nada ficar escondido.
 */
export interface AuditRow {
  id: string;
  createdAt: string;
  userId?: string | null;
  userName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  data: Record<string, unknown> | null;
}

export const AUDIT_ENTITIES: Record<string, string> = {
  session: 'Acesso',
  two_factor: 'Verificação em duas etapas',
  customer: 'Cliente',
  customer_credentials: 'Credenciais do eCAC',
  customer_group: 'Grupo de clientes',
  declaration: 'Declaração',
  document: 'Documento',
  checklist: 'Checklist',
  backlog: 'Documentos faltantes',
  darf: 'DARF',
  budget: 'Orçamento',
  billing: 'Faturamento',
  installment: 'Parcela',
  payment_method: 'Forma de pagamento',
  price_table: 'Tabela de preços',
  delivery: 'Envio',
  mailing: 'Mala direta',
  email_template: 'Template de e-mail',
  employee: 'Colaborador',
  role: 'Função',
  office: 'Escritório',
  office_settings: 'Preferências',
  procurator: 'Procurador',
  api_token: 'Token do robô',
  ecac_record: 'Registro do eCAC',
  prefilled_statement: 'Pré-preenchida',
  sync_inbox: 'Arquivo sem cliente',
  backup: 'Backup',
  import_batch: 'Importação',
  opportunity: 'Oportunidade',
  radar: 'Radar',
  ai_analysis: 'Análise de IA',
  ai_conversation: 'Conversa com a IA',
  ai_defense: 'Defesa de malha',
  holding_simulation: 'Simulação de holding',
  irpfm: 'IRPF mínimo',
  cashbook: 'Livro caixa',
  copilot_document: 'Documento do copiloto',
  copilot_enrollment: 'Copiloto financeiro',
  copilot_entry: 'Lançamento do copiloto',
  user: 'Conta do usuário',
};

const ACTIONS: Record<string, string> = {
  login: 'entrou no sistema',
  create: 'criou',
  update: 'alterou',
  delete: 'excluiu',
  restore: 'restaurou',
  purge: 'eliminou em definitivo',
  reveal: 'consultou a senha guardada',
  export: 'exportou',
  import: 'importou',
  send: 'enviou',
  resend: 'reenviou',
  resend_failed: 'reenviou os que falharam',
  upload: 'enviou um arquivo',
  download: 'baixou',
  download_zip: 'baixou o .zip',
  generate: 'gerou',
  approve: 'aprovou',
  reject: 'recusou',
  cancel: 'cancelou',
  cancel_partial: 'cancelou parte',
  link: 'vinculou',
  revoke: 'revogou',
  enable: 'ativou',
  disable: 'desativou',
  reset: 'desligou para outra pessoa',
  receive: 'registrou o recebimento',
  reopen: 'reabriu',
  finish: 'concluiu',
  substatus: 'mudou a etapa',
  status: 'mudou a situação',
  refresh: 'atualizou',
  save: 'salvou',
  pdf: 'gerou o PDF',
  archive: 'arquivou',
  update_address: 'alterou o endereço',
  portal_access: 'gerou o acesso ao portal',
  revoke_portal_access: 'revogou o acesso ao portal',
  ecac_sync: 'pediu a sincronização do eCAC',
  ecac_sync_office: 'pediu a sincronização geral do eCAC',
  authorization_send: 'enviou a autorização',
  send_message: 'enviou uma mensagem',
  send_kit: 'enviou o kit pós-declaração',
  send_reports: 'enviou os relatórios',
  send_pdf: 'enviou o PDF',
  generate_reports: 'gerou os relatórios',
  create_item: 'incluiu uma linha',
  update_item: 'alterou uma linha',
  delete_item: 'excluiu uma linha',
  update_other_expenses: 'alterou as outras despesas',
  elaboration_process: 'processou documentos na elaboração',
  elaboration_validate: 'validou a elaboração',
  elaboration_export: 'exportou a elaboração',
  delete_file: 'excluiu um arquivo',
  reopen_section: 'reabriu uma seção',
  receipt_generate: 'gerou o recibo',
  receipt_send: 'enviou o recibo',
  charge_send: 'enviou a cobrança',
  billing_sync: 'sincronizou com o provedor de cobrança',
  mailing_cancel: 'cancelou o agendamento',
  restore_default: 'restaurou o texto padrão',
  resend_invite: 'reenviou o convite',
  change_email: 'trocou o e-mail de acesso',
  update_profile: 'alterou o próprio nome',
  revoke_notification_devices: 'desligou as notificações nos navegadores',
  update_logo: 'trocou o logotipo',
  remove_logo: 'removeu o logotipo',
  update_auth_type: 'mudou a forma de autenticação',
  upload_certificate: 'enviou o certificado',
  remove_certificate: 'removeu o certificado',
  prefilled_download: 'baixou a pré-preenchida',
  inbox_file: 'atribuiu a um cliente',
  inbox_discard: 'descartou',
  sync_file: 'recebeu do sincronizador',
  sync_document: 'recebeu do robô',
  sync_prefilled: 'recebeu do robô',
  sync_ecac_record: 'recebeu da extensão',
  undo_import: 'desfez a importação',
  delete_entry: 'excluiu um lançamento',
};

export const entityLabel = (entity: string) => AUDIT_ENTITIES[entity] ?? entity;
export const actionLabel = (action: string) => ACTIONS[action] ?? action;

/** Detalhe curto e legível do que veio em `data` (nome, e-mail trocado, token do robô). */
export function auditDetail(row: AuditRow): string {
  const d = row.data ?? {};
  const parts: string[] = [];
  const text = (k: string) => (typeof d[k] === 'string' && d[k] ? (d[k] as string) : null);
  if (text('name')) parts.push(text('name')!);
  if (text('filename')) parts.push(text('filename')!);
  if (text('from') && text('to')) parts.push(`de ${text('from')} para ${text('to')}`);
  if (text('email')) parts.push(text('email')!);
  if (text('tokenName')) parts.push(`token ${text('tokenName')}`);
  if (text('ip')) parts.push(`IP ${text('ip')}`);
  if (d.twoFactor === true) parts.push('com duas etapas');
  if (d.recoveryCode === true) parts.push('com código de recuperação');
  if (typeof d.count === 'number') parts.push(`${d.count} registro(s)`);
  if (d.emailSent === false) parts.push('e-mail não enviado');
  return parts.join(' · ');
}

/** "Maria: Cliente — alterou o endereço". Sem usuário é ação do robô ou do sistema. */
export const auditActor = (row: AuditRow) => row.userName ?? (row.data && typeof row.data.tokenName === 'string' ? 'Robô' : 'Sistema');
