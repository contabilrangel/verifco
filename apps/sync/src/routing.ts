import type { InboxReason } from './api';
import type { Classified } from './identify';

/** O que fazer com um arquivo, decidido só pela identificação (nome, pasta e cabeçalho). */
export type Plan =
  | { action: 'upload'; destination: 'files' | 'prefilled' }
  | { action: 'inbox'; reason: InboxReason; why: string; cpf: string | null; year: number | null }
  | { action: 'skip'; why: string };

/**
 * Identificado (CPF e ano, sem divergência) → envio ao cliente (`/sync/files` ou `/sync/prefilled`).
 * Não identificado → caixa de entrada do escritório (motivo `sem_cpf`), para alguém conferir:
 *   - CPF do nome diferente do CPF do conteúdo (não se envia nenhum dos dois CPFs);
 *   - arquivos do programa (.DEC, .REC, .DBK) sem CPF ou sem ano reconhecíveis;
 *   - qualquer arquivo com CPF válido no nome mas sem ano, ou numa pasta de pré-preenchidas.
 * Os demais (.PDF e .XML sem CPF no nome) ficam só no log: as pastas do programa IRPF trazem
 * dezenas de arquivos do próprio programa (ajuda, tabelas) que encheriam a caixa de entrada.
 * O motivo `cliente_nao_cadastrado` não sai daqui: depende da resposta 404 da API ao envio.
 */
export function planFile(c: Classified): Plan {
  if (c.cpfMismatch) return { action: 'inbox', reason: 'sem_cpf', why: c.skipReason ?? 'CPF divergente', cpf: null, year: c.year };
  if (!c.skipReason && c.cpf && c.year) return { action: 'upload', destination: c.destination };
  const why = c.skipReason ?? 'não identificado';
  const fromProgram = c.type === 'dec' || c.type === 'rec' || c.type === 'dbk';
  if (c.cpf || fromProgram || c.destination === 'prefilled') return { action: 'inbox', reason: 'sem_cpf', why, cpf: c.cpf, year: c.year };
  return { action: 'skip', why };
}
