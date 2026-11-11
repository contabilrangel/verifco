import { describe, expect, it } from 'vitest';
import { alimonySummary, annualIrpfTable, legalDeductions, type DeclarationItem } from '../src';

const CPF_FILHO = '52998224725';
const CPF_EX = '11144477735';
const cap = annualIrpfTable(2026).educationCapCents;

describe('pensão alimentícia paga (alimonySummary)', () => {
  it('sem linhas de pensão não há alimentandos', () => {
    const s = alimonySummary([{ kind: 'payment', valueCents: 50_000, extra: { nature: 'health' }, ownerName: 'Lia' }], 2026);
    expect(s.recipients).toEqual([]);
    expect(s.totalDeductibleCents).toBe(0);
    expect(s.educationCapCents).toBe(cap);
  });

  it('separa por alimentando a parte dedutível da não dedutível e soma as despesas dele', () => {
    const items: DeclarationItem[] = [
      // filho: a mãe recebe; o alimentando vem no campo próprio, com CPF
      { kind: 'payment', code: '30', counterpartyName: 'Rita Moura', counterpartyDoc: CPF_EX, ownerName: 'Caio Moura', ownerCpf: CPF_FILHO, valueCents: 2_400_000, extra: { nature: 'alimony', relationship: 'child' } },
      // complemento por acordo informal: lançado como parcela não dedutível; só o nome do alimentando
      { kind: 'payment', code: '30', counterpartyName: 'Rita Moura', counterpartyDoc: CPF_EX, ownerName: 'caio  moura', valueCents: 600_000, extra: { nature: 'alimony', reimbursedCents: 600_000 } },
      // ex-cônjuge: sem alimentando informado, é quem recebeu
      { kind: 'payment', code: '33', counterpartyName: 'Rita Moura', counterpartyDoc: CPF_EX, valueCents: 1_200_000, extra: { nature: 'alimony' } },
      // despesas do filho pagas pelo alimentante
      { kind: 'payment', counterpartyName: 'Clínica Vida', ownerName: 'Caio Moura', valueCents: 300_000, extra: { nature: 'health', reimbursedCents: 50_000 } },
      { kind: 'payment', counterpartyName: 'Colégio Alfa', ownerCpf: CPF_FILHO, valueCents: cap + 100_000, extra: { nature: 'education' } },
      // do titular: fica de fora
      { kind: 'payment', counterpartyName: 'Clínica Vida', valueCents: 999_000, extra: { nature: 'health' } },
      { kind: 'payment', counterpartyName: 'Imobiliária', valueCents: 111_000, extra: { nature: 'other' } },
    ];
    const s = alimonySummary(items, 2026);
    expect(s.recipients.map((r) => [r.name, r.cpf])).toEqual([
      ['Caio Moura', CPF_FILHO],
      ['Rita Moura', CPF_EX],
    ]);
    const [caio, rita] = s.recipients;
    expect(caio).toMatchObject({
      relationship: 'child',
      codes: ['30'],
      alimonyPaidCents: 3_000_000,
      alimonyDeductibleCents: 2_400_000,
      alimonyNonDeductibleCents: 600_000,
      healthCents: 250_000,
      educationPaidCents: cap + 100_000,
      educationCents: cap,
      totalDeductibleCents: 2_400_000 + 250_000 + cap,
      alsoDependent: false,
    });
    expect(caio.lines.map((l) => l.nature)).toEqual(['alimony', 'alimony', 'health', 'education']);
    expect(rita).toMatchObject({ codes: ['33'], alimonyDeductibleCents: 1_200_000, healthCents: 0, educationCents: 0, totalDeductibleCents: 1_200_000, relationship: null });
    expect(s).toMatchObject({ alimonyPaidCents: 4_200_000, alimonyDeductibleCents: 3_600_000, alimonyNonDeductibleCents: 600_000, healthCents: 250_000, educationCents: cap });
    expect(s.totalDeductibleCents).toBe(3_600_000 + 250_000 + cap);
    // a pensão dedutível é a mesma linha das deduções legais do planejamento
    expect(legalDeductions(items, 2026, 20_000_000).lines.find((l) => l.key === 'alimony')!.cents).toBe(s.alimonyDeductibleCents);
  });

  it('aponta o alimentando que também está na ficha de dependentes, pelo CPF ou pelo nome', () => {
    const base: DeclarationItem[] = [
      { kind: 'payment', counterpartyName: 'Caio Moura', counterpartyDoc: CPF_FILHO, valueCents: 100_000, extra: { nature: 'alimony' } },
      { kind: 'payment', counterpartyName: 'Bia Moura', valueCents: 100_000, extra: { nature: 'alimony' } },
    ];
    const s = alimonySummary(
      [
        ...base,
        { kind: 'dependent', ownerName: 'Outro Nome', ownerCpf: CPF_FILHO, extra: { relationship: 'child' } },
        { kind: 'dependent', ownerName: 'BIA MOURA', extra: { relationship: 'child_student' } },
      ],
      2026,
    );
    expect(s.recipients.map((r) => [r.name, r.alsoDependent, r.relationship])).toEqual([
      ['Caio Moura', true, 'child'],
      ['Bia Moura', true, 'child_student'],
    ]);
    expect(alimonySummary(base, 2026).recipients.map((r) => r.alsoDependent)).toEqual([false, false]);
    // sem CPF em nenhuma linha, o alimentando fica sem CPF
    expect(s.recipients[1].cpf).toBe('');
  });
});
