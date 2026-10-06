/**
 * Adaptador entre o robô eCAC e a integração oficial SERPRO Integra Contador.
 *
 * A integração em si (autenticação mTLS/OAuth, contrato do escritório, chamada HTTP) fica em
 * `src/integrations/serpro.ts`, mantida em outro módulo. Este arquivo é o ÚNICO ponto que
 * conhece a forma dela. Aceita, nesta ordem:
 *
 *   1. `getSerproClient(ctx, officeId)` → cliente com
 *      `call(tipo, contribuinte, idSistema, idServico, dados?, { versaoSistema })`
 *      que devolve `{ dados, pending, raw }` (lança erro quando a integração não está ativa);
 *   2. `call(ctx, officeId, { tipo, idSistema, idServico, versaoSistema, contribuinte, dados })`
 *      (+ `isConfigured(ctx, officeId)` opcional).
 *
 * Se o arquivo não existir (ou não exportar nenhuma das formas), a sincronização falha com a
 * mensagem "Integração SERPRO não configurada" — nunca simulamos dados do eCAC.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { todayIso } from '@verifco/shared';
import type { AppContext } from '../../context';
import { normalizeDate } from './util';

export interface SerproRequest {
  tipo: 'Apoiar' | 'Consultar' | 'Declarar' | 'Emitir' | 'Monitorar';
  idSistema: string;
  idServico: string;
  versaoSistema?: string;
  /** CPF/CNPJ do contribuinte (cliente), só dígitos. */
  contribuinte: string;
  dados?: Record<string, unknown> | string;
}

/** Resposta normalizada: `dados` do serviço e `pending` quando o SERPRO ainda processa (202/204). */
export interface SerproResponse {
  dados: unknown;
  pending: boolean;
  /** Espera sugerida pelo SERPRO antes de tentar de novo (`tempoEspera`/ETag), em ms. */
  tempoEsperaMs?: number;
}

export interface SerproClient {
  call(req: SerproRequest): Promise<SerproResponse>;
}

export const SERPRO_NOT_CONFIGURED =
  'Integração SERPRO não configurada: a consulta automática ao eCAC usa o SERPRO Integra Contador. ' +
  'Configure-a em Administração › Integrações ou envie os dados pela extensão do navegador ou pelo sincronizador.';

/**
 * Serviços do Integra Contador usados na sincronização (catálogo oficial:
 * apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador).
 */
export const SERPRO_SERVICES = {
  /** Procurações eletrônicas entre o cliente (outorgante) e o procurador (outorgado). */
  procuration: { tipo: 'Consultar', idSistema: 'PROCURACOES', idServico: 'OBTERPROCURACAO41', versaoSistema: '1' },
  /** Indicador de mensagens novas na caixa postal (0 nenhuma, 1 uma, 2 várias). Não é bilhetado. */
  mailboxIndicator: { tipo: 'Monitorar', idSistema: 'CAIXAPOSTAL', idServico: 'INNOVAMSG63', versaoSistema: '1.0' },
  /**
   * Lista de mensagens da caixa postal, até 50 por página (as mais recentes na inicial):
   * `dados` { statusLeitura (0 todas), indicadorPagina (0 inicial) } → `conteudo[].listaMensagens[]`.
   */
  mailboxList: { tipo: 'Consultar', idSistema: 'CAIXAPOSTAL', idServico: 'MSGCONTRIBUINTE61', versaoSistema: '1.0' },
  /** Protocolo do relatório de situação fiscal (`dados` vazio) → { protocoloRelatorio, tempoEspera }. */
  fiscalSituationRequest: { tipo: 'Apoiar', idSistema: 'SITFIS', idServico: 'SOLICITARPROTOCOLO91', versaoSistema: '2.0' },
  /** Relatório de situação fiscal ({ protocoloRelatorio }) → { pdf (base64) }; 202/204 enquanto processa. */
  fiscalSituationReport: { tipo: 'Emitir', idSistema: 'SITFIS', idServico: 'RELATORIOSITFIS92', versaoSistema: '2.0' },
  /**
   * Pagamentos (DARF/DAS) do contribuinte: `dados` { codigoReceitaLista, intervaloDataArrecadacao,
   * primeiroDaPagina, tamanhoDaPagina (até 100) } → lista de documentos de arrecadação.
   */
  payments: { tipo: 'Consultar', idSistema: 'PAGTOWEB', idServico: 'PAGAMENTOS71', versaoSistema: '1.0' },
} as const satisfies Record<string, Omit<SerproRequest, 'contribuinte' | 'dados'>>;

const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const SERPRO_FILE = fileURLToPath(new URL(`../../integrations/serpro${EXT}`, import.meta.url));

type ModuleShape = {
  getSerproClient?: (ctx: AppContext, officeId: string) => Promise<{
    call: (
      tipo: string,
      contribuinte: string,
      idSistema: string,
      idServico: string,
      dados?: unknown,
      opts?: { versaoSistema?: string },
    ) => Promise<{ dados?: unknown; pending?: boolean; tempoEsperaMs?: number; raw?: unknown }>;
  }>;
  call?: (ctx: AppContext, officeId: string, req: SerproRequest) => Promise<unknown>;
  isConfigured?: (ctx: AppContext, officeId: string) => Promise<boolean>;
};

/** Módulo da integração, se existir no projeto. */
export async function loadSerproModule(): Promise<ModuleShape | null> {
  if (!existsSync(SERPRO_FILE)) return null;
  const mod = (await import(pathToFileURL(SERPRO_FILE).href)) as ModuleShape;
  return typeof mod.getSerproClient === 'function' || typeof mod.call === 'function' ? mod : null;
}

/** Monta o cliente do escritório; lança o erro explicativo (sempre citando o SERPRO) quando indisponível. */
export async function requireSerpro(ctx: AppContext, officeId: string): Promise<SerproClient> {
  const mod = await loadSerproModule();
  if (!mod) throw new Error(SERPRO_NOT_CONFIGURED);
  if (mod.getSerproClient) {
    let client: Awaited<ReturnType<NonNullable<ModuleShape['getSerproClient']>>>;
    try {
      client = await mod.getSerproClient(ctx, officeId);
    } catch (err) {
      throw new Error(`Integração SERPRO não configurada ou inativa: ${errMsg(err)}`);
    }
    return {
      call: async (req) => {
        const r = await wrap(req, () => client.call(req.tipo, req.contribuinte, req.idSistema, req.idServico, req.dados, { versaoSistema: req.versaoSistema }));
        return { dados: r.dados ?? r.raw ?? null, pending: Boolean(r.pending), tempoEsperaMs: r.tempoEsperaMs };
      },
    };
  }
  if (mod.isConfigured && !(await mod.isConfigured(ctx, officeId))) throw new Error(SERPRO_NOT_CONFIGURED);
  const call = mod.call!;
  return { call: async (req) => ({ dados: await wrap(req, () => call(ctx, officeId, req)), pending: false }) };
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Padroniza a mensagem de erro de uma chamada (sempre cita o SERPRO e o serviço). */
async function wrap<T>(req: SerproRequest, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = errMsg(err);
    throw new Error(/serpro/i.test(msg) ? msg : `Falha na consulta ao SERPRO Integra Contador (${req.idSistema}/${req.idServico}): ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Interpretação defensiva das respostas
// ---------------------------------------------------------------------------

/** Percorre a resposta (objetos, listas e JSON em texto) e coleta pares chave/valor. */
function* walk(value: unknown, depth = 0): Generator<[string, unknown]> {
  if (depth > 8) return;
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try {
      yield* walk(JSON.parse(value), depth + 1);
    } catch {
      /* texto comum */
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) yield* walk(v, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      yield [k, v];
      yield* walk(v, depth + 1);
    }
  }
}

/**
 * Procura a data de expiração da procuração na resposta (campos com "expira" no nome, como
 * `dtexpiracao`). Sem data reconhecível devolve `null`: o registro bruto é guardado, mas o
 * cadastro não muda.
 */
export function interpretProcuration(raw: unknown, today = todayIso()): { status: 'valid' | 'expired'; expiresAt: string } | null {
  const dates: string[] = [];
  for (const [k, v] of walk(raw)) {
    if (!/expira/i.test(k)) continue;
    const iso = normalizeDate(typeof v === 'number' ? String(v) : v);
    if (iso) dates.push(iso);
  }
  if (!dates.length) return null;
  const latest = dates.sort().at(-1)!;
  return { status: latest >= today ? 'valid' : 'expired', expiresAt: latest };
}

/**
 * Mensagens novas na caixa postal: um campo de quantidade, se houver; senão o indicador do
 * INNOVAMSG63 (0 nenhuma, 1 uma, 2 duas ou mais — gravado como 2). `null` se não reconhecer.
 */
export function interpretMailbox(raw: unknown): number | null {
  let indicator: number | null = null;
  for (const [k, v] of walk(raw)) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || v === null || v === '' || typeof v === 'boolean') continue;
    if (/(quantidade|qtd)/i.test(k)) return n;
    if (/indicador/i.test(k) && n <= 2 && indicator === null) indicator = n;
  }
  return indicator;
}

/** Objetos da resposta (em qualquer nível, inclusive JSON em texto) que atendem `match`; não desce neles. */
function collectObjects(value: unknown, match: (o: Record<string, unknown>) => boolean, depth = 0, out: Record<string, unknown>[] = []) {
  if (depth > 8) return out;
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try {
      collectObjects(JSON.parse(value), match, depth + 1, out);
    } catch {
      /* texto comum */
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectObjects(v, match, depth + 1, out);
    return out;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (match(o)) out.push(o);
    else for (const v of Object.values(o)) collectObjects(v, match, depth + 1, out);
  }
  return out;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** Primeiro valor (texto ou número) do campo, em qualquer nível da resposta. */
export function findField(raw: unknown, key: string): string | null {
  for (const [k, v] of walk(raw)) if (k === key && text(v)) return text(v);
  return null;
}

export interface SerproMailboxMessage {
  /** `isn` da mensagem (identificador único na caixa postal). */
  id: string;
  subject: string | null;
  receivedAt: string | null;
  read: boolean;
  origin: string | null;
  relevant: boolean;
  controlNumber: string | null;
  validUntil: string | null;
}

/**
 * Mensagens da lista MSGCONTRIBUINTE61 (`conteudo[].listaMensagens[]`). O assunto troca
 * "++VARIAVEL++" pelo `valorParametroAssunto`, como manda a documentação do serviço.
 */
export function interpretMailboxList(raw: unknown): SerproMailboxMessage[] {
  const out: SerproMailboxMessage[] = [];
  for (const m of collectObjects(raw, (o) => 'isn' in o)) {
    const id = text(m.isn);
    if (!id) continue;
    const template = text(m.assuntoModelo);
    out.push({
      id,
      subject: template ? template.replace(/\+\+VARIAVEL\+\+/g, text(m.valorParametroAssunto) ?? '').trim() : null,
      receivedAt: normalizeDate(text(m.dataEnvio)),
      read: text(m.indicadorLeitura) === '1' || Boolean(text(m.dataLeitura)),
      origin: text(m.descricaoOrigem),
      relevant: text(m.relevancia) === '2',
      controlNumber: text(m.numeroControle),
      validUntil: normalizeDate(text(m.dataValidade)),
    });
  }
  return out;
}

/** Código de receita só com os dígitos significativos (o PAGTOWEB devolve "211" para a 0211). */
export const revenueCode = (v: unknown) => String(v ?? '').replace(/\D+/g, '').replace(/^0+/, '') || null;

/** Valor em reais da resposta (número, ou texto com vírgula decimal) em centavos. */
function toCents(v: unknown): number | null {
  let n = typeof v === 'number' ? v : NaN;
  if (typeof v === 'string' && v.trim()) n = Number(v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export interface SerproPayment {
  documentNumber: string;
  revenue: string | null;
  dueDate: string | null;
  paidAt: string | null;
  totalCents: number | null;
  principalCents: number | null;
}

/** Documentos de arrecadação pagos do PAGAMENTOS71 (sem descer nos desmembramentos). */
export function interpretPayments(raw: unknown): SerproPayment[] {
  return collectObjects(raw, (o) => 'numeroDocumento' in o)
    .map((d) => {
      const revenue = d.receitaPrincipal && typeof d.receitaPrincipal === 'object' ? (d.receitaPrincipal as Record<string, unknown>).codigo : d.codigoReceita;
      return {
        documentNumber: text(d.numeroDocumento) ?? '',
        revenue: revenueCode(revenue),
        dueDate: normalizeDate(text(d.dataVencimento)),
        paidAt: normalizeDate(text(d.dataArrecadacao)),
        totalCents: toCents(d.valorTotal),
        principalCents: toCents(d.valorPrincipal),
      };
    })
    .filter((p) => p.documentNumber);
}
