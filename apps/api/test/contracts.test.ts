/**
 * Limite e validade do contrato (COB-12): a criação de declarações acima do limite do pacote, ou sem
 * pacote vigente, é recusada com mensagem clara; a aba Contratos mostra o uso.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { contracts, customers } from '../src/db/schema';
import { assertContractAllowsDeclaration } from '../src/services/declarations';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const year = new Date().getFullYear();
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function officeWith(limit: number | null) {
  const o = await registerOffice(env);
  // o cadastro cria o contrato de avaliação (30 declarações, exercício do ano corrente)
  const [trial] = await env.ctx.db.select().from(contracts).where(eq(contracts.officeId, o.officeId));
  expect(trial).toMatchObject({ plan: 'trial', declarationLimit: 30, year });
  await env.ctx.db.update(contracts).set({ declarationLimit: limit }).where(eq(contracts.id, trial.id));
  const ids: string[] = [];
  for (const cpf of VALID_CPFS.slice(0, 4)) ids.push((await o.api.post('/api/customers', { name: `Cliente ${cpf}`, cpfCnpj: cpf })).body.id);
  return { ...o, contractId: trial.id, ids };
}

const createDecl = (o: Awaited<ReturnType<typeof officeWith>>, customerId: string, y = year) => o.api.put(`/api/customers/${customerId}/declarations/${y}`, { notes: 'x' });

describe('limite de declarações do contrato', () => {
  it('bloqueia a criação acima do limite do exercício, com mensagem clara, e mostra o uso', async () => {
    const o = await officeWith(2);
    expect((await createDecl(o, o.ids[0])).status).toBe(200);
    expect((await createDecl(o, o.ids[1])).status).toBe(200);
    const blocked = await createDecl(o, o.ids[2]);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error ?? blocked.body.message).toMatch(new RegExp(`Limite do contrato atingido: o escritório já tem 2 declaração\\(ões\\) do exercício ${year}, o máximo do pacote \\(2\\)`));
    // as declarações já criadas continuam editáveis
    expect((await createDecl(o, o.ids[0])).status).toBe(200);
    // outro exercício (ex.: retificar o anterior) não consome o pacote
    expect((await createDecl(o, o.ids[2], year - 1)).status).toBe(200);

    const status = await o.api.get('/api/office/contracts/status');
    expect(status.body).toMatchObject({ hasContracts: true, blocked: false, quotas: [{ year, limit: 2, used: 2, remaining: 0 }] });

    // cliente excluído libera a vaga
    await env.ctx.db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, o.ids[1]));
    expect((await createDecl(o, o.ids[2])).status).toBe(200);

    // outros caminhos que criam a declaração também respeitam o limite (checklist)
    const viaChecklist = await o.api.post(`/api/customers/${o.ids[3]}/checklist`, { year });
    expect(viaChecklist.status).toBe(409);
  });

  it('limite nulo é ilimitado; pacotes vigentes do mesmo exercício somam', async () => {
    const o = await officeWith(null);
    for (const id of o.ids.slice(0, 3)) expect((await createDecl(o, id)).status).toBe(200);
    expect((await o.api.get('/api/office/contracts/status')).body.quotas).toEqual([{ year, limit: null, used: 3, remaining: null }]);

    const p = await officeWith(1);
    await env.ctx.db.insert(contracts).values({ officeId: p.officeId, name: 'Pacote extra', plan: 'basic', declarationLimit: 1, year, startsAt: iso(new Date(Date.now() - 86_400_000)), expiresAt: iso(new Date(Date.now() + 86_400_000)) });
    expect((await createDecl(p, p.ids[0])).status).toBe(200);
    expect((await createDecl(p, p.ids[1])).status).toBe(200);
    expect((await createDecl(p, p.ids[2])).status).toBe(409);
  });

  it('contrato vencido, cancelado ou ainda não iniciado bloqueia novas declarações', async () => {
    const o = await officeWith(30);
    await createDecl(o, o.ids[0]);
    await env.ctx.db.update(contracts).set({ expiresAt: '2026-01-31', startsAt: '2026-01-01' }).where(eq(contracts.id, o.contractId));
    const expired = await createDecl(o, o.ids[1]);
    expect(expired.status).toBe(409);
    expect(expired.body.error ?? expired.body.message).toMatch(/O contrato do escritório venceu em 31\/01\/2026\. Para criar novas declarações, renove o pacote/);
    expect((await o.api.get('/api/office/contracts/status')).body).toMatchObject({ blocked: true, lastExpiresAt: '2026-01-31' });
    // a declaração já existente continua acessível
    expect((await createDecl(o, o.ids[0])).status).toBe(200);

    await env.ctx.db.update(contracts).set({ startsAt: iso(new Date(Date.now() + 5 * 86_400_000)), expiresAt: '2099-12-31' }).where(eq(contracts.id, o.contractId));
    expect((await createDecl(o, o.ids[1])).body.error ?? '').toMatch(/O pacote do escritório começa em/);
    await env.ctx.db.update(contracts).set({ startsAt: '2026-01-01', status: 'canceled' }).where(eq(contracts.id, o.contractId));
    expect((await createDecl(o, o.ids[1])).status).toBe(409);
  });

  it('escritório sem contrato registrado não é limitado; a situação exige contracts.view', async () => {
    const o = await officeWith(1);
    await env.ctx.db.delete(contracts).where(eq(contracts.officeId, o.officeId));
    await expect(assertContractAllowsDeclaration(env.ctx.db, o.officeId, year)).resolves.toBeUndefined();
    for (const id of o.ids.slice(0, 2)) expect((await createDecl(o, id)).status).toBe(200);
    expect((await o.api.get('/api/office/contracts/status')).body).toMatchObject({ hasContracts: false, quotas: [] });
    const emp = await createEmployee(env, o.api, ['customer.list']);
    expect((await emp.api.get('/api/office/contracts/status')).status).toBe(403);
  });
});
