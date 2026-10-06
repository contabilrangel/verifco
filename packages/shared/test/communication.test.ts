import { describe, expect, it } from 'vitest';
import {
  INDIVIDUAL_REPORTS,
  MAILING_SKIP_REASONS,
  MAILING_TYPES,
  annualProgressiveTax,
  compareTaxation,
  decodeHtmlEntities,
  escapeHtml,
  fineMeshCheck,
  getMailingType,
  htmlToText,
  isSafeUrl,
  mailingTypeForTemplate,
  renderTemplate,
  sanitizeHtml,
  type DeclarationItem,
} from '../src';

describe('sanitizeHtml', () => {
  it('remove scripts, eventos e javascript:', () => {
    const dirty =
      '<p onclick="alert(1)">Olá <b>{{CLIENTE}}</b></p><script>alert("x")</script><a href="javascript:alert(1)">x</a>' +
      '<a href="JaVa&#x53;cript:alert(1)">y</a><img src=x onerror=alert(1)><iframe src="//mal.com"></iframe>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toMatch(/script/i);
    expect(clean).not.toMatch(/onclick|onerror/i);
    expect(clean).not.toMatch(/iframe/i);
    expect(clean).toContain('<b>{{CLIENTE}}</b>');
    expect(clean).toContain('<a>x</a>');
  });

  it('mantém links, imagens, cores e variáveis em atributos', () => {
    const html = '<p style="color: #ff0000">Texto</p><a href="{{LINK}}" target="_blank">Abrir</a><img src="https://ex.com/a.png" alt="logo"><ul><li>Item</li></ul><h2>Título</h2>';
    const clean = sanitizeHtml(html);
    expect(clean).toContain('style="color: #ff0000"');
    expect(clean).toContain('href="{{LINK}}"');
    expect(clean).toContain('rel="noopener noreferrer"');
    expect(clean).toContain('<img src="https://ex.com/a.png" alt="logo" />');
    expect(clean).toContain('<ul><li>Item</li></ul><h2>Título</h2>');
  });

  it('descarta estilos perigosos e tags incompletas', () => {
    expect(sanitizeHtml('<p style="background:url(javascript:alert(1))">a</p>')).toBe('<p>a</p>');
    expect(sanitizeHtml('a <img src=x onerror=alert(1)')).toBe('a &lt;img src=x onerror=alert(1)');
    expect(sanitizeHtml('<script>sem fim')).toBe('');
    expect(isSafeUrl('java\nscript:alert(1)')).toBe(false);
    expect(isSafeUrl('mailto:a@b.com')).toBe(true);
    expect(isSafeUrl('data:text/html;base64,xx', 'src')).toBe(false);
    // referência numérica fora do Unicode não derruba a sanitização
    expect(sanitizeHtml('<a href="&#x110000;x">y</a>')).toBe('<a href="&#x110000;x">y</a>');
  });
});

describe('HTML para texto (CON-5)', () => {
  it('um só conversor: decodifica todas as entidades e quebra a linha em br, p, div, títulos e itens com atributos', () => {
    const html = renderTemplate('<div>Olá, {{CLIENTE}}!</div><div class="x">Prazo "final" &amp; multa&nbsp;&#8212; &eacute;poca</div><h2 style="color:red">Itens</h2><ul><li class="a">Um</li><li>Dois</li></ul><p>Fim<br class="q">linha</p>', {
      CLIENTE: "Maria D'Ávila",
    });
    expect(html).toContain('D&#39;Ávila');
    expect(htmlToText(html)).toBe(`Olá, Maria D'Ávila!\nPrazo "final" & multa — época\nItens\n• Um\n• Dois\nFim\nlinha`);
  });

  it('links com o endereço, texto de PDF com linha em branco entre parágrafos e escape uma vez só', () => {
    const html = '<p>Acesse <a href="https://ex.com/a?b=1&amp;c=2" target="_blank">o portal</a>.</p><p><a href="https://ex.com">https://ex.com</a></p>';
    expect(htmlToText(html)).toBe('Acesse o portal: https://ex.com/a?b=1&c=2.\nhttps://ex.com');
    expect(htmlToText(html, { linksInParens: true, blankLines: true })).toBe('Acesse o portal (https://ex.com/a?b=1&c=2).\n\nhttps://ex.com');
    // entidade escapada continua literal (uma decodificação só)
    expect(decodeHtmlEntities('&amp;lt;b&amp;gt; &#39;x&#39; &quot;y&quot; &desconhecida;')).toBe(`&lt;b&gt; 'x' "y" &desconhecida;`);
    expect(htmlToText('<p>a &lt;b&gt; c</p>')).toBe('a <b> c');
    expect(escapeHtml(`<a href="x">D'Ávila & cia</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;D&#39;Ávila &amp; cia&lt;/a&gt;');
    expect(htmlToText(escapeHtml(`D'Ávila "&" <cia>`))).toBe(`D'Ávila "&" <cia>`);
  });
});

describe('IRPF', () => {
  it('aplica a tabela progressiva anual (fonte única: irpf-annual)', () => {
    expect(annualProgressiveTax(2_696_320, 2025)).toBe(0);
    expect(annualProgressiveTax(3_000_000, 2025)).toBe(22_776);
    expect(annualProgressiveTax(6_000_000, 2025)).toBe(575_902);
    // exercício 2024 tem tabela própria (antes caía na de 2025)
    expect(annualProgressiveTax(3_000_000, 2024)).toBe(41_161);
  });

  it('compara completa e simplificada', () => {
    const items: DeclarationItem[] = [
      { kind: 'income_pj', valueCents: 12_000_000, withheldCents: 1_500_000, counterpartyDoc: '11222333000181', extra: { officialPensionCents: 1_000_000 } },
      { kind: 'dependent', counterpartyDoc: '39053344705', extra: { relationship: 'child' } },
      { kind: 'payment', valueCents: 2_000_000, counterpartyDoc: '11144477735', extra: { nature: 'health' } },
      { kind: 'payment', valueCents: 500_000, counterpartyDoc: '11222333000181', extra: { nature: 'education' } },
    ];
    const r = compareTaxation({ exerciseYear: 2025, items, currentTaxation: 'simplified' });
    expect(r.complete.deductionsCents).toBe(3_583_658);
    expect(r.complete.taxCents).toBe(1_240_396);
    expect(r.simplified.taxCents).toBe(1_765_158);
    expect(r.best).toBe('complete');
    expect(r.savingsCents).toBe(524_762);
    expect(r.complete.resultCents).toBe(-259_604);
    expect(r.suggestions[0]).toMatch(/completa reduziria/);
    expect(r.suggestions.some((s) => /PGBL/.test(s))).toBe(true);
  });
});

describe('malha fina', () => {
  it('aponta caixa negativo, dependentes repetidos, PF sem carnê-leão e despesa médica alta', () => {
    const items: DeclarationItem[] = [
      { kind: 'income_pj', valueCents: 6_000_000, counterpartyDoc: '11222333000181' },
      { kind: 'income_pf', valueCents: 4_000_000 },
      { kind: 'payment', valueCents: 3_000_000, extra: { nature: 'health' } },
      { kind: 'dependent', counterpartyDoc: '39053344705' },
      { kind: 'dependent', counterpartyDoc: '390.533.447-05' },
      { kind: 'asset', groupCode: '01', prevValueCents: 0, valueCents: 50_000_000 },
    ];
    const points = fineMeshCheck({ exerciseYear: 2025, taxation: 'complete', items, holderCpf: '52998224725' });
    const keys = points.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['negative_cash', 'patrimony_incompatible', 'high_medical', 'payment_without_doc', 'pf_income_without_carne_leao', 'duplicate_dependents']));
    expect(points[0].severity).toBe('high');
    expect(points.find((p) => p.key === 'high_medical')!.severity).toBe('medium');
  });

  it('não aponta nada numa declaração equilibrada', () => {
    const items: DeclarationItem[] = [
      { kind: 'income_pj', valueCents: 10_000_000, withheldCents: 1_000_000, counterpartyDoc: '11222333000181' },
      { kind: 'payment', valueCents: 500_000, counterpartyDoc: '11144477735', extra: { nature: 'health' } },
      { kind: 'asset', groupCode: '06', prevValueCents: 1_000_000, valueCents: 3_000_000 },
    ];
    expect(fineMeshCheck({ exerciseYear: 2025, taxation: 'complete', items })).toEqual([]);
  });
});

describe('catálogos', () => {
  it('cada tipo de mala direta e relatório tem permissão', () => {
    expect(MAILING_TYPES.every((t) => t.permission && t.templateKey)).toBe(true);
    expect(INDIVIDUAL_REPORTS.every((r) => r.permission.startsWith('report.'))).toBe(true);
    expect(mailingTypeForTemplate('budget_digital')?.key).toBe('budget');
    expect(mailingTypeForTemplate('budget')?.key).toBe('budget');
    expect(mailingTypeForTemplate('planning')?.key).toBe('planning');
  });

  it('a mala direta de orçamento usa a proposta com link e os novos motivos de ficar de fora (INT-2, INT-5)', () => {
    expect(getMailingType('budget')?.templateKey).toBe('budget_digital');
    expect(MAILING_SKIP_REASONS.budget_approved).toBe('Orçamento já aprovado');
    expect(MAILING_SKIP_REASONS.checklist_locked).toBe('Checklist bloqueado ou só para consulta');
    expect(getMailingType('checklist_digital')?.note).not.toMatch(/portal/);
  });
});
