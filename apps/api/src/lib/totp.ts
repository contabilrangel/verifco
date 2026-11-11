/**
 * Verificação em duas etapas por aplicativo autenticador (TOTP, RFC 6238): HMAC-SHA1, códigos
 * de 6 dígitos que mudam a cada 30 segundos, o padrão do Google Authenticator, Microsoft
 * Authenticator, Authy e dos gerenciadores de senha.
 */
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { safeEqual, sha256 } from './crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Chave inválida.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo (160 bits, o tamanho recomendado para SHA-1), em base32. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

/** Código do passo `counter` (RFC 4226, truncamento dinâmico). */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const totpAt = (secretBase32: string, at = Date.now()) => hotp(base32Decode(secretBase32), Math.floor(at / 1000 / STEP_SECONDS));

/**
 * Confere o código digitado, aceitando o passo anterior e o seguinte (relógio do celular até
 * 30 segundos fora). Espaços e traços digitados são ignorados.
 */
export function verifyTotp(secretBase32: string, code: string, at = Date.now()): boolean {
  const typed = code.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(typed)) return false;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(at / 1000 / STEP_SECONDS);
  let ok = false;
  // percorre os três passos sempre (tempo constante em relação a qual deles casou)
  for (const delta of [-1, 0, 1]) if (safeEqual(hotp(secret, step + delta), typed)) ok = true;
  return ok;
}

/** Endereço `otpauth://` lido pelos aplicativos (o QR code da tela é este texto). */
export function otpauthUrl(opts: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  return `otpauth://totp/${label}?secret=${opts.secret}&issuer=${encodeURIComponent(opts.issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** Códigos de recuperação (uso único), no formato `abcd-efgh-jkmn`, sem caracteres ambíguos. */
export function newRecoveryCodes(count = 8): string[] {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const group = () => Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join('');
  return Array.from({ length: count }, () => `${group()}-${group()}-${group()}`);
}

export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecoveryCode = (code: string) => sha256(`recovery:${normalizeRecoveryCode(code)}`);
