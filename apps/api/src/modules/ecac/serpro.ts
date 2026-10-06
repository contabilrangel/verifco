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

/**
 * Resposta normalizada: `dados` do serviço, `pending` quando o SERPRO ainda processa (202/204) e
 * `tempoEsperaMs`, o tempo sugerido para tentar de novo (quando informado).
 */
export interface SerproResponse {
  dados: unknown;
  pending: boolean;
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
 * apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/pt/catalogo_de_servicos/).
 *
 * Fora daqui, de propósito:
 * - CAIXAPOSTAL/MSGDETALHAMENTO62 (conteúdo da mensagem): pela documentação, consultar o detalhe
 *   "caracteriza ciência da intimação" (Decreto 70.235/1972, art. 23, § 2º, III). O robô só lista
 *   as mensagens (assunto, data, lida/não lida); quem abre o conteúdo é o contador, no eCAC.
 * - SICALC/CONSOLIDARGERARDARF51: emitir DARF é uma ação (cobrada) sobre uma quota específica, não
 *   uma consulta; as guias do IRPF vêm da declaração (etapa DARF).
 * - Declaração do IRPF (situação, malha, lote de restituição), extratos e pré-preenchida: o
 *   catálogo do Integra Contador não tem serviço de IRPF (conferido em 06/10/2026, catálogo
 *   atualizado em 03/09/2026). Esses dados vêm da extensão do navegador ou de lançamento manual.
 * - Emissão de CND: também não existe no Integra Contador; o SITFIS informa a certidão vigente.
 */
export const SERPRO_SERVICES = {
  /** Procurações eletrônicas entre o cliente (outorgante) e o procurador (outorgado). */
  procuration: { tipo: 'Consultar', idSistema: 'PROCURACOES', idServico: 'OBTERPROCURACAO41', versaoSistema: '1' },
  /** Indicador de mensagens novas na caixa postal (0 nenhuma, 1 uma, 2 várias). Não é bilhetado. */
  mailboxIndicator: { tipo: 'Monitorar', idSistema: 'CAIXAPOSTAL', idServico: 'INNOVAMSG63', versaoSistema: '1.0' },
  /** Lista das mensagens da caixa postal (até 50 por página, as mais recentes primeiro). */
  mailboxList: { tipo: 'Consultar', idSistema: 'CAIXAPOSTAL', idServico: 'MSGCONTRIBUINTE61', versaoSistema: '1.0' },
  /** Protocolo do relatório de situação fiscal (assíncrono). */
  fiscalSituationRequest: { tipo: 'Apoiar', idSistema: 'SITFIS', idServico: 'SOLICITARPROTOCOLO91', versaoSistema: '2.0' },
  /** Relatório de situação fiscal (PDF em base64) a partir do protocolo. */
  fiscalSituationReport: { tipo: 'Emitir', idSistema: 'SITFIS', idServico: 'RELATORIOSITFIS92', versaoSistema: '2.0' },
  /** Pagamentos (DARF/DAS) do contribuinte. */
  payments: { tipo: 'Consultar', idSistema: 'PAGTOWEB', idServico: 'PAGAMENTOS71', versaoSistema: '1.0' },
} as const satisfies Record<string, Omit<SerproRequest, 'contribuinte' | 'dados'>>;

/** Código de receita do DARF das quotas do IRPF (declaração de ajuste anual). */
export const IRPF_QUOTA_REVENUE_CODE = '0211';

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
    ) => Promise<{ dados?: unknown; pending?: boolean; raw?: unknown; tempoEsperaMs?: number }>;
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
        return { dados: r.dados ?? r.raw ?? null, pending: Boolean(r.pending), tempoEsperaMs: typeof r.tempoEsperaMs === 'number' ? r.tempoEsperaMs : undefined };
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

// ---------------------------------------------------------------------------
// Caixa postal, situação fiscal e pagamentos
// ---------------------------------------------------------------------------

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Valores da resposta guardados na chave pedida (ex.: `listaMensagens`), onde quer que estejam. */
function findAll(raw: unknown, key: string): unknown[] {
  const out: unknown[] = [];
  for (const [k, v] of walk(raw)) if (k === key) out.push(v);
  return out;
}

export interface SerproMailboxMessage {
  /** Identificador estável: `serpro:` + `isn` (ou o número de controle). */
  externalId: string;
  subject: string;
  receivedAt: string | null;
  read: boolean;
  relevant: boolean;
  origin: string | null;
  controlNumber: string | null;
  /** Data de ciência registrada pela Receita (AAAA-MM-DD), se houver. */
  acknowledgedAt: string | null;
}

/**
 * Mensagens de MSGCONTRIBUINTE61 (`conteudo[].listaMensagens[]`). O assunto vem com
 * `++VARIAVEL++` trocado por `valorParametroAssunto`, como manda a documentação; a mensagem conta
 * como lida quando tem data de leitura ou `indicadorLeitura` 1. Linhas sem identificador são ignoradas.
 */
export function interpretMailboxList(raw: unknown): SerproMailboxMessage[] {
  const out: SerproMailboxMessage[] = [];
  for (const list of findAll(raw, 'listaMensagens')) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const r = m as Record<string, unknown>;
      const control = text(r.numeroControle);
      const id = text(r.isn) || control;
      if (!id) continue;
      const subject = text(r.assuntoModelo).replace(/\+\+VARIAVEL\+\+/g, text(r.valorParametroAssunto)) || 'Mensagem sem assunto';
      out.push({
        externalId: `serpro:${id}`,
        subject: subject.slice(0, 300),
        receivedAt: normalizeDate(text(r.dataEnvio)),
        read: Boolean(normalizeDate(text(r.dataLeitura))) || text(r.indicadorLeitura) === '1',
        relevant: text(r.relevancia) === '2',
        origin: text(r.descricaoOrigem) || null,
        controlNumber: control || null,
        acknowledgedAt: normalizeDate(text(r.dataCiencia)),
      });
    }
  }
  return out;
}

/** Protocolo e tempo de espera (ms) de SOLICITARPROTOCOLO91. */
export function interpretSitfisProtocol(raw: unknown): { protocol: string | null; waitMs: number | null } {
  const protocol = findAll(raw, 'protocoloRelatorio').map(text).find(Boolean) ?? null;
  const wait = findAll(raw, 'tempoEspera')
    .map(Number)
    .find((n) => Number.isFinite(n) && n >= 0);
  return { protocol, waitMs: wait ?? null };
}

/** PDF (base64 → bytes) de RELATORIOSITFIS92; `null` se a resposta não trouxer um PDF. */
export function sitfisPdf(raw: unknown): Buffer | null {
  for (const v of findAll(raw, 'pdf')) {
    if (typeof v !== 'string' || v.length < 20) continue;
    const buf = Buffer.from(v.replace(/\s+/g, ''), 'base64');
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return buf;
  }
  return null;
}

export interface SerproPayment {
  documentNumber: string;
  /** Código de receita com 4 dígitos. */
  revenueCode: string;
  /** Datas AAAA-MM-DD. */
  paidOn: string | null;
  dueDate: string | null;
  totalCents: number | null;
  principalCents: number | null;
}

const reaisToCents = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Documentos pagos de PAGAMENTOS71 (lista de `DocumentoArrecadacaoIC`). O código de receita vem
 * sem zeros à esquerda (ex.: "211") e volta com 4 dígitos; valores em reais viram centavos.
 */
export function interpretPayments(input: unknown): SerproPayment[] {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const docs: unknown[] = [];
  if (Array.isArray(raw)) docs.push(...raw);
  for (const [, v] of walk(raw)) if (Array.isArray(v)) docs.push(...v);
  const out: SerproPayment[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    const r = d as Record<string, unknown>;
    const number = text(r.numeroDocumento);
    if (!number || seen.has(number)) continue;
    seen.add(number);
    const revenue = text((r.receitaPrincipal as Record<string, unknown> | null | undefined)?.codigo).replace(/\D/g, '');
    out.push({
      documentNumber: number,
      revenueCode: revenue ? revenue.padStart(4, '0') : '',
      paidOn: normalizeDate(text(r.dataArrecadacao)),
      dueDate: normalizeDate(text(r.dataVencimento)),
      totalCents: reaisToCents(r.valorTotal),
      principalCents: reaisToCents(r.valorPrincipal),
    });
  }
  return out;
}
