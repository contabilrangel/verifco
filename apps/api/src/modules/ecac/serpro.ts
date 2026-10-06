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
  /** Indicador de mensagens novas na caixa postal (0 nenhuma, 1 uma, 2 várias). */
  mailboxIndicator: { tipo: 'Monitorar', idSistema: 'CAIXAPOSTAL', idServico: 'INNOVAMSG63', versaoSistema: '1.0' },
} as const satisfies Record<string, Omit<SerproRequest, 'contribuinte' | 'dados'>>;

const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const SERPRO_FILE = fileURLToPath(new URL(`../../integrations/serpro${EXT}`, import.meta.url));

type ModuleShape = {
  getSerproClient?: (ctx: AppContext, officeId: string) => Promise<{
    call: (tipo: string, contribuinte: string, idSistema: string, idServico: string, dados?: unknown, opts?: { versaoSistema?: string }) => Promise<{ dados?: unknown; pending?: boolean; raw?: unknown }>;
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
        return { dados: r.dados ?? r.raw ?? null, pending: Boolean(r.pending) };
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
export function interpretProcuration(raw: unknown, today = new Date().toISOString().slice(0, 10)): { status: 'valid' | 'expired'; expiresAt: string } | null {
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
