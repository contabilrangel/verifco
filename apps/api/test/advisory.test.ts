import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declarationItems } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { R, seedDeclaration } from './advisory-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

async function officeWithCustomer(cpf = VALID_CPFS[0], name = 'Helena Prado') {
  const office = await registerOffice(env);
  const c = await office.api.post('/api/customers', { name, cpfCnpj: cpf, email: 'helena@ex.com' });
  return { ...office, customerId: c.body.id as string };
}

describe('IRPFM', () => {
  it('calcula a partir das linhas da declaração, com exclusões e ajustes', async () => {
    const o = await officeWithCustomer();
    await seedDeclaration(
      env,
      o.officeId,
      o.customerId,
      2027,
      [
        { kind: 'income_pj', description: 'Pró-labore', counterpartyName: 'Prado Ltda', valueCents: R(100_000), withheldCents: R(15_000), extra: { nature: 'salary' } },
        { kind: 'income_exempt', description: 'Lucros', counterpartyName: 'Prado Ltda', counterpartyDoc: '11222333000181', valueCents: R(800_000), extra: { nature: 'dividends' } },
        { kind: 'income_exempt', description: 'LCI', valueCents: R(200_000), extra: { nature: 'financial_exempt' } },
      ],
      { taxDueCents: 0, refundCents: R(1_000) },
    );
    const r = await o.api.get(`/api/customers/${o.customerId}/irpfm?year=2027`);
    expect(r.status).toBe(200);
    expect(r.body.calendarYear).toBe(2026);
    expect(r.body.regularTaxSource).toBe('declaration');
    const res = r.body.result;
    expect(res.inForce).toBe(true);
    expect(res.subject).toBe(true);
    expect(res.totalIncomeCents).toBe(R(1_100_000));
    expect(res.exclusionsCents).toBe(R(200_000));
    expect(res.baseCents).toBe(R(900_000));
    expect(res.ratePercent).toBeCloseTo(5, 8);
    // IR devido = −1.000 (restituição) + 15.000 retido = 14.000 → 45.000 − 14.000
    expect(res.deductions.regularTaxDueCents).toBe(R(14_000));
    expect(res.dueCents).toBe(R(31_000));

    // ajustes: IR informado e alíquota efetiva da PJ para o redutor
    const adj = await o.api.post(`/api/customers/${o.customerId}/irpfm`, {
      year: 2027,
      adjustments: { regularTaxDueCents: R(15_000), dividendPayers: [{ payerDoc: '11222333000181', pjEffectiveRatePercent: 34 }] },
    });
    expect(adj.body.regularTaxSource).toBe('manual');
    expect(adj.body.result.reducer.totalCents).toBe(R(30_000));
    expect(adj.body.result.dueCents).toBe(0);

    const pdf = await o.api.post(`/api/customers/${o.customerId}/irpfm/pdf`, { year: 2027 });
    expect(pdf.status).toBe(200);
    expect(pdf.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('sem declaração devolve cálculo zerado e estimativa', async () => {
    const o = await officeWithCustomer(VALID_CPFS[1]);
    const r = await o.api.get(`/api/customers/${o.customerId}/irpfm?year=2026`);
    expect(r.body.hasDeclaration).toBe(false);
    expect(r.body.result.inForce).toBe(false);
    expect(r.body.result.subject).toBe(false);
    expect(r.body.regularTaxSource).toBe('estimated');
  });

  it('exige irpfm.view e isola escritórios', async () => {
    const o = await officeWithCustomer(VALID_CPFS[2]);
    const emp = await createEmployee(env, o.api, ['customer.list']);
    expect((await emp.api.get(`/api/customers/${o.customerId}/irpfm?year=2027`)).status).toBe(403);
    const other = await registerOffice(env, 'Outro');
    expect((await other.api.get(`/api/customers/${o.customerId}/irpfm?year=2027`)).status).toBe(404);
  });
});

describe('holding', () => {
  it('lista imóveis do grupo 01, salva parâmetros e calcula a comparação', async () => {
    const o = await officeWithCustomer(VALID_CPFS[3]);
    const { items } = await seedDeclaration(env, o.officeId, o.customerId, 2026, [
      { kind: 'asset', groupCode: '01', code: '11', description: 'Apartamento Rua A', valueCents: R(1_000_000), prevValueCents: R(1_000_000) },
      { kind: 'asset', groupCode: '01', code: '13', description: 'Sala comercial', valueCents: R(500_000) },
      { kind: 'asset', groupCode: '04', description: 'CDB', valueCents: R(300_000) },
      { kind: 'income_pj', description: 'Salário', valueCents: R(300_000), extra: { nature: 'salary' } },
      { kind: 'income_pf', description: 'Aluguel', valueCents: R(96_000), extra: { nature: 'rent' } },
    ]);
    const first = await o.api.get(`/api/customers/${o.customerId}/holding?year=2026`);
    expect(first.status).toBe(200);
    expect(first.body.saved).toBe(false);
    expect(first.body.properties).toHaveLength(2);
    expect(first.body.properties.every((p: any) => p.selected)).toBe(true);
    // aluguel não entra nos demais rendimentos
    expect(first.body.otherTaxableIncomeCents).toBe(R(300_000));

    const apt = items.find((i) => i.description === 'Apartamento Rua A')!;
    const saved = await o.api.put(`/api/customers/${o.customerId}/holding`, {
      year: 2026,
      selectedItemIds: [apt.id],
      params: { itbiPercent: 3, registryPercent: 1, itcmdPercent: 4, inventoryFeesPercent: 6, holdingSetupCents: R(5_000), holdingAnnualCostCents: R(6_000) },
      properties: { [apt.id]: { monthlyRentCents: R(8_000), marketValueCents: R(2_000_000) } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.saved).toBe(true);
    const row = Object.fromEntries(saved.body.result.rows.map((x: any) => [x.key, x]));
    expect(row.itbi.holdingCents).toBe(R(60_000));
    expect(row.annual_tax.pfCents).toBe(R(26_400));
    expect(row.ten_years.holdingCents).toBe(R(253_768));
    expect(saved.body.result.totalSavingCents).toBe(R(130_232));

    const again = await o.api.get(`/api/customers/${o.customerId}/holding?year=2026`);
    expect(again.body.properties.find((p: any) => p.id === apt.id)).toMatchObject({ selected: true, monthlyRentCents: R(8_000), marketValueCents: R(2_000_000) });
    expect(again.body.properties.filter((p: any) => p.selected)).toHaveLength(1);

    const bad = await o.api.put(`/api/customers/${o.customerId}/holding`, { year: 2026, selectedItemIds: [items[2].id] });
    expect(bad.status).toBe(400);

    const pdf = await o.api.post(`/api/customers/${o.customerId}/holding/pdf`, { year: 2026 });
    expect(pdf.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('exige holding.view e isola escritórios', async () => {
    const o = await officeWithCustomer(VALID_CPFS[4]);
    const emp = await createEmployee(env, o.api, ['customer.list', 'irpfm.view']);
    expect((await emp.api.get(`/api/customers/${o.customerId}/holding?year=2026`)).status).toBe(403);
    const other = await registerOffice(env);
    expect((await other.api.put(`/api/customers/${o.customerId}/holding`, { year: 2026, selectedItemIds: [] })).status).toBe(404);
  });
});

describe('Radar de oportunidades', () => {
  it('calcula pelo job, mantém o status e remove as que deixam de valer', async () => {
    const o = await officeWithCustomer(VALID_CPFS[5]);
    const b = await o.api.post('/api/customers', { name: 'Bruno Lima', cpfCnpj: VALID_CPFS[6] });
    await o.api.put('/api/office/settings', { highNetWorthBaseCents: R(1_000_000) });
    const { declaration } = await seedDeclaration(env, o.officeId, o.customerId, 2026, [
      { kind: 'asset', groupCode: '01', description: 'Casa', valueCents: R(1_200_000) },
      { kind: 'asset', groupCode: '08', description: 'Bitcoin', valueCents: R(80_000) },
      { kind: 'income_pf', description: 'Consultas', valueCents: R(150_000), extra: { nature: 'other' } },
    ]);
    await seedDeclaration(env, o.officeId, b.body.id, 2026, [{ kind: 'income_exempt', description: 'Dividendos', valueCents: R(700_000), extra: { nature: 'dividends' } }]);

    const refresh = await o.api.post('/api/radar/refresh', { year: 2026 });
    expect(refresh.status).toBe(202);
    expect((await o.api.post('/api/radar/refresh', { year: 2026 })).body.alreadyRunning).toBe(true);
    await env.ctx.jobs.drain();

    const radar = await o.api.get('/api/radar?year=2026');
    const cat = Object.fromEntries(radar.body.categories.map((c: any) => [c.category, c.total]));
    expect(cat).toMatchObject({ high_net_worth: 1, crypto: 1, carne_leao: 1, company_opening: 1, holding: 1, irpfm: 1, rural: 0 });
    expect(radar.body.lastJob.status).toBe('done');

    const list = await o.api.get('/api/radar/opportunities?year=2026&category=crypto');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].customerName).toBe('Helena Prado');
    expect(list.body[0].evidence.summary).toMatch(/criptoativo/);
    const upd = await o.api.put(`/api/radar/opportunities/${list.body[0].id}`, { status: 'in_progress' });
    expect(upd.body.status).toBe('in_progress');

    // cliente vende o bitcoin e encerra o carnê-leão: crypto (em andamento) fica; carnê-leão (aberto) sai
    await env.ctx.db.delete(declarationItems).where(eq(declarationItems.declarationId, declaration.id));
    await o.api.post('/api/radar/refresh', { year: 2026 });
    await env.ctx.jobs.drain();
    const after = await o.api.get('/api/radar/opportunities?year=2026');
    const cats = after.body.filter((x: any) => x.customerId === o.customerId).map((x: any) => x.category);
    expect(cats).toEqual(['crypto']);
    expect(after.body.find((x: any) => x.category === 'crypto').status).toBe('in_progress');
  });

  it('exige radar.view e isola escritórios', async () => {
    const o = await officeWithCustomer(VALID_CPFS[7]);
    await seedDeclaration(env, o.officeId, o.customerId, 2026, [{ kind: 'asset', groupCode: '08', description: 'ETH', valueCents: R(10_000) }]);
    await o.api.post('/api/radar/refresh', { year: 2026 });
    await env.ctx.jobs.drain();
    const mine = await o.api.get('/api/radar/opportunities?year=2026');
    expect(mine.body).toHaveLength(1);

    const emp = await createEmployee(env, o.api, ['customer.list']);
    expect((await emp.api.get('/api/radar?year=2026')).status).toBe(403);
    const other = await registerOffice(env);
    expect((await other.api.get('/api/radar/opportunities?year=2026')).body).toHaveLength(0);
    expect((await other.api.put(`/api/radar/opportunities/${mine.body[0].id}`, { status: 'done' })).status).toBe(404);
  });
});
