import { and, eq } from 'drizzle-orm';
import { addDaysIso, currentExerciseYear, todayIso } from '@verifco/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contracts, customers, declarations, jobs } from '../src/db/schema';
import { createDeliveryBatch } from '../src/services/delivery';
import { createEmployee, createTestEnv, registerOffice, VALID_CPFS, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv(); });
afterAll(async () => { await env.close(); });

describe('integração dos lotes da onda 2', () => {
  it('o plano vencido permite revogar, mas não editar ou cadastrar credenciais (F1)', async () => {
    const office = await registerOffice(env);
    const employee = await createEmployee(env, office.api, ['customer.list']);
    const person = (await office.api.get('/api/employees')).body.find((e: any) => e.id === employee.userId);
    const c = await office.api.post('/api/customers', { name: 'Cliente', cpfCnpj: VALID_CPFS[0] });
    const credentials = `/api/customers/${c.body.id}/credentials`;
    expect((await office.api.put(credentials, { ecacLogin: 'login', ecacPassword: 'senha-original' })).status).toBe(200);
    const yesterday = addDaysIso(todayIso(), -1);
    await env.ctx.db.update(contracts).set({ startsAt: addDaysIso(yesterday, -30), expiresAt: yesterday }).where(eq(contracts.officeId, office.officeId));
    expect((await office.api.put(credentials, { ecacPassword: 'nova-senha' })).status).toBe(403);
    expect((await office.api.put(credentials, { ecacLogin: null, ecacPassword: null })).status).toBe(200);
    const body = { name: person.name, email: person.email, roleId: person.roleId, isActive: false };
    expect((await office.api.put(`/api/employees/${employee.userId}`, { ...body, name: 'Novo nome' })).status).toBe(403);
    expect((await office.api.put(`/api/employees/${employee.userId}`, body)).status).toBe(200);
    expect((await office.api.put(`/api/employees/${employee.userId}`, { ...body, isActive: true })).status).toBe(403);
  });

  it('o status em massa respeita a quota inteira e não grava parte do lote (C + F1)', async () => {
    const office = await registerOffice(env);
    const year = currentExerciseYear();
    await env.ctx.db.update(contracts).set({ declarationLimit: 1 }).where(eq(contracts.officeId, office.officeId));
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await office.api.post('/api/customers', { name: `Cliente ${i}`, cpfCnpj: VALID_CPFS[i] });
      ids.push(c.body.id);
    }
    const bulk = () => office.api.post('/api/customers/bulk', { ids, action: 'substatus', value: 'started', year });
    expect((await bulk()).status).toBe(409);
    expect(await env.ctx.db.select().from(declarations).where(eq(declarations.officeId, office.officeId))).toHaveLength(0);
    expect((await office.api.put(`/api/customers/${ids[0]}/declarations/${year}`, {})).status).toBe(200);
    expect((await bulk()).status).toBe(409);
    const rows = await env.ctx.db.select().from(declarations).where(eq(declarations.officeId, office.officeId));
    expect(rows).toHaveLength(1);
    expect(rows[0].substatus).toBe('not_started');
    expect((await office.api.post('/api/customers/bulk', { ids: [ids[0]], action: 'substatus', value: 'started', year })).status).toBe(200);
  });

  it('criações concorrentes não passam da quota (C + F1)', async () => {
    const office = await registerOffice(env);
    const year = currentExerciseYear();
    await env.ctx.db.update(contracts).set({ declarationLimit: 1 }).where(eq(contracts.officeId, office.officeId));
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await office.api.post('/api/customers', { name: `Concorrente ${i}`, cpfCnpj: VALID_CPFS[i] })).body.id);
    const results = await Promise.all(ids.map((id) => office.api.put(`/api/customers/${id}/declarations/${year}`, {})));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await env.ctx.db.select().from(declarations).where(eq(declarations.officeId, office.officeId))).toHaveLength(1);
  });

  it('a mala direta preserva as políticas da fila e as variáveis cifradas do WhatsApp (A + D + E)', async () => {
    const office = await registerOffice(env);
    const [customer] = await env.ctx.db.insert(customers).values({ officeId: office.officeId, name: 'Cliente WhatsApp', cpfCnpj: VALID_CPFS[0], mobile: '11999998888' }).returning();
    const batch = await createDeliveryBatch(env.ctx, { officeId: office.officeId, templateKey: 'checklist_digital', customers: [customer], userId: office.userId });
    const code = '123456';
    const link = 'https://app.exemplo.com/checklist/token-secreto';
    expect(await batch.queue([{ customer, channel: 'whatsapp', values: { CODIGO: code, LINK: link }, redact: [code, link], idempotencyKey: 'convite-teste' }])).toMatchObject({ queued: 1 });
    const job = await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.officeId, office.officeId), eq(jobs.type, 'delivery.send')) });
    expect(job).toMatchObject({ priority: 10, maxAttempts: 5 });
    expect(JSON.stringify(job!.payload)).not.toContain(code);
    const content = JSON.parse(env.ctx.secrets.decrypt(job!.payload.sealed as string));
    expect(content.values).toMatchObject({ CLIENTE: customer.name, CODIGO: code, LINK: link });
    const delivery = await env.ctx.db.query.deliveries.findFirst({ where: (d, { eq }) => eq(d.id, job!.payload.deliveryId as string) });
    expect(delivery!.body).not.toContain(code);
    expect(delivery!.body).not.toContain(link);
    await env.ctx.jobs.drain();
    expect(env.providers.sentWhatsApp.find((w) => w.customerId === customer.id)).toMatchObject({ values: expect.objectContaining({ CODIGO: code, LINK: link }) });
    const after = await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, job!.id) });
    expect(after!.payload).not.toHaveProperty('sealed');
  });
});
