/**
 * Radar de oportunidades: regras aplicadas às linhas da declaração de cada cliente no exercício.
 *
 * Cada regra devolve um sinal com pontuação (0 a 100) e as evidências usadas, para o escritório
 * oferecer um serviço (planejamento, holding, carnê-leão, abertura de empresa...).
 */
import type { DeclarationItem } from './dirpf';
import type { OpportunityCategory } from './enums';
import { computeIrpfm, irpfmFromItems } from './tax/irpfm';

export const RADAR_THRESHOLDS = {
  /** Rendimentos de trabalho recebidos de PF/exterior no ano a partir dos quais vale comparar com a tributação como empresa. */
  companyOpeningCents: 12_000_000,
  /** Imóveis declarados (grupo 01) a partir deste total sugerem planejamento com holding. */
  holdingRealEstateCents: 100_000_000,
};

export const RADAR_RULES: Record<OpportunityCategory, { title: string; description: string; rule: string }> = {
  high_net_worth: {
    title: 'Alto patrimônio',
    description: 'Clientes com patrimônio relevante: planejamento patrimonial, sucessório e de investimentos.',
    rule: 'Bens e direitos em 31/12 somam pelo menos a base de alto patrimônio das preferências do escritório.',
  },
  crypto: {
    title: 'Criptoativos',
    description: 'Declaram criptoativos: apuração mensal de ganhos, obrigações acessórias e organização das carteiras.',
    rule: 'Há bens do grupo 08 (criptoativos) na declaração.',
  },
  variable_income: {
    title: 'Renda variável',
    description: 'Operam em bolsa: apuração mensal, DARF de ganhos e compensação de prejuízos.',
    rule: 'Há lançamentos na ficha de renda variável ou rendimentos de natureza "renda variável (bolsa)".',
  },
  rural: {
    title: 'Atividade rural',
    description: 'Produtores rurais: livro caixa da atividade rural e opção pelo resultado presumido.',
    rule: 'Há receitas, despesas, bens ou dívidas da atividade rural.',
  },
  carne_leao: {
    title: 'Carnê-Leão',
    description: 'Recebem de pessoas físicas ou do exterior: escrituração mensal e DARF do carnê-leão.',
    rule: 'Há rendimentos tributáveis recebidos de pessoa física ou do exterior.',
  },
  company_opening: {
    title: 'Possível abertura de empresa',
    description: 'Renda alta de trabalho recebida como pessoa física: compare com a tributação como empresa.',
    rule: 'Rendimentos de PF/exterior (exceto aluguéis) a partir de R$ 120 mil no ano.',
  },
  irpfm: {
    title: 'Sujeito ao IRPFM',
    description: 'Altas rendas: cálculo e planejamento da tributação mínima (Lei 15.270/2025).',
    rule: 'Soma de todos os rendimentos do ano acima de R$ 600 mil.',
  },
  holding: {
    title: 'Potencial para holding',
    description: 'Imóveis de valor relevante: simulação de holding patrimonial e sucessão.',
    rule: 'Imóveis (grupo 01) a partir de R$ 1 milhão.',
  },
};

export interface RadarSignal {
  category: OpportunityCategory;
  score: number;
  evidence: Record<string, unknown> & { summary: string };
}

const sum = (list: DeclarationItem[], f: (i: DeclarationItem) => number) => list.reduce((a, i) => a + (f(i) || 0), 0);
const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const scoreOf = (value: number, threshold: number) => Math.max(1, Math.min(100, Math.round((value / Math.max(1, threshold)) * 50)));

export function evaluateRadar(input: { items: DeclarationItem[]; calendarYear: number; highNetWorthBaseCents: number }): RadarSignal[] {
  const { items } = input;
  const by = (kind: DeclarationItem['kind']) => items.filter((i) => i.kind === kind);
  const nature = (i: DeclarationItem) => (typeof i.extra?.nature === 'string' ? i.extra.nature : null);
  const out: RadarSignal[] = [];

  const assets = [...by('asset'), ...by('rural_asset')];
  const assetsTotal = sum(assets, (i) => i.valueCents ?? 0);
  if (input.highNetWorthBaseCents > 0 && assetsTotal >= input.highNetWorthBaseCents) {
    out.push({
      category: 'high_net_worth',
      score: scoreOf(assetsTotal, input.highNetWorthBaseCents),
      evidence: { summary: `Bens e direitos de ${brl(assetsTotal)} (base ${brl(input.highNetWorthBaseCents)})`, assetsTotalCents: assetsTotal, baseCents: input.highNetWorthBaseCents },
    });
  }

  const crypto = by('asset').filter((i) => i.groupCode === '08');
  if (crypto.length) {
    const total = sum(crypto, (i) => Math.max(i.valueCents ?? 0, i.prevValueCents ?? 0));
    out.push({
      category: 'crypto',
      score: Math.min(100, 40 + crypto.length * 10),
      evidence: { summary: `${crypto.length} criptoativo(s), ${brl(total)}`, count: crypto.length, totalCents: total },
    });
  }

  const variable = [...by('variable_income'), ...items.filter((i) => nature(i) === 'stock_market')];
  if (variable.length) {
    const total = sum(variable, (i) => Math.abs(i.valueCents ?? 0));
    out.push({
      category: 'variable_income',
      score: Math.min(100, 40 + variable.length * 5),
      evidence: { summary: `${variable.length} lançamento(s) de renda variável`, count: variable.length, totalCents: total },
    });
  }

  const rural = [...by('rural_income'), ...by('rural_expense'), ...by('rural_asset'), ...by('rural_debt')];
  if (rural.length) {
    const revenue = sum(by('rural_income'), (i) => i.valueCents ?? 0);
    out.push({
      category: 'rural',
      score: Math.min(100, 40 + rural.length * 5),
      evidence: { summary: revenue ? `Receita rural de ${brl(revenue)}` : `${rural.length} lançamento(s) da atividade rural`, count: rural.length, revenueCents: revenue },
    });
  }

  const pf = by('income_pf').filter((i) => (i.valueCents ?? 0) > 0);
  if (pf.length) {
    const total = sum(pf, (i) => i.valueCents ?? 0);
    out.push({
      category: 'carne_leao',
      score: Math.min(100, 30 + pf.length * 10),
      evidence: { summary: `${brl(total)} recebidos de PF/exterior`, count: pf.length, totalCents: total },
    });
    const work = pf.filter((i) => nature(i) !== 'rent');
    const workTotal = sum(work, (i) => i.valueCents ?? 0);
    if (workTotal >= RADAR_THRESHOLDS.companyOpeningCents) {
      out.push({
        category: 'company_opening',
        score: scoreOf(workTotal, RADAR_THRESHOLDS.companyOpeningCents),
        evidence: { summary: `${brl(workTotal)} de trabalho recebidos como pessoa física`, totalCents: workTotal, thresholdCents: RADAR_THRESHOLDS.companyOpeningCents },
      });
    }
  }

  const ir = irpfmFromItems(items);
  const irpfm = computeIrpfm({ calendarYear: input.calendarYear, incomes: ir.incomes, regularTaxDueCents: 0, exclusiveWithheldCents: ir.exclusiveWithheldCents });
  if (irpfm.subject) {
    out.push({
      category: 'irpfm',
      score: scoreOf(irpfm.totalIncomeCents, irpfm.thresholdCents),
      evidence: {
        summary: `Rendimentos de ${brl(irpfm.totalIncomeCents)}; base do IRPFM de ${brl(irpfm.baseCents)}`,
        totalIncomeCents: irpfm.totalIncomeCents,
        baseCents: irpfm.baseCents,
        ratePercent: irpfm.ratePercent,
      },
    });
  }

  const realEstate = by('asset').filter((i) => i.groupCode === '01');
  const realEstateTotal = sum(realEstate, (i) => i.valueCents ?? 0);
  if (realEstateTotal >= RADAR_THRESHOLDS.holdingRealEstateCents) {
    out.push({
      category: 'holding',
      score: scoreOf(realEstateTotal, RADAR_THRESHOLDS.holdingRealEstateCents),
      evidence: { summary: `${realEstate.length} imóvel(is) declarados por ${brl(realEstateTotal)}`, count: realEstate.length, totalCents: realEstateTotal },
    });
  }
  return out;
}
