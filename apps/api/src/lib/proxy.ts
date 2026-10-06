import { BlockList, isIP } from 'node:net';
import type { TrustProxy } from '../config';

/** Redes internas (as faixas `loopback`, `linklocal` e `uniquelocal` do proxy-addr). */
const INTERNAL = new BlockList();
INTERNAL.addSubnet('127.0.0.0', 8, 'ipv4');
INTERNAL.addSubnet('10.0.0.0', 8, 'ipv4');
INTERNAL.addSubnet('172.16.0.0', 12, 'ipv4');
INTERNAL.addSubnet('192.168.0.0', 16, 'ipv4');
INTERNAL.addSubnet('169.254.0.0', 16, 'ipv4');
INTERNAL.addAddress('::1', 'ipv6');
INTERNAL.addSubnet('fc00::', 7, 'ipv6');
INTERNAL.addSubnet('fe80::', 10, 'ipv6');

/** O endereço é de rede interna (onde fica o proxy reverso)? Aceita IPv4 mapeado em IPv6. */
export function isInternalAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const v4 = addr.startsWith('::ffff:') && isIP(addr.slice(7)) === 4 ? addr.slice(7) : null;
  if (v4) return INTERNAL.check(v4, 'ipv4');
  const family = isIP(addr);
  return family ? INTERNAL.check(addr, family === 4 ? 'ipv4' : 'ipv6') : false;
}

type TrustFn = (addr: string, hop: number) => boolean;

/**
 * `TRUST_PROXY` no formato do `trustProxy` do Fastify.
 *
 * Número de saltos: o Fastify 5.12+ ignora `trustProxy` numérico (não confia em nada), porque só
 * contar saltos não confere quem está conectado. Aqui o número vira uma função que confia nos `n`
 * saltos mais próximos, desde que a conexão direta (salto 0, o proxy da frente) venha de rede
 * interna: um cliente que alcance a API direto pela internet não consegue forjar o IP. Proxy com
 * IP público: informe os IPs/CIDRs dele em `TRUST_PROXY`.
 */
export function fastifyTrustProxy(value: TrustProxy): boolean | string | TrustFn {
  if (typeof value !== 'number') return value;
  if (value <= 0) return false;
  return (addr, hop) => hop < value && (hop > 0 || isInternalAddress(addr));
}
