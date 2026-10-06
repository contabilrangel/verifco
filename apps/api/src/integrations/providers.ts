/**
 * Contratos dos provedores externos usados pelos módulos.
 * As implementações reais ficam em `integrations/*` e são montadas em `createProviders`;
 * os testes usam implementações em memória.
 */
export interface OutgoingEmail {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  replyTo?: string | null;
  fromName?: string | null;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export interface EmailSender {
  send(officeId: string, msg: OutgoingEmail): Promise<{ messageId: string }>;
}

export interface OutgoingWhatsApp {
  to: string;
  text: string;
  document?: { filename: string; content: Buffer; contentType?: string };
}

export interface WhatsAppSender {
  send(officeId: string, msg: OutgoingWhatsApp): Promise<{ messageId: string }>;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Documentos enviados junto da mensagem (PDF ou imagem). */
  files?: { filename: string; mimeType: string; data: Buffer }[];
}

export interface AiCompletion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiProvider {
  complete(officeId: string, input: { system: string; messages: AiMessage[]; maxTokens?: number }): Promise<AiCompletion>;
}

export interface Providers {
  email: EmailSender;
  whatsapp: WhatsAppSender;
  ai: AiProvider;
  /** `fetch` injetável para que os clientes HTTP (Asaas, Omie, SERPRO...) sejam testáveis. */
  fetch: typeof fetch;
}

/** Provedores em memória para testes e desenvolvimento sem credenciais. */
export class MemoryProviders implements Providers {
  sentEmails: (OutgoingEmail & { officeId: string })[] = [];
  sentWhatsApp: (OutgoingWhatsApp & { officeId: string })[] = [];
  aiReplies: string[] = [];
  fetch: typeof fetch = globalThis.fetch;

  email: EmailSender = {
    send: async (officeId, msg) => {
      this.sentEmails.push({ ...msg, officeId });
      return { messageId: `mem-email-${this.sentEmails.length}` };
    },
  };

  whatsapp: WhatsAppSender = {
    send: async (officeId, msg) => {
      this.sentWhatsApp.push({ ...msg, officeId });
      return { messageId: `mem-wa-${this.sentWhatsApp.length}` };
    },
  };

  ai: AiProvider = {
    complete: async (_officeId, input) => {
      const last = input.messages[input.messages.length - 1];
      const text = this.aiReplies.shift() ?? `Resposta simulada para: ${last?.content.slice(0, 80) ?? ''}`;
      return { text, inputTokens: 0, outputTokens: 0 };
    },
  };
}
