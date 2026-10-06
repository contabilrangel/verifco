import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import multipartPlugin from '@fastify/multipart';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLogs, customerGroupMembers, customerGroups, documents, files, prefilledStatements } from '../src/db/schema';
import { HttpError } from '../src/lib/errors';
import { FileService, LocalBlobStore } from '../src/storage';
import { readUploads, KNOWN_FILE_TYPES } from '../src/services/uploads';
import { ZipStream } from '../src/services/zip';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { multipartBody } from './upload-helpers';

let env: TestEnv;
let dir: string;
beforeAll(async () => {
  env = await createTestEnv();
  dir = await mkdtemp(join(tmpdir(), 'verifco-storage-'));
});
afterAll(async () => {
  await env.close();
  await rm(dir, { recursive: true, force: true });
});

const GB = 1024 * 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function officeWithCustomer(i = 0) {
  const o = await registerOffice(env);
  const c = await o.api.post('/api/customers', { name: `Cliente ${i}`, cpfCnpj: VALID_CPFS[i] });
  return { ...o, customerId: c.body.id as string };
}

/** Linha de arquivo que aponta para um blob que não existe (sumiu do disco, ou só para testar o teto). */
async function phantomFile(officeId: string, filename: string, size = 10) {
  const [row] = await env.ctx.db
    .insert(files)
    .values({ officeId, storageKey: `${officeId}/nao-existe/${randomUUID()}`, filename, mimeType: 'application/pdf', size, sha256: 'x' })
    .returning();
  return row;
}

describe('armazenamento em fluxo (DAD-3)', () => {
  it('grava e lê em fluxo, calculando tamanho e SHA-256 sem montar o arquivo na memória', async () => {
    const service = new FileService(env.ctx.db, new LocalBlobStore(dir));
    const { officeId } = await registerOffice(env);
    const chunk = Buffer.alloc(64 * 1024, 7);
    const parts = Array.from({ length: 40 }, (_, i) => Buffer.concat([chunk, Buffer.from(String(i))]));
    const whole = Buffer.concat(parts);
    const row = await service.saveStream({ officeId, stream: Readable.from(parts), filename: 'grande.bin', mimeType: 'application/octet-stream' });
    expect(row.size).toBe(whole.length);
    expect(row.sha256).toBe(sha(whole));
    const { stream } = await service.open(officeId, row.id);
    const back: Buffer[] = [];
    for await (const c of stream) back.push(c as Buffer);
    expect(Buffer.concat(back).equals(whole)).toBe(true);
  });

  it('falha no meio não deixa arquivo pela metade nem blob órfão', async () => {
    const root = join(dir, 'falhas');
    const store = new LocalBlobStore(root);
    const service = new FileService(env.ctx.db, store);
    const { officeId } = await registerOffice(env);
    // só arquivos (as pastas do escritório e do mês podem ficar)
    const blobs = async () => (await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])).filter((e) => e.isFile()).map((e) => e.name);
    // a origem dá erro no meio da cópia
    async function* broken() {
      yield Buffer.from('começo');
      throw new Error('disco removido');
    }
    await expect(service.saveStream({ officeId, stream: Readable.from(broken()), filename: 'x.zip', mimeType: 'application/zip' })).rejects.toThrow('disco removido');
    expect(await blobs()).toEqual([]);
    // o banco recusa a linha (escritório inexistente): o blob gravado é apagado
    await expect(service.saveStream({ officeId: randomUUID(), stream: Readable.from([Buffer.from('ok')]), filename: 'y.zip', mimeType: 'application/zip' })).rejects.toThrow();
    expect(await blobs()).toEqual([]);
    // e o caminho feliz grava um arquivo só
    await service.saveStream({ officeId, stream: Readable.from([Buffer.from('ok')]), filename: 'z.zip', mimeType: 'application/zip' });
    expect(await blobs()).toHaveLength(1);
    // abrir um arquivo que sumiu falha antes do primeiro byte (dá para pular no .zip)
    await expect(store.getStream('nao/existe')).rejects.toThrow();
  });

  it('files.size aceita arquivos acima de 2 GB (bigint)', async () => {
    const { officeId } = await registerOffice(env);
    const row = await phantomFile(officeId, 'backup-enorme.zip', 5 * GB);
    const back = await env.ctx.db.query.files.findFirst({ where: eq(files.id, row.id) });
    expect(back!.size).toBe(5 * GB);
  });
});

describe('backup em fluxo (DAD-3)', () => {
  it('pagina tabelas grandes, pula arquivo que sumiu e entrega o .zip em fluxo', async () => {
    const o = await officeWithCustomer(1);
    // mais linhas que uma página (1.000) para conferir a paginação pela chave primária
    const rows = Array.from({ length: 2345 }, (_, i) => ({ officeId: o.officeId, action: 'teste', entity: 'linha', entityId: String(i), data: { i } }));
    for (let i = 0; i < rows.length; i += 500) await env.ctx.db.insert(auditLogs).values(rows.slice(i, i + 500));
    // tabela de chave composta (sem office_id), exportada pela chave estrangeira
    const [group] = await env.ctx.db.insert(customerGroups).values({ officeId: o.officeId, name: 'VIP' }).returning();
    await env.ctx.db.insert(customerGroupMembers).values({ customerId: o.customerId, groupId: group.id });
    const kept = await env.ctx.files.save({ officeId: o.officeId, data: Buffer.from('%PDF-guardado'), filename: 'guardado.pdf', mimeType: 'application/pdf' });
    const gone = await phantomFile(o.officeId, 'sumiu.pdf');

    expect((await o.api.post('/api/backups')).status).toBe(202);
    await env.ctx.jobs.drain();
    const job = (await o.api.get('/api/backups')).body[0];
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ files: 1, missingFiles: 1 });

    const dl = await o.api.get(`/api/backups/${job.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.raw.headers['content-type']).toBe('application/zip');
    expect(Number(dl.raw.headers['content-length'])).toBe(job.result.size);
    expect(dl.raw.rawPayload.length).toBe(job.result.size);
    const zip = await JSZip.loadAsync(dl.raw.rawPayload);
    const audit = JSON.parse(await zip.file('dados/audit_logs.json')!.async('string'));
    const ids = audit.filter((a: any) => a.action === 'teste').map((a: any) => Number(a.entityId));
    expect(ids).toHaveLength(2345);
    expect(new Set(ids).size).toBe(2345);
    expect(job.result.tables.audit_logs).toBe(audit.length);
    const members = JSON.parse(await zip.file('dados/customer_group_members.json')!.async('string'));
    expect(members).toEqual([{ customerId: o.customerId, groupId: group.id }]);
    expect(await zip.file(`arquivos/${kept.id}-guardado.pdf`)!.async('string')).toBe('%PDF-guardado');
    expect(Object.keys(zip.files).some((n) => n.includes(gone.id))).toBe(false);
    const manifest = JSON.parse(await zip.file('manifesto.json')!.async('string'));
    expect(manifest).toMatchObject({ files: 1, missingFiles: [`arquivos/${gone.id}-sumiu.pdf`] });
    const filesJson = JSON.parse(await zip.file('dados/files.json')!.async('string'));
    expect(filesJson.every((f: any) => f.storageKey === undefined)).toBe(true);
  });

  it('o .zip em fluxo é interrompido quando quem lê desiste (download cancelado)', async () => {
    const zip = new ZipStream();
    const big = Readable.from((function* () {
      for (let i = 0; i < 10_000; i++) yield Buffer.alloc(64 * 1024, i % 256);
    })());
    const adding = zip.addStream('grande.bin', big);
    zip.output.once('data', () => zip.output.destroy());
    zip.output.resume();
    await expect(adding).rejects.toThrow(/interrompida/);
    expect(big.destroyed).toBe(true);
  });
});

describe('.zip de download em fluxo e com teto (DAD-10)', () => {
  it('documentos: arquivo que sumiu fica de fora e é listado; acima de 1 GB é recusado antes de começar', async () => {
    const o = await officeWithCustomer(2);
    const ok = await env.ctx.files.save({ officeId: o.officeId, data: Buffer.from('%PDF-ok'), filename: 'informe.pdf', mimeType: 'application/pdf' });
    const lost = await phantomFile(o.officeId, 'recibo.pdf');
    await env.ctx.db.insert(documents).values([
      { officeId: o.officeId, customerId: o.customerId, fileId: ok.id },
      { officeId: o.officeId, customerId: o.customerId, fileId: lost.id },
    ]);
    const res = await o.api.post('/api/documents/zip', { customerIds: [o.customerId] });
    expect(res.status).toBe(200);
    expect(res.raw.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(res.raw.rawPayload);
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.endsWith('/informe.pdf'))).toBe(true);
    expect(names.some((n) => n.endsWith('/recibo.pdf'))).toBe(false);
    expect(await zip.file('ARQUIVOS-NAO-ENCONTRADOS.txt')!.async('string')).toContain('recibo.pdf');

    const huge = await phantomFile(o.officeId, 'enorme.pdf', 2 * GB);
    await env.ctx.db.insert(documents).values({ officeId: o.officeId, customerId: o.customerId, fileId: huge.id });
    const tooBig = await o.api.post('/api/documents/zip', { customerIds: [o.customerId] });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error).toMatch(/limite de 1 GB/);
  });

  it('pré-preenchidas: o .zip também tem teto', async () => {
    const o = await officeWithCustomer(3);
    const huge = await phantomFile(o.officeId, 'pre.dec', 1.5 * GB);
    await env.ctx.db.insert(prefilledStatements).values({ officeId: o.officeId, customerId: o.customerId, exerciseYear: 2026, fileId: huge.id });
    const res = await o.api.post('/api/prefilled/download', { year: 2026, mode: 'all' });
    expect(res.status).toBe(413);
  });

  it('uploads: soma dos arquivos de um envio tem teto (memória por requisição)', async () => {
    const app = Fastify();
    await app.register(multipartPlugin);
    app.setErrorHandler((err, _req, reply) => {
      reply.status(err instanceof HttpError ? err.statusCode : 500).send({ error: err instanceof Error ? err.message : String(err) });
    });
    app.post('/up', async (req) => {
      const { files: got } = await readUploads(req, { types: KNOWN_FILE_TYPES, maxTotalBytes: 1000 });
      return { n: got.length };
    });
    const send = (sizes: number[]) => {
      const { payload, contentType } = multipartBody(sizes.map((n, i) => ({ name: `a${i}.txt`, content: 'x'.repeat(n), type: 'text/plain' })));
      return app.inject({ method: 'POST', url: '/up', payload, headers: { 'content-type': contentType } });
    };
    expect((await send([400, 500])).json()).toEqual({ n: 2 });
    const over = await send([600, 600]);
    expect(over.statusCode).toBe(413);
    expect(over.json().error).toMatch(/no total/);
    await app.close();
  });
});
