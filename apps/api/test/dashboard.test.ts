import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DASHBOARD_PERMISSIONS, IRPFM_THRESHOLD_CENTS, addDaysIso, todayIso } from '@verifco/shared';
import { budgets, customers, integrations, procurators } from '../src/db/schema';
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

  // INT-15 detalhado: situação do acesso de cada procurador pelo certificado e pelo último login no SERPRO
  describe('acesso dos procuradores', () => {
    const day = (offset: number) => addDaysIso(todayIso(), offset);
    type Office = Awaited<ReturnType<typeof registerOffice>>;
    const proc = async (o: Office, name: string, cpf: string, body: Record<string, unknown>) => {
      const res = await o.api.post('/api/procurators', { name, cpfCnpj: cpf, ...body });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const withCertificate = (id: string, extra: Partial<typeof procurators.$inferInsert> = {}) =>
      env.ctx.db.update(procurators).set({ certificateFileId: randomUUID(), certificatePasswordEnc: 'senha-cifrada', ...extra }).where(eq(procurators.id, id));
    const dashboard = async (o: { api: Office['api'] }) => {
      const res = await o.api.get(`/api/dashboard?year=${YEAR}`);
      expect(res.status).toBe(200);
      return res.body;
    };
    const byName = (body: any) => Object.fromEntries(body.procuratorAccess.items.map((i: any) => [i.name, i]));

    it('classifica cada procurador e agrupa por gravidade, sem documento nem segredo', async () => {
      const o = await registerOffice(env);
      const ids = {
        gov: await proc(o, 'Gov Br', VALID_CPFS[0], { authType: 'govbr' }),
        missing: await proc(o, 'Nuvem sem arquivo', VALID_CPFS[1], { authType: 'certificate_cloud', certificateExpiresAt: day(200) }),
        expired: await proc(o, 'Vencido', VALID_CPFS[2], { authType: 'certificate_local', certificateExpiresAt: day(-1) }),
        expiring: await proc(o, 'Vencendo', VALID_CPFS[3], { authType: 'certificate_local', certificateExpiresAt: day(30) }),
        valid: await proc(o, 'No prazo', VALID_CPFS[4], { authType: 'certificate_local', certificateExpiresAt: day(31) }),
        serproOk: await proc(o, 'SERPRO ok', VALID_CPFS[5], { authType: 'certificate_cloud', certificateExpiresAt: day(300) }),
        serproError: await proc(o, 'SERPRO falhou', VALID_CPFS[6], { authType: 'certificate_cloud', certificateExpiresAt: day(300) }),
        noExpiry: await proc(o, 'Sem validade', VALID_CPFS[7], { authType: 'certificate_local' }),
      };
      const usedAt = new Date(Date.now() - 3600_000);
      await withCertificate(ids.serproOk, { loginStatus: 'ok', lastValidatedAt: usedAt });
      await withCertificate(ids.serproError, { loginStatus: 'error', lastValidatedAt: usedAt });
      await env.ctx.db.insert(integrations).values({ officeId: o.officeId, provider: 'serpro', enabled: true, status: 'connected', publicConfig: { procuratorId: ids.serproError } });
      // clientes ativos atendidos (o inativo não conta)
      for (const [i, cpf] of VALID_CPFS.slice(0, 3).entries()) {
        const c = (await o.api.post('/api/customers', { name: `Cliente ${i}`, cpfCnpj: cpf })).body.id;
        await env.ctx.db.update(customers).set({ procuratorId: ids.expired, status: i === 2 ? 'inactive' : 'active' }).where(eq(customers.id, c));
      }

      const body = await dashboard(o);
      const items = byName(body);
      expect(Object.keys(items)).toEqual(['Nuvem sem arquivo', 'SERPRO falhou', 'Vencido', 'Vencendo', 'Gov Br', 'Sem validade']);
      expect(items['Vencido']).toMatchObject({ access: 'certificate_expired', severity: 'danger', label: 'Certificado vencido', certificateExpiresAt: day(-1), daysLeft: -1, customers: 2 });
      expect(items['Nuvem sem arquivo']).toMatchObject({ access: 'certificate_missing', severity: 'danger', label: 'Certificado não enviado' });
      expect(items['Vencendo']).toMatchObject({ access: 'certificate_expiring', severity: 'warning', label: 'Certificado vence em até 30 dias', daysLeft: 30 });
      expect(items['SERPRO falhou']).toMatchObject({
        access: 'serpro_error',
        severity: 'danger',
        serpro: { status: 'error', at: usedAt.toISOString(), usesThisCertificate: true },
      });
      expect(items['Gov Br']).toMatchObject({ access: 'govbr_unverified', severity: 'info', label: 'Login gov.br sem verificação', certificateExpiresAt: null, serpro: { status: null, at: null } });
      expect(items['Sem validade']).toMatchObject({ access: 'expiry_unknown', severity: 'info' });
      expect(body.procuratorAccess).toMatchObject({ warningDays: 30, total: 8, count: 6, counts: { danger: 3, warning: 1, info: 2, ok: 2 } });

      const slice = (k: string) => body.charts.procuratorLogin.byAccess.find((s: any) => s.key === k).count;
      expect([slice('serpro_ok'), slice('valid'), slice('certificate_expired')]).toEqual([1, 1, 1]);
      expect(body.charts.procuratorLogin.total).toBe(8);

      // o login bem-sucedido aparece como último uso do SERPRO, e o procurador fica fora dos alertas
      expect(items['SERPRO ok']).toBeUndefined();
      // nada de CPF/CNPJ, arquivo ou senha do certificado no payload
      const raw = JSON.stringify(body.procuratorAccess) + JSON.stringify(body.charts.procuratorLogin);
      for (const cpf of VALID_CPFS) expect(raw).not.toContain(cpf);
      expect(raw).not.toMatch(/cpfCnpj|certificateFileId|certificatePassword|senha-cifrada|userId/);

      // outro escritório não enxerga os procuradores
      const other = await dashboard(await registerOffice(env));
      expect(other.procuratorAccess).toMatchObject({ total: 0, count: 0, items: [] });
      expect(other.charts.procuratorLogin.total).toBe(0);
    });

    it('contador restrito aos próprios clientes vê só os procuradores que o afetam', async () => {
      const o = await registerOffice(env);
      const emp = await createEmployee(env, o.api, ['declaration.view']);
      const mineCustomer = (await o.api.post('/api/customers', { name: 'Cliente do contador', cpfCnpj: VALID_CPFS[0] })).body.id;
      const otherCustomer = (await o.api.post('/api/customers', { name: 'Cliente de outro', cpfCnpj: VALID_CPFS[1] })).body.id;
      const ofMine = await proc(o, 'Dos meus clientes', VALID_CPFS[2], { authType: 'certificate_local', certificateExpiresAt: day(-5) });
      const ofOther = await proc(o, 'De outro contador', VALID_CPFS[3], { authType: 'certificate_local', certificateExpiresAt: day(-5) });
      const serpro = await proc(o, 'Certificado do SERPRO', VALID_CPFS[4], { authType: 'certificate_cloud', certificateExpiresAt: day(10) });
      await proc(o, 'Eu mesmo', VALID_CPFS[5], { authType: 'govbr', userId: emp.userId });
      await withCertificate(serpro);
      await env.ctx.db.insert(integrations).values({ officeId: o.officeId, provider: 'serpro', enabled: true, status: 'connected', publicConfig: { procuratorId: serpro } });
      await env.ctx.db.update(customers).set({ procuratorId: ofMine, responsibleUserId: emp.userId }).where(eq(customers.id, mineCustomer));
      await env.ctx.db.update(customers).set({ procuratorId: ofOther }).where(eq(customers.id, otherCustomer));

      // sem restrição, o colaborador vê todos
      expect(Object.keys(byName(await dashboard(emp)))).toHaveLength(4);

      await o.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
      const body = await dashboard(emp);
      const items = byName(body);
      expect(Object.keys(items).sort()).toEqual(['Certificado do SERPRO', 'Dos meus clientes', 'Eu mesmo']);
      expect(items['Dos meus clientes']).toMatchObject({ customers: 1, mine: false });
      expect(items['Eu mesmo']).toMatchObject({ mine: true, customers: 0 });
      expect(items['Certificado do SERPRO']).toMatchObject({ access: 'certificate_expiring', serpro: { usesThisCertificate: true } });
      expect(body.procuratorAccess.total).toBe(3);
      // o dono continua vendo todos, com os clientes de todos
      const owner = byName(await dashboard(o));
      expect(Object.keys(owner)).toHaveLength(4);
      expect(owner['De outro contador'].customers).toBe(1);

      // integração SERPRO desativada: o certificado dela deixa de afetar o contador
      await env.ctx.db.update(integrations).set({ enabled: false }).where(eq(integrations.officeId, o.officeId));
      expect(Object.keys(byName(await dashboard(emp))).sort()).toEqual(['Dos meus clientes', 'Eu mesmo']);

      // sem as permissões do dashboard, nada
      const noPerm = await createEmployee(env, o.api, ['procuration.list']);
      expect((await noPerm.api.get(`/api/dashboard?year=${YEAR}`)).status).toBe(403);
    });
  });

  it('exige permissão', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['budget.list']);
    expect((await emp.api.get(`/api/dashboard?year=${YEAR}`)).status).toBe(403);
    // cada uma das permissões que o menu da web usa para mostrar o Dashboard (a mesma lista) abre a rota
    expect(DASHBOARD_PERMISSIONS).toEqual(['declaration.view', 'customer.list']);
    for (const perm of DASHBOARD_PERMISSIONS) {
      const one = await createEmployee(env, office.api, [perm]);
      expect((await one.api.get(`/api/dashboard?year=${YEAR}`)).status, perm).toBe(200);
    }
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
