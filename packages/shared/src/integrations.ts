/**
 * Catálogo das integrações externas do escritório: campos de configuração,
 * quais são segredos (guardados cifrados e nunca devolvidos ao navegador) e
 * instruções de onde obter cada credencial. A API valida a configuração a partir
 * daqui e a tela de Administração › Integrações monta os formulários.
 */
import type { IntegrationProvider } from './enums';

export type IntegrationFieldType = 'text' | 'url' | 'email' | 'number' | 'select' | 'boolean' | 'secret' | 'procurator';

/** Mostra o campo (ou a instrução) só quando outro campo tem um dos valores. */
export interface IntegrationCondition {
  field: string;
  in: string[];
}

export interface IntegrationField {
  key: string;
  label: string;
  type: IntegrationFieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  default?: string | number | boolean;
  when?: IntegrationCondition;
  /** Ocupa a linha inteira no formulário. */
  wide?: boolean;
}

export interface IntegrationStep {
  text: string;
  when?: IntegrationCondition;
}

export interface IntegrationDef {
  key: IntegrationProvider;
  label: string;
  category: 'billing' | 'messaging' | 'government' | 'ai';
  description: string;
  /** O que a integração faz no Verifco. */
  capabilities: string[];
  fields: IntegrationField[];
  /** Passo a passo para obter as credenciais. */
  steps: IntegrationStep[];
  docsUrl: string;
  /** Recebe notificações do provedor (URL com token para copiar). */
  webhook?: boolean;
}

export const INTEGRATION_STATUS = {
  not_configured: 'Não configurada',
  configured: 'Configurada, não testada',
  connected: 'Conectada',
  error: 'Com erro',
} as const;
export type IntegrationStatus = keyof typeof INTEGRATION_STATUS;

export const INTEGRATION_CATEGORIES = {
  billing: 'Cobrança',
  messaging: 'Comunicação',
  government: 'Receita Federal',
  ai: 'Inteligência artificial',
} as const;

const whatsappEvolution: IntegrationCondition = { field: 'mode', in: ['evolution'] };
const whatsappMeta: IntegrationCondition = { field: 'mode', in: ['meta'] };

export const INTEGRATION_CATALOG: IntegrationDef[] = [
  {
    key: 'asaas',
    label: 'Asaas',
    category: 'billing',
    description: 'Emite boletos e cobranças Pix das parcelas dos honorários e dá baixa automática quando o cliente paga.',
    capabilities: [
      'Cadastra o cliente no Asaas (CPF/CNPJ, nome, e-mail e celular)',
      'Cria uma cobrança por parcela com o vencimento e o valor do faturamento',
      'Marca a parcela como paga, vencida ou cancelada pelo webhook do Asaas',
    ],
    fields: [
      {
        key: 'environment',
        label: 'Ambiente',
        type: 'select',
        required: true,
        default: 'sandbox',
        options: [
          { value: 'sandbox', label: 'Sandbox (testes)' },
          { value: 'production', label: 'Produção' },
        ],
      },
      { key: 'apiKey', label: 'Chave de API', type: 'secret', required: true, placeholder: '$aact_...' },
      {
        key: 'billingType',
        label: 'Forma de pagamento das cobranças',
        type: 'select',
        required: true,
        default: 'UNDEFINED',
        options: [
          { value: 'UNDEFINED', label: 'Cliente escolhe (boleto, Pix ou cartão)' },
          { value: 'BOLETO', label: 'Boleto (com Pix no boleto)' },
          { value: 'PIX', label: 'Pix' },
        ],
      },
      {
        key: 'notifyCustomer',
        label: 'Asaas também envia lembretes de cobrança ao cliente',
        type: 'boolean',
        default: false,
      },
      {
        key: 'webhookAuthToken',
        label: 'Token de autenticação do webhook',
        type: 'secret',
        help: 'O mesmo valor do campo "Token de autenticação" do webhook cadastrado no Asaas.',
      },
    ],
    steps: [
      { text: 'No Asaas, acesse Integrações › Chaves de API e gere uma chave. Para testes, use uma conta em sandbox.asaas.com.' },
      { text: 'Chaves de produção começam com $aact_prod_ e de sandbox com $aact_hmlg_; o ambiente escolhido precisa combinar com a chave.' },
      { text: 'Em Integrações › Webhooks, crie um webhook de cobranças com a URL abaixo (API v3, envio sequencial) e defina um token de autenticação.' },
      { text: 'Marque os eventos de cobrança recebida, confirmada, vencida, removida, restaurada e estornada.' },
    ],
    docsUrl: 'https://docs.asaas.com/docs/sobre-os-webhooks',
    webhook: true,
  },
  {
    key: 'omie',
    label: 'Omie',
    category: 'billing',
    description: 'Lança as parcelas dos honorários como contas a receber no Omie e acompanha a baixa dos pagamentos.',
    capabilities: [
      'Cadastra ou atualiza o cliente no Omie',
      'Inclui uma conta a receber por parcela, identificada pelo código da parcela no Verifco',
      'Consulta periodicamente as contas em aberto e marca como pagas as baixadas no Omie',
    ],
    fields: [
      { key: 'appKey', label: 'App Key', type: 'secret', required: true },
      { key: 'appSecret', label: 'App Secret', type: 'secret', required: true },
      {
        key: 'categoryCode',
        label: 'Código da categoria de receita',
        type: 'text',
        required: true,
        placeholder: '1.01.02',
        help: 'Categoria usada nas contas a receber (Finanças › Cadastros › Categorias).',
      },
      {
        key: 'bankAccountId',
        label: 'ID da conta corrente',
        type: 'number',
        required: true,
        help: 'Código da conta corrente no Omie onde os recebimentos são baixados.',
      },
      {
        key: 'pollHours',
        label: 'Consultar pagamentos a cada',
        type: 'select',
        required: true,
        default: '6',
        options: [
          { value: '1', label: '1 hora' },
          { value: '3', label: '3 horas' },
          { value: '6', label: '6 horas' },
          { value: '12', label: '12 horas' },
          { value: '24', label: '24 horas' },
        ],
      },
    ],
    steps: [
      { text: 'No Omie, acesse Configurações › Integrações (Desenvolvedor) e copie a App Key e o App Secret do aplicativo.' },
      { text: 'O usuário do aplicativo precisa de acesso ao módulo Finanças (contas a receber e clientes).' },
      { text: 'Informe o código da categoria de receita e o ID da conta corrente (Finanças › Contas Correntes).' },
      { text: 'O Omie limita requisições repetidas: aguarde um minuto entre testes com os mesmos dados.' },
    ],
    docsUrl: 'https://developer.omie.com.br/service-list/',
  },
  {
    key: 'smtp',
    label: 'E-mail (SMTP)',
    category: 'messaging',
    description: 'Envia checklists, orçamentos, recibos e avisos pelo e-mail do próprio escritório.',
    capabilities: [
      'Usa o servidor SMTP do escritório como remetente',
      'Anexa PDFs e planilhas gerados pelo Verifco',
      'Sem configuração, usa o envio padrão da plataforma (quando disponível)',
    ],
    fields: [
      { key: 'host', label: 'Servidor SMTP', type: 'text', required: true, placeholder: 'smtp.seudominio.com.br' },
      { key: 'port', label: 'Porta', type: 'number', required: true, default: 587 },
      {
        key: 'security',
        label: 'Segurança',
        type: 'select',
        required: true,
        default: 'starttls',
        options: [
          { value: 'starttls', label: 'STARTTLS (porta 587)' },
          { value: 'tls', label: 'SSL/TLS (porta 465)' },
          { value: 'none', label: 'Sem criptografia' },
        ],
      },
      { key: 'username', label: 'Usuário', type: 'text', placeholder: 'contato@seudominio.com.br' },
      { key: 'password', label: 'Senha', type: 'secret' },
      { key: 'fromEmail', label: 'E-mail do remetente', type: 'email', required: true },
      { key: 'fromName', label: 'Nome do remetente', type: 'text', help: 'Padrão: nome do escritório.' },
    ],
    steps: [
      { text: 'Use os dados SMTP do seu provedor de e-mail (Google Workspace, Microsoft 365, Zoho, Locaweb, SendGrid...).' },
      { text: 'No Google Workspace/Gmail, gere uma senha de app em Conta Google › Segurança › Senhas de app (exige verificação em duas etapas).' },
      { text: 'No Microsoft 365, habilite o SMTP autenticado da caixa em Centro de administração › Usuários › Email › Gerenciar aplicativos de email.' },
      { text: 'Prefira um e-mail do domínio do escritório com SPF e DKIM configurados para não cair no spam.' },
    ],
    docsUrl: 'https://nodemailer.com/smtp/',
  },
  {
    key: 'whatsapp',
    label: 'WhatsApp',
    category: 'messaging',
    description: 'Envia mensagens e documentos aos clientes pelo WhatsApp do escritório e recebe as respostas na aba Mensagens.',
    capabilities: [
      'Envia textos dos templates (checklist, orçamento, avisos)',
      'Envia PDFs como documento (DARF, recibos, relatórios)',
      'Recebe as respostas dos clientes pelo webhook e as mostra na aba Mensagens do cliente (casando pelo celular)',
      'No modo Meta, fora da janela de 24 h usa o modelo aprovado e marca como falha o envio que a Meta recusar',
      'Funciona com a Evolution API ou com a WhatsApp Cloud API oficial da Meta',
    ],
    fields: [
      {
        key: 'mode',
        label: 'Conexão',
        type: 'select',
        required: true,
        default: 'evolution',
        options: [
          { value: 'evolution', label: 'Evolution API (instância própria)' },
          { value: 'meta', label: 'WhatsApp Cloud API (Meta)' },
        ],
      },
      { key: 'baseUrl', label: 'URL da Evolution API', type: 'url', required: true, placeholder: 'https://evolution.seudominio.com.br', when: whatsappEvolution },
      { key: 'instance', label: 'Nome da instância', type: 'text', required: true, when: whatsappEvolution },
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, when: whatsappEvolution },
      { key: 'phoneNumberId', label: 'Phone number ID', type: 'text', required: true, when: whatsappMeta },
      { key: 'accessToken', label: 'Token de acesso', type: 'secret', required: true, when: whatsappMeta },
      { key: 'apiVersion', label: 'Versão da Graph API', type: 'text', default: 'v25.0', when: whatsappMeta },
      {
        key: 'appSecret',
        label: 'Chave secreta do app (App Secret)',
        type: 'secret',
        help: 'Com ela, o Verifco confere a assinatura (X-Hub-Signature-256) de cada notificação recebida da Meta. Fica em Meta for Developers › seu app › Configurações do app › Básico.',
        when: whatsappMeta,
      },
      {
        key: 'templateName',
        label: 'Modelo aprovado para fora da janela de 24 h',
        type: 'text',
        placeholder: 'aviso_escritorio',
        help: 'Nome do modelo aprovado no Gerenciador do WhatsApp. Sem ele, a Meta não entrega mensagens a quem não escreveu nas últimas 24 h.',
        when: whatsappMeta,
      },
      { key: 'templateLanguage', label: 'Idioma do modelo', type: 'text', default: 'pt_BR', when: whatsappMeta },
      {
        key: 'templateBody',
        label: 'Corpo do modelo',
        type: 'select',
        default: 'message',
        options: [
          { value: 'message', label: 'Tem uma variável {{1}}, que recebe o texto da mensagem' },
          { value: 'none', label: 'Sem variáveis (só avisa e convida o cliente a responder)' },
        ],
        when: whatsappMeta,
        wide: true,
      },
      { key: 'templateDocument', label: 'O modelo tem cabeçalho do tipo documento (para enviar PDFs fora da janela)', type: 'boolean', default: false, when: whatsappMeta, wide: true },
    ],
    steps: [
      { text: 'Na sua Evolution API, crie uma instância e conecte o número do escritório lendo o QR Code.', when: whatsappEvolution },
      { text: 'Copie a URL do servidor, o nome da instância e a API key (global ou da instância).', when: whatsappEvolution },
      {
        text: 'Para receber as respostas na aba Mensagens: em Webhook da instância, cole a URL do webhook mostrada aqui, ligue o evento MESSAGES_UPSERT e deixe "Webhook by events" desligado.',
        when: whatsappEvolution,
      },
      { text: 'No Meta for Developers, crie um app do tipo Empresa e adicione o produto WhatsApp.', when: whatsappMeta },
      { text: 'Em WhatsApp › Configuração da API, copie o Phone number ID do número do escritório.', when: whatsappMeta },
      {
        text: 'Gere um token permanente de um usuário do sistema (Configurações do negócio › Usuários do sistema) com a permissão whatsapp_business_messaging.',
        when: whatsappMeta,
      },
      {
        text: 'Para receber as respostas: em WhatsApp › Configuração › Webhook, cole a URL do webhook mostrada aqui, use como token de verificação o código do fim da URL (depois de /whatsapp/) e assine o campo messages.',
        when: whatsappMeta,
      },
      {
        text: 'Pela política da Meta, mensagens livres só são entregues até 24 h depois da última mensagem do cliente. Para avisar fora dessa janela, crie um modelo da categoria Utilidade com uma variável {{1}} no corpo (ex.: "Mensagem do escritório: {{1}}") e informe o nome dele aqui.',
        when: whatsappMeta,
      },
    ],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages',
    webhook: true,
  },
  {
    key: 'serpro',
    label: 'SERPRO Integra Contador',
    category: 'government',
    description: 'Consulta a Receita Federal pela API oficial do SERPRO: procurações, caixa postal, situação fiscal e pagamentos de DARF.',
    capabilities: [
      'Autentica com as chaves do contrato e o certificado digital do escritório',
      'Consulta procurações eletrônicas e lista as mensagens da caixa postal do e-CAC (sem abrir o conteúdo, que daria ciência de intimações)',
      'Baixa o relatório de situação fiscal (pendências e certidão vigente), se ligado em Administração › Preferências',
      'Dá baixa nas quotas do IRPF pagas, consultando os pagamentos de DARF (código 0211)',
      'O Integra Contador não tem serviço de IRPF: situação da declaração, malha, extratos e pré-preenchida vêm da extensão ou de lançamento manual',
    ],
    fields: [
      {
        key: 'contractorCnpj',
        label: 'CNPJ do contratante',
        type: 'text',
        required: true,
        help: 'CNPJ que contratou o Integra Contador na Loja Serpro (normalmente o do escritório).',
      },
      {
        key: 'procuratorId',
        label: 'Certificado digital (e-CNPJ)',
        type: 'procurator',
        required: true,
        help: 'Certificado A1 (.pfx) cadastrado em Administração › Procuradores.',
      },
      { key: 'consumerKey', label: 'Consumer Key', type: 'secret', required: true },
      { key: 'consumerSecret', label: 'Consumer Secret', type: 'secret', required: true },
      {
        key: 'autoSync',
        label: 'Sincronização automática',
        type: 'select',
        default: '',
        options: [
          { value: '', label: 'Desligada (só quando você pedir)' },
          { value: 'daily', label: 'Diária, às 6h' },
          { value: 'weekly', label: 'Semanal, às 6h' },
        ],
        help: 'Consulta todos os clientes com procurador. Cada consulta ao Integra Contador é cobrada pelo SERPRO conforme o seu contrato.',
        wide: true,
      },
    ],
    steps: [
      { text: 'Contrate a API Integra Contador na Loja Serpro (loja.serpro.gov.br) com o e-CNPJ do escritório.' },
      { text: 'Na Área do Cliente Serpro (cliente.serpro.gov.br), copie a Consumer Key e o Consumer Secret do contrato.' },
      { text: 'Cadastre o certificado A1 (.pfx) usado na contratação em Administração › Procuradores e selecione-o aqui; ele é usado na autenticação.' },
      { text: 'Para consultar um cliente, o escritório precisa de procuração eletrônica no e-CAC para os serviços desejados.' },
    ],
    docsUrl: 'https://apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/pt/quick_start/',
  },
  {
    key: 'ai',
    label: 'Claude (Anthropic)',
    category: 'ai',
    description: 'Assistentes de IA (Claude, da Anthropic) que leem documentos, conferem a declaração e respondem dúvidas.',
    capabilities: [
      'Lê PDFs e imagens enviados pelos clientes',
      'Usa a chave de API do escritório, com o consumo cobrado direto pela Anthropic',
      'Sem chave própria, usa a chave da plataforma (quando disponível)',
    ],
    fields: [
      { key: 'apiKey', label: 'Chave de API da Anthropic', type: 'secret', placeholder: 'sk-ant-...' },
      {
        key: 'model',
        label: 'Modelo',
        type: 'select',
        default: '',
        options: [
          { value: '', label: 'Padrão do Verifco' },
          { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 (mais capaz)' },
          { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (mais rápido)' },
          { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (mais econômico)' },
        ],
      },
      {
        key: 'effort',
        label: 'Esforço de raciocínio',
        type: 'select',
        default: 'high',
        options: [
          { value: 'low', label: 'Baixo (respostas rápidas)' },
          { value: 'medium', label: 'Médio' },
          { value: 'high', label: 'Alto (recomendado)' },
          { value: 'xhigh', label: 'Muito alto' },
        ],
        help: 'Ignorado no Claude Haiku.',
      },
    ],
    steps: [
      { text: 'Crie uma conta em console.anthropic.com e gere uma chave em Settings › API Keys.' },
      { text: 'Defina um limite de gastos no Console para controlar o consumo do escritório.' },
      { text: 'Documentos enviados à IA são processados pela Anthropic; informe isso na sua política de privacidade.' },
    ],
    docsUrl: 'https://docs.claude.com/en/api/overview',
  },
];

export function getIntegrationDef(key: string): IntegrationDef | undefined {
  return INTEGRATION_CATALOG.find((d) => d.key === key);
}

/** O campo/instrução vale para a configuração atual? */
export function integrationConditionMet(cond: IntegrationCondition | undefined, config: Record<string, unknown>): boolean {
  if (!cond) return true;
  return cond.in.includes(String(config[cond.field] ?? ''));
}

/** Campos visíveis na configuração atual (respeitando `when`). */
export function activeIntegrationFields(def: IntegrationDef, config: Record<string, unknown>): IntegrationField[] {
  return def.fields.filter((f) => integrationConditionMet(f.when, config));
}

/** Valores padrão da configuração pública. */
export function integrationDefaults(def: IntegrationDef): Record<string, unknown> {
  return Object.fromEntries(def.fields.filter((f) => f.type !== 'secret' && f.default !== undefined).map((f) => [f.key, f.default]));
}

/**
 * Campos obrigatórios que faltam, dada a configuração pública e quais segredos estão guardados.
 * Devolve os rótulos para exibir na mensagem de erro.
 */
export function missingIntegrationFields(def: IntegrationDef, config: Record<string, unknown>, secretKeys: Iterable<string>): string[] {
  const secrets = new Set(secretKeys);
  return activeIntegrationFields(def, config)
    .filter((f) => f.required)
    .filter((f) => {
      if (f.type === 'secret') return !secrets.has(f.key);
      const v = config[f.key];
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.label);
}
