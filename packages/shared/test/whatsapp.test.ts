import { describe, expect, it } from 'vitest';
import { brazilPhoneVariants, getIntegrationDef, parseWhatsAppTemplates, whatsappTemplateFor, whatsappTemplateParam } from '../src';

describe('modelos aprovados do WhatsApp (COB-8)', () => {
  it('lê nome, idioma, variáveis posicionais ou nomeadas e o cabeçalho com documento', () => {
    const { templates, errors } = parseWhatsAppTemplates(
      [
        '# comentário',
        'darf = aviso_darf | pt_BR | CLIENTE, VALOR, VENCIMENTO | documento',
        '',
        'mensagem = nova_mensagem |  | nome=CLIENTE, texto=mensagem',
        'padrao = aviso_geral',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(templates).toEqual([
      {
        type: 'darf',
        name: 'aviso_darf',
        language: 'pt_BR',
        params: [
          { variable: 'CLIENTE', name: null },
          { variable: 'VALOR', name: null },
          { variable: 'VENCIMENTO', name: null },
        ],
        document: true,
      },
      {
        type: 'mensagem',
        name: 'nova_mensagem',
        language: 'pt_BR',
        params: [
          { variable: 'CLIENTE', name: 'nome' },
          { variable: 'MENSAGEM', name: 'texto' },
        ],
        document: false,
      },
      { type: 'padrao', name: 'aviso_geral', language: 'pt_BR', params: [], document: false },
    ]);
    expect(whatsappTemplateFor(templates, 'darf')?.name).toBe('aviso_darf');
    expect(whatsappTemplateFor(templates, null)?.name).toBe('nova_mensagem');
    expect(whatsappTemplateFor(templates, 'budget')?.name).toBe('aviso_geral');
    expect(whatsappTemplateFor([], 'darf')).toBeNull();
  });

  it('explica cada linha inválida em português', () => {
    const { errors } = parseWhatsAppTemplates(
      [
        'sem igual',
        'xyz = modelo',
        'darf = Modelo-Com-Maiusculas',
        'darf = aviso | portugues',
        'darf = aviso | pt_BR | CODIGO',
        'checklist_pdf = aviso | pt_BR | CLIENTE | anexo',
        'budget = aviso | pt_BR | CLIENTE, nome=VALOR',
        'monthly = a | pt_BR',
        'monthly = b | pt_BR',
      ].join('\n'),
    );
    expect(errors).toEqual([
      'Linha 1: use “tipo = nome_do_modelo | idioma | variáveis”.',
      'Linha 2: o tipo de envio “xyz” não existe.',
      'Linha 3: o nome do modelo usa só letras minúsculas, números e _.',
      'Linha 4: idioma “portugues” inválido; use o código da Meta, como pt_BR.',
      expect.stringContaining('Linha 5: a variável “CODIGO” não existe para “darf”'),
      'Linha 6: no fim da linha, só “documento” (modelo com PDF no cabeçalho).',
      'Linha 7: use só parâmetros posicionais ou só nomeados.',
      'Linha 9: o tipo “monthly” já tem um modelo.',
    ]);
    // a validação do campo usa o mesmo leitor
    const field = getIntegrationDef('whatsapp')!.fields.find((f) => f.key === 'templates')!;
    expect(field.validate!('darf = aviso_darf')).toBeNull();
    expect(field.validate!('xyz = a')).toContain('não existe');
  });

  it('parâmetros sem quebra de linha, tabulação nem espaços repetidos', () => {
    expect(whatsappTemplateParam('Linha 1\n\nLinha\t2     fim')).toBe('Linha 1 Linha 2 fim');
    expect(whatsappTemplateParam('')).toBe('-');
    expect(whatsappTemplateParam('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('celular brasileiro com e sem 55 e nono dígito', () => {
  it('gera as formas equivalentes do número', () => {
    expect(brazilPhoneVariants('5511987654321').sort()).toEqual(['1187654321', '11987654321', '551187654321', '5511987654321'].sort());
    expect(brazilPhoneVariants('551187654321').sort()).toEqual(['1187654321', '11987654321', '551187654321', '5511987654321'].sort());
    expect(brazilPhoneVariants('(11) 3456-7890').sort()).toEqual(['1134567890', '551134567890'].sort());
    expect(brazilPhoneVariants('+1 415 555 0100 22')).toEqual(['1415555010022']);
    expect(brazilPhoneVariants('')).toEqual([]);
  });
});
