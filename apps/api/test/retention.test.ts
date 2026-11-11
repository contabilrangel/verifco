/**
 * Lixeira de clientes, eliminação definitiva e a rotina diária de retenção.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditLogs, customers, deliveries, documents, files, jobs, notifications, passwordResets } from '../src/db/schema';
import { RETENTION_JOB, nextRetentionRun, runRetention, scheduleRetention } from '../src/modules/maintenance/jobs';
import type { MemoryBlobStore } from '../src/storage';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { fakePdf, multipart, send } from './robot-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const DAY = 86_400_000;
const blobs = () => (env.ctx.files as unknown as { store: MemoryBlobStore }).store;

/** Cliente com um documento enviado pelo robô (arquivo real no armazenamento). */
async function customerWithFile(office: Awaited<ReturnType<typeof registerOffice>>, cpf: string, name: string) {
  const c = await office.api.post('/api/customers', { name, cpfCnpj: cpf, email: `${cpf}@teste.com` });
  const token = (await office.api.post('/api/robot/tokens', { name: `Robô ${name}`, scope: 'sync' })).body.token as string;
  const up = await send(env, token, 'POST', '/api/sync/documents', { multipart: multipart({ cpf, ano: '2026' }, { name: 'doc.pdf', content: fakePdf(name), type: 'application/pdf' }) });
  expect(up.status).toBe(201);
  const doc = await env.ctx.db.query.documents.findFirst({ where: eq(documents.id, up.body.id) });
  const file = await env.ctx.db.query.files.findFirst({ where: eq(files.id, doc!.fileId) });
  return { id: c.body.id as string, fileId: file!.id, storageKey: file!.storageKey };
}

describe('lixeira de clientes', () => {
  it('lista os excluídos com a data de eliminação, restaura e recusa restaurar com CPF em uso', async () => {
    const office = await registerOffice(env);
    const a = await customerWithFile(office, VALID_CPFS[0], 'Ana');
    expect((await office.api.del(`/api/customers/${a.id}`)).status).toBe(200);
    const trash = await office.api.get('/api/customers/deleted');
    expect(trash.status).toBe(200);
    expect(trash.body.retentionDays).toBe(90);
    expect(trash.body.data).toEqual([expect.objectContaining({ id: a.id, name: 'Ana', cpfCnpj: VALID_CPFS[0] })]);
    expect(Math.round((Date.parse(trash.body.data[0].purgeAt) - Date.parse(trash.body.data[0].deletedAt)) / DAY)).toBe(90);
    expect((await office.api.get(`/api/customers/${a.id}`)).status).toBe(404);

    expect((await office.api.post(`/api/customers/${a.id}/restore`)).status).toBe(200);
    expect((await office.api.get(`/api/customers/${a.id}`)).status).toBe(200);
    expect((await office.api.get('/api/customers/deleted')).body.data).toEqual([]);
    expect((await office.api.post(`/api/customers/${a.id}/restore`)).status).toBe(404);

    // excluído de novo, o CPF foi recadastrado: restaurar criaria dois ativos com o mesmo CPF
    await office.api.del(`/api/customers/${a.id}`);
    await office.api.post('/api/customers', { name: 'Ana de novo', cpfCnpj: VALID_CPFS[0] });
    const conflict = await office.api.post(`/api/customers/${a.id}/restore`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/Ana de novo/);
  });

  it('eliminação definitiva apaga o cliente, os dependentes e o conteúdo dos arquivos; só da lixeira e só do próprio escritório', async () => {
    const office = await registerOffice(env);
    const other = await registerOffice(env);
    const a = await customerWithFile(office, VALID_CPFS[1], 'Bruno');
    const keep = await customerWithFile(office, VALID_CPFS[2], 'Carla');
    await env.ctx.db.insert(deliveries).values({ officeId: office.officeId, customerId: a.id, channel: 'email', toAddress: 'bruno@teste.com', body: 'Olá, Bruno' });
    // ainda ativo: não se elimina sem passar pela lixeira
    expect((await office.api.del(`/api/customers/${a.id}/purge`)).status).toBe(404);
    await office.api.del(`/api/customers/${a.id}`);
    expect((await other.api.del(`/api/customers/${a.id}/purge`)).status).toBe(404);
    expect((await other.api.post(`/api/customers/${a.id}/restore`)).status).toBe(404);

    const purged = await office.api.del(`/api/customers/${a.id}/purge`);
    expect(purged.status).toBe(200);
    expect(purged.body).toEqual({ ok: true, files: 1 });
    expect(await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, a.id) })).toBeUndefined();
    expect(await env.ctx.db.query.files.findFirst({ where: eq(files.id, a.fileId) })).toBeUndefined();
    await expect(blobs().get(a.storageKey)).rejects.toThrow();
    expect(await env.ctx.db.select().from(documents).where(eq(documents.customerId, a.id))).toEqual([]);
    expect(await env.ctx.db.select().from(deliveries).where(eq(deliveries.toAddress, 'bruno@teste.com'))).toEqual([]);
    // o outro cliente e o arquivo dele ficam
    expect((await office.api.get(`/api/customers/${keep.id}`)).status).toBe(200);
    expect((await blobs().get(keep.storageKey)).length).toBeGreaterThan(0);
    const trail = await env.ctx.db.select().from(auditLogs).where(eq(auditLogs.entityId, a.id));
    expect(trail.map((t) => t.action)).toEqual(expect.arrayContaining(['delete', 'purge']));
    expect(trail.find((t) => t.action === 'purge')!.data).toMatchObject({ name: 'Bruno', files: 1, deliveries: 1 });
  });
});

describe('rotina de retenção', () => {
  it('apaga só o que passou do prazo: tarefas, backups, clientes da lixeira, links e avisos lidos', async () => {
    const office = await registerOffice(env);
    const now = new Date();
    const old = (days: number) => new Date(now.getTime() - days * DAY);
    const oldCustomer = await customerWithFile(office, VALID_CPFS[3], 'Antigo');
    const recentCustomer = await customerWithFile(office, VALID_CPFS[4], 'Recente');
    await office.api.del(`/api/customers/${oldCustomer.id}`);
    await office.api.del(`/api/customers/${recentCustomer.id}`);
    await env.ctx.db.update(customers).set({ deletedAt: old(91) }).where(eq(customers.id, oldCustomer.id));
    await env.ctx.db.update(customers).set({ deletedAt: old(89) }).where(eq(customers.id, recentCustomer.id));

    const backupFile = await env.ctx.files.save({ officeId: office.officeId, data: Buffer.from('zip'), filename: 'backup.zip', mimeType: 'application/zip' });
    const freshFile = await env.ctx.files.save({ officeId: office.officeId, data: Buffer.from('zip2'), filename: 'backup2.zip', mimeType: 'application/zip' });
    const inserted = await env.ctx.db
      .insert(jobs)
      .values([
        { officeId: office.officeId, type: 'teste.antigo', status: 'done', finishedAt: old(31) },
        { officeId: office.officeId, type: 'teste.falha-antiga', status: 'failed', finishedAt: old(40) },
        { officeId: office.officeId, type: 'teste.recente', status: 'done', finishedAt: old(29) },
        { officeId: office.officeId, type: 'teste.na-fila', status: 'queued', createdAt: old(60) },
        { officeId: office.officeId, type: 'backup.generate', status: 'done', finishedAt: old(31), result: { fileId: backupFile.id } },
        { officeId: office.officeId, type: 'backup.generate', status: 'done', finishedAt: old(5), result: { fileId: freshFile.id } },
      ])
      .returning();
    const [oldJob, oldFailed, recentJob, queuedJob, oldBackup, freshBackup] = inserted;
    await env.ctx.db.insert(passwordResets).values([
      { userId: office.userId, tokenHash: 'vencido-ha-muito', expiresAt: old(8) },
      { userId: office.userId, tokenHash: 'usado-ha-muito', expiresAt: new Date(now.getTime() + DAY), usedAt: old(8) },
      { userId: office.userId, tokenHash: 'valido', expiresAt: new Date(now.getTime() + DAY) },
    ]);
    await env.ctx.db.insert(notifications).values([
      { officeId: office.officeId, title: 'lido antigo', readAt: old(170), createdAt: old(181) },
      { officeId: office.officeId, title: 'nao lido antigo', createdAt: old(181) },
      { officeId: office.officeId, title: 'lido recente', readAt: old(1), createdAt: old(2) },
    ]);
    await env.ctx.db.execute(sql`insert into rate_limits (key, count, window_started_at) values ('teste-antigo', 3, ${old(2)}), ('teste-novo', 1, now())`);
    await env.ctx.platformDb.execute(sql`insert into rate_limits (key, count, window_started_at) values ('plataforma-antigo', 3, ${old(2)})`);

    const result = await runRetention(env.ctx, now);
    expect(result).toMatchObject({ backups: 1, customers: 1, customerFiles: 1, passwordResets: 2, notifications: 1 });
    expect(result.jobs).toBeGreaterThanOrEqual(2);
    expect(result.rateLimits).toBeGreaterThanOrEqual(2);

    const left = async (id: string) => Boolean(await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, id) }));
    expect([await left(oldJob.id), await left(oldFailed.id), await left(recentJob.id), await left(queuedJob.id), await left(oldBackup.id), await left(freshBackup.id)]).toEqual([false, false, true, true, false, true]);
    expect(await env.ctx.db.query.files.findFirst({ where: eq(files.id, backupFile.id) })).toBeUndefined();
    expect(await env.ctx.db.query.files.findFirst({ where: eq(files.id, freshFile.id) })).toBeTruthy();
    expect(await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, oldCustomer.id) })).toBeUndefined();
    await expect(blobs().get(oldCustomer.storageKey)).rejects.toThrow();
    expect(await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, recentCustomer.id) })).toBeTruthy();
    expect((await blobs().get(recentCustomer.storageKey)).length).toBeGreaterThan(0);
    expect((await env.ctx.db.select().from(passwordResets).where(eq(passwordResets.userId, office.userId))).map((r) => r.tokenHash)).toEqual(['valido']);
    expect((await env.ctx.db.select().from(notifications).where(eq(notifications.officeId, office.officeId))).map((n) => n.title).sort()).toEqual(['lido recente', 'nao lido antigo']);
    expect((await env.ctx.db.execute<{ key: string }>(sql`select key from rate_limits where key like 'teste-%'`)).rows.map((r) => r.key)).toEqual(['teste-novo']);

    // rodar de novo não apaga mais nada
    expect(await runRetention(env.ctx, now)).toMatchObject({ backups: 0, customers: 0, passwordResets: 0, notifications: 0 });
  });

  it('agenda uma rodada por dia às 3h40 de Brasília e se reagenda ao rodar', async () => {
    expect(nextRetentionRun(new Date('2026-11-10T05:00:00Z')).toISOString()).toBe('2026-11-10T06:40:00.000Z');
    expect(nextRetentionRun(new Date('2026-11-10T06:40:00Z')).toISOString()).toBe('2026-11-11T06:40:00.000Z');
    expect(nextRetentionRun(new Date('2026-12-31T23:00:00Z')).toISOString()).toBe('2027-01-01T06:40:00.000Z');
    const first = await scheduleRetention(env.ctx, new Date('2030-01-05T12:00:00Z'));
    const again = await scheduleRetention(env.ctx, new Date('2030-01-05T20:00:00Z'));
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ type: RETENTION_JOB, idempotencyKey: 'retention:2030-01-06', officeId: null });
    // ao executar, deixa a do dia seguinte na fila
    await env.ctx.db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, first.id));
    await env.ctx.jobs.drain();
    expect(await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, first.id) })).toMatchObject({ status: 'done' });
    const queued = await env.ctx.db.select().from(jobs).where(eq(jobs.type, RETENTION_JOB));
    expect(queued.filter((j) => j.status === 'queued')).toHaveLength(1);
    expect(queued.find((j) => j.status === 'queued')!.runAt.getTime()).toBeGreaterThan(Date.now());
  });
});
