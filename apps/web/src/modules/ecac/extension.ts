/**
 * Ponte com a extensão Verifco para Chrome/Edge/Opera (apps/extension).
 * A página envia `window.postMessage({ type: 'VERIFCO_OPEN_ECAC', service, cpf, requestId })`;
 * o content script da extensão responde com `VERIFCO_EXTENSION_ACK` e o mesmo `requestId`.
 * Sem resposta em 1,5 s, consideramos que a extensão não está instalada.
 */
import type { EcacService } from '@verifco/shared';

export const EXTENSION_TIMEOUT_MS = 1500;

export interface ExtensionAck {
  type: 'VERIFCO_EXTENSION_ACK';
  requestId: string;
  ok: boolean;
  version?: string;
  error?: string;
}

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export function callExtension(message: Record<string, unknown>, timeoutMs = EXTENSION_TIMEOUT_MS): Promise<ExtensionAck | null> {
  return new Promise((resolve) => {
    const requestId = newId();
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin) return;
      const d = e.data as Partial<ExtensionAck> | null;
      if (!d || d.type !== 'VERIFCO_EXTENSION_ACK' || d.requestId !== requestId) return;
      cleanup();
      resolve(d as ExtensionAck);
    };
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ ...message, requestId }, window.location.origin);
  });
}

/** Pede à extensão para abrir o serviço do eCAC numa nova aba. `null` = extensão não respondeu. */
export const openEcacService = (service: EcacService, cpf: string) => callExtension({ type: 'VERIFCO_OPEN_ECAC', service, cpf });

/** Verifica se a extensão está instalada e ativa nesta página. */
export const pingExtension = () => callExtension({ type: 'VERIFCO_PING' });
