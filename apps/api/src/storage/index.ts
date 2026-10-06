import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { files } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { notFound } from '../lib/errors';

/**
 * Armazenamento de arquivos. A implementação local grava em disco; outra pode usar S3.
 * Arquivos grandes (backup, .zip, downloads) passam por `stream`/`putStream`, sem carregar o
 * conteúdo inteiro na memória; `get`/`put` ficam para os pequenos (logo, anexos, PDFs gerados).
 */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  /** Grava o que vier do stream; se falhar no meio, não deixa arquivo parcial. */
  putStream(key: string, input: Readable): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Abre o conteúdo para leitura em stream; falha já aqui se o arquivo não existe. */
  stream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export class LocalBlobStore implements BlobStore {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error('Caminho inválido.');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async putStream(key: string, input: Readable) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    try {
      await pipeline(input, createWriteStream(p, { flags: 'wx' }));
    } catch (err) {
      await rm(p, { force: true });
      throw err;
    }
  }
  /** Lê o arquivo inteiro (o `readFile` recusa arquivos acima de 2 GiB: use `stream`). */
  async get(key: string) {
    return readFile(this.path(key));
  }
  async stream(key: string) {
    // abre já (arquivo inexistente falha antes de começar a resposta); o stream fecha o arquivo no fim
    const handle = await open(this.path(key), 'r');
    return handle.createReadStream();
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export class MemoryBlobStore implements BlobStore {
  private map = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.map.set(key, data);
  }
  async putStream(key: string, input: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    this.map.set(key, Buffer.concat(chunks));
  }
  async get(key: string) {
    const b = this.map.get(key);
    if (!b) throw new Error('Arquivo não encontrado.');
    return b;
  }
  async stream(key: string) {
    const b = this.map.get(key);
    if (!b) throw new Error('Arquivo não encontrado.');
    return Readable.from([b], { objectMode: false });
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

export type FileRow = typeof files.$inferSelect;

interface SaveInput {
  officeId: string;
  filename: string;
  mimeType: string;
  userId?: string | null;
}

export class FileService {
  constructor(
    private db: Db,
    private store: BlobStore,
  ) {}

  private newKey(officeId: string) {
    return `${officeId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}`;
  }

  /** Grava a linha do arquivo; se o insert falhar, remove o conteúdo já gravado (sem órfão). */
  private async insertRow(key: string, input: SaveInput, size: number, hash: string): Promise<FileRow> {
    try {
      const [row] = await this.db
        .insert(files)
        .values({
          officeId: input.officeId,
          storageKey: key,
          filename: input.filename.slice(0, 255),
          mimeType: input.mimeType || 'application/octet-stream',
          size,
          sha256: hash,
          createdByUserId: input.userId ?? null,
        })
        .returning();
      return row;
    } catch (err) {
      await this.store.delete(key).catch(() => {});
      throw err;
    }
  }

  async save(input: SaveInput & { data: Buffer }): Promise<FileRow> {
    const key = this.newKey(input.officeId);
    await this.store.put(key, input.data);
    return this.insertRow(key, input, input.data.length, sha256(input.data));
  }

  /**
   * Grava o conteúdo de um stream (ex.: o .zip do backup) sem montá-lo na memória: o tamanho
   * e o sha256 são calculados durante a gravação e a linha só é inserida depois.
   */
  async saveStream(input: SaveInput & { stream: Readable }): Promise<FileRow> {
    const key = this.newKey(input.officeId);
    const hash = createHash('sha256');
    let size = 0;
    async function* measure(source: Readable) {
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        size += buf.length;
        yield buf;
      }
    }
    try {
      await this.store.putStream(key, Readable.from(measure(input.stream), { objectMode: false }));
    } catch (err) {
      input.stream.destroy();
      await this.store.delete(key).catch(() => {});
      throw err;
    }
    return this.insertRow(key, input, size, hash.digest('hex'));
  }

  private async find(officeId: string, fileId: string): Promise<FileRow> {
    const row = await this.db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.officeId, officeId)) });
    if (!row) throw notFound('Arquivo');
    return row;
  }

  /** Conteúdo inteiro na memória: só para arquivos pequenos (logo, anexos, certificado). */
  async get(officeId: string, fileId: string): Promise<{ row: FileRow; data: Buffer }> {
    const row = await this.find(officeId, fileId);
    return { row, data: await this.store.get(row.storageKey) };
  }

  /**
   * Conteúdo em stream, para downloads e .zip (sem limite de tamanho). Entregue o stream logo
   * em seguida (`sendStoredFile`): enquanto ninguém lê nem o destrói, o arquivo fica aberto.
   */
  async open(officeId: string, fileId: string): Promise<{ row: FileRow; stream: Readable }> {
    const row = await this.find(officeId, fileId);
    return { row, stream: await this.store.stream(row.storageKey) };
  }

  /** Stream de um arquivo já consultado (ex.: os do backup e dos .zip, lidos em lote). */
  stream(file: Pick<FileRow, 'storageKey'>): Promise<Readable> {
    return this.store.stream(file.storageKey);
  }

  async remove(officeId: string, fileId: string) {
    const row = await this.db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.officeId, officeId)) });
    if (!row) return;
    await this.db.delete(files).where(eq(files.id, fileId));
    await this.store.delete(row.storageKey);
  }
}
