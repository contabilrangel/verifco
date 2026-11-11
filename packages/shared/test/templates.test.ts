import { describe, expect, it } from 'vitest';
import { TEMPLATES, TEMPLATE_TAG_ALIASES, getTemplateDef, renderTemplate, resolveTemplateTag, unknownVariables } from '../src';

const values = { CLIENTE: 'Ana & Cia', LINK: 'https://app.verifco.com.br/c/abc', ESCRITORIO: 'Contábil Sol' };

describe('apelidos de tags dos templates', () => {
  it('troca as tags coladas de outros sistemas pela variável equivalente do Verifco', () => {
    expect(TEMPLATE_TAG_ALIASES).toEqual({ CUSTOMER_NAME: 'CLIENTE', FORMULARY_URL: 'LINK' });
    const out = renderTemplate('Olá, {{Cliente}} / {{CUSTOMER_NAME}}! <a href="{{FORMULARY_URL}}">Abrir</a>', values);
    expect(out).toBe('Olá, Ana &amp; Cia / Ana &amp; Cia! <a href="https://app.verifco.com.br/c/abc">Abrir</a>');
    // no assunto (sem HTML) o valor não é escapado
    expect(renderTemplate('{{CUSTOMER_NAME}}', values, { html: false })).toBe('Ana & Cia');
  });

  it('aceita o nome da variável em qualquer caixa, com acento e com espaços nas chaves', () => {
    expect(renderTemplate('{{cliente}} · {{ Escritório }} · {{customer_name}} · {{Formulary_Url}}', values, { html: false })).toBe(
      'Ana & Cia · Contábil Sol · Ana & Cia · https://app.verifco.com.br/c/abc',
    );
    expect(resolveTemplateTag('Escritório')).toBe('ESCRITORIO');
    expect(resolveTemplateTag('FORMULARY_URL')).toBe('LINK');
    expect(resolveTemplateTag('CODIGO')).toBe('CODIGO');
  });

  it('o apelido respeita o HTML bruto da variável oficial', () => {
    expect(renderTemplate('{{Pendencias}}', { PENDENCIAS: '<ul><li>x</li></ul>' }, { rawHtml: ['PENDENCIAS'] })).toBe('<ul><li>x</li></ul>');
  });

  it('tag desconhecida não é aceita em silêncio: fica no texto e é apontada, em qualquer caixa', () => {
    const def = getTemplateDef('checklist_digital')!;
    const text = 'Oi {{Cliente}}, {{CUSTOMER_NAME}}: {{FORMULARY_URL}} {{Customer_Phone}} {{nome}} {{VALOR}}';
    expect(renderTemplate(text, values, { html: false })).toBe('Oi Ana & Cia, Ana & Cia: https://app.verifco.com.br/c/abc {{Customer_Phone}} {{nome}} {{VALOR}}');
    expect(unknownVariables(text, def)).toEqual(['Customer_Phone', 'nome', 'VALOR']);
  });

  it('apelido de variável que o template não tem também é apontado', () => {
    // o e-mail mensal não tem link: {{FORMULARY_URL}} não tem para onde ir
    const monthly = getTemplateDef('monthly')!;
    expect(unknownVariables('{{CUSTOMER_NAME}} {{FORMULARY_URL}}', monthly)).toEqual(['FORMULARY_URL']);
    expect(renderTemplate('{{FORMULARY_URL}}', { CLIENTE: 'Ana' })).toBe('{{FORMULARY_URL}}');
  });

  it('os apelidos apontam para variáveis que existem e não escondem nenhuma variável oficial', () => {
    const names = new Set(TEMPLATES.flatMap((t) => t.variables.map((v) => v.name)));
    for (const [alias, target] of Object.entries(TEMPLATE_TAG_ALIASES)) {
      expect(names.has(target), `${alias} → ${target}`).toBe(true);
      expect(names.has(alias), `${alias} é nome de variável oficial`).toBe(false);
    }
    // nomes oficiais continuam resolvendo para eles mesmos
    for (const n of names) expect(resolveTemplateTag(n)).toBe(n);
  });

  it('nomes de propriedades herdadas do objeto não viram valor', () => {
    const text = '{{constructor}} {{toString}} {{__proto__}} {{hasOwnProperty}}';
    expect(renderTemplate(text, values)).toBe(text);
    expect(unknownVariables(text, getTemplateDef('monthly')!)).toEqual(['constructor', 'toString', '__proto__', 'hasOwnProperty']);
  });

  it('o valor informado com o nome exato da tag vence o apelido', () => {
    expect(renderTemplate('{{CUSTOMER_NAME}}', { CUSTOMER_NAME: 'direto', CLIENTE: 'apelido' }, { html: false })).toBe('direto');
  });
});
