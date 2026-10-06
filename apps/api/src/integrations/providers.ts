import type { TransportFactory } from './email';
import type { MtlsRequest } from './serpro';

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
  /** Cliente do envio: na Cloud API da Meta, decide a janela de 24 h pela última mensagem dele. */
  customerId?: string | null;
  /** Tipo de envio (template do Verifco) e as variáveis usadas, para montar o modelo aprovado. */
  templateKey?: string | null;
  values?: Record<string, string | number | null | undefined>;
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
  /**
   * `fetch` para endereços informados pelo escritório (URL da Evolution API): bloqueia rede
   * interna (também por DNS) e não segue redirecionamentos. Sem ele, usa `fetch`.
   */
  userUrlFetch?: typeof fetch;
  /** Fábrica de transporte SMTP usada no teste da integração de e-mail (padrão: nodemailer). */
  smtpTransport?: TransportFactory;
  /** Requisição com certificado de cliente (mTLS) usada na autenticação do SERPRO (padrão: node:https). */
  mtlsRequest?: MtlsRequest;
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
