import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { files } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { notFound } from '../lib/errors';

/** Armazenamento de arquivos. A implementação local grava em disco; outra pode usar S3. */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
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
  async delete(key: string) {
    this.map.delete(key);
  }
}

export type FileRow = typeof files.$inferSelect;

export class FileService {
  constructor(
    private db: Db,
    private store: BlobStore,
  ) {}

  async save(input: { officeId: string; data: Buffer; filename: string; mimeType: string; userId?: string | null }): Promise<FileRow> {
    const key = `${input.officeId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}`;
    await this.store.put(key, input.data);
    const [row] = await this.db
      .insert(files)
      .values({
        officeId: input.officeId,
        storageKey: key,
        filename: input.filename.slice(0, 255),
        mimeType: input.mimeType || 'application/octet-stream',
        size: input.data.length,
        sha256: sha256(input.data),
        createdByUserId: input.userId ?? null,
      })
      .returning();
    return row;
  }

  async get(officeId: string, fileId: string): Promise<{ row: FileRow; data: Buffer }> {
    const row = await this.db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.officeId, officeId)) });
    if (!row) throw notFound('Arquivo');
    return { row, data: await this.store.get(row.storageKey) };
  }

  async remove(officeId: string, fileId: string) {
    const row = await this.db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.officeId, officeId)) });
    if (!row) return;
    await this.db.delete(files).where(eq(files.id, fileId));
    await this.store.delete(row.storageKey);
  }
}
