/** Arquivos do cliente por exercício (aba Documentos do IRPF). */
export const DOCUMENT_CATEGORIES = {
  income_report: 'Informe de rendimentos',
  bank_statement: 'Extratos e investimentos',
  health: 'Despesas com saúde',
  education: 'Despesas com educação',
  property: 'Bens, imóveis e veículos',
  debt: 'Dívidas e financiamentos',
  personal: 'Documentos pessoais',
  previous_declaration: 'Declaração anterior',
  receipt: 'Recibo de entrega',
  darf: 'DARF',
  other: 'Outros',
} as const;
export type DocumentCategory = keyof typeof DOCUMENT_CATEGORIES;
export const DOCUMENT_CATEGORY_LIST = Object.keys(DOCUMENT_CATEGORIES) as DocumentCategory[];

/** Quem enviou o arquivo. */
export const DOCUMENT_ORIGINS = {
  office: 'Escritório',
  customer: 'Cliente',
  sync: 'Sincronização',
} as const;
export type DocumentOrigin = keyof typeof DOCUMENT_ORIGINS;

export const documentCategoryLabel = (c: string) => DOCUMENT_CATEGORIES[c as DocumentCategory] ?? c;
export const documentOriginLabel = (o: string) => DOCUMENT_ORIGINS[o as DocumentOrigin] ?? o;
