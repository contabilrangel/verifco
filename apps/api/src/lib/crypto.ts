import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Cifra simétrica (AES-256-GCM) para segredos guardados no banco:
 * senhas eCAC/gov.br, senha de certificado e chaves de integrações.
 * Formato: v1.<iv>.<tag>.<conteúdo>, tudo em base64url.
 */
export class Secrets {
  private key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY deve ter 32 bytes em base64.');
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Segredo em formato inválido.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(payload: string | null | undefined): T | null {
    return payload ? (JSON.parse(this.decrypt(payload)) as T) : null;
  }
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Token aleatório para links (aprovação de orçamento, checklist, redefinição de senha). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Código numérico curto para validação pelo cliente. */
export const randomCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, '0');

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
