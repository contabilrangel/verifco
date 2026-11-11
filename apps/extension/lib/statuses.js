/*
 * Chaves e rótulos usados nos formulários do popup. Script clássico: `globalThis.VerifcoStatuses`.
 *
 * A extensão não tem etapa de build, por isso os mapas são CÓPIAS do pacote compartilhado.
 * Ao mudar lá, mude aqui (a API ignora ou recusa chaves que não conhece):
 *   - DECLARATION_STATUS  ← ECAC_DECLARATION_STATUS em packages/shared/src/enums.ts
 *   - CND_STATUS          ← CND_STATUS em packages/shared/src/enums.ts
 *   - DOCUMENT_CATEGORIES ← DOCUMENT_CATEGORIES em packages/shared/src/customer-documents.ts
 * (os tipos de registro do eCAC que usam essas situações estão em packages/shared/src/ecac.ts)
 */
(function () {
  /** Situação da declaração no eCAC (registro `declaration`, campo `data.status`). */
  const DECLARATION_STATUS = {
    unknown: 'Desconhecido',
    waiting: 'Aguardando',
    processing: 'Em processamento',
    fine_mesh: 'Malha fina',
    refund_lot: 'Restituição liberada',
    processed: 'Processada',
    pending_issues: 'Com pendências',
  };

  /** Situação da certidão (registro `cnd`, campo `data.status`). */
  const CND_STATUS = {
    not_requested: 'Não consultada',
    success: 'Emitida com sucesso',
    invalid_cpf: 'CPF inválido',
    cpf_not_found: 'CPF não encontrado',
    pending_issues: 'Analisar pendências no eCAC',
  };

  /** Categorias aceitas no campo `categoria` de POST /api/sync/documents. */
  const DOCUMENT_CATEGORIES = {
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
  };
  const DEFAULT_DOCUMENT_CATEGORY = 'other';

  globalThis.VerifcoStatuses = { DECLARATION_STATUS, CND_STATUS, DOCUMENT_CATEGORIES, DEFAULT_DOCUMENT_CATEGORY };
})();
