/**
 * Provedor de IA com a API da Anthropic (SDK oficial `@anthropic-ai/sdk`).
 *
 * - Chave e modelo da plataforma, definidos pelo proprietário do sistema.
 * - PDFs vão como bloco `document` (base64) e imagens como bloco `image`, antes do texto.
 * - `output_config.effort` explícito (no Opus 5.5 o padrão do modelo é `medium`).
 * - Fallback no servidor em caso de recusa (`fallbacks: 'default'`, beta
 *   `server-side-fallback-2026-07-01`) nos modelos que aceitam essa forma.
 * Referência: https://docs.claude.com/en/api/messages
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AppContext } from '../context';
import { IntegrationError } from './http';
import type { AiCompletion, AiMessage, AiProvider } from './providers';
import { resolveGlobalAi } from './platform-ai-store';
export { createAiProvider } from './multi-ai';

export interface AiConfig {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
export interface AiSecrets {
  apiKey?: string;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);
/** Até aqui a resposta vem numa chamada simples; acima, por streaming (evita timeout HTTP). */
const NON_STREAMING_MAX_TOKENS = 16_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
/** Modelos que aceitam `fallbacks: 'default'` na API da Anthropic. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// Para outros modelos, deixa a API aplicar o padrão, sem enviar uma opção incompatível.
const supportsEffort = (model: string) => FALLBACK_MODELS.has(model);

export interface ResolvedAi {
  apiKey: string;
  model: string;
  effort: AiConfig['effort'];
  source: 'platform';
}

/** Chave e modelo efetivos. `includeDisabled` permite testar antes de ativar a integração. */
export async function resolveAi(ctx: AppContext, officeId: string, opts: { includeDisabled?: boolean } = {}): Promise<ResolvedAi> {
  const c = await resolveGlobalAi(ctx);
  if (c.provider !== 'anthropic') throw new IntegrationError('ai', 'A plataforma selecionou outro provedor de IA.');
  return { apiKey: c.apiKey, model: c.model, effort: 'high', source: 'platform' };
}

function fileBlock(f: NonNullable<AiMessage['files']>[number]): Anthropic.Beta.BetaContentBlockParam {
  const mime = f.mimeType.toLowerCase();
  const data = f.data.toString('base64');
  if (mime === 'application/pdf') {
    return { type: 'document', title: f.filename, source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  if (IMAGE_TYPES.has(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data } };
  }
  if (TEXT_TYPES.has(mime)) {
    return { type: 'document', title: f.filename, source: { type: 'text', media_type: 'text/plain', data: f.data.toString('utf8') } };
  }
  throw new IntegrationError('ai', `A IA não lê arquivos do tipo ${f.mimeType} (${f.filename}). Envie PDF ou imagem.`);
}

export function toMessageParams(messages: AiMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'user' && m.files?.length) {
      // documentos antes do texto da pergunta
      return { role: 'user', content: [...m.files.map(fileBlock), { type: 'text', text: m.content || 'Analise os documentos anexos.' }] };
    }
    return { role: m.role, content: m.content };
  });
}

/** Traduz os erros tipados do SDK (do mais específico ao mais geral). */
export function aiError(err: unknown, model: string): IntegrationError {
  if (err instanceof IntegrationError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new IntegrationError('ai', 'Chave de API da Anthropic inválida ou revogada.', 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new IntegrationError('ai', 'A chave de API não tem permissão para este recurso ou modelo.', 403);
  if (err instanceof Anthropic.NotFoundError) return new IntegrationError('ai', `Modelo de IA não encontrado: ${model}.`, 404);
  if (err instanceof Anthropic.RateLimitError) return new IntegrationError('ai', 'Limite de uso da IA atingido. Tente novamente em alguns instantes.', 429);
  if (err instanceof Anthropic.BadRequestError) return new IntegrationError('ai', 'A IA recusou o pedido. Confira o modelo e os anexos.', 400);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new IntegrationError('ai', 'A IA demorou demais para responder. Tente novamente.');
  if (err instanceof Anthropic.APIConnectionError) return new IntegrationError('ai', 'Não foi possível conectar ao serviço de IA. Confira a conexão do servidor.');
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 500;
    return new IntegrationError('ai', status >= 500 ? 'O serviço de IA está instável no momento. Tente novamente em instantes.' : `Erro da IA (HTTP ${status}).`, status);
  }
  return new IntegrationError('ai', 'Erro inesperado na IA. Contate o suporte do Verifco.');
}

export function anthropicClient(apiKey: string, fetchImpl?: typeof fetch) {
  return new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 2, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

export async function completeAnthropic(ai: ResolvedAi, input: Parameters<AiProvider['complete']>[1], fetchImpl?: typeof fetch): Promise<AiCompletion> {
  const client = anthropicClient(ai.apiKey, fetchImpl);
  const maxTokens = input.maxTokens ?? NON_STREAMING_MAX_TOKENS;
  const withFallback = FALLBACK_MODELS.has(ai.model);
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: ai.model,
    max_tokens: maxTokens,
    system: input.system,
    messages: toMessageParams(input.messages),
    ...(supportsEffort(ai.model) && ai.effort ? { output_config: { effort: ai.effort } } : {}),
    ...(withFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  };
  let response: Anthropic.Beta.BetaMessage;
  try {
    response =
      maxTokens > NON_STREAMING_MAX_TOKENS
        ? await client.beta.messages.stream(params).finalMessage()
        : await client.beta.messages.create(params);
  } catch (err) {
    throw aiError(err, ai.model);
  }
  if (response.stop_reason === 'refusal') {
    throw new IntegrationError('ai', 'A IA não pôde atender a este pedido. Reformule a pergunta ou revise os documentos enviados.');
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new IntegrationError('ai', 'A IA não retornou uma resposta utilizável. Confira o modelo selecionado.');
  if (response.stop_reason === 'max_tokens') throw new IntegrationError('ai', 'A IA não concluiu a resposta. Revise o limite de tokens do modelo.');
  return { text, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

/** Teste sem custo: consulta o modelo na API de modelos (valida chave e modelo). */
export async function testAi(ctx: AppContext, officeId: string, fetchImpl?: typeof fetch) {
  const ai = await resolveAi(ctx, officeId, { includeDisabled: true });
  try {
    const model = await anthropicClient(ai.apiKey, fetchImpl).models.retrieve(ai.model);
    const origin = 'chave da plataforma';
    return `IA disponível: ${model.display_name ?? ai.model} (${origin}).`;
  } catch (err) {
    throw aiError(err, ai.model);
  }
}
