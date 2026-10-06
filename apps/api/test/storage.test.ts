/**
 * Armazenamento em stream (DAD-3, DAD-10): gravação e leitura sem montar o arquivo na memória,
 * sem arquivo órfão quando o registro não é gravado, `files.size` acima de 2 GiB e o .zip em stream.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer as readAll, text as readText } from 'node:stream/consumers';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documents, files } from '../src/db/schema';
import { sha256 } from '../src/lib/crypto';
import { FileService, LocalBlobStore, type MemoryBlobStore } from '../src/storage';
import { MISSING_FILES_NAME, ZipWriter, zipStoredFiles } from '../src/storage/zip';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
let dir: string;
beforeAll(async () => {
  env = await createTestEnv();
  dir = mkdtempSync(join(tmpdir(), 'verifco-armazenamento-'));
});
afterAll(async () => {
  await env.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Stream com os pedaços dados (como chegam de um upload ou de um .zip em geração). */
const chunks = (...parts: string[]) => Readable.from(parts.map((p) => Buffer.from(p)), { objectMode: false });
/** Stream que entrega um pedaço e falha (disco, rede ou geração do .zip com erro). */
const failing = () =>
  Readable.from(
    (async function* () {
      yield Buffer.from('parcial');
      throw new Error('falhou no meio');
    })(),
    { objectMode: false },
  );
/** Arquivos gravados numa pasta, em qualquer nível. */
const storedIn = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);

describe('FileService em stream (DAD-3)', () => {
  it('saveStream grava tamanho e sha256 calculados no caminho e o conteúdo volta em stream', async () => {
    const o = await registerOffice(env);
    const row = await env.ctx.files.saveStream({ officeId: o.officeId, stream: chunks('abc', 'def', 'ghi'), filename: 'partes.txt', mimeType: 'text/plain', userId: o.userId });
    expect(row).toMatchObject({ size: 9, sha256: sha256('abcdefghi'), filename: 'partes.txt', mimeType: 'text/plain', createdByUserId: o.userId });
    const { row: opened, stream } = await env.ctx.files.open(o.officeId, row.id);
    expect(opened.id).toBe(row.id);
    expect(await readText(stream)).toBe('abcdefghi');
    // arquivo de outro escritório não abre
    const other = await registerOffice(env);
    await expect(env.ctx.files.open(other.officeId, row.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('save e saveStream não deixam arquivo órfão quando o registro não é gravado', async () => {
    const root = join(dir, 'orfaos');
    const svc = new FileService(env.ctx.db, new LocalBlobStore(root));
    const o = await registerOffice(env);
    // escritório inexistente: o insert falha (chave estrangeira) depois de o conteúdo ir para o disco
    const ghost = randomUUID();
    await expect(svc.saveStream({ officeId: ghost, stream: chunks('a', 'b'), filename: 'a.txt', mimeType: 'text/plain' })).rejects.toThrow();
    await expect(svc.save({ officeId: ghost, data: Buffer.from('x'), filename: 'b.txt', mimeType: 'text/plain' })).rejects.toThrow();
    expect(storedIn(root)).toEqual([]);
    // origem que falha no meio: nada gravado, nem arquivo nem registro
    await expect(svc.saveStream({ officeId: o.officeId, stream: failing(), filename: 'meio.txt', mimeType: 'text/plain' })).rejects.toThrow('falhou no meio');
    expect(storedIn(root)).toEqual([]);
    expect(await env.ctx.db.select().from(files).where(eq(files.filename, 'meio.txt'))).toEqual([]);
    // e o caminho normal grava um arquivo só, com tamanho e sha256 conferidos
    const ok = await svc.saveStream({ officeId: o.officeId, stream: chunks('conteúdo ', 'em partes'), filename: 'ok.txt', mimeType: 'text/plain' });
    expect(storedIn(root)).toHaveLength(1);
    expect(ok.size).toBe(Buffer.byteLength('conteúdo em partes'));
    expect(ok.sha256).toBe(sha256('conteúdo em partes'));
    expect(await readText((await svc.open(o.officeId, ok.id)).stream)).toBe('conteúdo em partes');
  });

  it('LocalBlobStore grava e lê em stream, sem arquivo parcial e sem sair da pasta', async () => {
    const store = new LocalBlobStore(join(dir, 'blobs'));
    await store.putStream('escritorio/2026-10/um', chunks('1', '2', '3'));
    expect(await readText(await store.stream('escritorio/2026-10/um'))).toBe('123');
    expect((await store.get('escritorio/2026-10/um')).toString()).toBe('123');
    await expect(store.stream('escritorio/2026-10/nao-existe')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.putStream('escritorio/2026-10/parcial', failing())).rejects.toThrow('falhou no meio');
    expect(existsSync(join(dir, 'blobs', 'escritorio/2026-10/parcial'))).toBe(false);
    await expect(store.stream('../fora')).rejects.toThrow('Caminho inválido.');
  });

  it('files.size aceita mais de 2 GiB (bigint) e a API devolve o tamanho como número', async () => {
    const o = await registerOffice(env);
    const c = await o.api.post('/api/customers', { name: 'Cliente Grande', cpfCnpj: VALID_CPFS[0] });
    const big = 5 * 1024 ** 3;
    const [row] = await env.ctx.db
      .insert(files)
      .values({ officeId: o.officeId, storageKey: `${o.officeId}/grande`, filename: 'grande.zip', mimeType: 'application/zip', size: big, sha256: 'x' })
      .returning();
    expect(row.size).toBe(big);
    await env.ctx.db.insert(documents).values({ officeId: o.officeId, customerId: c.body.id, fileId: row.id, category: 'other' });
    const list = await o.api.get(`/api/customers/${c.body.id}/documents`);
    expect(list.body[0].size).toBe(big);
    // e o .zip de documentos recusa pelo tamanho antes de ler qualquer arquivo
    const zip = await o.api.post('/api/documents/zip', { customerIds: [c.body.id] });
    expect(zip.status).toBe(400);
    expect(zip.body.error).toBe('Os arquivos passam de 1 GB. Selecione menos clientes.');
  });
});

describe('.zip em stream (DAD-3, DAD-10)', () => {
  it('ZipWriter monta o .zip entrada por entrada, com caminhos saneados', async () => {
    const zip = new ZipWriter();
    const out = readAll(zip.output);
    await zip.addStream('pasta/um.txt', chunks('um ', 'dois'));
    await zip.addStream('../fora.txt', chunks('x'));
    await zip.addStream('pasta/guardado.bin', chunks('sem compressão'), { compress: false });
    zip.addBuffer('LEIAME.txt', 'oi');
    zip.end();
    const read = await JSZip.loadAsync(await out);
    expect(Object.keys(read.files).filter((n) => !read.files[n].dir).sort()).toEqual(['LEIAME.txt', '_/fora.txt', 'pasta/guardado.bin', 'pasta/um.txt']);
    expect(await read.file('pasta/um.txt')!.async('string')).toBe('um dois');
    expect(await read.file('pasta/guardado.bin')!.async('string')).toBe('sem compressão');
    expect(await read.file('LEIAME.txt')!.async('string')).toBe('oi');
  });

  it('download cancelado: a origem em leitura é fechada e a geração para (sem travar)', async () => {
    const zip = new ZipWriter();
    let pulled = 0;
    // origem sem fim e assíncrona, como um arquivo grande lido do disco
    const endless = new Readable({
      read() {
        setImmediate(() => {
          pulled++;
          this.push(Buffer.alloc(64 * 1024, 7));
        });
      },
    });
    const adding = zip.addStream('sem-fim.bin', endless, { compress: false });
    // o navegador baixa um pouco e cancela
    await new Promise<void>((resolve) => zip.output.on('data', () => pulled >= 3 && resolve()));
    zip.output.destroy();
    await expect(adding).rejects.toThrow();
    expect(endless.destroyed).toBe(true);
    expect(zip.failure).toBeTruthy();
    // no máximo a leitura que já estava pedida termina; depois disso a origem não é mais lida
    const stopped = pulled;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pulled).toBeLessThanOrEqual(stopped + 1);
    const next = chunks('x');
    await expect(zip.addStream('depois.txt', next)).rejects.toThrow();
    expect(next.destroyed).toBe(true);
  });

  it('zipStoredFiles lê um arquivo de cada vez e lista o que sumiu do armazenamento', async () => {
    const o = await registerOffice(env);
    const a = await env.ctx.files.save({ officeId: o.officeId, data: Buffer.from('conteúdo A'), filename: 'a.txt', mimeType: 'text/plain' });
    const b = await env.ctx.files.save({ officeId: o.officeId, data: Buffer.from('conteúdo B'), filename: 'b.txt', mimeType: 'text/plain' });
    const store = (env.ctx.files as unknown as { store: MemoryBlobStore }).store;
    await store.delete(b.storageKey);
    const out = await readAll(
      zipStoredFiles(env.ctx.files, [
        { path: 'cliente/a.txt', file: a },
        { path: 'cliente/b.txt', file: b },
      ]),
    );
    const read = await JSZip.loadAsync(out);
    expect(Object.keys(read.files).filter((n) => !read.files[n].dir).sort()).toEqual([MISSING_FILES_NAME, 'cliente/a.txt']);
    expect(await read.file('cliente/a.txt')!.async('string')).toBe('conteúdo A');
    expect(await read.file(MISSING_FILES_NAME)!.async('string')).toContain('- cliente/b.txt');
  });
});
