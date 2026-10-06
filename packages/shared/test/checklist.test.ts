import { describe, expect, it } from 'vitest';
import { buildChecklistDrafts, checklistLock, checklistProgress, checklistUploadMime, customerDeclarationStatus, type DeclarationItem } from '../src';

const CPF = '52998224725';

describe('montagem do checklist', () => {
  it('usa as linhas do ano anterior e agrupa por fonte pagadora', () => {
    const prev: DeclarationItem[] = [
      { kind: 'dependent', ownerName: 'João', ownerCpf: '111.444.777-35' },
      { kind: 'income_pj', counterpartyName: 'Empresa X', counterpartyDoc: '11222333000181', ownerCpf: CPF },
      { kind: 'income_exclusive', counterpartyName: 'Empresa X', counterpartyDoc: '11.222.333/0001-81', ownerCpf: CPF },
      { kind: 'income_exempt', counterpartyName: 'Banco Y', ownerCpf: '11144477735', ownerName: 'João' },
      { kind: 'payment', counterpartyName: 'Clínica Z', extra: { nature: 'health' } },
      { kind: 'asset', groupCode: '01', description: 'Apartamento na Rua A' },
      { kind: 'asset', groupCode: '06', counterpartyName: 'Banco Y', description: 'Conta corrente' },
      { kind: 'asset', groupCode: '04', counterpartyName: 'Banco Y', description: 'CDB' },
      { kind: 'debt', description: 'Financiamento imobiliário' },
      { kind: 'rural_income' },
      { kind: 'rural_expense' },
      { kind: 'capital_gain', description: 'Venda pontual' },
    ];
    const drafts = buildChecklistDrafts(prev, { customerCpf: CPF, hasPreviousDeclaration: true });
    const titles = drafts.map((d) => `${d.section}:${d.title}`);
    expect(titles).toContain('family:Dependente: João');
    expect(drafts.filter((d) => d.title === 'Informe de rendimentos — Empresa X')).toHaveLength(1);
    // o informe do dependente é separado do titular
    const dep = drafts.find((d) => d.title === 'Informe de rendimentos — Banco Y');
    expect(dep?.ownerName).toBe('João');
    expect(titles).toContain('payments:Comprovantes de pagamento — Clínica Z');
    expect(titles).toContain('assets_debts:Bem: Apartamento na Rua A');
    expect(drafts.filter((d) => d.title === 'Saldos em 31/12 — Banco Y')).toHaveLength(1);
    expect(titles).toContain('assets_debts:Dívida: Financiamento imobiliário');
    expect(drafts.filter((d) => d.section === 'rural')).toHaveLength(1);
    expect(titles.some((t) => t.includes('Venda pontual'))).toBe(false);
    // seções sem histórico recebem itens padrão
    expect(drafts.filter((d) => d.section === 'identification').every((d) => !d.fromPreviousYear)).toBe(true);
    expect(drafts.some((d) => d.section === 'files')).toBe(true);
    // ordem das seções
    expect(drafts[0].section).toBe('identification');
  });

  it('sem histórico usa só os itens padrão', () => {
    const drafts = buildChecklistDrafts([], { customerCpf: CPF, hasPreviousDeclaration: false });
    expect(drafts.every((d) => !d.fromPreviousYear)).toBe(true);
    expect(new Set(drafts.map((d) => d.section))).toEqual(new Set(['identification', 'family', 'income', 'payments', 'assets_debts', 'rural', 'files']));
    expect(drafts.some((d) => d.title === 'Última declaração entregue')).toBe(true);
  });
});

describe('bloqueio do checklist', () => {
  it('modo consulta depois de “Em preenchimento” e bloqueio por status', () => {
    expect(checklistLock({}, { substatus: 'ecac_processed' }).readOnly).toBe(false);
    expect(checklistLock({ checklistReadOnlyAfterStart: true }, { substatus: 'review' }).readOnly).toBe(false);
    expect(checklistLock({ checklistReadOnlyAfterStart: true }, { substatus: 'ecac_waiting' }).readOnly).toBe(true);
    expect(checklistLock({ lockChecklistFromSubstatus: 'review' }, { substatus: 'elaboration' }).readOnly).toBe(false);
    expect(checklistLock({ lockChecklistFromSubstatus: 'review' }, { substatus: 'review' }).readOnly).toBe(true);
    expect(checklistLock({ lockChecklistFromSubstatus: 'review' }, { substatus: 'finished' }).readOnly).toBe(true);
    expect(checklistLock({}, { substatus: 'started', checklistLocked: true }).readOnly).toBe(true);
  });
});

describe('apoio', () => {
  it('tipos de arquivo, progresso e status para o cliente', () => {
    expect(checklistUploadMime('Informe.PDF')).toBe('application/pdf');
    expect(checklistUploadMime('planilha.xlsx')).toContain('spreadsheetml');
    expect(checklistUploadMime('virus.exe')).toBeNull();
    expect(checklistProgress([{ status: 'pending' }, { status: 'sent' }, { status: 'removed' }, { status: 'not_applicable' }])).toMatchObject({ total: 4, pending: 1, resolved: 3, percent: 75 });
    expect(customerDeclarationStatus('missing_documents').tone).toBe('warning');
    expect(customerDeclarationStatus('qualquer').title).toBe('Ainda não iniciada');
  });
});
