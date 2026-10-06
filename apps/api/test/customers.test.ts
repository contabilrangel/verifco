import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

describe('clientes', () => {
  it('cria, valida CPF e impede duplicado', async () => {
    const { api } = await registerOffice(env);
    expect((await api.post('/api/customers', { name: 'Maria', cpfCnpj: '123.456.789-00' })).status).toBe(400);
    const ok = await api.post('/api/customers', { name: 'Maria Silva', cpfCnpj: '529.982.247-25', email: 'maria@ex.com' });
    expect(ok.status).toBe(201);
    expect(ok.body.cpfCnpj).toBe('52998224725');
    expect((await api.post('/api/customers', { name: 'Outra', cpfCnpj: '52998224725' })).status).toBe(409);
  });

  it('filtra e conta facetas', async () => {
    const { api } = await registerOffice(env);
    const g = await api.post('/api/customer-groups', { name: 'VIP' });
    const a = await api.post('/api/customers', { name: 'Ana Costa', cpfCnpj: VALID_CPFS[0], email: 'ana@ex.com' });
    await api.post('/api/customers', { name: 'Bruno Lima', cpfCnpj: VALID_CPFS[1] });
    await api.put(`/api/customers/${a.body.id}/identification`, { name: 'Ana Costa', groupIds: [g.body.id] });

    expect((await api.get('/api/customers?email=with')).body.total).toBe(1);
    expect((await api.get('/api/customers?search=bruno')).body.data[0].name).toBe('Bruno Lima');
    expect((await api.get(`/api/customers?search=${VALID_CPFS[1].slice(0, 5)}`)).body.total).toBe(1);
    expect((await api.get(`/api/customers?groups=${g.body.id}`)).body.data[0].groups[0].name).toBe('VIP');
    expect((await api.get('/api/customers?noGroup=true')).body.total).toBe(1);

    const facets = (await api.get('/api/customers/facets')).body;
    expect(facets.total).toBe(2);
    expect(facets.email).toEqual({ with: 1, without: 1 });
    expect(facets.noGroup).toBe(1);
    expect(facets.groups.find((x: any) => x.name === 'VIP').n).toBe(1);
  });

  it('ações em massa: grupos, status da declaração e exclusão', async () => {
    const { api } = await registerOffice(env);
    const ids = [];
    for (const cpf of VALID_CPFS.slice(0, 3)) ids.push((await api.post('/api/customers', { name: `Cliente ${cpf}`, cpfCnpj: cpf })).body.id);
    const g = await api.post('/api/customer-groups', { name: 'Família' });
    await api.post('/api/customers/bulk', { ids, action: 'groups_add', value: [g.body.id] });
    expect((await api.get(`/api/customers?groups=${g.body.id}`)).body.total).toBe(3);

    await api.post('/api/customers/bulk', { ids: ids.slice(0, 2), action: 'substatus', value: 'missing_documents', year: 2026 });
    const filling = await api.get('/api/customers?year=2026&stage=filling');
    expect(filling.body.total).toBe(2);
    expect(filling.body.data[0].declaration.substatus).toBe('missing_documents');
    expect((await api.get('/api/customers?year=2026&stage=not_started')).body.total).toBe(1);

    await api.post('/api/customers/bulk', { ids: [ids[2]], action: 'delete' });
    expect((await api.get('/api/customers')).body.total).toBe(2);
    // CPF pode ser cadastrado de novo após a exclusão
    expect((await api.post('/api/customers', { name: 'Volta', cpfCnpj: VALID_CPFS[2] })).status).toBe(201);
  });

  it('guarda credenciais cifradas e nunca as devolve', async () => {
    const { api, officeId } = await registerOffice(env);
    const c = await api.post('/api/customers', { name: 'Carla', cpfCnpj: VALID_CPFS[3] });
    const res = await api.put(`/api/customers/${c.body.id}/credentials`, { ecacLogin: VALID_CPFS[3], ecacPassword: 'segredo' });
    expect(res.body.hasEcacCredentials).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('segredo');
    const row = await env.ctx.db.query.customers.findFirst({ where: (t, { eq }) => eq(t.id, c.body.id) });
    expect(row!.officeId).toBe(officeId);
    expect(row!.ecacPasswordEnc).not.toContain('segredo');
    expect(env.ctx.secrets.decrypt(row!.ecacPasswordEnc!)).toBe('segredo');
  });

  it('restringe clientes ao responsável quando o escritório pede', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['customer.list', 'customer.edit']);
    await office.api.post('/api/customers', { name: 'Do dono', cpfCnpj: VALID_CPFS[4] });
    const mine = await office.api.post('/api/customers', { name: 'Do colaborador', cpfCnpj: VALID_CPFS[5], responsibleUserId: emp.userId });
    expect((await emp.api.get('/api/customers')).body.total).toBe(2);
    await office.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    const list = await emp.api.get('/api/customers');
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].id).toBe(mine.body.id);
    expect((await office.api.get('/api/customers')).body.total).toBe(2);
  });

  it('exporta Excel e gera etiquetas em PDF', async () => {
    const { api } = await registerOffice(env);
    const c = await api.post('/api/customers', { name: 'Diego', cpfCnpj: VALID_CPFS[6] });
    await api.put(`/api/customers/${c.body.id}/address`, { address: { street: 'Rua A', number: '10', city: 'Recife', state: 'PE', zip: '50000-000' } });
    const x = await api.post('/api/customers/export', {});
    expect(x.status).toBe(200);
    expect(x.raw.headers['content-type']).toContain('spreadsheetml');
    const l = await api.post('/api/customers/labels', { ids: [c.body.id] });
    expect(l.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    // o rodapé não pode abrir uma página extra
    const pages = l.raw.rawPayload.toString('latin1').match(/\/Type \/Page[^s]/g) ?? [];
    expect(pages).toHaveLength(1);
  });

  it('gera acesso ao portal e envia e-mail pela fila', async () => {
    const { api } = await registerOffice(env);
    const c = await api.post('/api/customers', { name: 'Eva', cpfCnpj: VALID_CPFS[7], email: 'eva@ex.com' });
    const res = await api.post(`/api/customers/${c.body.id}/portal-access`);
    expect(res.body.code).toMatch(/^\d{6}$/);
    await env.ctx.jobs.drain();
    const mail = env.providers.sentEmails.find((m) => m.to === 'eva@ex.com');
    expect(mail?.html).toContain(res.body.code);
  });

  it('procurador com certificado', async () => {
    const { api } = await registerOffice(env);
    const p = await api.post('/api/procurators', { name: 'Escritório', cpfCnpj: '11.222.333/0001-81' });
    expect(p.status).toBe(201);
    const c = await api.post('/api/customers', { name: 'Fábio', cpfCnpj: VALID_CPFS[0] });
    await api.post('/api/customers/bulk', { ids: [c.body.id], action: 'procurator', value: p.body.id });
    const got = await api.get(`/api/customers/${c.body.id}`);
    expect(got.body.procurator.name).toBe('Escritório');
    expect(got.body.procurationStatus).toBe('validating');
    const list = await api.get('/api/procurators');
    expect(list.body[0].customers).toBe(1);
  });
});

describe('procuradores e notificações', () => {
  it('impede procurador repetido e mantém a forma de acesso ao editar', async () => {
    const { api } = await registerOffice(env);
    const p = await api.post('/api/procurators', { name: 'Proc', cpfCnpj: '11.222.333/0001-81', authType: 'certificate_local' });
    expect((await api.post('/api/procurators', { name: 'Outro', cpfCnpj: '11222333000181' })).status).toBe(409);
    const upd = await api.put(`/api/procurators/${p.body.id}`, { name: 'Proc 2', cpfCnpj: '11222333000181' });
    expect(upd.body.authType).toBe('certificate_local');
  });

  it('respeita a preferência de não receber notificações', async () => {
    const { api, officeId } = await registerOffice(env);
    const { notify } = await import('../src/services/notify');
    await notify(env.ctx.db, { officeId, title: 'Aviso' });
    expect((await api.get('/api/notifications')).body).toHaveLength(1);
    await api.put('/api/auth/preferences', { notificationsEnabled: false });
    expect((await api.get('/api/notifications')).body).toHaveLength(0);
  });
});
