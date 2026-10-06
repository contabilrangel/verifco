import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { files } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { notFound } from '../lib/errors';

/**
 * Armazenamento de arquivos. A implementação local grava em disco; outra pode usar S3.
 * Arquivos grandes (backup do escritório, .zip) passam por `putStream`/`getStream`, sem ficar
 * inteiros na memória (o `readFile` do Node nem lê arquivos acima de 2 GB).
 */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Grava o conteúdo lido do fluxo; só aparece na chave quando termina sem erro. */
  putStream(key: string, source: Readable): Promise<void>;
  /** Abre o arquivo para leitura em fluxo; falha logo (antes do primeiro byte) se ele não existe. */
  getStream(key: string): Promise<Readable>;
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
  async get(key: string) {
    return readFile(this.path(key));
  }
  async putStream(key: string, source: Readable) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    // grava num temporário e renomeia no fim: uma falha no meio não deixa arquivo pela metade na chave
    const tmp = `${p}.${randomUUID()}.tmp`;
    try {
      await pipeline(source, createWriteStream(tmp));
      await rename(tmp, p);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
  async getStream(key: string) {
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
  async get(key: string) {
    const b = this.map.get(key);
    if (!b) throw new Error('Arquivo não encontrado.');
    return b;
  }
  async putStream(key: string, source: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.map.set(key, Buffer.concat(chunks));
  }
  async getStream(key: string) {
    return Readable.from([await this.get(key)]);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

export type FileRow = typeof files.$inferSelect;
/** O banco ou uma transação aberta (`db.transaction(async (tx) => ...)`). */
type DbExecutor = Pick<Db, 'select' | 'delete'>;

export class FileService {
  constructor(
    private db: Db,
    private store: BlobStore,
  ) {}

  private newKey(officeId: string) {
    return `${officeId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}`;
  }

  async save(input: { officeId: string; data: Buffer; filename: string; mimeType: string; userId?: string | null }): Promise<FileRow> {
    const key = this.newKey(input.officeId);
    await this.store.put(key, input.data);
    return this.insertRow(key, { ...input, size: input.data.length, sha256: sha256(input.data) });
  }

  /**
   * Grava um arquivo lido em fluxo (ex.: o .zip do backup), calculando tamanho e SHA-256 no
   * caminho, sem montar o conteúdo na memória.
   */
  async saveStream(input: { officeId: string; stream: Readable; filename: string; mimeType: string; userId?: string | null }): Promise<FileRow> {
    const key = this.newKey(input.officeId);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    // origem → medidor → armazenamento; um erro em qualquer ponto derruba os dois lados
    const [read, write] = await Promise.allSettled([pipeline(input.stream, meter), this.store.putStream(key, meter)]);
    if (read.status === 'rejected') throw read.reason;
    if (write.status === 'rejected') throw write.reason;
    return this.insertRow(key, { ...input, size, sha256: hash.digest('hex') });
  }

  /** Grava a linha do arquivo; se o banco recusar, apaga o blob já gravado (não fica órfão). */
  private async insertRow(key: string, input: { officeId: string; filename: string; mimeType: string; userId?: string | null; size: number; sha256: string }) {
    try {
      const [row] = await this.db
        .insert(files)
        .values({
          officeId: input.officeId,
          storageKey: key,
          filename: input.filename.slice(0, 255),
          mimeType: input.mimeType || 'application/octet-stream',
          size: input.size,
          sha256: input.sha256,
          createdByUserId: input.userId ?? null,
        })
        .returning();
      return row;
    } catch (err) {
      await this.store.delete(key).catch(() => undefined);
      throw err;
    }
  }

  private async row(officeId: string, fileId: string) {
    const row = await this.db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.officeId, officeId)) });
    if (!row) throw notFound('Arquivo');
    return row;
  }

  async get(officeId: string, fileId: string): Promise<{ row: FileRow; data: Buffer }> {
    const row = await this.row(officeId, fileId);
    return { row, data: await this.store.get(row.storageKey) };
  }

  /** Abre o arquivo para leitura em fluxo (downloads grandes, .zip). Falha antes do primeiro byte se ele sumiu. */
  async open(officeId: string, fileId: string): Promise<{ row: FileRow; stream: Readable }> {
    const row = await this.row(officeId, fileId);
    return { row, stream: await this.store.getStream(row.storageKey) };
  }

  /** Abre pelo registro já lido (ex.: na montagem de um .zip, sem reconsultar o banco). */
  openRow(row: Pick<FileRow, 'storageKey'>): Promise<Readable> {
    return this.store.getStream(row.storageKey);
  }

  async remove(officeId: string, fileId: string) {
    const row = await this.db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.officeId, officeId)) });
    if (!row) return;
    await this.db.delete(files).where(eq(files.id, fileId));
    await this.store.delete(row.storageKey);
  }

  /**
   * Apaga as linhas dos arquivos (pode ser dentro de uma transação) e devolve as chaves dos blobs.
   * Apague os blobs com `deleteBlobs` só depois do commit: se a transação desfizer, o arquivo continua lá.
   */
  async removeRows(executor: DbExecutor, officeId: string, fileIds: string[]): Promise<string[]> {
    if (!fileIds.length) return [];
    const rows = await executor
      .select({ key: files.storageKey })
      .from(files)
      .where(and(eq(files.officeId, officeId), inArray(files.id, fileIds)));
    await executor.delete(files).where(and(eq(files.officeId, officeId), inArray(files.id, fileIds)));
    return rows.map((r) => r.key);
  }

  async deleteBlobs(keys: string[]) {
    for (const key of keys) await this.store.delete(key).catch(() => undefined);
  }
}
