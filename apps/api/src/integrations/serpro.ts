/**
 * SERPRO Integra Contador — cliente usado pelo módulo eCAC.
 *
 * Documentação oficial: https://apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/pt/
 * - Autenticação (quick_start/): POST https://autenticacao.sapi.serpro.gov.br/authenticate com
 *   `Authorization: Basic base64(consumerKey:consumerSecret)`, `Role-Type: TERCEIROS`,
 *   corpo `grant_type=client_credentials` e o certificado digital do contratante (.pfx) em mTLS.
 *   Devolve `access_token`, `jwt_token` e `expires_in`; em 401 basta autenticar de novo.
 * - Chamadas (integra_contador/): POST https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/{Apoiar|Consultar|Emitir|Declarar|Monitorar}
 *   com `Authorization: Bearer <access_token>` e cabeçalho `jwt_token`; corpo
 *   `{ contratante, autorPedidoDados, contribuinte, pedidoDados: { idSistema, idServico, versaoSistema, dados } }`,
 *   `dados` como JSON em string; tipo 1 = CPF, 2 = CNPJ (o contratante é sempre CNPJ).
 * - Códigos de retorno (codigos_retorno/): 200 ok, 202/204 em processamento (aguardar `tempoEspera`/ETag),
 *   403 sem procuração, 429 limite. Quando o autor do pedido é um procurador diferente do contratante,
 *   envie o `autenticar_procurador_token` obtido em AUTENTICAPROCURADOR/ENVIOXMLASSINADO81.
 */
import https from 'node:https';
import { and, eq } from 'drizzle-orm';
import { onlyDigits } from '@verifco/shared';
import type { AppContext } from '../context';
import { offices, procurators } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { IntegrationError, errorMessage, httpRequest, todayIso } from './http';
import { loadIntegration, requireIntegration, type LoadedIntegration } from './store';

export type SerproTipo = 'Apoiar' | 'Consultar' | 'Emitir' | 'Declarar' | 'Monitorar';

export const SERPRO_AUTH_URL = 'https://autenticacao.sapi.serpro.gov.br/authenticate';
export const SERPRO_GATEWAY_URL = 'https://gateway.apiserpro.serpro.gov.br/integra-contador/v1';

export interface SerproServiceDef {
  tipo: SerproTipo;
  idSistema: string;
  idServico: string;
  versaoSistema: string;
  descricao: string;
  /** Campos de `dados` conforme a documentação do serviço. */
  dados: string;
  fonte: string;
}

const DOC = 'https://apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/pt';

/**
 * Serviços conferidos na documentação oficial (catálogo em `${DOC}/catalogo_de_servicos/`
 * e a página de cada serviço). Não acrescente códigos sem conferir a fonte.
 */
export const SERPRO_SERVICES = {
  procuracoes: {
    tipo: 'Consultar',
    idSistema: 'PROCURACOES',
    idServico: 'OBTERPROCURACAO41',
    versaoSistema: '1',
    descricao: 'Procurações eletrônicas entre outorgante e procurador (sistemas e data de expiração).',
    dados: '{ outorgante, tipoOutorgante ("1" CPF | "2" CNPJ), outorgado, tipoOutorgado }',
    fonte: `${DOC}/solucoes/integra-procuracoes/procuracoes/servicos/obter_procuracao/`,
  },
  caixaPostalLista: {
    tipo: 'Consultar',
    idSistema: 'CAIXAPOSTAL',
    idServico: 'MSGCONTRIBUINTE61',
    versaoSistema: '1.0',
    descricao: 'Lista as mensagens da caixa postal do contribuinte no e-CAC.',
    dados: '{ statusLeitura (0 todas | 1 lidas | 2 não lidas), indicadorPagina (0 inicial | 1 seguinte), indicadorFavorito?, cnpjReferencia? }',
    fonte: `${DOC}/solucoes/integra-caixapostal/caixapostal/servicos/obter_lista_de_mensagens_por_contribuintes/`,
  },
  caixaPostalMensagem: {
    tipo: 'Consultar',
    idSistema: 'CAIXAPOSTAL',
    idServico: 'MSGDETALHAMENTO62',
    versaoSistema: '1.0',
    descricao: 'Detalhe de uma mensagem da caixa postal.',
    dados: '{ isn }',
    fonte: `${DOC}/solucoes/integra-caixapostal/caixapostal/servicos/obter_detalhes_de_uma_mensagem_especifica/`,
  },
  caixaPostalNovas: {
    tipo: 'Monitorar',
    idSistema: 'CAIXAPOSTAL',
    idServico: 'INNOVAMSG63',
    versaoSistema: '1.0',
    descricao: 'Indicador de mensagens novas (0 nenhuma, 1 uma, 2 várias). Não é bilhetado.',
    dados: 'vazio ("")',
    fonte: `${DOC}/solucoes/integra-caixapostal/caixapostal/servicos/obter_indicador_de_novas_mensagens/`,
  },
  dteSituacao: {
    tipo: 'Consultar',
    idSistema: 'DTE',
    idServico: 'CONSULTASITUACAODTE111',
    versaoSistema: '1.0',
    descricao: 'Adesão do contribuinte ao Domicílio Tributário Eletrônico.',
    dados: 'vazio ("")',
    fonte: `${DOC}/solucoes/integra-caixapostal/dte/servicos/obter_indicador_dte/`,
  },
  situacaoFiscalSolicitar: {
    tipo: 'Apoiar',
    idSistema: 'SITFIS',
    idServico: 'SOLICITARPROTOCOLO91',
    versaoSistema: '2.0',
    descricao: 'Pede o protocolo do relatório de situação fiscal (assíncrono).',
    dados: 'vazio ("")',
    fonte: `${DOC}/solucoes/integra-sitfis/sitfis/servicos/apoiar_relatorio/`,
  },
  situacaoFiscalRelatorio: {
    tipo: 'Emitir',
    idSistema: 'SITFIS',
    idServico: 'RELATORIOSITFIS92',
    versaoSistema: '2.0',
    descricao: 'Emite o relatório de situação fiscal (PDF em base64) a partir do protocolo.',
    dados: '{ protocoloRelatorio }',
    fonte: `${DOC}/solucoes/integra-sitfis/sitfis/servicos/emitir_relatorio/`,
  },
  darfSicalc: {
    tipo: 'Emitir',
    idSistema: 'SICALC',
    idServico: 'CONSOLIDARGERARDARF51',
    versaoSistema: '2.9',
    descricao: 'Consolida o débito e emite o DARF em PDF.',
    dados: 'conforme a receita (consulte CONSULTAAPOIORECEITAS52)',
    fonte: `${DOC}/solucoes/integra-sicalc/sicalc/servicos/consolidar_emitir_um_darf/`,
  },
  sicalcReceita: {
    tipo: 'Apoiar',
    idSistema: 'SICALC',
    idServico: 'CONSULTAAPOIORECEITAS52',
    versaoSistema: '2.9',
    descricao: 'Campos obrigatórios e opcionais de uma receita para emitir o DARF.',
    dados: '{ codigoReceita }',
    fonte: `${DOC}/solucoes/integra-sicalc/sicalc/servicos/apoio_consulta_receitas_do_sicalc/`,
  },
  pagamentos: {
    tipo: 'Consultar',
    idSistema: 'PAGTOWEB',
    idServico: 'PAGAMENTOS71',
    versaoSistema: '1.0',
    descricao: 'Consulta pagamentos (DARF/DAS) do contribuinte.',
    dados: '{ primeiroDaPagina, tamanhoDaPagina, intervaloDataArrecadacao?, codigoReceitaLista?, ... }',
    fonte: `${DOC}/solucoes/integra-pagamento/pagtoweb/servicos/consulta_pagamento/`,
  },
  eventosPfSolicitar: {
    tipo: 'Monitorar',
    idSistema: 'EVENTOSATUALIZACAO',
    idServico: 'SOLICEVENTOSPF131',
    versaoSistema: '1.0',
    descricao: 'Solicita em lote os eventos de atualização de pessoas físicas.',
    dados: '{ evento }',
    fonte: `${DOC}/solucoes/integra-contador-gerenciador/eventosatualizacao/servicos/solicitar_eventos_pf/`,
  },
  eventosPfObter: {
    tipo: 'Monitorar',
    idSistema: 'EVENTOSATUALIZACAO',
    idServico: 'OBTEREVENTOSPF133',
    versaoSistema: '1.0',
    descricao: 'Obtém os eventos de atualização de pessoas físicas solicitados.',
    dados: '{ protocolo, evento }',
    fonte: `${DOC}/solucoes/integra-contador-gerenciador/eventosatualizacao/servicos/obter_eventos_pf/`,
  },
  autenticaProcurador: {
    tipo: 'Apoiar',
    idSistema: 'AUTENTICAPROCURADOR',
    idServico: 'ENVIOXMLASSINADO81',
    versaoSistema: '1.0',
    descricao: 'Envia o termo de autorização assinado pelo procurador e recebe o autenticar_procurador_token.',
    dados: '{ xml (termo assinado em base64) }',
    fonte: `${DOC}/solucoes/integra-contador-gerenciador/autenticaprocurador/servicos/envio_de_xml_assinado/`,
  },
} as const satisfies Record<string, SerproServiceDef>;

export type SerproServiceKey = keyof typeof SERPRO_SERVICES;

export interface SerproConfig {
  contractorCnpj: string;
  procuratorId: string;
}
export interface SerproSecrets {
  consumerKey?: string;
  consumerSecret?: string;
}

/** POST com certificado de cliente (mTLS). Injetável nos testes. */
export type MtlsRequest = (
  url: string,
  init: { headers: Record<string, string>; body: string; pfx: Buffer; passphrase: string; timeoutMs: number },
) => Promise<{ status: number; body: string }>;

/** Implementação real: `https.Agent({ pfx, passphrase })`. */
export const httpsMtlsRequest: MtlsRequest = (url, init) =>
  new Promise((resolve, reject) => {
    let agent: https.Agent;
    try {
      agent = new https.Agent({ pfx: init.pfx, passphrase: init.passphrase, keepAlive: false });
    } catch (err) {
      reject(err);
      return;
    }
    const req = https.request(url, { method: 'POST', headers: { ...init.headers, 'Content-Length': Buffer.byteLength(init.body) }, agent, timeout: init.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        agent.destroy();
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => {
      agent.destroy();
      reject(err);
    });
    req.end(init.body);
  });

export interface SerproToken {
  accessToken: string;
  jwtToken: string;
  expiresAt: number;
}

export interface SerproMensagem {
  codigo: string;
  texto: string;
}

export interface SerproResult<T = unknown> {
  status: number;
  /** `dados` já convertido de string JSON quando possível. */
  dados: T | string | null;
  mensagens: SerproMensagem[];
  /** 202/204: ainda em processamento; tente de novo após `tempoEsperaMs`. */
  pending: boolean;
  tempoEsperaMs?: number;
  raw: unknown;
}

export interface SerproCallOptions {
  versaoSistema?: string;
  /** CPF/CNPJ do autor do pedido (padrão: o contratante). */
  autorPedidoDados?: string;
  autenticarProcuradorToken?: string;
  timeoutMs?: number;
}

const niTipo = (ni: string) => (ni.length === 11 ? 1 : 2);
const TOKEN_MARGIN_MS = 60_000;
const tokenCache = new Map<string, SerproToken>();

function certificateError(err: unknown): IntegrationError {
  const e = err as { code?: string; message?: string };
  const msg = `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (/mac verify failure|bad decrypt/i.test(msg)) return new IntegrationError('serpro', 'A senha do certificado digital está incorreta.');
  if (/unsupported|ERR_OSSL_EVP_UNSUPPORTED|not enough data|wrong tag/i.test(msg)) {
    return new IntegrationError('serpro', 'Não foi possível ler o certificado (.pfx). Exporte-o novamente com criptografia AES-256 e cadastre de novo.');
  }
  if (/ETIMEDOUT|timeout/i.test(msg)) return new IntegrationError('serpro', 'O SERPRO não respondeu à autenticação a tempo. Tente novamente.');
  return new IntegrationError('serpro', `Falha na conexão com o SERPRO: ${errorMessage(err)}`);
}

export interface SerproClientOptions {
  fetch: typeof fetch;
  mtls?: MtlsRequest;
  consumerKey: string;
  consumerSecret: string;
  contractorCnpj: string;
  /** Carrega o .pfx e a senha só quando for autenticar. */
  certificate: () => Promise<{ pfx: Buffer; passphrase: string }>;
  /** Chave do cache de token (escritório + credenciais). */
  cacheKey: string;
}

export class SerproClient {
  constructor(private opts: SerproClientOptions) {}

  get contractorCnpj() {
    return this.opts.contractorCnpj;
  }

  /** OAuth2 client_credentials com mTLS; reaproveita o token até perto de expirar. */
  async authenticate(force = false): Promise<SerproToken> {
    const cached = tokenCache.get(this.opts.cacheKey);
    if (!force && cached && cached.expiresAt > Date.now() + TOKEN_MARGIN_MS) return cached;
    const { pfx, passphrase } = await this.opts.certificate();
    const basic = Buffer.from(`${this.opts.consumerKey}:${this.opts.consumerSecret}`).toString('base64');
    let res: { status: number; body: string };
    try {
      res = await (this.opts.mtls ?? httpsMtlsRequest)(SERPRO_AUTH_URL, {
        headers: { Authorization: `Basic ${basic}`, 'Role-Type': 'TERCEIROS', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'grant_type=client_credentials',
        pfx,
        passphrase,
        timeoutMs: 30_000,
      });
    } catch (err) {
      throw certificateError(err);
    }
    let data: { access_token?: string; jwt_token?: string; expires_in?: number; error_description?: string; message?: string } = {};
    try {
      data = JSON.parse(res.body || '{}');
    } catch {
      /* corpo não JSON */
    }
    if (res.status === 401 || res.status === 403) {
      throw new IntegrationError('serpro', `O SERPRO recusou a autenticação (HTTP ${res.status}). Confira a Consumer Key, o Consumer Secret e se o certificado é o do contratante.`, res.status);
    }
    if (res.status < 200 || res.status >= 300 || !data.access_token || !data.jwt_token) {
      const detail = data.error_description ?? data.message ?? res.body.slice(0, 200);
      throw new IntegrationError('serpro', `Falha na autenticação do SERPRO (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`, res.status);
    }
    const token = { accessToken: data.access_token, jwtToken: data.jwt_token, expiresAt: Date.now() + (Number(data.expires_in) || 1800) * 1000 };
    tokenCache.set(this.opts.cacheKey, token);
    return token;
  }

  /**
   * Chamada genérica ao Integra Contador.
   * `dados` pode ser objeto (vira JSON em string, como a API exige), string ou vazio.
   */
  async call<T = unknown>(
    tipo: SerproTipo,
    contribuinte: string,
    idSistema: string,
    idServico: string,
    dados?: unknown,
    opts: SerproCallOptions = {},
  ): Promise<SerproResult<T>> {
    const contrib = onlyDigits(contribuinte);
    if (contrib.length !== 11 && contrib.length !== 14) throw new IntegrationError('serpro', 'CPF/CNPJ do contribuinte inválido.');
    const autor = onlyDigits(opts.autorPedidoDados) || this.opts.contractorCnpj;
    const known = Object.values(SERPRO_SERVICES).find((s) => s.idSistema === idSistema && s.idServico === idServico);
    const body = {
      contratante: { numero: this.opts.contractorCnpj, tipo: 2 },
      autorPedidoDados: { numero: autor, tipo: niTipo(autor) },
      contribuinte: { numero: contrib, tipo: niTipo(contrib) },
      pedidoDados: {
        idSistema,
        idServico,
        versaoSistema: opts.versaoSistema ?? known?.versaoSistema ?? '1.0',
        dados: dados === undefined || dados === null ? '' : typeof dados === 'string' ? dados : JSON.stringify(dados),
      },
    };
    const send = async (token: SerproToken) =>
      httpRequest<Record<string, unknown>>(this.opts.fetch, 'serpro', `${SERPRO_GATEWAY_URL}/${tipo}`, {
        method: 'POST',
        body,
        timeoutMs: opts.timeoutMs ?? 60_000,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          jwt_token: token.jwtToken,
          ...(opts.autenticarProcuradorToken ? { autenticar_procurador_token: opts.autenticarProcuradorToken } : {}),
        },
      });
    let res = await send(await this.authenticate());
    // token expirado ou revogado: autentica de novo uma vez
    if (res.status === 401) res = await send(await this.authenticate(true));

    const payload = (res.data && typeof res.data === 'object' ? res.data : {}) as { dados?: unknown; mensagens?: SerproMensagem[]; status?: number };
    const mensagens = Array.isArray(payload.mensagens) ? payload.mensagens : [];
    if (res.status === 202 || res.status === 204) {
      const dadosObj = parseDados(payload.dados) as { tempoEspera?: number } | null;
      const etag = res.headers.get('etag');
      const wait = Number(dadosObj?.tempoEspera ?? (etag ? /(\d+)/.exec(etag)?.[1] : undefined));
      return { status: res.status, dados: dadosObj as T | null, mensagens, pending: true, tempoEsperaMs: Number.isFinite(wait) ? wait : undefined, raw: res.data };
    }
    if (!res.ok) {
      const detail = mensagens.map((m) => m.texto).filter(Boolean).join(' ') || res.text.slice(0, 300);
      const prefix =
        res.status === 403
          ? 'Acesso negado pelo SERPRO (verifique a procuração eletrônica no e-CAC)'
          : res.status === 429
            ? 'Limite de requisições do SERPRO atingido'
            : `SERPRO respondeu com erro (HTTP ${res.status})`;
      throw new IntegrationError('serpro', `${prefix}${detail ? `: ${detail}` : '.'}`, res.status, { mensagens });
    }
    return { status: res.status, dados: parseDados(payload.dados) as T | string | null, mensagens, pending: false, raw: res.data };
  }

  /** Atalho para um serviço do catálogo `SERPRO_SERVICES`. */
  callService<T = unknown>(service: SerproServiceKey, contribuinte: string, dados?: unknown, opts: SerproCallOptions = {}) {
    const s = SERPRO_SERVICES[service];
    return this.call<T>(s.tipo, contribuinte, s.idSistema, s.idServico, dados, { versaoSistema: s.versaoSistema, ...opts });
  }
}

function parseDados(dados: unknown): unknown {
  if (typeof dados !== 'string') return dados ?? null;
  if (!dados) return null;
  try {
    return JSON.parse(dados);
  } catch {
    return dados;
  }
}

async function loadCertificate(ctx: AppContext, officeId: string, procuratorId: string) {
  const proc = procuratorId
    ? await ctx.db.query.procurators.findFirst({ where: and(eq(procurators.officeId, officeId), eq(procurators.id, procuratorId)) })
    : null;
  if (!proc) throw new IntegrationError('serpro', 'Selecione o certificado digital do escritório na integração SERPRO.');
  if (!proc.certificateFileId || !proc.certificatePasswordEnc) {
    throw new IntegrationError('serpro', `O procurador ${proc.name} não tem certificado A1 (.pfx) e senha cadastrados.`);
  }
  if (proc.certificateExpiresAt && proc.certificateExpiresAt < todayIso()) {
    throw new IntegrationError('serpro', `O certificado de ${proc.name} venceu em ${proc.certificateExpiresAt.split('-').reverse().join('/')}.`);
  }
  const file = await ctx.files.get(officeId, proc.certificateFileId);
  return { pfx: file.data, passphrase: ctx.secrets.decrypt(proc.certificatePasswordEnc) };
}

/** Monta o cliente a partir da configuração carregada (habilitada ou não). */
export async function serproClientFrom(
  ctx: AppContext,
  officeId: string,
  loaded: LoadedIntegration<SerproConfig, SerproSecrets>,
  deps: { mtls?: MtlsRequest } = {},
): Promise<SerproClient> {
  const { consumerKey, consumerSecret } = loaded.secrets;
  if (!consumerKey || !consumerSecret) throw new IntegrationError('serpro', 'Informe a Consumer Key e o Consumer Secret do SERPRO em Administração › Integrações.');
  let cnpj = onlyDigits(loaded.config.contractorCnpj);
  if (!cnpj) {
    const office = await ctx.db.query.offices.findFirst({ where: eq(offices.id, officeId) });
    cnpj = onlyDigits(office?.cpfCnpj);
  }
  if (cnpj.length !== 14) throw new IntegrationError('serpro', 'Informe o CNPJ do contratante do Integra Contador.');
  const procuratorId = loaded.config.procuratorId;
  return new SerproClient({
    fetch: ctx.providers.fetch,
    mtls: deps.mtls ?? ctx.providers.mtlsRequest,
    consumerKey,
    consumerSecret,
    contractorCnpj: cnpj,
    certificate: () => loadCertificate(ctx, officeId, procuratorId),
    cacheKey: `${officeId}:${procuratorId}:${sha256(`${consumerKey}:${consumerSecret}`)}`,
  });
}

/**
 * Cliente do Integra Contador do escritório (integração precisa estar ativa).
 * Uso no módulo eCAC:
 *   const serpro = await getSerproClient(ctx, officeId);
 *   const r = await serpro.callService('caixaPostalNovas', cpf);
 *   const r2 = await serpro.call('Consultar', cpf, 'CAIXAPOSTAL', 'MSGCONTRIBUINTE61', { statusLeitura: '0', indicadorPagina: '0' });
 */
export async function getSerproClient(ctx: AppContext, officeId: string, deps: { mtls?: MtlsRequest } = {}) {
  const loaded = await requireIntegration<SerproConfig, SerproSecrets>(ctx, officeId, 'serpro');
  return serproClientFrom(ctx, officeId, loaded, deps);
}

/** Teste: só autentica (não consome serviços bilhetados). */
export async function testSerpro(ctx: AppContext, officeId: string, deps: { mtls?: MtlsRequest } = {}) {
  const loaded = await loadIntegration<SerproConfig, SerproSecrets>(ctx, officeId, 'serpro');
  if (!loaded) throw new IntegrationError('serpro', 'Salve a configuração do SERPRO antes de testar.');
  const client = await serproClientFrom(ctx, officeId, loaded, deps);
  const token = await client.authenticate(true);
  const minutes = Math.max(1, Math.round((token.expiresAt - Date.now()) / 60_000));
  return `Autenticado no SERPRO Integra Contador (token válido por ${minutes} min).`;
}

/** Limpa o cache de tokens (testes ou troca de credenciais). */
export function clearSerproTokens(prefix?: string) {
  for (const k of [...tokenCache.keys()]) if (!prefix || k.startsWith(prefix)) tokenCache.delete(k);
}
