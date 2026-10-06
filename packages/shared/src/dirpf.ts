/**
 * Estrutura das linhas da declaração (DIRPF) usada pelo Verifco.
 * Cada linha tem um `kind`; os códigos oficiais da Receita ficam no campo `code`
 * (informados pelo escritório ou pela importação), sem o sistema presumir tabela de códigos.
 */
export const ITEM_KINDS = {
  dependent: { label: 'Dependente', ficha: 'Dependentes' },
  income_pj: { label: 'Rendimento tributável de PJ', ficha: 'Rendimentos tributáveis recebidos de pessoa jurídica' },
  income_pf: { label: 'Rendimento tributável de PF/exterior', ficha: 'Rendimentos tributáveis recebidos de PF e do exterior' },
  income_exempt: { label: 'Rendimento isento', ficha: 'Rendimentos isentos e não tributáveis' },
  income_exclusive: { label: 'Rendimento de tributação exclusiva', ficha: 'Rendimentos sujeitos à tributação exclusiva/definitiva' },
  income_suspended: { label: 'Rendimento com exigibilidade suspensa', ficha: 'Rendimentos tributáveis com exigibilidade suspensa' },
  income_accumulated: { label: 'Rendimento recebido acumuladamente (RRA)', ficha: 'Rendimentos recebidos acumuladamente' },
  payment: { label: 'Pagamento efetuado', ficha: 'Pagamentos efetuados' },
  donation: { label: 'Doação efetuada', ficha: 'Doações efetuadas' },
  asset: { label: 'Bem ou direito', ficha: 'Bens e direitos' },
  debt: { label: 'Dívida ou ônus real', ficha: 'Dívidas e ônus reais' },
  rural_income: { label: 'Receita da atividade rural', ficha: 'Atividade rural' },
  rural_expense: { label: 'Despesa da atividade rural', ficha: 'Atividade rural' },
  rural_asset: { label: 'Bem da atividade rural', ficha: 'Atividade rural' },
  rural_debt: { label: 'Dívida da atividade rural', ficha: 'Atividade rural' },
  capital_gain: { label: 'Ganho de capital', ficha: 'Ganhos de capital' },
  variable_income: { label: 'Renda variável', ficha: 'Renda variável' },
  tax_paid: { label: 'Imposto pago', ficha: 'Imposto pago/retido' },
} as const;
export type ItemKind = keyof typeof ITEM_KINDS;
export const ITEM_KIND_LIST = Object.keys(ITEM_KINDS) as ItemKind[];

/** Natureza do pagamento, usada nas análises (educação, saúde etc.). */
export const PAYMENT_NATURES = {
  education: 'Instrução',
  health: 'Saúde (médicos, dentistas, hospitais, planos)',
  alimony: 'Pensão alimentícia',
  private_pension: 'Previdência complementar',
  domestic_employee: 'Contribuição patronal de empregado doméstico',
  other: 'Outros pagamentos',
} as const;
export type PaymentNature = keyof typeof PAYMENT_NATURES;

/** Natureza dos rendimentos isentos/exclusivos relevantes para as análises (IRPFM, Radar). */
export const INCOME_NATURES = {
  salary: 'Salário / pró-labore',
  dividends: 'Lucros e dividendos',
  financial_taxed: 'Aplicações financeiras tributadas',
  financial_exempt: 'Aplicações isentas (poupança, LCI, LCA, CRI, CRA, debêntures incentivadas)',
  rent: 'Aluguéis',
  retirement: 'Aposentadoria / pensão',
  retirement_illness: 'Aposentadoria por moléstia grave',
  thirteenth: '13º salário',
  capital_gain: 'Ganho de capital',
  inheritance_donation: 'Heranças e doações recebidas',
  indemnity: 'Indenizações',
  rural: 'Atividade rural',
  stock_market: 'Renda variável (bolsa)',
  other: 'Outros',
} as const;
export type IncomeNature = keyof typeof INCOME_NATURES;

export const DEPENDENT_RELATIONSHIPS = {
  spouse: 'Cônjuge ou companheiro(a)',
  child: 'Filho(a) ou enteado(a)',
  child_student: 'Filho(a)/enteado(a) universitário(a) até 24 anos',
  sibling_grandchild: 'Irmão(ã), neto(a) ou bisneto(a)',
  parent: 'Pais, avós ou bisavós',
  ward: 'Menor sob guarda / tutelado',
  incapable: 'Pessoa absolutamente incapaz sob tutela/curatela',
} as const;

/** Item da declaração no formato trafegado pela API. */
export interface DeclarationItem {
  id?: string;
  kind: ItemKind;
  code?: string | null;
  groupCode?: string | null;
  description?: string | null;
  ownerCpf?: string | null;
  ownerName?: string | null;
  counterpartyDoc?: string | null;
  counterpartyName?: string | null;
  prevValueCents?: number;
  valueCents?: number;
  withheldCents?: number;
  extra?: Record<string, unknown>;
}
