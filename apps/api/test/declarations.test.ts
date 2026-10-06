import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const YEAR = 2026;

async function newCustomer(api: Api, cpf = VALID_CPFS[0], name = 'Maria Souza') {
  const res = await api.post('/api/customers', { name, cpfCnpj: cpf, email: `${cpf}@ex.com` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function ensureDeclaration(api: Api, customerId: string, body: Record<string, unknown> = {}) {
  const res = await api.put(`/api/customers/${customerId}/declarations/${YEAR}`, body);
  expect(res.status).toBe(200);
  return res.body;
}

describe('declaração do exercício', () => {
  it('devolve "não iniciada" sem criar e cria ao salvar o resumo', async () => {
    const { api } = await registerOffice(env);
    const cid = await newCustomer(api);
    const empty = await api.get(`/api/customers/${cid}/declarations/${YEAR}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ id: null, exists: false, stage: 'not_started', substatus: 'not_started' });
    expect((await api.get(`/api/customers/${cid}/declarations/${YEAR}`)).body.id).toBeNull();

    const saved = await ensureDeclaration(api, cid, { taxation: 'complete', taxDueCents: 123_456, refundCents: 0, isRectification: true });
    expect(saved).toMatchObject({ exists: true, taxation: 'complete', taxDueCents: 123_456, isRectification: true, stage: 'not_started' });
    const again = await api.get(`/api/customers/${cid}/declarations/${YEAR}`);
    expect(again.body.id).toBe(saved.id);

    expect((await api.put(`/api/customers/${cid}/declarations/${YEAR}`, { taxDueCents: -1 })).status).toBe(400);
    expect((await api.put(`/api/customers/${cid}/declarations/${YEAR}`, { ecacStatus: 'qualquer' })).status).toBe(400);
  });

  it('informar a transmissão leva para "Transmitida" e a situação eCAC acompanha', async () => {
    const { api } = await registerOffice(env);
    const cid = await newCustomer(api);
    const d = await ensureDeclaration(api, cid);
    await api.patch(`/api/declarations/${d.id}/substatus`, { substatus: 'elaboration' });
    const t = await ensureDeclaration(api, cid, { receiptNumber: '12.34.56.78.90-12', transmittedAt: '2026-05-20' });
    expect(t).toMatchObject({ stage: 'transmitted', substatus: 'ecac_unknown' });
    expect(t.transmittedAt.slice(0, 10)).toBe('2026-05-20');
    const fm = await ensureDeclaration(api, cid, { ecacStatus: 'fine_mesh' });
    expect(fm).toMatchObject({ stage: 'transmitted', substatus: 'ecac_fine_mesh' });
    // e o caminho inverso: mudar o subestado ajusta a situação eCAC
    const back = await api.patch(`/api/declarations/${d.id}/substatus`, { substatus: 'ecac_refund' });
    expect(back.body).toMatchObject({ substatus: 'ecac_refund', ecacStatus: 'refund_lot' });
  });

  it('finalização exige permissão própria e não repete', async () => {
    const office = await registerOffice(env);
    const cid = await newCustomer(office.api);
    const d = await ensureDeclaration(office.api, cid);
    const editor = await createEmployee(env, office.api, ['customer.list', 'declaration.view', 'declaration.edit']);
    expect((await editor.api.patch(`/api/declarations/${d.id}/substatus`, { substatus: 'review' })).body.stage).toBe('filling');
    expect((await editor.api.patch(`/api/declarations/${d.id}/substatus`, { substatus: 'finished' })).status).toBe(403);
    expect((await editor.api.post(`/api/declarations/${d.id}/finish`)).status).toBe(403);
    const viewer = await createEmployee(env, office.api, ['declaration.view']);
    expect((await viewer.api.patch(`/api/declarations/${d.id}/substatus`, { substatus: 'review' })).status).toBe(403);
    expect((await viewer.api.put(`/api/customers/${cid}/declarations/${YEAR}`, { taxDueCents: 1 })).status).toBe(403);

    const fin = await office.api.post(`/api/declarations/${d.id}/finish`);
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ stage: 'finished', substatus: 'finished' });
    expect(fin.body.finishedAt).toBeTruthy();
    expect((await office.api.post(`/api/declarations/${d.id}/finish`)).status).toBe(409);
  });
});

describe('linhas da DIRPF e análise de caixa', () => {
  it('cadastra, valida, recalcula os totais e o saldo de caixa', async () => {
    const { api } = await registerOffice(env);
    const cid = await newCustomer(api);
    const d = await ensureDeclaration(api, cid, { taxation: 'complete' });
    const base = `/api/declarations/${d.id}/items`;

    expect((await api.post(base, { kind: 'dependent' })).status).toBe(400); // sem nome
    expect((await api.post(base, { kind: 'dependent', ownerName: 'Lia', ownerCpf: '123.456.789-00' })).status).toBe(400);
    expect((await api.post(base, { kind: 'asset', groupCode: '42', valueCents: 1 })).status).toBe(400);
    expect((await api.post(base, { kind: 'payment', valueCents: 100, extra: { nature: 'viagem' } })).status).toBe(400);
    expect((await api.post(base, { kind: 'inexistente' })).status).toBe(400);

    const dep = await api.post(base, { kind: 'dependent', ownerName: 'Lia Souza', ownerCpf: VALID_CPFS[1], extra: { relationship: 'child', birthDate: '2015-03-02' } });
    expect(dep.status).toBe(201);
    expect(dep.body.item.ownerCpf).toBe(VALID_CPFS[1]);
    const salary = await api.post(base, {
      kind: 'income_pj',
      counterpartyName: 'Empresa X',
      counterpartyDoc: '11.222.333/0001-81',
      valueCents: 12_000_000,
      withheldCents: 1_500_000,
      extra: { officialPensionCents: 900_000 },
    });
    expect(salary.body.declaration.taxableIncomeCents).toBe(12_000_000);
    await api.post(base, { kind: 'income_exempt', valueCents: 500_000, extra: { nature: 'dividends' } });
    await api.post(base, { kind: 'payment', valueCents: 800_000, counterpartyName: 'Clínica', extra: { nature: 'health', reimbursedCents: 100_000 } });
    const house = await api.post(base, { kind: 'asset', groupCode: '01', description: 'Apartamento', prevValueCents: 30_000_000, valueCents: 50_000_000 });
    expect(house.body.declaration.assetsTotalCents).toBe(50_000_000);
    expect(house.body.declaration.deductionsCents).toBe(700_000);

    // recursos 12.000.000 - 1.500.000 - 900.000 + 500.000 = 10.100.000
    // aplicações 20.000.000 (aumento de bens) + 700.000 (pagamentos) = 20.700.000
    const cash = await api.get(`/api/declarations/${d.id}/cash-analysis`);
    expect(cash.status).toBe(200);
    expect(cash.body.totalSourcesCents).toBe(10_100_000);
    expect(cash.body.totalUsesCents).toBe(20_700_000);
    expect(cash.body.balanceCents).toBe(-10_600_000);
    expect(cash.body.status).toBe('negative');
    const stored = await api.get(`/api/customers/${cid}/declarations/${YEAR}`);
    expect(stored.body.cashBalanceCents).toBe(-10_600_000);

    // editar a linha do bem recalcula o saldo gravado
    const upd = await api.put(`${base}/${house.body.item.id}`, { kind: 'asset', groupCode: '01', description: 'Apartamento', prevValueCents: 30_000_000, valueCents: 31_000_000 });
    expect(upd.status).toBe(200);
    expect(upd.body.declaration.cashBalanceCents).toBe(10_100_000 - 1_000_000 - 700_000);

    const list = await api.get(base);
    expect(list.body).toHaveLength(5);
    expect((await api.del(`${base}/${dep.body.item.id}`)).status).toBe(200);
    expect((await api.get(base)).body).toHaveLength(4);
    expect((await api.del(`${base}/${dep.body.item.id}`)).status).toBe(404);
  });

  it('usa outros gastos e a preferência da tributação simplificada', async () => {
    const { api } = await registerOffice(env);
    const cid = await newCustomer(api);
    const d = await ensureDeclaration(api, cid, { taxation: 'simplified', otherExpenses: { creditCardCents: 200_000 } });
    await api.post(`/api/declarations/${d.id}/items`, { kind: 'income_pj', valueCents: 5_000_000 });
    const standard = (await api.get(`/api/declarations/${d.id}/cash-analysis`)).body;
    expect(standard.uses.find((u: any) => u.key === 'living').cents).toBe(1_000_000); // 20% como gasto estimado
    expect(standard.uses.find((u: any) => u.key === 'other').cents).toBe(200_000);
    await api.put('/api/office/settings', { cashAnalysisSimplifiedDiscount: 'proportional' });
    const proportional = (await api.get(`/api/declarations/${d.id}/cash-analysis`)).body;
    expect(proportional.uses.find((u: any) => u.key === 'living').cents).toBe(0);
    expect(proportional.balanceCents).toBe(5_000_000 - 200_000);
  });
});

describe('kanban', () => {
  it('agrupa por etapa, inclui clientes sem declaração e filtra', async () => {
    const { api } = await registerOffice(env);
    const g = await api.post('/api/customer-groups', { name: 'Família Souza' });
    const ids: string[] = [];
    for (const [i, cpf] of VALID_CPFS.slice(0, 6).entries()) ids.push(await newCustomer(api, cpf, `Cliente ${String.fromCharCode(65 + i)}`));
    await api.put(`/api/customers/${ids[0]}/identification`, { name: 'Cliente A', groupIds: [g.body.id] });
    const d1 = await ensureDeclaration(api, ids[0]);
    await api.patch(`/api/declarations/${d1.id}/substatus`, { substatus: 'elaboration' });
    const d2 = await ensureDeclaration(api, ids[1]);
    await api.patch(`/api/declarations/${d2.id}/substatus`, { substatus: 'budget_sent' });
    await api.post(`/api/declarations/${d1.id}/backlogs`, { description: 'Informe do banco' });
    // inativo sem declaração não aparece
    await api.post('/api/customers/bulk', { ids: [ids[5]], action: 'status', value: 'inactive' });

    const k = await api.get(`/api/kanban?year=${YEAR}`);
    expect(k.status).toBe(200);
    const col = (s: string) => k.body.columns.find((c: any) => c.stage === s);
    expect(k.body.columns.map((c: any) => c.stage)).toEqual(['not_started', 'negotiation', 'filling', 'transmitted', 'finished']);
    expect(col('not_started').total).toBe(3);
    expect(col('negotiation').cards[0]).toMatchObject({ customerId: ids[1], substatus: 'budget_sent' });
    const filling = col('filling').cards[0];
    expect(filling).toMatchObject({ customerId: ids[0], substatus: 'missing_documents', openBacklogs: 1 });
    expect(filling.groups[0].name).toBe('Família Souza');
    expect(k.body.total).toBe(5);

    expect((await api.get(`/api/kanban?year=${YEAR}&groups=${g.body.id}`)).body.total).toBe(1);
    expect((await api.get(`/api/kanban?year=${YEAR}&groups=none`)).body.total).toBe(4);
    expect((await api.get(`/api/kanban?year=${YEAR}&search=cliente b`)).body.total).toBe(1);
    expect((await api.get(`/api/kanban?year=${YEAR}&search=${VALID_CPFS[2].slice(0, 6)}`)).body.total).toBe(1);
    // outro ano: todos não iniciados
    expect((await api.get(`/api/kanban?year=2025`)).body.columns[0].total).toBe(5);

    // paginação por coluna
    const first = await api.get(`/api/kanban?year=${YEAR}&stageLimit=2`);
    expect(first.body.columns[0].cards).toHaveLength(2);
    const more = await api.get(`/api/kanban?year=${YEAR}&stageLimit=2&stage=not_started&offset=2`);
    expect(more.body.columns).toHaveLength(1);
    expect(more.body.columns[0].cards).toHaveLength(1);
    expect(more.body.columns[0].cards[0].name).toBe('Cliente E');
  });

  it('exige permissão de visualização', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['customer.list']);
    expect((await emp.api.get(`/api/kanban?year=${YEAR}`)).status).toBe(403);
  });
});

describe('isolamento', () => {
  it('outro escritório recebe 404 e não vê os cartões', async () => {
    const a = await registerOffice(env, 'Escritório A');
    const b = await registerOffice(env, 'Escritório B');
    const cid = await newCustomer(a.api);
    const d = await ensureDeclaration(a.api, cid);
    const item = await a.api.post(`/api/declarations/${d.id}/items`, { kind: 'income_pj', valueCents: 100 });

    expect((await b.api.get(`/api/customers/${cid}/declarations/${YEAR}`)).status).toBe(404);
    expect((await b.api.put(`/api/customers/${cid}/declarations/${YEAR}`, {})).status).toBe(404);
    expect((await b.api.patch(`/api/declarations/${d.id}/substatus`, { substatus: 'review' })).status).toBe(404);
    expect((await b.api.post(`/api/declarations/${d.id}/finish`)).status).toBe(404);
    expect((await b.api.get(`/api/declarations/${d.id}/items`)).status).toBe(404);
    expect((await b.api.post(`/api/declarations/${d.id}/items`, { kind: 'income_pj', valueCents: 1 })).status).toBe(404);
    expect((await b.api.del(`/api/declarations/${d.id}/items/${item.body.item.id}`)).status).toBe(404);
    expect((await b.api.get(`/api/declarations/${d.id}/cash-analysis`)).status).toBe(404);
    expect((await b.api.get(`/api/kanban?year=${YEAR}`)).body.total).toBe(0);
  });

  it('respeita a restrição de clientes por responsável', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['customer.list', 'declaration.view', 'declaration.edit']);
    const other = await newCustomer(office.api, VALID_CPFS[3], 'Do dono');
    const d = await ensureDeclaration(office.api, other);
    await office.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    expect((await emp.api.get(`/api/declarations/${d.id}/items`)).status).toBe(404);
    expect((await emp.api.get(`/api/kanban?year=${YEAR}`)).body.total).toBe(0);
  });
});
