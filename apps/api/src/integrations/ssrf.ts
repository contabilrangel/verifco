/**
 * Proteção contra SSRF nas integrações cujo endereço é informado pelo escritório
 * (URL da Evolution API e servidor SMTP próprio).
 *
 * - Na configuração: só `https://`, sem usuário/senha, sem `?` nem `#`, sem nomes internos
 *   (`localhost`, `.local`, `.internal`) e sem IP de rede interna.
 * - Em cada conexão: o nome é resolvido e TODOS os IPs precisam ser públicos; a conexão usa o
 *   IP já conferido (sem nova consulta ao DNS), o que cobre DNS rebinding. Redirecionamentos
 *   não são seguidos.
 */
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { IntegrationError } from './http';

const blocked = new BlockList();
// IPv4: "esta rede", privadas (RFC 1918), CGNAT, loopback, link-local (inclui metadados de nuvem),
// IETF, documentação, benchmark, multicast e reservadas
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
// IPv6: não especificado, loopback, ULA, link-local, multicast, documentação, descarte
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** IPv4 embutido em IPv6 (mapeado `::ffff:a.b.c.d`, NAT64 `64:ff9b::`), quando houver. */
function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(lower);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** O IP é de rede interna, loopback, link-local, multicast ou reservado? */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true;
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|localdomain|intranet|home\.arpa)$/i;

/** O nome (ou IP) aponta claramente para a rede interna, sem consultar o DNS? */
export function isInternalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (isIP(host)) return isPrivateAddress(host);
  return INTERNAL_NAME.test(host) || !host.includes('.');
}

export const SAFE_URL_HINT = 'use o endereço público https:// do serviço (sem usuário, senha, “?” ou “#”)';

/** Valida a URL base informada pelo escritório. Devolve a mensagem do problema ou `null`. */
export function unsafeBaseUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'informe uma URL começando com https://';
  }
  if (url.protocol !== 'https:') return 'informe uma URL começando com https://';
  if (url.username || url.password) return 'a URL não pode ter usuário ou senha';
  if (raw.includes('?') || raw.includes('#')) return 'a URL não pode ter “?” nem “#”';
  if (isInternalHostname(url.hostname)) return 'endereços internos (localhost, IP privado ou de nuvem) não são permitidos';
  return null;
}

export function assertSafeBaseUrl(provider: string, raw: string): URL {
  const reason = unsafeBaseUrlReason(raw);
  if (reason) throw new IntegrationError(provider, `Endereço da integração recusado: ${reason}.`);
  return new URL(raw);
}

const blockedError = (provider: string, host: string) =>
  new IntegrationError(provider, `O endereço ${host} aponta para a rede interna e foi bloqueado. Use o endereço público do serviço.`);

type LookupFn = (hostname: string, options: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * `lookup` para conexões de saída que só aceita nomes cujos IPs são todos públicos.
 * Compatível com a opção `lookup` de `net`, `http`, `https` e `tls`.
 */
export function publicOnlyLookup(provider: string, resolver: LookupFn = dnsLookup as unknown as LookupFn) {
  return (hostname: string, options: { all?: boolean; family?: number } | number | undefined, callback: (...args: unknown[]) => void) => {
    const wantAll = typeof options === 'object' && options?.all === true;
    resolver(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) return callback(blockedError(provider, hostname));
      if (wantAll) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** Resolve o nome e devolve um IP público (ou lança se algum IP for interno). */
export async function resolvePublicAddress(provider: string, hostname: string, resolver?: LookupFn): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw blockedError(provider, host);
    return host;
  }
  if (isInternalHostname(host)) throw blockedError(provider, host);
  const lookup = publicOnlyLookup(provider, resolver);
  return new Promise((resolve, reject) => {
    lookup(host, { all: false }, (err: unknown, address: unknown) => (err ? reject(err) : resolve(String(address))));
  });
}

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * `fetch` para URLs informadas pelo escritório: confere o host antes e durante a conexão,
 * não segue redirecionamentos e limita o tamanho da resposta.
 */
export function createPublicOnlyFetch(provider: string, resolver?: LookupFn): typeof fetch {
  return async (input, init) => {
    const request = new Request(input as ConstructorParameters<typeof Request>[0], init);
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new IntegrationError(provider, 'Protocolo não permitido.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isInternalHostname(host)) throw blockedError(provider, host);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    if (body) headers['content-length'] = String(body.length);
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise<Response>((resolve, reject) => {
      const req = mod.request(
        url,
        { method: request.method, headers, lookup: publicOnlyLookup(provider, resolver) as never, signal: init?.signal ?? undefined },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) req.destroy(new IntegrationError(provider, 'A resposta do serviço é grande demais.'));
            else chunks.push(c);
          });
          res.on('error', reject);
          res.on('end', () => {
            const status = res.statusCode ?? 502;
            const out = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
              else if (v !== undefined) out.set(k, String(v));
            }
            const noBody = [204, 205, 304].includes(status) || request.method === 'HEAD';
            resolve(new Response(noBody ? null : Buffer.concat(chunks), { status: status >= 200 && status <= 599 ? status : 502, headers: out }));
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}
