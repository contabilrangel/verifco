import { describe, expect, it } from 'vitest';
import {
  CARNE_LEAO_INCOME_CODES,
  CARNE_LEAO_PAYMENT_CODES,
  CASHBOOK_MAX_ROWS,
  carneLeaoCodeError,
  carneLeaoFiles,
  carneLeaoLine,
  cashbookByMonth,
  cashbookModelCsv,
  copilotBudget,
  copilotLimit,
  copilotOverview,
  detectCashbookKind,
  evaluateRadar,
  normalizeHeader,
  parseBrDate,
  parseBrMoney,
  parseCashbookRow,
  projectCopilotIrpfm,
  INCOME_HEADERS,
  PAYMENT_HEADERS,
  type DeclarationItem,
} from '../src';

const R = (reais: number) => Math.round(reais * 100);
const row = (headers: string[], cells: string[]) => Object.fromEntries(headers.map((h, i) => [normalizeHeader(h), cells[i] ?? '']));

describe('livro caixa — conversão', () => {
  it('formatos de valor e data', () => {
    expect(parseBrMoney('1.234,56')).toBe(123456);
    expect(parseBrMoney('R$ 10,5')).toBe(1050);
    expect(parseBrMoney('1234.56')).toBe(123456);
    expect(parseBrMoney('abc')).toBeNull();
    expect(parseBrDate('31/01/2025')).toBe('2025-01-31');
    expect(parseBrDate('31/02/2025')).toBeNull();
    expect(parseBrDate('2025-03-05')).toBe('2025-03-05');
  });

  it('detecta o tipo pelo cabeçalho', () => {
    expect(detectCashbookKind(INCOME_HEADERS)).toBe('income');
    expect(detectCashbookKind(PAYMENT_HEADERS)).toBe('payment');
    expect(detectCashbookKind(['nome', 'cpf'])).toBeNull();
  });

  it('aceita aluguel de PF e trabalho não assalariado de PJ com IRRF', () => {
    const a = parseCashbookRow('income', row(INCOME_HEADERS, ['10/03/2025', 'r01.003.001', '', '2.500,00', '300,00', 'Aluguel março', 'PF', '529.982.247-25']), 2025);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.entry).toMatchObject({ entryDate: '2025-03-10', code: 'R01.003.001', valueCents: 250000, counterpartyCpf: '52998224725' });
    expect(a.entry.extra.deductionCents).toBe(30000);

    const b = parseCashbookRow(
      'income',
      row(INCOME_HEADERS, ['05/04/2025', 'R01.001.001', '225', '10000,00', '', 'Consulta', 'PJ', '', '', '', '11.222.333/0001-81', 'S', '150,00']),
      2025,
    );
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.entry.extra).toMatchObject({ receivedFrom: 'PJ', cnpj: '11222333000181', irrf: true, irrfCents: 15000 });
  });

  it('aponta os erros de cada linha', () => {
    const r = parseCashbookRow('income', row(INCOME_HEADERS, ['10/03/2024', 'X1', '', '0', '', '', 'ZZ']), 2025);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/fora do ano-calendário 2025/);
    expect(r.errors.join(' ')).toMatch(/formato R00.000.000/);
    expect(r.errors.join(' ')).toMatch(/maior que zero/);
    expect(r.errors.join(' ')).toMatch(/Histórico obrigatório/);
    expect(r.errors.join(' ')).toMatch(/"Recebido de" inválido/);

    const pf = parseCashbookRow('income', row(INCOME_HEADERS, ['10/03/2025', 'R01.001.001', '225', '100,00', '', 'Consulta', 'PF', '52998224725']), 2025);
    expect(pf.ok).toBe(false);
    if (!pf.ok) expect(pf.errors[0]).toMatch(/CPF do beneficiário/);

    const model = parseCashbookRow('income', row(INCOME_HEADERS, ['99/99/9999', 'R01.003.001']), 2025);
    expect(model.ok).toBe(false);
    if (!model.ok) expect(model.errors[0]).toMatch(/Linha do modelo/);
  });

  it('pagamentos com competência', () => {
    const p = parseCashbookRow('payment', row(PAYMENT_HEADERS, ['20/02/2025', 'P20.01.00001', '500,00', 'INSS', '10,00', '', '1/2025']), 2025);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.entry.extra).toMatchObject({ fineCents: 1000, interestCents: null, competence: '01/2025' });
    const bad = parseCashbookRow('payment', row(PAYMENT_HEADERS, ['20/02/2025', 'P1.1', '5', 'x', '', '', '13/2025']), 2025);
    expect(bad.ok).toBe(false);
  });

  it('COB-9: confere os códigos nas tabelas dos modelos oficiais do Carnê-Leão', () => {
    // tabelas dos modelos oficiais (20/10/2025): 4 rendimentos e 36 pagamentos (14 P10, 18 P11, 4 P20)
    expect(CARNE_LEAO_INCOME_CODES.map((c) => c.code)).toEqual(['R01.001.001', 'R01.001.002', 'R01.003.001', 'R01.004.001']);
    expect(CARNE_LEAO_PAYMENT_CODES).toHaveLength(36);
    expect(CARNE_LEAO_PAYMENT_CODES.filter((c) => c.code.startsWith('P20')).map((c) => c.code)).toEqual(['P20.01.00001', 'P20.01.00002', 'P20.01.00003', 'P20.01.00004']);
    expect(CARNE_LEAO_PAYMENT_CODES.find((c) => c.code === 'P10.01.00002')).toMatchObject({ label: 'Aluguel do escritório/consultório', group: 'Despesa dedutível do livro caixa' });

    // P20 fora da tabela e grupos inexistentes são recusados com mensagem clara
    const p20 = parseCashbookRow('payment', row(PAYMENT_HEADERS, ['20/02/2025', 'P20.01.00009', '500,00', 'x']), 2025);
    expect(p20).toEqual({ ok: false, errors: [expect.stringMatching(/P20.01.00009 não existe na tabela de pagamentos gerais/)] });
    expect(carneLeaoCodeError('payment', 'P30.01.00001')).toMatch(/use P10 .* P11 .* P20/);
    expect(carneLeaoCodeError('income', 'R02.001.001')).toMatch(/R02.001.001 não existe na tabela de rendimentos/);
    // contas próprias do plano de contas (regra oficial P10/P11 + código da conta) continuam aceitas
    expect(carneLeaoCodeError('payment', 'P10.03.00001')).toBeNull();
    expect(carneLeaoCodeError('payment', 'P11.03.00001')).toBeNull();
    expect(carneLeaoCodeError('income', 'R01.003.001')).toBeNull();
    const ok = parseCashbookRow('payment', row(PAYMENT_HEADERS, ['20/02/2025', 'P10.03.00001', '80,00', 'Conta própria']), 2025);
    expect(ok.ok).toBe(true);
  });
});

describe('livro caixa — exportação no layout do Carnê-Leão Web', () => {
  it('reproduz as linhas dos modelos oficiais', () => {
    const base = { entryDate: '2025-03-10', description: 'Aluguel', valueCents: 250000 };
    expect(carneLeaoLine({ ...base, kind: 'income', code: 'R01.003.001', counterpartyCpf: '52998224725', extra: { receivedFrom: 'PF' } })).toBe(
      '10/03/2025;R01.003.001;;2500,00;;Aluguel;PF;52998224725',
    );
    expect(carneLeaoLine({ ...base, kind: 'income', code: 'R01.003.001', counterpartyCpf: null, extra: { receivedFrom: 'EX', deductionCents: 1000 } })).toBe(
      '10/03/2025;R01.003.001;;2500,00;10,00;Aluguel;EX',
    );
    expect(
      carneLeaoLine({
        ...base,
        kind: 'income',
        code: 'R01.001.001',
        counterpartyCpf: null,
        extra: { receivedFrom: 'PJ', occupationCode: '225', cnpj: '11222333000181', irrf: false },
      }),
    ).toBe('10/03/2025;R01.001.001;225;2500,00;;Aluguel;PJ;;;;11222333000181;N');
    expect(
      carneLeaoLine({ ...base, kind: 'income', code: 'R01.001.001', counterpartyCpf: '52998224725', extra: { receivedFrom: 'PF', occupationCode: '225', beneficiaryCpfMissing: true } }),
    ).toBe('10/03/2025;R01.001.001;225;2500,00;;Aluguel;PF;52998224725;;S');
    expect(carneLeaoLine({ ...base, kind: 'payment', code: 'P10.01.00002', counterpartyCpf: null, extra: {} })).toBe('10/03/2025;P10.01.00002;2500,00;Aluguel');
    expect(carneLeaoLine({ ...base, kind: 'payment', code: 'P20.01.00002', description: 'Pensão; filho', counterpartyCpf: null, extra: {} })).toBe(
      '10/03/2025;P20.01.00002;2500,00;Pensão filho;;;',
    );
    expect(carneLeaoLine({ ...base, kind: 'payment', code: 'P20.01.00001', counterpartyCpf: null, extra: { fineCents: 100, competence: '02/2025' } })).toBe(
      '10/03/2025;P20.01.00001;2500,00;Aluguel;1,00;;02/2025',
    );
  });

  it('divide em arquivos de até 1.000 linhas', () => {
    const entries = Array.from({ length: CASHBOOK_MAX_ROWS + 5 }, (_, i) => ({
      kind: 'payment' as const,
      entryDate: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
      code: 'P10.01.00012',
      description: 'Material',
      valueCents: 100,
      counterpartyCpf: null,
      extra: {},
    }));
    const files = carneLeaoFiles(entries, 'livro');
    expect(files.map((f) => f.filename)).toEqual(['livro-parte-1.csv', 'livro-parte-2.csv']);
    expect(files[0].content.trim().split('\r\n')).toHaveLength(1000);
    expect(files[1].content.trim().split('\r\n')).toHaveLength(5);
  });

  it('modelos para download e totais por mês', () => {
    const m = cashbookModelCsv('pagamentos-plano-de-contas')!;
    expect(m.content.split('\r\n')[0]).toBe(PAYMENT_HEADERS.join(';'));
    expect(m.content).toContain('99/99/9999;P10.01.00001;0,00;Água do escritório/consultório');
    expect(cashbookModelCsv('nao-existe')).toBeNull();
    const months = cashbookByMonth([
      { kind: 'income', entryDate: '2025-01-10', code: 'R01.003.001', valueCents: 1000, extra: { deductionCents: 100 } },
      { kind: 'payment', entryDate: '2025-01-11', code: 'P10.01.00001', valueCents: 200 },
      { kind: 'payment', entryDate: '2025-01-12', code: 'P11.01.00007', valueCents: 300 },
      { kind: 'payment', entryDate: '2025-02-12', code: 'P20.01.00001', valueCents: 400 },
    ]);
    expect(months[0]).toMatchObject({ incomeCents: 1000, deductionCents: 100, deductibleCents: 200, nonDeductibleCents: 300, count: 3 });
    expect(months[1].generalPaymentsCents).toBe(400);
  });
});

describe('radar', () => {
  const items: DeclarationItem[] = [
    { kind: 'asset', groupCode: '01', valueCents: R(1_500_000) },
    { kind: 'asset', groupCode: '08', valueCents: R(50_000) },
    { kind: 'asset', groupCode: '04', valueCents: R(2_000_000) },
    { kind: 'income_pf', valueCents: R(150_000), extra: { nature: 'other' } },
    { kind: 'income_pf', valueCents: R(60_000), extra: { nature: 'rent' } },
    { kind: 'income_exempt', valueCents: R(500_000), extra: { nature: 'dividends' } },
    { kind: 'variable_income', valueCents: R(10_000) },
    { kind: 'rural_income', valueCents: R(80_000) },
  ];

  it('aplica as regras documentadas', () => {
    const signals = evaluateRadar({ items, calendarYear: 2025, highNetWorthBaseCents: R(3_000_000) });
    const cats = signals.map((s) => s.category).sort();
    expect(cats).toEqual(['carne_leao', 'company_opening', 'crypto', 'high_net_worth', 'holding', 'irpfm', 'rural', 'variable_income']);
    const irpfm = signals.find((s) => s.category === 'irpfm')!;
    // 150k + 60k + 500k + 10k + 80k
    expect(irpfm.evidence.totalIncomeCents).toBe(R(800_000));
    const company = signals.find((s) => s.category === 'company_opening')!;
    expect(company.evidence.totalCents).toBe(R(150_000));
    for (const s of signals) expect(s.score).toBeGreaterThan(0);
  });

  it('não sinaliza abaixo dos limites', () => {
    const signals = evaluateRadar({ items: [{ kind: 'asset', groupCode: '01', valueCents: R(500_000) }], calendarYear: 2025, highNetWorthBaseCents: R(3_000_000) });
    expect(signals).toEqual([]);
  });
});

describe('copiloto', () => {
  const entries = [
    ...[1, 2, 3].map((month) => ({ kind: 'income', year: 2026, month, category: 'salary', amountCents: R(20_000) })),
    ...[1, 2, 3].map((month) => ({ kind: 'income', year: 2026, month, category: 'dividends', amountCents: R(60_000) })),
    { kind: 'expense', year: 2026, month: 1, category: 'housing', amountCents: R(8_000) },
    { kind: 'expense', year: 2026, month: 1, category: 'food', amountCents: R(2_000) },
    { kind: 'budget', year: 2026, month: null, category: 'housing', amountCents: R(10_000) },
  ];

  it('visão geral por mês e orçamento', () => {
    const o = copilotOverview(entries);
    expect(o.months[0]).toMatchObject({ incomeCents: R(80_000), expenseCents: R(10_000), balanceCents: R(70_000) });
    expect(o.months[0].savingsRatePercent).toBeCloseTo(87.5, 10);
    expect(o.months[5].savingsRatePercent).toBeNull();
    const b = copilotBudget(entries, 1);
    expect(b.find((x) => x.category === 'housing')).toMatchObject({ limitCents: R(10_000), spentCents: R(8_000), usedPercent: 80 });
  });

  it('projeta o IRPFM do ano pela média dos meses lançados', () => {
    const p = projectCopilotIrpfm(entries, 2026);
    expect(p.monthsWithData).toBe(3);
    // 240k de salário + 720k de dividendos = 960k → alíquota 6%
    expect(p.result.baseCents).toBe(R(960_000));
    expect(p.result.ratePercent).toBeCloseTo(6, 10);
    // retenção de 10% sobre 60k em 3 meses, anualizada: 6k × 3 × 4
    expect(p.dividendWithholdingCents).toBe(R(72_000));
    // IR de 240k (tabela oficial do exercício 2027): (240.000 − 17.640) × 27,5% − 10.904,66 = 50.244,34
    expect(p.regularTaxDueCents).toBe(R(50_244.34));
    // 57.600 − 50.244,34 = 7.355,66; menos a retenção de 72.000
    expect(p.result.dueCents).toBe(R(7_355.66));
    expect(p.result.complementaryCents).toBe(R(7_355.66 - 72_000));
  });

  it('limite do plano', () => {
    expect(copilotLimit([])).toBe(5);
    expect(copilotLimit([{ plan: 'pro', status: 'active', startsAt: '2026-01-01', expiresAt: '2026-12-31' }], '2026-06-01')).toBe(25);
    expect(copilotLimit([{ plan: 'pro', status: 'active', startsAt: '2025-01-01', expiresAt: '2025-12-31' }], '2026-06-01')).toBe(5);
  });
});
