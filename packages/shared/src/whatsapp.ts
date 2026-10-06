/**
 * WhatsApp: modelos aprovados da Meta usados fora da janela de 24 h e celulares brasileiros.
 *
 * Na WhatsApp Cloud API (Meta), mensagem livre só é entregue até 24 h depois da última mensagem
 * do cliente; fora disso é preciso um modelo aprovado (tipo `template`). O escritório informa, por
 * tipo de envio, o nome e o idioma do modelo e quais variáveis do Verifco preenchem os parâmetros,
 * uma linha por tipo:
 *
 *   tipo = nome_do_modelo | idioma | VARIÁVEL, VARIÁVEL... | documento
 *
 * - tipo: a chave de um template do Verifco (`darf`, `checklist_digital`...), `mensagem` (aba
 *   Mensagens) ou `padrao` (qualquer envio sem linha própria);
 * - idioma: código da Meta (`pt_BR`); vazio usa `pt_BR`;
 * - variáveis: na ordem de {{1}}, {{2}}... ou `parametro=VARIÁVEL` para parâmetros nomeados;
 *   `MENSAGEM` é o texto inteiro do envio, em uma linha;
 * - documento: o modelo tem cabeçalho de documento e leva o PDF do envio.
 */
import { TEMPLATES } from './templates';
import { onlyDigits } from './validators';

export const WHATSAPP_FREE_TEXT_TYPE = 'mensagem';
export const WHATSAPP_DEFAULT_TYPE = 'padrao';
/** Texto inteiro do envio (quebras de linha viram espaço, como a Meta exige nos parâmetros). */
export const WHATSAPP_MESSAGE_VARIABLE = 'MENSAGEM';
export const WHATSAPP_DEFAULT_LANGUAGE = 'pt_BR';
/** Janela de atendimento da Meta: mensagem livre só até 24 h depois da última do cliente. */
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const COMMON_VARIABLES = ['CLIENTE', 'ESCRITORIO', 'CONTADOR'];

export interface WhatsAppTemplateType {
  key: string;
  label: string;
  variables: string[];
}

/** Tipos de envio que aceitam modelo, com as variáveis disponíveis em cada um. */
export const WHATSAPP_TEMPLATE_TYPES: WhatsAppTemplateType[] = [
  ...TEMPLATES.map((t) => ({
    key: t.key,
    label: t.name,
    variables: [...new Set([...COMMON_VARIABLES, ...t.variables.map((v) => v.name), WHATSAPP_MESSAGE_VARIABLE])],
  })),
  { key: WHATSAPP_FREE_TEXT_TYPE, label: 'Mensagem avulsa (aba Mensagens)', variables: [...COMMON_VARIABLES, WHATSAPP_MESSAGE_VARIABLE] },
  { key: WHATSAPP_DEFAULT_TYPE, label: 'Qualquer envio sem modelo próprio', variables: [...COMMON_VARIABLES, WHATSAPP_MESSAGE_VARIABLE] },
];

export interface WhatsAppTemplateParam {
  /** Variável do Verifco que preenche o parâmetro. */
  variable: string;
  /** Nome do parâmetro no modelo (parâmetros nomeados); `null` = posicional ({{1}}, {{2}}...). */
  name: string | null;
}

export interface WhatsAppTemplateConfig {
  type: string;
  name: string;
  language: string;
  params: WhatsAppTemplateParam[];
  /** O modelo tem cabeçalho de documento (leva o PDF do envio). */
  document: boolean;
}

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2,4})?$/;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,59}$/;

/** Lê a configuração dos modelos (uma linha por tipo). Linhas vazias e iniciadas por # são ignoradas. */
export function parseWhatsAppTemplates(text: string | null | undefined): { templates: WhatsAppTemplateConfig[]; errors: string[] } {
  const types = new Map(WHATSAPP_TEMPLATE_TYPES.map((t) => [t.key, t]));
  const templates: WhatsAppTemplateConfig[] = [];
  const errors: string[] = [];
  (text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const n = i + 1;
    const eq = line.indexOf('=');
    if (eq < 1) {
      errors.push(`Linha ${n}: use “tipo = nome_do_modelo | idioma | variáveis”.`);
      return;
    }
    const type = line.slice(0, eq).trim().toLowerCase();
    const def = types.get(type);
    if (!def) {
      errors.push(`Linha ${n}: o tipo de envio “${type}” não existe.`);
      return;
    }
    if (templates.some((t) => t.type === type)) {
      errors.push(`Linha ${n}: o tipo “${type}” já tem um modelo.`);
      return;
    }
    const parts = line.slice(eq + 1).split('|').map((s) => s.trim());
    if (parts.length > 4) {
      errors.push(`Linha ${n}: partes demais; use “nome | idioma | variáveis | documento”.`);
      return;
    }
    const [name = '', language = '', vars = '', flag = ''] = parts;
    if (!TEMPLATE_NAME.test(name)) {
      errors.push(`Linha ${n}: o nome do modelo usa só letras minúsculas, números e _.`);
      return;
    }
    if (language && !LANGUAGE.test(language)) {
      errors.push(`Linha ${n}: idioma “${language}” inválido; use o código da Meta, como pt_BR.`);
      return;
    }
    if (flag && flag.toLowerCase() !== 'documento') {
      errors.push(`Linha ${n}: no fim da linha, só “documento” (modelo com PDF no cabeçalho).`);
      return;
    }
    const params: WhatsAppTemplateParam[] = [];
    for (const item of vars ? vars.split(',').map((s) => s.trim()) : []) {
      const named = item.includes('=');
      const [pName, variable] = named ? item.split('=').map((s) => s.trim()) : [null, item];
      const upper = (variable ?? '').toUpperCase();
      if (named && !PARAM_NAME.test(pName ?? '')) {
        errors.push(`Linha ${n}: o nome do parâmetro “${pName}” usa só letras minúsculas, números e _.`);
        return;
      }
      if (!def.variables.includes(upper)) {
        errors.push(`Linha ${n}: a variável “${variable}” não existe para “${type}” (use ${def.variables.join(', ')}).`);
        return;
      }
      params.push({ variable: upper, name: named ? pName! : null });
    }
    if (params.some((p) => p.name) && params.some((p) => !p.name)) {
      errors.push(`Linha ${n}: use só parâmetros posicionais ou só nomeados.`);
      return;
    }
    templates.push({ type, name, language: language || WHATSAPP_DEFAULT_LANGUAGE, params, document: Boolean(flag) });
  });
  return { templates, errors };
}

/** Modelo do tipo de envio (ou o padrão); mensagens sem template usam o tipo `mensagem`. */
export function whatsappTemplateFor(templates: WhatsAppTemplateConfig[], templateKey: string | null | undefined): WhatsAppTemplateConfig | null {
  const type = templateKey || WHATSAPP_FREE_TEXT_TYPE;
  return templates.find((t) => t.type === type) ?? templates.find((t) => t.type === WHATSAPP_DEFAULT_TYPE) ?? null;
}

/**
 * Valor de um parâmetro de modelo: a Meta recusa quebra de linha, tabulação e mais de quatro
 * espaços seguidos; textos longos são cortados.
 */
export function whatsappTemplateParam(value: unknown, max = 1000): string {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || '-';
}

/**
 * Formas do mesmo celular brasileiro: com e sem o 55 e com e sem o nono dígito (o WhatsApp
 * informa alguns números antigos sem o 9). Outros números voltam só com os dígitos.
 */
export function brazilPhoneVariants(phone: string | null | undefined): string[] {
  const digits = onlyDigits(phone);
  if (!digits) return [];
  const national = (digits.length === 12 || digits.length === 13) && digits.startsWith('55') ? digits.slice(2) : digits;
  if (national.length !== 10 && national.length !== 11) return [digits];
  const list = new Set([national]);
  if (national.length === 11 && national[2] === '9') list.add(national.slice(0, 2) + national.slice(3));
  if (national.length === 10 && /[6-9]/.test(national[2])) list.add(`${national.slice(0, 2)}9${national.slice(2)}`);
  for (const n of [...list]) list.add(`55${n}`);
  return [...list];
}
