/**
 * eCAC, robô (extensão e sincronizador) e arquivos do programa IRPF.
 *
 * Importante: o layout interno dos arquivos .DEC/.REC/.DBK do programa IRPF e o HTML das
 * páginas do eCAC não são públicos nem estáveis. Aqui ficam só as regras que dá para garantir:
 * tipos de arquivo pela extensão e a identificação do CPF/ano pelo NOME do arquivo quando ele
 * segue o padrão de nomes usado pelo programa.
 */
import { isValidCpf, onlyDigits } from './validators';

// ---------------------------------------------------------------------------
// Registros do eCAC
// ---------------------------------------------------------------------------
export const ECAC_RECORD_KINDS = {
  declaration: 'Declaração processada',
  income_statement: 'Extrato de rendimentos',
  cnd: 'Certidão (CND)',
  simplified_status: 'Status simplificado',
  mailbox_message: 'Mensagem da caixa postal',
  procuration: 'Procuração eletrônica',
  fiscal_situation: 'Situação fiscal',
  darf: 'DARF',
  other: 'Outro',
} as const;
export type EcacRecordKind = keyof typeof ECAC_RECORD_KINDS;
export const ECAC_RECORD_KIND_LIST = Object.keys(ECAC_RECORD_KINDS) as EcacRecordKind[];

/** Origem de um registro do eCAC. */
export const ECAC_RECORD_SOURCES = {
  manual: 'Lançamento manual',
  serpro: 'SERPRO Integra Contador',
  extension: 'Extensão do navegador',
  sync: 'Sincronizador',
} as const;
export type EcacRecordSource = keyof typeof ECAC_RECORD_SOURCES;

/** Serviços do eCAC abertos pela extensão na aba "Ações eCAC". */
export const ECAC_SERVICES = {
  carne_leao: 'Carnê-Leão',
  meu_irpf: 'Meu Imposto de Renda',
  cnd: 'CND',
  fontes_pagadoras: 'Fontes pagadoras',
} as const;
export type EcacService = keyof typeof ECAC_SERVICES;

// ---------------------------------------------------------------------------
// Tokens de máquina (extensão e sincronizador)
// ---------------------------------------------------------------------------
export const MACHINE_TOKEN_PREFIX = 'vfk_';

export const MACHINE_TOKEN_SCOPES = {
  extension: 'Extensão do navegador',
  sync: 'Sincronizador',
} as const;
export type MachineTokenScope = keyof typeof MACHINE_TOKEN_SCOPES;

// ---------------------------------------------------------------------------
// Arquivos do programa IRPF
// ---------------------------------------------------------------------------
export const SYNC_FILE_TYPES = {
  dec: 'Declaração (.DEC)',
  rec: 'Recibo de entrega (.REC)',
  dbk: 'Cópia de segurança (.DBK)',
  xml: 'XML',
  pdf: 'PDF',
  other: 'Outro arquivo',
} as const;
export type SyncFileType = keyof typeof SYNC_FILE_TYPES;
export const SYNC_FILE_TYPE_LIST = Object.keys(SYNC_FILE_TYPES) as SyncFileType[];

/** Categoria do documento criado para cada tipo de arquivo recebido do sincronizador. */
export const SYNC_FILE_CATEGORY: Record<SyncFileType, string> = {
  dec: 'irpf_declaration',
  rec: 'irpf_receipt',
  dbk: 'irpf_backup',
  xml: 'xml',
  pdf: 'pdf',
  other: 'other',
};

/** Tipo pelo final do nome do arquivo (sem olhar o conteúdo). */
export function syncFileTypeFromName(name: string): SyncFileType {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  if (ext === 'dec' || ext === 'rec' || ext === 'dbk' || ext === 'xml' || ext === 'pdf') return ext;
  return 'other';
}

export interface IrpfFileNameInfo {
  /** CPF (só dígitos) quando identificado e com dígitos verificadores válidos. */
  cpf: string | null;
  /** Ano-exercício (ex.: 2026 para a declaração entregue em 2026). */
  exerciseYear: number | null;
  /** Ano-calendário (ex.: 2025), quando o nome traz os dois anos. */
  calendarYear: number | null;
  type: SyncFileType;
  /** true = retificadora, false = original, null = o nome não informa. */
  rectification: boolean | null;
  /**
   * Como o nome foi reconhecido:
   * - `irpf`: padrão do programa IRPF (`<CPF>-IRPF-...-<exercício>-<ano-calendário>-ORIGI.DEC`);
   * - `cpf_prefix`: nome começa com o CPF seguido de separador (ex.: `529.982.247-25 informe.pdf`);
   * - `null`: CPF não identificado.
   */
  pattern: 'irpf' | 'cpf_prefix' | null;
}

const isYear = (n: number) => n >= 2000 && n <= 2100;

/**
 * Padrão de nomes do programa IRPF, como `52998224725-IRPF-A-2026-2025-ORIGI.DEC`:
 * CPF (11 dígitos) · "IRPF" · letra opcional · ano-exercício · ano-calendário opcional ·
 * ORIGI/RETIF opcional · extensão. Maiúsculas/minúsculas e separadores `-`, `_` ou espaço
 * são aceitos.
 */
const IRPF_NAME =
  /^(\d{11})[-_ ]IRPF(?:[-_ ]([A-Z]))?[-_ ](\d{4})(?:[-_ ](\d{4}))?(?:[-_ ](ORIGI|RETIF)[A-Z]*)?(?:[-_ .][^.]*)?\.[a-z0-9]+$/i;

/** CPF no início do nome, com ou sem pontuação, seguido de separador ou fim. */
const CPF_PREFIX = /^(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?=$|[^\d])/;

/**
 * Identifica CPF, ano e tipo pelo NOME do arquivo. Não abre o arquivo: o layout interno
 * dos arquivos do programa IRPF não é público. Quando o CPF não é reconhecido, devolve
 * `cpf: null` e quem chamou decide (o sincronizador pula; a API pede o CPF explícito).
 */
export function parseIrpfFileName(fileName: string): IrpfFileNameInfo {
  const base = fileName.split(/[\\/]/).pop()!.trim();
  const type = syncFileTypeFromName(base);
  const m = IRPF_NAME.exec(base);
  if (m && isValidCpf(m[1])) {
    const exercise = Number(m[3]);
    const calendar = m[4] ? Number(m[4]) : null;
    return {
      cpf: m[1],
      exerciseYear: isYear(exercise) ? exercise : null,
      calendarYear: calendar !== null && isYear(calendar) ? calendar : null,
      type,
      rectification: m[5] ? m[5].toUpperCase() === 'RETIF' : null,
      pattern: 'irpf',
    };
  }
  const p = CPF_PREFIX.exec(base);
  const cpf = p ? onlyDigits(p[1]) : null;
  if (cpf && isValidCpf(cpf)) {
    // ano: primeiro grupo de 4 dígitos isolado entre 2000 e 2100 depois do CPF
    const rest = base.slice(p![0].length);
    const y = /(?:^|[^\d])(20\d{2})(?=$|[^\d])/.exec(rest);
    const year = y ? Number(y[1]) : null;
    return { cpf, exerciseYear: year && isYear(year) ? year : null, calendarYear: null, type, rectification: null, pattern: 'cpf_prefix' };
  }
  return { cpf: null, exerciseYear: null, calendarYear: null, type, rectification: null, pattern: null };
}

/**
 * Ano-exercício pela pasta do programa (`.../IRPF2026/...`), usado quando o nome do arquivo
 * não traz o ano. O programa de cada ano se chama IRPF<exercício>.
 */
export function exerciseYearFromPath(path: string): number | null {
  const parts = path.split(/[\\/]/).reverse();
  for (const part of parts) {
    const m = /^IRPF[-_ ]?(20\d{2})$/i.exec(part.trim());
    if (m && isYear(Number(m[1]))) return Number(m[1]);
  }
  return null;
}
