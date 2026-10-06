/**
 * Importações em lote por planilha (.xlsx ou .csv).
 * O `slug` é o tipo usado na URL (/importacoes/:tipo) e gravado em `import_batches.kind`.
 */
export interface ImportKindDef {
  slug: ImportKind;
  /** Título da tela e do histórico. */
  label: string;
  /** Permissão exigida para baixar o modelo e enviar a planilha. */
  permission: string;
  /** O que o usuário precisa preencher, em uma frase. */
  summary: string;
  /** Colunas obrigatórias (rótulos como aparecem no modelo). */
  required: string[];
  /** Colunas opcionais. */
  optional: string[];
  /** Orientações curtas exibidas na tela. */
  tips: string[];
  /** O modelo vem preenchido com os clientes do escritório. */
  prefilled: boolean;
  /** A planilha contém senhas: o arquivo enviado não é guardado. */
  hasSecrets: boolean;
}

/**
 * Não há importação de senhas gov.br do INSS: o Verifco não tem integração com o INSS (o Meu INSS não
 * oferece API a terceiros) e guardar a senha sem uso só criaria risco (LGPD, art. 6º, III). As senhas
 * que tinham sido importadas foram apagadas na migração 0004_inss_senhas_descartadas.
 */
export type ImportKind = 'novos-clientes' | 'atualizar-clientes' | 'procuracoes' | 'ecac';

/** Limite de linhas de dados por arquivo. */
export const IMPORT_MAX_ROWS = 5000;

export const IMPORT_KINDS: Record<ImportKind, ImportKindDef> = {
  'novos-clientes': {
    slug: 'novos-clientes',
    label: 'Novos clientes',
    permission: 'worksheet.new_customers',
    summary: 'Cadastre vários clientes de uma vez.',
    required: ['Nome', 'CPF', 'E-mail do responsável'],
    optional: ['E-mail', 'Celular', 'Telefone', 'Grupo', 'Data de nascimento'],
    tips: [
      'O e-mail do responsável precisa ser de um colaborador ativo do escritório (veja a aba Colaboradores do modelo).',
      'CPF já cadastrado gera erro na linha; o cliente existente não é alterado.',
      'Grupo deve ter o nome de um grupo existente. Para mais de um, separe com ponto e vírgula.',
      'Data de nascimento no formato DD/MM/AAAA.',
    ],
    prefilled: false,
    hasSecrets: false,
  },
  'atualizar-clientes': {
    slug: 'atualizar-clientes',
    label: 'Atualização de clientes',
    permission: 'worksheet.update_customers',
    summary: 'Atualize telefone, celular e e-mail dos clientes já cadastrados.',
    required: ['CPF'],
    optional: ['E-mail', 'Celular', 'Telefone'],
    tips: [
      'O modelo já vem com seus clientes e os contatos atuais. Altere só o que precisar.',
      'O cliente é localizado pelo CPF. Não altere essa coluna.',
      'Célula vazia mantém o valor atual.',
      'Celular e telefone com DDD (10 ou 11 dígitos).',
    ],
    prefilled: true,
    hasSecrets: false,
  },
  procuracoes: {
    slug: 'procuracoes',
    label: 'Procurações em lote',
    permission: 'worksheet.procuration',
    summary: 'Associe clientes a um procurador cadastrado.',
    required: ['CPF', 'CPF/CNPJ do procurador'],
    optional: [],
    tips: [
      'O modelo já vem com seus clientes. Preencha só a coluna do procurador.',
      'O procurador precisa estar cadastrado em Administração › Procuradores.',
      'Após a associação, a procuração fica “Aguardando validação” até o robô conferir no eCAC.',
      'Linhas sem procurador são ignoradas.',
    ],
    prefilled: true,
    hasSecrets: false,
  },
  ecac: {
    slug: 'ecac',
    label: 'Login eCAC em lote',
    permission: 'worksheet.ecac',
    summary: 'Informe login e senha gov.br dos clientes para o robô do eCAC.',
    required: ['CPF', 'Senha'],
    optional: ['Login'],
    tips: [
      'O modelo já vem com seus clientes. Preencha a senha e, se for diferente do CPF, o login.',
      'Com o login em branco, usamos o CPF do cliente.',
      'As credenciais são guardadas cifradas e nunca aparecem de volta no sistema.',
      'O arquivo enviado não é armazenado. Apague-o do seu computador depois da importação.',
    ],
    prefilled: true,
    hasSecrets: true,
  },
};

export const IMPORT_KIND_LIST: ImportKindDef[] = Object.values(IMPORT_KINDS);

export const isImportKind = (v: string): v is ImportKind => Object.prototype.hasOwnProperty.call(IMPORT_KINDS, v);

/** Resultado de uma linha importada. */
export interface ImportRowResult {
  row: number;
  ok: boolean;
  message: string;
}

export const IMPORT_STATUS = {
  done: 'Concluída',
  partial: 'Concluída com erros',
  failed: 'Falhou',
} as const;
