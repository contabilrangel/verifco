import { describe, expect, it } from 'vitest';
import { IMPORT_KINDS, IMPORT_KIND_LIST, IMPORT_MAX_ROWS, isImportKind, isPermission } from '../src';

describe('importações em lote', () => {
  it('cada tipo usa uma permissão existente do catálogo', () => {
    for (const k of IMPORT_KIND_LIST) expect(isPermission(k.permission)).toBe(true);
  });

  it('reconhece os tipos da URL e deixa orçamentos para o financeiro', () => {
    expect(isImportKind('novos-clientes')).toBe(true);
    expect(isImportKind('ecac')).toBe(true);
    expect(isImportKind('orcamentos')).toBe(false);
    expect(isImportKind('toString')).toBe(false);
    expect(Object.keys(IMPORT_KINDS)).toHaveLength(4);
  });

  it('não pede mais a senha gov.br do INSS: sem importação nem permissão (COB-7)', () => {
    expect(isImportKind('inss')).toBe(false);
    expect(isPermission('worksheet.inss')).toBe(false);
    expect(isPermission('worksheet.ecac')).toBe(true);
  });

  it('marca as planilhas com senha e o limite de linhas', () => {
    expect(IMPORT_KIND_LIST.filter((k) => k.hasSecrets).map((k) => k.slug)).toEqual(['ecac']);
    expect(IMPORT_MAX_ROWS).toBe(5000);
  });
});
