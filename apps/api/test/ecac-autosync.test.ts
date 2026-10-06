/**
 * Sincronização automática do eCAC configurável na integração SERPRO: desligada (padrão das
 * integrações novas, porque cada consulta é cobrada), diária ou semanal no dia escolhido. A rodada
 * entra na fila uma vez por período (dia ou semana de Brasília), mesmo com vários workers, e a
 * configuração vale na próxima rodada.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { addDaysIso, brazilToday, ecacAutoSyncPeriod, weekdayIso } from '@verifco/shared';
import { auditLogs, integrations, jobs, procurators } from '../src/db/schema';
import type { Providers } from '../src/integrations/providers';
import { clearSerproTokens } from '../src/integrations/serpro';
import { nextAutoSyncRun, scheduleEcacAutoSync } from '../src/modules/ecac/jobs';
import { createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(() => {
  clearSerproTokens();
  (env.ctx.providers as Providers).mtlsRequest = async () => ({ status: 200, body: JSON.stringify({ access_token: 'acesso', jwt_token: 'jwt', expires_in: 2000 }) });
});

/** Escritório com o SERPRO ativo (sem clientes: a sincronização geral termina na hora). */
async function officeWithSerpro(config: Record<string, unknown> = {}) {
  const office = await registerOffice(env);
  const file = await env.ctx.files.save({ officeId: office.officeId, data: Buffer.from('pfx-falso'), filename: 'escritorio.pfx', mimeType: 'application/x-pkcs12' });
  const [cert] = await env.ctx.db
    .insert(procurators)
    .values({
      officeId: office.officeId,
      name: 'Escritório (e-CNPJ)',
      cpfCnpj: '11222333000181',
      authType: 'certificate_cloud',
      certificateFileId: file.id,
      certificatePasswordEnc: env.ctx.secrets.encrypt('senha-do-pfx'),
      certificateExpiresAt: '2099-12-31',
    })
    .returning();
  const saved = await office.api.put('/api/integrations/serpro', {
    enabled: true,
    config: { contractorCnpj: '11.222.333/0001-81', procuratorId: cert.id, ...config },
    secrets: { consumerKey: 'consumer-key', consumerSecret: 'consumer-secret' },
  });
  expect(saved.status).toBe(200);
  return office;
}

const officeSyncs = (officeId: string) => env.ctx.db.select().from(jobs).where(and(eq(jobs.type, 'ecac.sync_office'), eq(jobs.officeId, officeId)));
const autoQueued = async (officeId: string) => (await officeSyncs(officeId)).filter((j) => j.status === 'queued' && j.payload.trigger);
const serproConfig = async (api: Awaited<ReturnType<typeof registerOffice>>['api']) =>
  ((await api.get('/api/integrations')).body as any[]).find((i) => i.provider === 'serpro').config;

describe('próxima rodada automática (datas de Brasília)', () => {
  const office = '2f1d0c9e-7b55-4c1c-9a0b-3d4e5f6a7b8c';

  it('diária: o próximo dia; semanal: o próximo dia da semana escolhido; desligada: nenhuma', () => {
    // 22h de terça, 06/10/2026, em Brasília (em UTC já é quarta, 07/10)
    const now = new Date('2026-10-07T01:00:00Z');
    expect(brazilToday(nextAutoSyncRun(office, { mode: 'daily', weekday: 1 }, { now })!)).toBe('2026-10-07');
    // terça já passou da hora: a semanal de terça fica para a semana seguinte
    expect(brazilToday(nextAutoSyncRun(office, { mode: 'weekly', weekday: 2 }, { now })!)).toBe('2026-10-13');
    expect(brazilToday(nextAutoSyncRun(office, { mode: 'weekly', weekday: 1 }, { now })!)).toBe('2026-10-12');
    expect(nextAutoSyncRun(office, { mode: 'off', weekday: 1 }, { now })).toBeNull();
    for (const mode of ['daily', 'weekly'] as const) {
      const at = nextAutoSyncRun(office, { mode, weekday: 3 }, { now })!;
      // entre 3h e 6h de Brasília = 6h–9h UTC
      expect(at.getUTCHours()).toBeGreaterThanOrEqual(6);
      expect(at.getUTCHours()).toBeLessThan(9);
    }
    // encadeando: sempre depois do dia da rodada em andamento
    expect(brazilToday(nextAutoSyncRun(office, { mode: 'weekly', weekday: 1 }, { now, afterDay: '2026-10-12' })!)).toBe('2026-10-19');
    expect(brazilToday(nextAutoSyncRun(office, { mode: 'daily', weekday: 1 }, { now, afterDay: '2026-10-07' })!)).toBe('2026-10-08');
  });
});

describe('sincronização automática configurável', () => {
  it('integração nova começa desligada: nada agendado, e o "sincronizar agora" continua funcionando', async () => {
    const office = await officeWithSerpro();
    expect(await serproConfig(office.api)).toMatchObject({ autoSync: 'off', autoSyncWeekday: '1' });
    expect(await autoQueued(office.officeId)).toHaveLength(0);
    expect((await office.api.get('/api/robot/overview')).body.nextAutoSync).toBeNull();

    const manual = await office.api.post('/api/robot/sync-office');
    expect(manual.status).toBe(202);
    await env.ctx.jobs.drain();
    const rows = await officeSyncs(office.officeId);
    expect(rows).toEqual([expect.objectContaining({ id: manual.body.job.id, status: 'done' })]);
    // e a manual não liga a automática
    expect(await autoQueued(office.officeId)).toHaveLength(0);
  });

  it('semanal no dia escolhido, uma por semana; trocar o dia, a frequência ou desligar vale na hora e fica na auditoria', async () => {
    const office = await officeWithSerpro();
    const saved = await office.api.put('/api/integrations/serpro', { config: { autoSync: 'weekly', autoSyncWeekday: '4' } });
    expect(saved.status).toBe(200);
    expect(saved.body.config).toMatchObject({ autoSync: 'weekly', autoSyncWeekday: '4' });
    let queued = await autoQueued(office.officeId);
    expect(queued).toHaveLength(1);
    const day = brazilToday(queued[0].runAt);
    expect(weekdayIso(day)).toBe(4);
    expect(queued[0]).toMatchObject({ payload: { trigger: 'weekly', day }, idempotencyKey: `weekly:${office.officeId}:${ecacAutoSyncPeriod('weekly', day)}` });
    expect(new Date((await office.api.get('/api/robot/overview')).body.nextAutoSync).getTime()).toBe(queued[0].runAt.getTime());

    // salvar de novo ou vários workers agendando ao mesmo tempo não duplicam
    await office.api.put('/api/integrations/serpro', { config: { autoSync: 'weekly', autoSyncWeekday: '4' } });
    await Promise.all([1, 2, 3].map(() => scheduleEcacAutoSync(env.ctx, office.officeId)));
    expect((await autoQueued(office.officeId)).map((j) => j.id)).toEqual([queued[0].id]);

    // outro dia da semana: a rodada agendada dá lugar à do novo dia
    await office.api.put('/api/integrations/serpro', { config: { autoSyncWeekday: '0' } });
    queued = await autoQueued(office.officeId);
    expect(queued).toHaveLength(1);
    expect(weekdayIso(brazilToday(queued[0].runAt))).toBe(0);

    // diária: a próxima madrugada
    await office.api.put('/api/integrations/serpro', { config: { autoSync: 'daily' } });
    queued = await autoQueued(office.officeId);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({ trigger: 'daily' });
    expect(queued[0].runAt.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);

    // desligada: sai da fila
    await office.api.put('/api/integrations/serpro', { config: { autoSync: 'off' } });
    expect(await autoQueued(office.officeId)).toHaveLength(0);
    expect((await office.api.get('/api/robot/overview')).body.nextAutoSync).toBeNull();

    const audits = await env.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.officeId, office.officeId), eq(auditLogs.action, 'integration.update')));
    const changes = audits.map((a) => (a.data as any).autoSync).filter(Boolean);
    expect(changes).toEqual([
      { from: { mode: 'off', weekday: 1 }, to: { mode: 'weekly', weekday: 4 } },
      { from: { mode: 'weekly', weekday: 4 }, to: { mode: 'weekly', weekday: 0 } },
      { from: { mode: 'weekly', weekday: 0 }, to: { mode: 'daily', weekday: 0 } },
      { from: { mode: 'daily', weekday: 0 }, to: { mode: 'off', weekday: 0 } },
    ]);
    // salvar sem mudar a frequência não registra de/para
    expect(audits.filter((a) => (a.data as any).autoSync === undefined).length).toBeGreaterThanOrEqual(2);
  });

  it('roda só quando chega a hora, agenda a da semana seguinte e não repete a rodada da semana', async () => {
    const office = await officeWithSerpro({ autoSync: 'weekly', autoSyncWeekday: '2' });
    const [first] = await autoQueued(office.officeId);
    const day = String(first.payload.day);

    // antes da hora: nada roda
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, first.id) }))!.status).toBe('queued');

    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, first.id));
    await env.ctx.jobs.drain();
    const ran = (await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, first.id) }))!;
    expect(ran.status).toBe('done');
    expect(ran.result).toMatchObject({ total: 0 });
    const [next] = await autoQueued(office.officeId);
    expect(next.payload).toEqual({ trigger: 'weekly', day: addDaysIso(day, 7) });
    expect(next.idempotencyKey).toBe(`weekly:${office.officeId}:${ecacAutoSyncPeriod('weekly', addDaysIso(day, 7))}`);
    await env.ctx.jobs.drain();
    expect((await officeSyncs(office.officeId)).filter((j) => j.status === 'done')).toHaveLength(1);

    // outro worker recalculando a mesma semana (relógio de antes da rodada) cai na chave já usada e vai para a seguinte
    await env.ctx.db.delete(jobs).where(eq(jobs.id, next.id));
    const again = await scheduleEcacAutoSync(env.ctx, office.officeId, { now: new Date(first.runAt.getTime() - 60_000) });
    expect(again!.id).not.toBe(first.id);
    expect(again!.payload).toEqual({ trigger: 'weekly', day: addDaysIso(day, 7) });
    // trocar o dia na mesma semana não faz uma segunda rodada nesta semana
    await env.ctx.db.delete(jobs).where(eq(jobs.id, again!.id));
    await env.ctx.db
      .update(integrations)
      .set({ publicConfig: { contractorCnpj: '11222333000181', autoSync: 'weekly', autoSyncWeekday: String((weekdayIso(day) + 1) % 7) } })
      .where(and(eq(integrations.officeId, office.officeId), eq(integrations.provider, 'serpro')));
    const moved = await scheduleEcacAutoSync(env.ctx, office.officeId, { now: new Date(first.runAt.getTime() - 60_000) });
    expect(ecacAutoSyncPeriod('weekly', String(moved!.payload.day))).not.toBe(ecacAutoSyncPeriod('weekly', day));
  });

  it('a configuração vale na hora de rodar: desligada ou trocada depois do agendamento não sincroniza', async () => {
    const office = await officeWithSerpro({ autoSync: 'daily' });
    const setConfig = (config: Record<string, unknown>) =>
      env.ctx.db
        .update(integrations)
        .set({ publicConfig: { contractorCnpj: '11222333000181', ...config } })
        .where(and(eq(integrations.officeId, office.officeId), eq(integrations.provider, 'serpro')));

    // desligada direto no banco (sem passar pela tela, que já tira da fila)
    let [queued] = await autoQueued(office.officeId);
    await setConfig({ autoSync: 'off' });
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, queued.id));
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, queued.id) }))!.result).toMatchObject({ skipped: true, reason: 'Sincronização automática desligada.' });
    expect(await autoQueued(office.officeId)).toHaveLength(0);

    // diária agendada, mas a configuração virou semanal: não roda e agenda a semanal
    await setConfig({ autoSync: 'daily' });
    [queued] = [(await scheduleEcacAutoSync(env.ctx, office.officeId))!];
    await setConfig({ autoSync: 'weekly', autoSyncWeekday: '5' });
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, queued.id));
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, queued.id) }))!.result).toMatchObject({ skipped: true });
    const [weekly] = await autoQueued(office.officeId);
    expect(weekly.payload.trigger).toBe('weekly');
    expect(weekdayIso(String(weekly.payload.day))).toBe(5);
    // nenhuma sincronização de clientes aconteceu
    expect((await officeSyncs(office.officeId)).some((j) => j.payload.fanout)).toBe(false);
  });

  it('só quem tem integrations.manage muda a frequência, e cada escritório tem a sua', async () => {
    const a = await officeWithSerpro({ autoSync: 'daily' });
    const b = await officeWithSerpro({ autoSync: 'daily' });
    const [bQueued] = await autoQueued(b.officeId);

    const viewer = await createEmployee(env, a.api, ['customer.list', 'settings.view', 'ecac.sync']);
    expect((await viewer.api.put('/api/integrations/serpro', { config: { autoSync: 'off' } })).status).toBe(403);
    expect(await serproConfig(a.api)).toMatchObject({ autoSync: 'daily' });
    expect(await autoQueued(a.officeId)).toHaveLength(1);
    // o "sincronizar agora" não depende da permissão da integração nem da frequência
    expect((await viewer.api.post('/api/robot/sync-office')).status).toBe(202);

    const manager = await createEmployee(env, a.api, ['integrations.manage']);
    expect((await manager.api.put('/api/integrations/serpro', { config: { autoSync: 'weekly', autoSyncWeekday: '3' } })).status).toBe(200);
    expect((await manager.api.put('/api/integrations/serpro', { config: { autoSync: 'monthly' } })).status).toBe(400);
    expect((await autoQueued(a.officeId)).map((j) => j.payload.trigger)).toEqual(['weekly']);

    // o escritório B continua com a diária, sem auditoria da mudança de A
    expect(await serproConfig(b.api)).toMatchObject({ autoSync: 'daily' });
    expect((await autoQueued(b.officeId)).map((j) => j.id)).toEqual([bQueued.id]);
    const bAudits = await env.ctx.db.select().from(auditLogs).where(eq(auditLogs.officeId, b.officeId));
    expect(bAudits.some((x) => (x.data as any)?.autoSync?.to?.mode === 'weekly')).toBe(false);
    const aAudit = await env.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.officeId, a.officeId), eq(auditLogs.userId, manager.userId)));
    expect(aAudit.map((x) => (x.data as any).autoSync)).toContainEqual({ from: { mode: 'daily', weekday: 1 }, to: { mode: 'weekly', weekday: 3 } });
  });
});
