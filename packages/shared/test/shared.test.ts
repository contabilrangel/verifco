import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DOCUMENT_CATEGORY_LIST,
  PERMISSION_CATEGORIES,
  STAGE_SUBSTATUS,
  TEMPLATES,
  canShareWithCustomer,
  documentCategoryLabel,
  formatCpfCnpj,
  isValidCnpj,
  isValidCpf,
  renderTemplate,
  stageOfSubstatus,
  unknownVariables,
} from '../src';

describe('documentos', () => {
  it('valida CPF', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
  });
  it('valida CNPJ', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
  });
  it('formata', () => {
    expect(formatCpfCnpj('52998224725')).toBe('529.982.247-25');
    expect(formatCpfCnpj('11222333000181')).toBe('11.222.333/0001-81');
  });
});

describe('permissões', () => {
  it('não tem chaves repetidas', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    expect(PERMISSION_CATEGORIES.length).toBeGreaterThan(15);
  });
});

describe('etapas', () => {
  it('cada subestado pertence a uma etapa', () => {
    for (const [stage, list] of Object.entries(STAGE_SUBSTATUS)) {
      for (const s of list) expect(stageOfSubstatus(s)).toBe(stage);
    }
  });
});

describe('templates', () => {
  it('tem 14 modelos e todos usam só variáveis declaradas', () => {
    expect(TEMPLATES).toHaveLength(14);
    for (const t of TEMPLATES) {
      expect(unknownVariables(t.defaultSubject + t.defaultBody, t)).toEqual([]);
    }
  });
  it('escapa valores e preserva variáveis desconhecidas', () => {
    const out = renderTemplate('Olá {{CLIENTE}} {{X}}', { CLIENTE: '<b>Ana</b>' });
    expect(out).toBe('Olá &lt;b&gt;Ana&lt;/b&gt; {{X}}');
  });
  it('permite HTML bruto quando pedido', () => {
    expect(renderTemplate('{{PENDENCIAS}}', { PENDENCIAS: '<ul></ul>' }, { rawHtml: ['PENDENCIAS'] })).toBe('<ul></ul>');
  });
});

describe('documentos do cliente (INT-3)', () => {
  it('só arquivos do escritório ficam visíveis no portal, em qualquer categoria; categorias do sistema têm rótulo', () => {
    expect(canShareWithCustomer({ uploadedBy: 'office', category: 'darf' })).toBe(true);
    expect(canShareWithCustomer({ uploadedBy: 'customer', category: 'checklist' })).toBe(false);
    expect(canShareWithCustomer({ uploadedBy: 'sync', category: 'irpf_receipt' })).toBe(false);
    expect(canShareWithCustomer({ uploadedBy: 'office', category: 'copilot' })).toBe(false);
    for (const category of DOCUMENT_CATEGORY_LIST) expect(canShareWithCustomer({ uploadedBy: 'office', category })).toBe(true);
    // a visibilidade no portal é um campo do documento, não uma categoria
    expect(DOCUMENT_CATEGORY_LIST).not.toContain('shared_with_customer');
    expect(documentCategoryLabel('irpf_receipt')).toBe('Recibo de entrega (.REC)');
    expect(documentCategoryLabel('desconhecida')).toBe('desconhecida');
  });
});
