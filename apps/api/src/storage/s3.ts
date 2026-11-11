/**
 * Armazenamento em bucket compatível com S3 (AWS S3, Cloudflare R2, Backblaze B2, MinIO...),
 * sem SDK: requisições REST assinadas com AWS Signature Version 4
 * (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html).
 *
 * Arquivos pequenos sobem num PUT; streams (backup, .zip) sobem em partes (multipart upload),
 * sem montar o conteúdo inteiro na memória. O corpo vai como UNSIGNED-PAYLOAD: a integridade em
 * trânsito é do TLS, e o sha256 de cada arquivo já fica gravado na tabela `files`.
 */
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { BlobStore } from './index';

export interface S3Options {
  /** Endereço do serviço (ex.: https://s3.sa-east-1.amazonaws.com, https://<conta>.r2.cloudflarestorage.com). */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `true`: endpoint/bucket/chave (MinIO, R2, B2). `false`: bucket.endpoint/chave (AWS). */
  forcePathStyle: boolean;
  fetch?: typeof fetch;
  /** Tamanho de cada parte do envio em partes (mínimo do S3: 5 MiB, exceto a última). */
  partSize?: number;
  /** Relógio (testes). */
  now?: () => Date;
}

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** Codificação de URI do SigV4: tudo fora de A-Z a-z 0-9 - _ . ~ vira %XX (a barra, só no caminho). */
export function uriEncode(value: string, keepSlash = false): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === '/')) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export interface SignInput {
  method: string;
  /** Caminho já decodificado (ex.: /bucket/pasta/arquivo). */
  path: string;
  query?: Record<string, string>;
  /** Cabeçalhos a assinar (o `host` é obrigatório); nomes em qualquer caixa. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
}

/** Cabeçalho `Authorization` do SigV4 para o serviço `s3`. */
export function signV4(input: SignInput): string {
  const date = input.amzDate.slice(0, 8);
  const headers = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([k]) => k).join(';');
  const query = Object.entries(input.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [input.method, uriEncode(input.path, true), query, ...headers.map(([k, v]) => `${k}:${v}`), '', signedHeaders, input.payloadHash].join('\n');
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

const UNSIGNED = 'UNSIGNED-PAYLOAD';
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MIN_PART = 5 * 1024 * 1024;

export class S3Error extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
  ) {
    super(message);
  }
}

const xmlValue = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? null;
const xmlEscape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class S3BlobStore implements BlobStore {
  private origin: string;
  private host: string;
  private basePath: string;
  private fetchImpl: typeof fetch;
  private partSize: number;

  constructor(private opts: S3Options) {
    const url = new URL(opts.endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('S3_ENDPOINT deve começar com https:// (ou http:// numa rede interna).');
    const prefix = url.pathname.replace(/\/+$/, '');
    if (opts.forcePathStyle) {
      this.host = url.host;
      this.basePath = `${prefix}/${opts.bucket}`;
    } else {
      this.host = `${opts.bucket}.${url.host}`;
      this.basePath = prefix;
    }
    this.origin = `${url.protocol}//${this.host}`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.partSize = Math.max(opts.partSize ?? 8 * 1024 * 1024, 1);
  }

  private async request(method: string, key: string, init: { query?: Record<string, string>; body?: Buffer | string; headers?: Record<string, string>; okStatuses?: number[] } = {}) {
    if (!key || key.includes('..')) throw new Error('Caminho inválido.');
    const path = `${this.basePath}/${key}`;
    const now = (this.opts.now ?? (() => new Date()))();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadHash = init.body === undefined ? EMPTY_HASH : UNSIGNED;
    const headers: Record<string, string> = { host: this.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(init.headers ?? {}) };
    const authorization = signV4({ method, path, query: init.query, headers, payloadHash, region: this.opts.region, accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey, amzDate });
    const qs = Object.entries(init.query ?? {})
      .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
      .join('&');
    const { host: _host, ...sent } = headers;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${uriEncode(path, true)}${qs ? `?${qs}` : ''}`, {
        method,
        headers: { ...sent, authorization },
        body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : new Uint8Array(init.body),
      });
    } catch (err) {
      throw new S3Error(0, null, `Não foi possível conectar ao armazenamento de arquivos (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (res.ok || init.okStatuses?.includes(res.status)) return res;
    const text = await res.text().catch(() => '');
    const code = xmlValue(text, 'Code');
    // a mensagem do serviço pode citar a chave do objeto; fica só o código
    throw new S3Error(res.status, code, res.status === 404 ? 'Arquivo não encontrado.' : `O armazenamento de arquivos recusou a operação (${res.status}${code ? ` ${code}` : ''}).`);
  }

  async put(key: string, data: Buffer) {
    await this.request('PUT', key, { body: data, headers: { 'content-length': String(data.length) } });
  }

  async putStream(key: string, input: Readable) {
    let uploadId: string | null = null;
    const parts: { n: number; etag: string }[] = [];
    let pending: Buffer[] = [];
    let size = 0;
    const flush = async () => {
      const body = Buffer.concat(pending);
      pending = [];
      size = 0;
      if (!uploadId) {
        const res = await this.request('POST', key, { query: { uploads: '' } });
        uploadId = xmlValue(await res.text(), 'UploadId');
        if (!uploadId) throw new S3Error(res.status, null, 'O armazenamento de arquivos não iniciou o envio em partes.');
      }
      const n = parts.length + 1;
      const res = await this.request('PUT', key, { query: { partNumber: String(n), uploadId }, body, headers: { 'content-length': String(body.length) } });
      const etag = res.headers.get('etag');
      if (!etag) throw new S3Error(res.status, null, 'O armazenamento de arquivos não confirmou uma parte do envio.');
      parts.push({ n, etag });
    };
    try {
      for await (const chunk of input) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pending.push(buf);
        size += buf.length;
        if (size >= this.partSize) await flush();
      }
      if (!uploadId) {
        // coube numa parte só: um PUT simples
        await this.put(key, Buffer.concat(pending));
        return;
      }
      if (size > 0) await flush();
      const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const res = await this.request('POST', key, { query: { uploadId }, body: xml, headers: { 'content-type': 'application/xml' } });
      // o S3 pode responder 200 com um erro no corpo ao concluir
      const text = await res.text();
      if (/<Error>/.test(text)) throw new S3Error(res.status, xmlValue(text, 'Code'), 'O armazenamento de arquivos não concluiu o envio em partes.');
    } catch (err) {
      input.destroy();
      // não deixa partes cobradas nem objeto parcial
      if (uploadId) await this.request('DELETE', key, { query: { uploadId }, okStatuses: [404] }).catch(() => {});
      throw err;
    }
  }

  async get(key: string) {
    const res = await this.request('GET', key);
    return Buffer.from(await res.arrayBuffer());
  }

  async stream(key: string) {
    // a requisição já foi respondida aqui: objeto inexistente falha antes de começar o download
    const res = await this.request('GET', key);
    if (!res.body) return Readable.from([Buffer.alloc(0)], { objectMode: false });
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  }

  async delete(key: string) {
    // apagar o que não existe não é erro (o S3 responde 204; alguns compatíveis, 404)
    await this.request('DELETE', key, { okStatuses: [404] });
  }

  /** Confere credenciais e bucket no início (uma listagem de 1 item). Usado no boot e no /ready. */
  async check() {
    const now = (this.opts.now ?? (() => new Date()))();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const path = this.basePath || '/';
    const query = { 'list-type': '2', 'max-keys': '1' };
    const headers = { host: this.host, 'x-amz-content-sha256': EMPTY_HASH, 'x-amz-date': amzDate };
    const authorization = signV4({ method: 'GET', path, query, headers, payloadHash: EMPTY_HASH, region: this.opts.region, accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey, amzDate });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${uriEncode(path, true)}?list-type=2&max-keys=1`, { headers: { 'x-amz-content-sha256': EMPTY_HASH, 'x-amz-date': amzDate, authorization } });
    } catch (err) {
      throw new S3Error(0, null, `Não foi possível conectar ao armazenamento de arquivos (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (!res.ok) {
      const code = xmlValue(await res.text().catch(() => ''), 'Code');
      throw new S3Error(res.status, code, `O armazenamento de arquivos recusou o acesso ao bucket (${res.status}${code ? ` ${code}` : ''}). Confira S3_BUCKET, S3_REGION e as chaves.`);
    }
  }
}

export { MIN_PART as S3_MIN_PART_SIZE };
