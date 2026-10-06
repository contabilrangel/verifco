/** Conexões globais de IA. Modelos são informados pelo proprietário, sem lista fixa. */
export const AI_PROVIDERS = [
  { key: 'anthropic', label: 'Claude · Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', pdf: true },
  { key: 'openai', label: 'OpenAI', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', pdf: true },
  { key: 'gemini', label: 'Gemini · Google', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', pdf: true },
  { key: 'deepseek', label: 'DeepSeek', protocol: 'chat', baseUrl: 'https://api.deepseek.com/v1', pdf: false },
  { key: 'mistral', label: 'Mistral', protocol: 'chat', baseUrl: 'https://api.mistral.ai/v1', pdf: false },
  { key: 'groq', label: 'Groq', protocol: 'chat', baseUrl: 'https://api.groq.com/openai/v1', pdf: false },
  { key: 'xai', label: 'Grok · xAI', protocol: 'chat', baseUrl: 'https://api.x.ai/v1', pdf: false },
  { key: 'openrouter', label: 'OpenRouter', protocol: 'chat', baseUrl: 'https://openrouter.ai/api/v1', pdf: false },
  { key: 'together', label: 'Together AI', protocol: 'chat', baseUrl: 'https://api.together.ai/v1', pdf: false },
  { key: 'fireworks', label: 'Fireworks AI', protocol: 'chat', baseUrl: 'https://api.fireworks.ai/inference/v1', pdf: false },
  { key: 'cerebras', label: 'Cerebras', protocol: 'chat', baseUrl: 'https://api.cerebras.ai/v1', pdf: false },
  { key: 'ollama', label: 'Ollama · modelos locais', protocol: 'chat', baseUrl: 'http://127.0.0.1:11434/v1', pdf: false },
  { key: 'compatible', label: 'Outro serviço compatível', protocol: 'chat', baseUrl: '', pdf: false },
] as const;
export type AiProviderKey = (typeof AI_PROVIDERS)[number]['key'];
export const aiProviderDef = (key: string) => AI_PROVIDERS.find((p) => p.key === key);
