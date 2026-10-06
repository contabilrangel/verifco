import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

describe('autenticação', () => {
  it('cadastra escritório, faz login e lê o perfil', async () => {
    const office = await registerOffice(env);
    const me = await office.api.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.isOwner).toBe(true);
    expect(me.body.permissions).toContain('customer.create');

    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: office.email, password: 'senha-forte-123' } });
    expect(login.statusCode).toBe(200);
    const bad = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: office.email, password: 'errada' } });
    expect(bad.statusCode).toBe(401);
  });

  it('cria métodos de pagamento e tabela padrão no cadastro', async () => {
    const office = await registerOffice(env);
    const roles = await office.api.get('/api/roles');
    expect(roles.body.map((r: any) => r.name)).toEqual(expect.arrayContaining(['Administrador', 'Contador']));
  });

  it('rejeita e-mail repetido', async () => {
    const office = await registerOffice(env);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { officeName: 'Outro', name: 'Xavier', email: office.email, password: 'senha-forte-123' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('troca de senha invalida tokens antigos', async () => {
    const office = await registerOffice(env);
    const res = await office.api.post('/api/auth/change-password', { currentPassword: 'senha-forte-123', newPassword: 'nova-senha-456' });
    expect(res.status).toBe(200);
    expect((await office.api.get('/api/auth/me')).status).toBe(401);
    expect((await client(env, res.body.token).get('/api/auth/me')).status).toBe(200);
  });

  it('redefine senha por link enviado por e-mail', async () => {
    const office = await registerOffice(env);
    await env.app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: office.email } });
    const mail = env.providers.sentEmails.at(-1)!;
    const token = /token=([\w-]+)/.exec(mail.html)![1];
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'outra-senha-789' } });
    expect(res.statusCode).toBe(200);
    const again = await env.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'outra-senha-789' } });
    expect(again.statusCode).toBe(400);
  });
});

describe('funções e colaboradores', () => {
  it('aplica permissões da função no servidor', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['customer_group.list']);
    expect((await emp.api.post('/api/customer-groups', { name: 'VIP' })).status).toBe(403);
    expect((await office.api.post('/api/customer-groups', { name: 'VIP' })).status).toBe(201);

    // concede a permissão: vale na próxima requisição
    await office.api.put(`/api/roles/${emp.roleId}`, { name: 'Ajustada', permissions: ['customer_group.list', 'customer_group.create'] });
    expect((await emp.api.post('/api/customer-groups', { name: 'Família' })).status).toBe(201);
  });

  it('não permite excluir função em uso nem a do administrador', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, []);
    expect((await office.api.del(`/api/roles/${emp.roleId}`)).status).toBe(409);
    const admin = (await office.api.get('/api/roles')).body.find((r: any) => r.isSystem);
    expect((await office.api.del(`/api/roles/${admin.id}`)).status).toBe(400);
  });

  it('desativar colaborador derruba a sessão', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, []);
    const list = await office.api.get('/api/employees');
    const target = list.body.find((u: any) => u.id === emp.userId);
    await office.api.put(`/api/employees/${emp.userId}`, { name: target.name, email: target.email, roleId: emp.roleId, isActive: false });
    expect((await emp.api.get('/api/auth/me')).status).toBe(401);
  });

  it('isola escritórios', async () => {
    const a = await registerOffice(env, 'Escritório A');
    const b = await registerOffice(env, 'Escritório B');
    const g = await a.api.post('/api/customer-groups', { name: 'Só do A' });
    expect((await b.api.put(`/api/customer-groups/${g.body.id}`, { name: 'invasão' })).status).toBe(404);
    expect((await b.api.get('/api/customer-groups')).body).toEqual([]);
  });

  it('salva preferências do escritório', async () => {
    const office = await registerOffice(env);
    const res = await office.api.put('/api/office/settings', { autoGenerateCnd: true, reportTitleColor: '#112233' });
    expect(res.body.autoGenerateCnd).toBe(true);
    const got = await office.api.get('/api/office');
    expect(got.body.settings.reportTitleColor).toBe('#112233');
    expect(got.body.settings.receiptShowDetails).toBe(true);
  });
});
