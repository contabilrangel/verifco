/**
 * Armazenamento S3 sem SDK: a assinatura confere com o exemplo publicado pela AWS e o
 * armazenamento funciona contra um serviço S3 falso (PUT, GET, DELETE e envio em partes).
 */
import { Readable } from 'node:stream';
import { buffer as readAll } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { openBlobStore } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { S3BlobStore, S3Error, signV4, uriEncode } from '../src/storage/s3';

/** Serviço S3 mínimo em memória, no estilo de caminho: /bucket/chave. */
function fakeS3(opts: { failPart?: number; denyAll?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const calls: { method: string; url: string; auth: string | null }[] = [];
  let nextUpload = 1;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ method, url: url.pathname + url.search, auth: headers.get('authorization') });
    const body = init?.body === undefined || init.body === null ? Buffer.alloc(0) : Buffer.from(init.body as Uint8Array | string);
    if (opts.denyAll) return new Response('<Error><Code>InvalidAccessKeyId</Code><Message>chave AKIA-SEGREDO desconhecida</Message></Error>', { status: 403 });
    const key = decodeURIComponent(url.pathname);
    const q = url.searchParams;
    if (q.has('list-type')) return new Response('<ListBucketResult></ListBucketResult>');
    if (method === 'POST' && q.has('uploads')) {
      const id = `up-${nextUpload++}`;
      uploads.set(id, new Map());
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (method === 'PUT' && q.has('uploadId')) {
      const n = Number(q.get('partNumber'));
      if (opts.failPart === n) return new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
      uploads.get(q.get('uploadId')!)!.set(n, body);
      return new Response(null, { status: 200, headers: { etag: `"etag-${n}"` } });
    }
    if (method === 'POST' && q.has('uploadId')) {
      const parts = uploads.get(q.get('uploadId')!)!;
      const order = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      objects.set(key, Buffer.concat(order.map((n) => parts.get(n)!)));
      uploads.delete(q.get('uploadId')!);
      return new Response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
    }
    if (method === 'DELETE' && q.has('uploadId')) {
      uploads.delete(q.get('uploadId')!);
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT') {
      objects.set(key, body);
      return new Response(null, { status: 200 });
    }
    if (method === 'GET') {
      const found = objects.get(key);
      return found ? new Response(new Uint8Array(found)) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  return { objects, uploads, calls, fetchImpl };
}

const store = (s3: ReturnType<typeof fakeS3>, extra: Partial<ConstructorParameters<typeof S3BlobStore>[0]> = {}) =>
  new S3BlobStore({ endpoint: 'https://s3.exemplo.com', region: 'sa-east-1', bucket: 'verifco', accessKeyId: 'AKIAEXEMPLO', secretAccessKey: 'segredo', forcePathStyle: true, fetch: s3.fetchImpl, partSize: 10, ...extra });

describe('assinatura AWS SigV4', () => {
  it('reproduz o exemplo "GET Object" da documentação da AWS', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const authorization = signV4({
      method: 'GET',
      path: '/test.txt',
      headers: {
        Host: 'examplebucket.s3.amazonaws.com',
        Range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('reproduz o exemplo "GET Bucket Lifecycle" (parâmetro de consulta sem valor)', () => {
    const authorization = signV4({
      method: 'GET',
      path: '/',
      query: { lifecycle: '' },
      headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
    });
    expect(authorization).toContain('Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('codifica o caminho como o SigV4 pede', () => {
    expect(uriEncode('a b/c+d~e_f-g.h', true)).toBe('a%20b/c%2Bd~e_f-g.h');
    expect(uriEncode('a/b')).toBe('a%2Fb');
    expect(uriEncode('ação')).toBe('a%C3%A7%C3%A3o');
  });
});

describe('armazenamento S3', () => {
  it('grava, lê, transmite e apaga; toda requisição vai assinada', async () => {
    const s3 = fakeS3();
    const blobs = store(s3);
    await blobs.put('escritorio/2026-11/arquivo 1.pdf', Buffer.from('conteudo'));
    expect(s3.objects.get('/verifco/escritorio/2026-11/arquivo 1.pdf')?.toString()).toBe('conteudo');
    expect((await blobs.get('escritorio/2026-11/arquivo 1.pdf')).toString()).toBe('conteudo');
    expect((await readAll(await blobs.stream('escritorio/2026-11/arquivo 1.pdf'))).toString()).toBe('conteudo');
    await blobs.delete('escritorio/2026-11/arquivo 1.pdf');
    await blobs.delete('escritorio/2026-11/arquivo 1.pdf'); // apagar de novo não é erro
    await expect(blobs.get('escritorio/2026-11/arquivo 1.pdf')).rejects.toThrow('Arquivo não encontrado.');
    await expect(blobs.stream('nao/existe')).rejects.toBeInstanceOf(S3Error);
    await expect(blobs.get('../fora')).rejects.toThrow('Caminho inválido.');
    expect(s3.calls.length).toBeGreaterThan(4);
    for (const c of s3.calls) expect(c.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXEMPLO\/\d{8}\/sa-east-1\/s3\/aws4_request,SignedHeaders=.*host.*,Signature=[0-9a-f]{64}$/);
    expect(s3.calls[0].url).toBe('/verifco/escritorio/2026-11/arquivo%201.pdf');
  });

  it('stream pequeno vira um PUT; grande sobe em partes na ordem', async () => {
    const s3 = fakeS3();
    const blobs = store(s3);
    await blobs.putStream('pequeno', Readable.from([Buffer.from('abc')], { objectMode: false }));
    expect(s3.calls.map((c) => c.method)).toEqual(['PUT']);
    const pieces = ['0123456', '789abcd', 'efghij', 'k'];
    await blobs.putStream('grande', Readable.from(pieces.map((p) => Buffer.from(p)), { objectMode: false }));
    expect(s3.objects.get('/verifco/grande')?.toString()).toBe(pieces.join(''));
    expect(s3.calls.filter((c) => c.url.includes('partNumber')).length).toBe(2);
    expect(s3.uploads.size).toBe(0);
  });

  it('falha no meio do envio em partes cancela o envio e não deixa objeto parcial', async () => {
    const s3 = fakeS3({ failPart: 2 });
    const blobs = store(s3);
    const big = Readable.from(['0123456789', 'abcdefghij', 'klm'].map((p) => Buffer.from(p)), { objectMode: false });
    await expect(blobs.putStream('grande', big)).rejects.toThrow(/recusou a operação \(500 InternalError\)/);
    expect(s3.objects.has('/verifco/grande')).toBe(false);
    expect(s3.uploads.size).toBe(0);
    expect(s3.calls.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('estilo de host virtual põe o bucket no nome do servidor', async () => {
    const s3 = fakeS3();
    const urls: string[] = [];
    const blobs = store(s3, { forcePathStyle: false, fetch: (async (input: string | URL | Request, init?: RequestInit) => (urls.push(String(input)), s3.fetchImpl(input, init))) as typeof fetch });
    await blobs.put('a/b', Buffer.from('x'));
    expect(urls[0]).toBe('https://verifco.s3.exemplo.com/a/b');
  });

  it('a API não sobe com bucket ou chaves errados, e o erro não repete a mensagem do serviço', async () => {
    const base = { ...loadConfig({ NODE_ENV: 'test' }), STORAGE_DRIVER: 's3' as const, S3_ENDPOINT: 'https://s3.exemplo.com', S3_BUCKET: 'verifco', S3_ACCESS_KEY_ID: 'AKIA', S3_SECRET_ACCESS_KEY: 's' };
    const ok = await openBlobStore(base, fakeS3().fetchImpl);
    expect(ok).toBeInstanceOf(S3BlobStore);
    const denied = await openBlobStore(base, fakeS3({ denyAll: true }).fetchImpl).catch((e: Error) => e);
    expect(denied).toBeInstanceOf(S3Error);
    expect((denied as Error).message).toMatch(/recusou o acesso ao bucket \(403 InvalidAccessKeyId\)/);
    expect((denied as Error).message).not.toContain('AKIA-SEGREDO');
    await expect(openBlobStore({ ...base, S3_BUCKET: undefined })).rejects.toThrow(/exige S3_BUCKET/);
    const offline = await openBlobStore(base, (async () => { throw new Error('ENOTFOUND'); }) as typeof fetch).catch((e: Error) => e);
    expect((offline as Error).message).toMatch(/Não foi possível conectar ao armazenamento/);
  });
});
