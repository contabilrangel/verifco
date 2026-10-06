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
  shared_with_customer: 'Visível no portal',
  other: 'Outros',
} as const;
export type DocumentCategory = keyof typeof DOCUMENT_CATEGORIES;
export const DOCUMENT_CATEGORY_LIST = Object.keys(DOCUMENT_CATEGORIES) as DocumentCategory[];

/**
 * Categoria dos arquivos que o escritório compartilha com o cliente: só eles aparecem (e podem
 * ser baixados) no portal, em "Documentos do escritório". Arquivos enviados pelo próprio cliente
 * não entram.
 */
export const SHARED_WITH_CUSTOMER: DocumentCategory = 'shared_with_customer';

/** Categoria usada ao tirar um arquivo do portal. */
export const UNSHARED_CATEGORY: DocumentCategory = 'other';

/**
 * Categorias gravadas pelo sistema (checklist, sincronização, copiloto). Não aparecem na escolha
 * do upload, mas têm rótulo para a aba Documentos não mostrar a chave crua.
 */
export const SYSTEM_DOCUMENT_CATEGORIES: Record<string, string> = {
  checklist: 'Enviado pelo checklist',
  copilot: 'Copiloto',
  irpf_declaration: 'Declaração (arquivo .DEC)',
  irpf_receipt: 'Recibo de entrega (.REC)',
  irpf_backup: 'Cópia de segurança (.DBK)',
  xml: 'Arquivo XML',
  pdf: 'PDF',
};

/** Quem enviou o arquivo. */
export const DOCUMENT_ORIGINS = {
  office: 'Escritório',
  customer: 'Cliente',
  sync: 'Sincronização',
} as const;
export type DocumentOrigin = keyof typeof DOCUMENT_ORIGINS;

export const documentCategoryLabel = (c: string) => DOCUMENT_CATEGORIES[c as DocumentCategory] ?? SYSTEM_DOCUMENT_CATEGORIES[c] ?? c;
export const documentOriginLabel = (o: string) => DOCUMENT_ORIGINS[o as DocumentOrigin] ?? o;

/** O arquivo pode ser compartilhado no portal? Só os do escritório (enviados ou sincronizados). */
export const canShareWithCustomer = (uploadedBy: string) => uploadedBy !== 'customer';
