/**
 * Catálogo de templates de comunicação.
 *
 * Os textos padrão são próprios do Verifco. As variáveis seguem a convenção
 * `{{NOME}}`; cada template declara as que aceita, e `renderTemplate` só substitui
 * as conhecidas (o restante fica visível para o usuário perceber o erro).
 *
 * Tags coladas de outros sistemas valem como apelidos das do Verifco
 * ({@link TEMPLATE_TAG_ALIASES}); as demais continuam desconhecidas e são apontadas por
 * `unknownVariables`.
 */
import { escapeHtml } from './html';

export interface TemplateVariable {
  name: string;
  description: string;
}

export interface TemplateDef {
  key: string;
  name: string;
  description: string;
  variables: TemplateVariable[];
  defaultSubject: string;
  defaultBody: string;
}

const v = (name: string, description: string): TemplateVariable => ({ name, description });

const CLIENTE = v('CLIENTE', 'Nome do cliente');
const ESCRITORIO = v('ESCRITORIO', 'Nome do escritório');
const CONTADOR = v('CONTADOR', 'Nome do contador responsável');
const ANO = v('ANO_EXERCICIO', 'Ano-exercício da declaração');
const ANO_CAL = v('ANO_CALENDARIO', 'Ano-calendário da declaração');
const LINK = (d: string) => v('LINK', d);

const wrap = (inner: string) =>
  `<p>Olá, {{CLIENTE}}!</p>${inner}<p>Qualquer dúvida, estamos à disposição.</p><p>{{CONTADOR}}<br/>{{ESCRITORIO}}</p>`;

export const TEMPLATES: TemplateDef[] = [
  {
    key: 'checklist_digital',
    name: 'Checklist DIRPF (digital)',
    description: 'Convite para o cliente preencher o checklist digital e enviar documentos.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, ANO_CAL, LINK('Link de acesso ao checklist'), v('CODIGO', 'Código de validação do acesso')],
    defaultSubject: 'Documentos do Imposto de Renda {{ANO_EXERCICIO}}',
    defaultBody: wrap(
      '<p>Já está disponível o checklist da sua declaração de Imposto de Renda {{ANO_EXERCICIO}} (ano-calendário {{ANO_CALENDARIO}}).</p><p>Acesse pelo link abaixo, confirme os itens do ano anterior e anexe os documentos. Para entrar, informe seu CPF e o código <strong>{{CODIGO}}</strong>.</p><p><a href="{{LINK}}">Abrir meu checklist</a></p>',
    ),
  },
  {
    key: 'checklist_pdf',
    name: 'Checklist DIRPF (PDF)',
    description: 'Envio do checklist em PDF anexo.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO],
    defaultSubject: 'Checklist do Imposto de Renda {{ANO_EXERCICIO}}',
    defaultBody: wrap('<p>Segue em anexo a lista de documentos necessários para a sua declaração de Imposto de Renda {{ANO_EXERCICIO}}.</p>'),
  },
  {
    key: 'darf',
    name: 'DARF do Imposto de Renda',
    description: 'Envio da guia DARF da quota do imposto.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, v('VALOR', 'Valor da quota'), v('VENCIMENTO', 'Data de vencimento'), LINK('Link da guia DARF')],
    defaultSubject: 'DARF do Imposto de Renda — vencimento {{VENCIMENTO}}',
    defaultBody: wrap('<p>Sua guia DARF do Imposto de Renda {{ANO_EXERCICIO}} no valor de <strong>{{VALOR}}</strong> vence em <strong>{{VENCIMENTO}}</strong>.</p><p><a href="{{LINK}}">Baixar DARF</a></p>'),
  },
  {
    key: 'customer_document',
    name: 'Documento para o cliente',
    description: 'Envio de documento avulso (declaração, recibo de entrega, relatórios).',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO],
    defaultSubject: 'Documentos do Imposto de Renda {{ANO_EXERCICIO}}',
    defaultBody: wrap('<p>Enviamos em anexo os documentos referentes ao seu Imposto de Renda {{ANO_EXERCICIO}}.</p>'),
  },
  {
    key: 'missing_document',
    name: 'Documentos faltantes',
    description: 'Lista de pendências de documentos com data limite.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, v('PENDENCIAS', 'Lista HTML das pendências')],
    defaultSubject: 'Pendências na sua declaração {{ANO_EXERCICIO}}',
    defaultBody: wrap('<p>Para concluirmos sua declaração {{ANO_EXERCICIO}}, ainda precisamos dos seguintes documentos:</p>{{PENDENCIAS}}'),
  },
  {
    key: 'monthly',
    name: 'E-mail mensal',
    description: 'Comunicado mensal livre para a carteira.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR],
    defaultSubject: 'Novidades do mês — {{ESCRITORIO}}',
    defaultBody: wrap('<p>Confira as novidades e lembretes deste mês.</p>'),
  },
  {
    key: 'marketing',
    name: 'Marketing',
    description: 'Campanhas e oferta de serviços.',
    variables: [CLIENTE, ESCRITORIO],
    defaultSubject: '{{CLIENTE}}, temos uma novidade para você',
    defaultBody: '<p>Olá, {{CLIENTE}}!</p><p>O {{ESCRITORIO}} preparou uma novidade para você.</p>',
  },
  {
    key: 'budget',
    name: 'Orçamento',
    description: 'Cópia da proposta de honorários, sem link de aprovação: vai quando o escritório envia ao cliente um orçamento já aprovado. O envio para aprovação (etapa Orçamento e mala direta) usa o “Orçamento (digital)”, com o link.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, v('CATEGORIA', 'Categoria do serviço'), v('DESCRICAO', 'Descrição do orçamento'), v('VALOR', 'Valor total')],
    defaultSubject: 'Proposta de serviço — {{CATEGORIA}} {{ANO_EXERCICIO}}',
    defaultBody: wrap('<p>Segue nossa proposta para <strong>{{CATEGORIA}}</strong> ({{ANO_EXERCICIO}}):</p><p>{{DESCRICAO}}</p><p>Valor: <strong>{{VALOR}}</strong></p>'),
  },
  {
    key: 'budget_digital',
    name: 'Orçamento (digital)',
    description: 'Proposta com link para aprovação online.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, v('CATEGORIA', 'Categoria do serviço'), v('DESCRICAO', 'Descrição do orçamento'), v('VALOR', 'Valor total'), LINK('Link de aprovação')],
    defaultSubject: 'Aprove sua proposta — {{CATEGORIA}} {{ANO_EXERCICIO}}',
    defaultBody: wrap('<p>Preparamos sua proposta para <strong>{{CATEGORIA}}</strong> ({{ANO_EXERCICIO}}) no valor de <strong>{{VALOR}}</strong>.</p><p>{{DESCRICAO}}</p><p><a href="{{LINK}}">Ver e aprovar a proposta</a></p>'),
  },
  {
    key: 'planning',
    name: 'Planejamento DIRPF',
    description: 'Comunicado de planejamento para o próximo exercício.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, v('ANO_ANTERIOR', 'Ano anterior ao exercício'), v('PROXIMO_ANO', 'Ano seguinte ao exercício')],
    defaultSubject: 'Planejamento do Imposto de Renda {{PROXIMO_ANO}}',
    defaultBody: wrap('<p>Com a declaração {{ANO_EXERCICIO}} concluída, é hora de planejar {{PROXIMO_ANO}}. Separe ao longo do ano os comprovantes de despesas médicas, educação e previdência.</p>'),
  },
  {
    key: 'authorization',
    name: 'Documento de autorização',
    description: 'Texto do termo de autorização para o escritório elaborar e transmitir a declaração.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, ANO_CAL, v('CPF_CLIENTE', 'CPF/CNPJ do cliente'), v('CPF_CONTADOR', 'CPF/CNPJ do escritório'), v('CIDADE_CLIENTE', 'Cidade do cliente'), v('DATA', 'Data de emissão')],
    defaultSubject: 'Autorização — Imposto de Renda {{ANO_EXERCICIO}}',
    defaultBody:
      '<p>Eu, {{CLIENTE}}, inscrito(a) no CPF {{CPF_CLIENTE}}, autorizo {{ESCRITORIO}} (CPF/CNPJ {{CPF_CONTADOR}}) a elaborar e transmitir minha Declaração de Ajuste Anual do Imposto de Renda Pessoa Física do exercício {{ANO_EXERCICIO}}, ano-calendário {{ANO_CALENDARIO}}, com base nas informações e documentos que forneci.</p><p>{{CIDADE_CLIENTE}}, {{DATA}}.</p><p>______________________________<br/>{{CLIENTE}}</p>',
  },
  {
    key: 'receipt',
    name: 'Recibo',
    description: 'Texto do recibo de honorários.',
    variables: [CLIENTE, ESCRITORIO, v('CPF_CLIENTE', 'CPF/CNPJ do cliente'), v('EMAIL_CLIENTE', 'E-mail do cliente'), v('ENDERECO_CLIENTE', 'Endereço do cliente'), v('TELEFONE_CLIENTE', 'Telefone do cliente'), v('VALOR', 'Valor recebido'), v('VALOR_EXTENSO', 'Valor por extenso'), v('ANO_REFERENCIA', 'Ano de referência'), v('VENCIMENTO', 'Data de vencimento'), v('DATA', 'Data de emissão')],
    defaultSubject: 'Recibo de pagamento — {{ESCRITORIO}}',
    defaultBody:
      '<p>Recebemos de {{CLIENTE}} (CPF/CNPJ {{CPF_CLIENTE}}) a importância de <strong>{{VALOR}}</strong> ({{VALOR_EXTENSO}}), referente aos serviços de Imposto de Renda {{ANO_REFERENCIA}}, com vencimento em {{VENCIMENTO}}.</p><p>{{ESCRITORIO}} — {{DATA}}</p>',
  },
  {
    key: 'procuration_tutorial',
    name: 'Tutorial de procuração (PF)',
    description: 'Passo a passo para o cliente cadastrar a procuração eletrônica.',
    variables: [CLIENTE, ESCRITORIO, ANO, v('CPF_PROCURADOR', 'CPF/CNPJ do procurador')],
    defaultSubject: 'Como cadastrar a procuração eletrônica para o {{ESCRITORIO}}',
    defaultBody:
      '<p>Olá, {{CLIENTE}}!</p><p>Para acompanharmos sua declaração {{ANO_EXERCICIO}} no eCAC, cadastre uma procuração eletrônica para o CPF/CNPJ <strong>{{CPF_PROCURADOR}}</strong>:</p><ol><li>Entre no eCAC com sua conta gov.br (nível prata ou ouro).</li><li>Acesse Senhas e Procurações › Cadastro, Consulta e Cancelamento › Cadastro de Procuração.</li><li>Informe o CPF/CNPJ acima, a validade e marque os serviços solicitados.</li></ol><p>{{ESCRITORIO}}</p>',
  },
  {
    key: 'whatsapp_tutorial',
    name: 'Tutorial WhatsApp',
    description: 'Orienta o cliente a salvar o número de atendimento do escritório.',
    variables: [CLIENTE, ESCRITORIO, ANO, v('WHATSAPP', 'Número de WhatsApp do escritório')],
    defaultSubject: 'Fale com o {{ESCRITORIO}} pelo WhatsApp',
    defaultBody: '<p>Olá, {{CLIENTE}}!</p><p>Salve nosso número de atendimento <strong>{{WHATSAPP}}</strong> para receber avisos da sua declaração {{ANO_EXERCICIO}}.</p><p>{{ESCRITORIO}}</p>',
  },
  {
    key: 'charge',
    name: 'Cobrança dos honorários',
    description: 'Link de pagamento da parcela dos honorários (boleto ou Pix), enviado quando a cobrança é emitida.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, v('CATEGORIA', 'Categoria do serviço'), v('PARCELA', 'Número da parcela, ex.: 1/3'), v('VALOR', 'Valor da parcela'), v('VENCIMENTO', 'Data de vencimento'), LINK('Link de pagamento')],
    defaultSubject: 'Cobrança dos honorários — vencimento {{VENCIMENTO}}',
    defaultBody: wrap(
      '<p>A cobrança da parcela {{PARCELA}} dos honorários de {{CATEGORIA}} {{ANO_EXERCICIO}}, no valor de <strong>{{VALOR}}</strong>, vence em <strong>{{VENCIMENTO}}</strong>.</p><p><a href="{{LINK}}">Pagar agora</a></p>',
    ),
  },
  {
    key: 'installment_reminder',
    name: 'Lembrete de vencimento dos honorários',
    description: 'Lembrete enviado alguns dias antes do vencimento da parcela dos honorários.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, v('PARCELA', 'Número da parcela, ex.: 1/3'), v('VALOR', 'Valor da parcela'), v('VENCIMENTO', 'Data de vencimento'), LINK('Link de pagamento (vazio quando não há cobrança emitida)')],
    defaultSubject: 'Lembrete: honorários vencem em {{VENCIMENTO}}',
    defaultBody: wrap('<p>A parcela {{PARCELA}} dos honorários, no valor de <strong>{{VALOR}}</strong>, vence em <strong>{{VENCIMENTO}}</strong>.</p><p><a href="{{LINK}}">Ver cobrança</a></p>'),
  },
  {
    key: 'installment_overdue',
    name: 'Honorários vencidos',
    description: 'Aviso enviado uma vez quando a parcela dos honorários fica vencida.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, v('PARCELA', 'Número da parcela, ex.: 1/3'), v('VALOR', 'Valor da parcela'), v('VENCIMENTO', 'Data de vencimento'), LINK('Link de pagamento (vazio quando não há cobrança emitida)')],
    defaultSubject: 'Honorários em aberto desde {{VENCIMENTO}}',
    defaultBody: wrap('<p>Não identificamos o pagamento da parcela {{PARCELA}} dos honorários, no valor de <strong>{{VALOR}}</strong>, vencida em <strong>{{VENCIMENTO}}</strong>.</p><p>Se você já pagou, desconsidere este aviso.</p><p><a href="{{LINK}}">Ver cobrança</a></p>'),
  },
  {
    key: 'darf_reminder',
    name: 'Lembrete de vencimento do DARF',
    description: 'Lembrete enviado alguns dias antes do vencimento da quota do imposto.',
    variables: [CLIENTE, ESCRITORIO, CONTADOR, ANO, v('QUOTA', 'Número da quota'), v('VALOR', 'Valor da quota'), v('VENCIMENTO', 'Data de vencimento'), LINK('Link do portal do cliente')],
    defaultSubject: 'Lembrete: DARF do Imposto de Renda vence em {{VENCIMENTO}}',
    defaultBody: wrap('<p>A quota {{QUOTA}} do seu Imposto de Renda {{ANO_EXERCICIO}}, no valor de <strong>{{VALOR}}</strong>, vence em <strong>{{VENCIMENTO}}</strong>.</p><p>A guia está disponível no <a href="{{LINK}}">portal do cliente</a>.</p>'),
  },
];

export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key);

export function getTemplateDef(key: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

/**
 * Apelidos de tags: nomes que os escritórios trazem de modelos de outros sistemas e a variável
 * do Verifco equivalente. A chave vem normalizada (maiúsculas, sem acentos). Além destes, o nome
 * de qualquer variável do Verifco vale em qualquer caixa e com acento (`{{Cliente}}`,
 * `{{Escritório}}`).
 */
export const TEMPLATE_TAG_ALIASES: Record<string, string> = {
  CUSTOMER_NAME: 'CLIENTE',
  FORMULARY_URL: 'LINK',
};

/** Uma tag `{{...}}`: letras (com acento), números e sublinhado, com espaços opcionais em volta. */
const TAG = /\{\{\s*([\p{L}\p{N}_]+)\s*\}\}/gu;

/**
 * Nome da variável do Verifco para uma tag como foi escrita: tira os acentos, passa para
 * maiúsculas e troca o apelido pelo nome oficial. Não diz se a variável existe: quem decide é o
 * template (`unknownVariables`) e os valores do envio (`renderTemplate`).
 */
export function resolveTemplateTag(name: string): string {
  const key = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  return Object.hasOwn(TEMPLATE_TAG_ALIASES, key) ? TEMPLATE_TAG_ALIASES[key] : key;
}

/**
 * Substitui `{{VAR}}` pelos valores informados. Valores são escapados para HTML,
 * exceto os listados em `rawHtml` (ex.: PENDENCIAS, que já é uma lista montada pelo sistema).
 * Apelidos ({@link TEMPLATE_TAG_ALIASES}) e nomes fora da caixa alta são trocados pela variável
 * equivalente; tag que não corresponde a nenhum valor fica como foi escrita.
 */
export function renderTemplate(
  text: string,
  values: Record<string, string | number | null | undefined>,
  opts: { html?: boolean; rawHtml?: string[] } = {},
): string {
  const { html = true, rawHtml = [] } = opts;
  return text.replace(TAG, (match, written: string) => {
    // só valores informados: `{{constructor}}` não pode cair nas propriedades herdadas do objeto
    const name = Object.hasOwn(values, written) ? written : resolveTemplateTag(written);
    if (!Object.hasOwn(values, name)) return match;
    const raw = values[name];
    const str = raw === null || raw === undefined ? '' : String(raw);
    return html && !rawHtml.includes(name) ? escapeHtml(str) : str;
  });
}

/**
 * Lista as tags usadas num texto que não pertencem ao template, como foram escritas (um apelido
 * de variável que o template não tem também entra: `{{FORMULARY_URL}}` num modelo sem link).
 */
export function unknownVariables(text: string, def: TemplateDef): string[] {
  const allowed = new Set(def.variables.map((x) => x.name));
  const found = [...text.matchAll(TAG)].map((m) => m[1]);
  return [...new Set(found.filter((n) => !allowed.has(n) && !allowed.has(resolveTemplateTag(n))))];
}
