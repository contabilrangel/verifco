import { aiProviderDef } from '@verifco/shared';
import type { AppContext } from '../context';
import type { AiMessage, AiProvider, AiCompletion } from './providers';
import { IntegrationError } from './http';
import { completeAnthropic } from './ai';
import { resolveGlobalAi, type ResolvedConnection } from './platform-ai-store';
import { createPublicOnlyFetch } from './ssrf';

const TEXT = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);
const IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
type Input = Parameters<AiProvider['complete']>[1];

function fileKind(c: ResolvedConnection, f: NonNullable<AiMessage['files']>[number]) {
  const mime = f.mimeType.toLowerCase();
  if (TEXT.has(mime)) return 'text';
  if (IMAGE.has(mime) && c.supportsImages) return 'image';
  if (mime === 'application/pdf' && aiProviderDef(c.provider)?.pdf) return 'pdf';
  throw new IntegrationError('ai', `A conexão ${c.name} não lê este anexo (${f.filename}). Para PDF, o proprietário deve selecionar Claude, OpenAI ou Gemini; para imagens, um modelo com visão.`);
}

/** Formatos nativos; nunca descarta um anexo nem troca o provedor silenciosamente. */
export function requestFor(c: ResolvedConnection, input: Input): { path: string; headers: Record<string, string>; body: unknown } {
  for (const message of input.messages) {
    if (message.role === 'assistant' && message.files?.length) throw new IntegrationError('ai', 'Anexos devem acompanhar uma mensagem do usuário.');
  }
  const def = aiProviderDef(c.provider);
  if (!def) throw new IntegrationError('ai', 'Serviço de IA desconhecido.');
  const max = input.maxTokens ?? 16000;
  if (def.protocol === 'gemini') return {
    path: `/models/${encodeURIComponent(c.model.replace(/^models\//, ''))}:generateContent`,
    headers: { 'x-goog-api-key': c.apiKey },
    body: {
      systemInstruction: { parts: [{ text: input.system }] },
      generationConfig: { maxOutputTokens: max },
      contents: input.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          ...(m.files ?? []).map((f) => fileKind(c, f) === 'text' ? { text: `${f.filename}\n${f.data.toString('utf8')}` }
            : { inlineData: { mimeType: f.mimeType, data: f.data.toString('base64') } }),
          { text: m.content || 'Analise os anexos.' },
        ],
      })),
    },
  };
  if (def.protocol === 'responses') return {
    path: '/responses', headers: { Authorization: `Bearer ${c.apiKey}` },
    body: { model: c.model, instructions: input.system, max_output_tokens: max, store: false,
      input: input.messages.map((m) => m.role === 'assistant' ? { role: m.role, content: m.content } : ({ role: m.role, content: [
        ...(m.files ?? []).map((f) => {
          const kind = fileKind(c, f);
          if (kind === 'text') return { type: 'input_text', text: `${f.filename}\n${f.data.toString('utf8')}` };
          const data = `data:${f.mimeType};base64,${f.data.toString('base64')}`;
          return kind === 'image' ? { type: 'input_image', image_url: data } : { type: 'input_file', filename: f.filename, file_data: data };
        }),
        { type: 'input_text', text: m.content || 'Analise os anexos.' },
      ] })),
    },
  };
  return {
    path: '/chat/completions', headers: { Authorization: `Bearer ${c.apiKey || 'ollama'}` },
    body: { model: c.model, max_tokens: max, stream: false, messages: [
      { role: 'system', content: input.system },
      ...input.messages.map((m) => !m.files?.length ? { role: m.role, content: m.content } : ({ role: m.role, content: [
        ...(m.files ?? []).map((f) => {
          const kind = fileKind(c, f);
          return kind === 'text' ? { type: 'text', text: `${f.filename}\n${f.data.toString('utf8')}` }
            : { type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.data.toString('base64')}` } };
        }), { type: 'text', text: m.content || 'Analise os anexos.' },
      ] })),
    ] },
  };
}

export async function completeConnection(c: ResolvedConnection, input: Input, fetchImpl: typeof fetch): Promise<AiCompletion> {
  if (c.provider === 'anthropic') {
    for (const message of input.messages) {
      if (message.role === 'assistant' && message.files?.length) throw new IntegrationError('ai', 'Anexos devem acompanhar uma mensagem do usuário.');
      for (const file of message.files ?? []) fileKind(c, file);
    }
    return completeAnthropic({ apiKey: c.apiKey, model: c.model, effort: 'high', source: 'platform' }, input, fetchImpl);
  }
  const request = requestFor(c, input);
  let res: Response;
  try {
    res = await fetchImpl(c.baseUrl.replace(/\/+$/, '') + request.path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body), signal: AbortSignal.timeout(180000), redirect: 'error',
    });
  } catch { throw new IntegrationError('ai', 'Não foi possível obter uma resposta da IA. Confira o serviço e a conexão do servidor.'); }
  // Não repassa erros do fornecedor: podem conter chave, documento ou dados pessoais.
  if (!res.ok) throw new IntegrationError('ai', res.status === 401 || res.status === 403
    ? 'A chave de IA é inválida ou não tem permissão para este modelo.'
    : res.status === 429 ? 'Limite de uso da IA atingido. Tente novamente em instantes.'
    : `O serviço de IA recusou o pedido (HTTP ${res.status}). Confira o modelo e os anexos.`, res.status);
  let data: any;
  try { data = await res.json(); } catch { throw new IntegrationError('ai', 'A IA retornou uma resposta inválida.'); }
  let text: string; let inputTokens: number | undefined; let outputTokens: number | undefined;
  if (c.provider === 'gemini') {
    if (data.candidates?.[0]?.finishReason && data.candidates[0].finishReason !== 'STOP') {
      throw new IntegrationError('ai', 'A IA não concluiu a resposta. Revise o pedido e o limite de tokens do modelo.');
    }
    text = (data.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought && typeof p.text === 'string').map((p: any) => p.text).join('\n');
    inputTokens = data.usageMetadata?.promptTokenCount; outputTokens = data.usageMetadata?.candidatesTokenCount;
  } else if (c.provider === 'openai') {
    if (data.status === 'incomplete' || data.status === 'failed') throw new IntegrationError('ai', 'A IA não concluiu a resposta. Revise o limite de tokens do modelo.');
    text = (data.output ?? []).flatMap((o: any) => o.type === 'message' ? o.content ?? [] : []).filter((p: any) => p.type === 'output_text').map((p: any) => p.text).join('\n');
    inputTokens = data.usage?.input_tokens; outputTokens = data.usage?.output_tokens;
  } else {
    if (['length', 'content_filter', 'tool_calls'].includes(data.choices?.[0]?.finish_reason)) throw new IntegrationError('ai', 'A IA não concluiu a resposta. Revise o pedido e o limite de tokens do modelo.');
    text = data.choices?.[0]?.message?.content ?? '';
    inputTokens = data.usage?.prompt_tokens; outputTokens = data.usage?.completion_tokens;
  }
  if (typeof text !== 'string' || !text.trim()) throw new IntegrationError('ai', 'A IA não retornou uma resposta utilizável. Confira o modelo selecionado.');
  return { text: text.trim(), inputTokens, outputTokens };
}

export function connectionFetch(c: ResolvedConnection, fetchImpl: typeof fetch, publicFetch?: typeof fetch) {
  return c.provider === 'compatible' ? publicFetch ?? createPublicOnlyFetch('ai') : fetchImpl;
}

export function createAiProvider(ctx: AppContext, getFetch: () => typeof fetch): AiProvider {
  return { async complete(_officeId, input) {
    const c = await resolveGlobalAi(ctx);
    return completeConnection(c, input, connectionFetch(c, getFetch(), ctx.providers.userUrlFetch));
  } };
}
