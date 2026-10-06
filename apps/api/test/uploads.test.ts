/**
 * Uploads e downloads de arquivos (DAD-10): partes ignoradas descartadas sem ir para a memória,
 * teto da soma do envio, tipo conferido nos primeiros bytes e downloads em stream mantendo a
 * lista branca, `nosniff` e a CSP do `sendStoredFile`.
 */
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { files, prefilledStatements } from '../src/db/schema';
import { KNOWN_FILE_TYPES, PDF_TYPES, SIGNATURE_BYTES, readUploads } from '../src/services/uploads';
import type { MemoryBlobStore } from '../src/storage';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { FAKE_PDF, upload } from './upload-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
afterEach(() => vi.restoreAllMocks());

interface FakeFilePart {
  type: 'file';
  fieldname: string;
  filename: string;
  file: Readable;
  toBuffer: ReturnType<typeof vi.fn>;
}
type FakePart = FakeFilePart | { type: 'field'; fieldname: string; value: string };

/** Parte de arquivo de um formulário multipart, entregue em pedaços. */
function filePart(filename: string, ...data: Buffer[]): FakeFilePart {
  return { type: 'file', fieldname: 'file', filename, file: Readable.from(data, { objectMode: false }), toBuffer: vi.fn(async () => Buffer.concat(data)) };
}

/**
 * Requisição multipart falsa com o comportamento do busboy: a parte seguinte só chega depois que
 * a atual foi lida até o fim (se ninguém a ler, o envio trava e o teste estoura o tempo).
 */
function fakeMultipart(parts: FakePart[]) {
  return {
    isMultipart: () => true,
    async *parts() {
      for (const p of parts) {
        yield p;
        if (p.type === 'file') await finished(p.file);
      }
    },
  } as unknown as FastifyRequest;
}

const kb = (n: number, fill = 0x41) => Buffer.alloc(n * 1024, fill);

describe('readUploads (DAD-10)', () => {
  it('firstFileOnly descarta as partes seguintes com resume(), sem ler para a memória', async () => {
    const first = filePart('pre.dec', Buffer.from('conteúdo'));
    const ignored = filePart('grande.pdf', ...Array.from({ length: 32 }, () => kb(64)));
    const last = filePart('outro.txt', kb(1));
    const resume = vi.spyOn(ignored.file, 'resume');
    const req = fakeMultipart([{ type: 'field', fieldname: 'cpf', value: VALID_CPFS[0] }, first, ignored, last]);
    // teto de 1 KB: se as partes ignoradas fossem lidas para a memória, o envio passaria do limite
    const { files: got, fields } = await readUploads(req, { types: KNOWN_FILE_TYPES, unknown: 'octet-stream', firstFileOnly: true, maxTotalBytes: 1024 });
    expect(got.map((f) => [f.filename, f.data.toString()])).toEqual([['pre.dec', 'conteúdo']]);
    expect(fields).toEqual({ cpf: VALID_CPFS[0] });
    expect(resume).toHaveBeenCalled();
    expect(ignored.toBuffer).not.toHaveBeenCalled();
    expect(ignored.file.readableEnded).toBe(true);
    expect(last.file.readableEnded).toBe(true);
  });

  it('recusa o envio que passa da soma permitida, lendo o resto do formulário sem guardar', async () => {
    const a = filePart('a.pdf', Buffer.from('%PDF-1.4\n'), kb(600));
    const b = filePart('b.pdf', Buffer.from('%PDF-1.4\n'), kb(600));
    const c = filePart('c.pdf', Buffer.from('%PDF-1.4\n'), kb(10));
    const err = await readUploads(fakeMultipart([a, b, c]), { types: PDF_TYPES, maxTotalBytes: 1024 * 1024 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 413, message: 'Os arquivos enviados passam de 1 MB juntos. Envie menos arquivos por vez.' });
    // o formulário foi lido até o fim: o navegador recebe a resposta, não uma conexão cortada
    expect(c.file.readableEnded).toBe(true);
    // abaixo do teto, os arquivos chegam inteiros
    const ok = await readUploads(fakeMultipart([filePart('a.pdf', Buffer.from('%PDF-1.4\n'), kb(600))]), { types: PDF_TYPES, maxTotalBytes: 1024 * 1024 });
    expect(ok.files[0].data.length).toBe(9 + 600 * 1024);
  });

  it('confere o tipo nos primeiros bytes e recusa antes de ler o resto do arquivo', async () => {
    let pulled = 0;
    const html = Buffer.concat([Buffer.from('<html><script>alert(1)</script>'), kb(SIGNATURE_BYTES / 1024)]);
    const fake: FakeFilePart = {
      type: 'file',
      fieldname: 'file',
      filename: 'disfarce.pdf',
      file: Readable.from(
        (function* () {
          for (let i = 0; i < 1000; i++) {
            pulled++;
            yield i === 0 ? html : kb(64);
          }
        })(),
        { objectMode: false },
      ),
      toBuffer: vi.fn(),
    };
    const err = await readUploads(fakeMultipart([fake]), { types: PDF_TYPES }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 400, message: 'O conteúdo de “disfarce.pdf” não corresponde ao tipo do arquivo.' });
    expect(pulled).toBeLessThan(10);
    // fora do modo estrito, o mesmo conteúdo é aceito como binário (só download)
    const loose = await readUploads(fakeMultipart([filePart('disfarce.pdf', html, kb(64))]), { types: PDF_TYPES, unknown: 'octet-stream' });
    expect(loose.files[0]).toMatchObject({ filename: 'disfarce.pdf', mimeType: 'application/octet-stream' });
    // e um PDF de verdade, grande, é reconhecido pelos primeiros bytes
    const pdf = await readUploads(fakeMultipart([filePart('ok.pdf', Buffer.from('%PDF-1.7\n'), kb(64), kb(64))]), { types: PDF_TYPES });
    expect(pdf.files[0].mimeType).toBe('application/pdf');
  });

  it('robô: só o primeiro arquivo do formulário é gravado, e o envio termina (multipart de verdade)', async () => {
    const o = await registerOffice(env);
    await o.api.post('/api/customers', { name: 'Ana', cpfCnpj: VALID_CPFS[1] });
    const tok = (await o.api.post('/api/robot/tokens', { name: 'Sync', scope: 'sync' })).body.token as string;
    const boundary = '----robo';
    const part = (name: string, content: Buffer) =>
      Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), content, Buffer.from('\r\n')]);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cpf"\r\n\r\n${VALID_CPFS[1]}\r\n--${boundary}\r\nContent-Disposition: form-data; name="ano"\r\n\r\n2026\r\n`),
      part('pre.dec', Buffer.from('pre-ana')),
      part('extra-1.bin', kb(2048, 1)),
      part('extra-2.bin', kb(2048, 2)),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/sync/prefilled',
      payload,
      headers: { authorization: `Bearer ${tok}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(201);
    const st = await env.ctx.db.query.prefilledStatements.findFirst({ where: eq(prefilledStatements.id, res.json().id) });
    const saved = await env.ctx.files.get(o.officeId, st!.fileId);
    expect(saved.row.filename).toBe('pre.dec');
    expect(saved.data.toString()).toBe('pre-ana');
    const all = await env.ctx.db.select({ filename: files.filename }).from(files).where(eq(files.officeId, o.officeId));
    expect(all.map((f) => f.filename)).toEqual(['pre.dec']);
  });
});

describe('downloads em stream (DAD-10)', () => {
  it('arquivo gravado sai em stream, com Content-Length, lista branca, nosniff e CSP', async () => {
    const o = await registerOffice(env);
    const c = await o.api.post('/api/customers', { name: 'Bia', cpfCnpj: VALID_CPFS[2] });
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const up = await upload(env, o.token, `/api/customers/${c.body.id}/documents?year=2026`, [
      { name: 'informe.pdf', content: FAKE_PDF, type: 'text/html' },
      { name: 'pagina.html', content: html, type: 'text/html' },
    ]);
    expect(up.status).toBe(201);
    const store = (env.ctx.files as unknown as { store: MemoryBlobStore }).store;
    const get = vi.spyOn(store, 'get');
    const stream = vi.spyOn(store, 'stream');

    const pdf = await o.api.get(`/api/documents/${up.body[0].id}/file?inline=1`);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.raw.headers['content-disposition'])).toMatch(/^inline;/);
    expect(pdf.raw.headers['content-length']).toBe(String(FAKE_PDF.length));
    expect(pdf.raw.headers['x-content-type-options']).toBe('nosniff');
    expect(pdf.raw.rawPayload.equals(FAKE_PDF)).toBe(true);

    const page = await o.api.get(`/api/files/${up.body[1].fileId}?inline=1`);
    expect(page.status).toBe(200);
    expect(page.raw.headers['content-type']).toBe('application/octet-stream');
    expect(String(page.raw.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(page.raw.headers['x-content-type-options']).toBe('nosniff');
    expect(String(page.raw.headers['content-security-policy'])).toContain('sandbox');
    expect(page.raw.headers['content-length']).toBe(String(html.length));
    expect(page.raw.rawPayload.equals(html)).toBe(true);

    // lido em stream, nunca inteiro na memória
    expect(stream).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalled();
  });
});
