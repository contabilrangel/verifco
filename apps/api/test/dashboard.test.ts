import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IRPFM_THRESHOLD_CENTS } from '@verifco/shared';
import { budgets, customers, integrations, jobs, procurators } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const YEAR = 2026;

describe('dashboard do escritório', () => {
  it('soma indicadores, monta alertas e gráficos do exercício', async () => {
    const { api, officeId } = await registerOffice(env);
    const ids: string[] = [];
    for (const [i, cpf] of VALID_CPFS.slice(0, 5).entries()) ids.push((await api.post('/api/customers', { name: `Cliente ${i + 1}`, cpfCnpj: cpf })).body.id);
    const decl = async (cid: string, body: Record<string, unknown>) => (await api.put(`/api/customers/${cid}/declarations/${YEAR}`, body)).body;

    // 1: transmitida com imposto, saldo negativo e DARF vencido
    const d1 = await decl(ids[0], { taxation: 'complete', taxDueCents: 250_000, transmittedAt: '2026-05-10' });
    await api.post(`/api/declarations/${d1.id}/items`, { kind: 'asset', groupCode: '01', prevValueCents: 0, valueCents: 40_000_000 });
    await api.post(`/api/declarations/${d1.id}/darfs`, { valueCents: 125_000, dueDate: '2020-05-29' });
    // 2: restituição e malha fina
    const d2 = await decl(ids[1], { taxation: 'simplified', refundCents: 80_000, receiptNumber: '1234', ecacStatus: 'fine_mesh' });
    await api.post(`/api/declarations/${d2.id}/items`, { kind: 'asset', groupCode: '04', prevValueCents: 0, valueCents: 1_000_000 });
    await api.post(`/api/declarations/${d2.id}/items`, { kind: 'income_pj', valueCents: 9_000_000 });
    // exatamente R$ 600 mil não sujeita ao IRPFM (art. 16-A: "superior a")
    await api.post(`/api/declarations/${d2.id}/items`, { kind: 'income_exempt', valueCents: IRPFM_THRESHOLD_CENTS - 9_000_000, extra: { nature: 'dividends' } });
    // 3: rendimentos acima do limite do IRPFM, finalizada
    const d3 = await decl(ids[2], { taxation: 'complete' });
    await api.post(`/api/declarations/${d3.id}/items`, { kind: 'income_exempt', valueCents: IRPFM_THRESHOLD_CENTS + 1, extra: { nature: 'dividends' } });
    await api.post(`/api/declarations/${d3.id}/finish`);
    // 4: em preenchimento; 5: inativo sem declaração
    const d4 = await decl(ids[3], {});
    await api.patch(`/api/declarations/${d4.id}/substatus`, { substatus: 'started' });
    // produtor rural com receita alta e resultado baixo: o alerta usa o resultado, não a receita bruta
    await api.post(`/api/declarations/${d4.id}/items`, { kind: 'rural_income', valueCents: 90_000_000 });
    await api.post(`/api/declarations/${d4.id}/items`, { kind: 'rural_expense', valueCents: 80_000_000 });
    await api.post('/api/customers/bulk', { ids: [ids[4]], action: 'status', value: 'inactive' });
    await env.ctx.db.update(customers).set({ procurationStatus: 'valid', cndStatus: 'success' }).where(eq(customers.id, ids[0]));
    await env.ctx.db.insert(budgets).values([
      { officeId, customerId: ids[0], exerciseYear: YEAR, status: 'approved', amountCents: 50_000, totalCents: 50_000 },
      { officeId, customerId: ids[1], exerciseYear: YEAR, status: 'sent', amountCents: 40_000, totalCents: 40_000 },
      { officeId, customerId: ids[1], exerciseYear: 2025, status: 'approved', amountCents: 10_000, totalCents: 10_000 },
    ]);
    await api.post('/api/procurators', { name: 'Ana Procuradora', cpfCnpj: VALID_CPFS[7] });

    const res = await api.get(`/api/dashboard?year=${YEAR}`);
    expect(res.status).toBe(200);
    const { indicators, alerts, charts } = res.body;
    expect(indicators).toMatchObject({ activeCustomers: 4, declarations: 4, transmitted: 3, finished: 1, taxDueCents: 250_000, refundCents: 80_000 });
    const alert = (k: string) => alerts.find((a: any) => a.key === k);
    expect(alert('negative_cash').customers.map((c: any) => c.id)).toEqual([ids[0]]);
    expect(alert('fine_mesh').customers.map((c: any) => c.id)).toEqual([ids[1]]);
    expect(alert('darf_overdue')).toMatchObject({ count: 1, customers: [{ id: ids[0], valueCents: 125_000 }] });
    expect(alert('irpfm').customers.map((c: any) => c.id)).toEqual([ids[2]]);

    const slice = (list: any[], k: string) => list.find((s) => s.key === k);
    expect(slice(charts.stages, 'transmitted').count).toBe(2);
    expect(slice(charts.stages, 'finished').count).toBe(1);
    expect(slice(charts.stages, 'filling').count).toBe(1);
    expect(slice(charts.stages, 'not_started').count).toBe(0); // inativo sem declaração não conta
    expect(slice(charts.taxation, 'complete').count).toBe(2);
    expect(slice(charts.taxation, 'simplified').count).toBe(1);
    expect(slice(charts.taxation, 'none').count).toBe(1);
    expect(slice(charts.ecac, 'fine_mesh').count).toBe(1);
    expect(slice(charts.ecac, 'unknown').count).toBe(2);
    expect(slice(charts.procurations, 'valid').count).toBe(1);
    expect(slice(charts.procurations, 'none').count).toBe(3);
    expect(slice(charts.cnd, 'success').count).toBe(1);
    expect(slice(charts.budgets, 'approved')).toMatchObject({ count: 1, cents: 50_000 });
    expect(slice(charts.budgets, 'sent')).toMatchObject({ count: 1, cents: 40_000 });
    expect(slice(charts.assets, '01')).toMatchObject({ count: 1, cents: 40_000_000 });
    expect(slice(charts.assets, '04').cents).toBe(1_000_000);
    expect(charts.procuratorLogin.total).toBe(1);
    expect(slice(charts.procuratorLogin.byAuthType, 'govbr').count).toBe(1);

    // outro escritório não enxerga nada
    const other = await registerOffice(env);
    const empty = (await other.api.get(`/api/dashboard?year=${YEAR}`)).body;
    expect(empty.indicators).toMatchObject({ activeCustomers: 0, declarations: 0, taxDueCents: 0 });
    expect(empty.alerts.every((a: any) => a.count === 0)).toBe(true);
  });

  // INT-15: o acesso dos procuradores vem de dados reais (certificado e último uso no SERPRO)
  it('situação do acesso dos procuradores pelo certificado e pelo último uso do SERPRO', async () => {
    const { api, officeId } = await registerOffice(env);
    const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
    const proc = async (name: string, cpf: string, body: Record<string, unknown>) =>
      (await api.post('/api/procurators', { name, cpfCnpj: cpf, ...body })).body.id as string;
    await proc('Gov', VALID_CPFS[0], { authType: 'govbr' });
    await proc('Nuvem sem arquivo', VALID_CPFS[1], { authType: 'certificate_cloud' });
    await proc('Vencido', VALID_CPFS[2], { authType: 'certificate_local', certificateExpiresAt: day(-3) });
    await proc('Vencendo', VALID_CPFS[3], { authType: 'certificate_local', certificateExpiresAt: day(10) });
    await proc('No prazo', VALID_CPFS[4], { authType: 'certificate_local', certificateExpiresAt: day(200) });
    const serproId = await proc('Escritório SERPRO', VALID_CPFS[5], { authType: 'certificate_cloud', certificateExpiresAt: day(300) });
    await env.ctx.db.update(procurators).set({ certificateFileId: randomUUID(), certificatePasswordEnc: 'cifrada' }).where(eq(procurators.id, serproId));

    const login = async () => (await api.get(`/api/dashboard?year=${YEAR}`)).body.charts.procuratorLogin;
    const count = (l: any, k: string) => l.byAccess.find((s: any) => s.key === k).count;
    // sem SERPRO configurado, o certificado do escritório conta só pela validade
    let l = await login();
    expect([count(l, 'unverified'), count(l, 'missing'), count(l, 'expired'), count(l, 'expiring'), count(l, 'valid'), count(l, 'serpro_ok')]).toEqual([1, 1, 1, 1, 2, 0]);
    expect(l).toMatchObject({ total: 6, loginOk: 3, loginError: 2, certificatesExpired: 1, unverified: 1, serpro: { state: null } });

    // teste da integração SERPRO autenticou com o certificado
    const [row] = await env.ctx.db
      .insert(integrations)
      .values({ officeId, provider: 'serpro', enabled: true, status: 'connected', publicConfig: { procuratorId: serproId, lastTestAt: new Date(Date.now() - 3600_000).toISOString() } })
      .returning();
    l = await login();
    expect(count(l, 'serpro_ok')).toBe(1);
    expect(l.serpro.state).toBe('ok');

    // sincronização geral posterior que falhou para todos: falha no SERPRO
    await env.ctx.db.insert(jobs).values({ officeId, type: 'ecac.sync_office', status: 'done', result: { total: 3, ok: 0, failed: 3 }, finishedAt: new Date(), payload: {} });
    l = await login();
    expect(count(l, 'serpro_error')).toBe(1);
    expect(l).toMatchObject({ loginError: 3, serpro: { state: 'error' } });
    // integração desativada: volta a valer só a validade do certificado
    await env.ctx.db.update(integrations).set({ enabled: false }).where(eq(integrations.id, row.id));
    expect(count(await login(), 'valid')).toBe(2);
  });

  it('exige permissão', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['budget.list']);
    expect((await emp.api.get(`/api/dashboard?year=${YEAR}`)).status).toBe(403);
  });
});

describe('painel do cliente', () => {
  it('resume caixa, imposto, patrimônio, saúde, educação, dependentes e bens', async () => {
    const { api } = await registerOffice(env);
    const cid = (await api.post('/api/customers', { name: 'Rita Alves', cpfCnpj: VALID_CPFS[0] })).body.id;
    const empty = await api.get(`/api/customers/${cid}/dashboard?year=${YEAR}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ declaration: { exists: false }, cash: null, itemCount: 0 });

    const d = (await api.put(`/api/customers/${cid}/declarations/${YEAR}`, { taxation: 'complete', taxDueCents: 10_000 })).body;
    const add = (body: Record<string, unknown>) => api.post(`/api/declarations/${d.id}/items`, body);
    await add({ kind: 'income_pj', valueCents: 20_000_000, withheldCents: 2_000_000 });
    await add({ kind: 'dependent', ownerName: 'Téo Alves', extra: { relationship: 'child' } });
    await add({ kind: 'payment', valueCents: 300_000, extra: { nature: 'health' } });
    await add({ kind: 'payment', valueCents: 150_000, extra: { nature: 'education' } });
    await add({ kind: 'asset', groupCode: '02', prevValueCents: 5_000_000, valueCents: 4_000_000 });
    await add({ kind: 'asset', groupCode: '06', prevValueCents: 1_000_000, valueCents: 8_000_000 });
    await add({ kind: 'debt', prevValueCents: 0, valueCents: 2_000_000 });
    await api.post(`/api/declarations/${d.id}/backlogs`, { description: 'Informe', dueDate: '2020-01-01' });
    await api.post(`/api/declarations/${d.id}/darfs`, { valueCents: 10_000, dueDate: '2020-05-29' });

    const res = await api.get(`/api/customers/${cid}/dashboard?year=${YEAR}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      health: 300_000,
      education: 150_000,
      dependents: [{ name: 'Téo Alves', relationship: 'child' }],
      netWorth: { assetsPrevCents: 6_000_000, assetsCents: 12_000_000, debtsCents: 2_000_000, variationCents: 4_000_000 },
      backlogs: { open: 1, overdue: 1 },
      darfs: { total: 1, overdue: 1, openCents: 10_000 },
      customer: { procurationStatus: 'none' },
    });
    expect(res.body.assetsByGroup).toEqual([
      { key: '02', label: 'Bens móveis', cents: 4_000_000 },
      { key: '06', label: 'Depósitos à vista e numerário', cents: 8_000_000 },
    ]);
    expect(res.body.cash.balanceCents).toBe(20_000_000 - 2_000_000 + 2_000_000 - 6_000_000 - 450_000);
  });

  it('permissão e isolamento', async () => {
    const office = await registerOffice(env);
    const cid = (await office.api.post('/api/customers', { name: 'Sara', cpfCnpj: VALID_CPFS[1] })).body.id;
    const emp = await createEmployee(env, office.api, ['customer.list']);
    expect((await emp.api.get(`/api/customers/${cid}/dashboard?year=${YEAR}`)).status).toBe(403);
    const other = await registerOffice(env);
    expect((await other.api.get(`/api/customers/${cid}/dashboard?year=${YEAR}`)).status).toBe(404);
  });
});
