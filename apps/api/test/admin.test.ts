import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { addDaysIso, currentExerciseYear, todayIso } from '@verifco/shared';
import { contracts } from '../src/db/schema';
import { VALID_CPFS, client, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f20000000049454e44ae426082', 'hex');

async function uploadLogo(token: string, data = PNG, filename = 'logo.png', type = 'image/png') {
  const boundary = `----vf${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/office/logo',
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('escritório', () => {
  it('valida e normaliza os dados do escritório', async () => {
    const office = await registerOffice(env);
    expect((await office.api.put('/api/office', { name: 'Contábil', email: 'invalido' })).status).toBe(400);
    expect((await office.api.put('/api/office', { name: 'Contábil', state: 'Pernambuco' })).status).toBe(400);
    expect((await office.api.put('/api/office', { name: 'Contábil', cpfCnpj: '11.222.333/0001-80' })).status).toBe(400);
    const ok = await office.api.put('/api/office', {
      name: 'Contábil Recife',
      cpfCnpj: '11.222.333/0001-81',
      email: 'Contato@Contabil.com.br',
      phone: '(81) 3333-4444',
      website: 'www.contabil.com.br',
      city: 'Recife',
      state: 'pe',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      cpfCnpj: '11222333000181',
      email: 'contato@contabil.com.br',
      phone: '8133334444',
      website: 'https://www.contabil.com.br',
      state: 'PE',
    });
    const emp = await createEmployee(env, office.api, ['customer.list']);
    expect((await emp.api.put('/api/office', { name: 'Invasão' })).status).toBe(403);
  });

  it('envia, troca e remove o logo', async () => {
    const office = await registerOffice(env);
    expect((await uploadLogo(office.token, Buffer.from('%PDF-1.4'), 'logo.pdf', 'application/pdf')).status).toBe(400);
    // SVG pode carregar script e não sai nos PDFs; conteúdo que não é PNG/JPG também é recusado
    expect((await uploadLogo(office.token, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg', 'image/svg+xml')).status).toBe(400);
    expect((await uploadLogo(office.token, Buffer.from('<script>alert(1)</script>'), 'logo.png', 'image/png')).status).toBe(400);
    const first = await uploadLogo(office.token);
    expect(first.status).toBe(200);
    const second = await uploadLogo(office.token);
    expect((await office.api.get('/api/office')).body.logoFileId).toBe(second.body.logoFileId);
    // o logo anterior é apagado
    expect((await office.api.get(`/api/files/${first.body.logoFileId}`)).status).toBe(404);
    expect((await office.api.get(`/api/files/${second.body.logoFileId}`)).status).toBe(200);
    expect((await office.api.del('/api/office/logo')).status).toBe(200);
    expect((await office.api.get('/api/office')).body.logoFileId).toBeNull();
    expect((await office.api.get(`/api/files/${second.body.logoFileId}`)).status).toBe(404);
  });

  it('preferências: status de bloqueio do checklist e cores validados', async () => {
    const office = await registerOffice(env);
    expect((await office.api.put('/api/office/settings', { lockChecklistFromSubstatus: 'qualquer' })).status).toBe(400);
    expect((await office.api.put('/api/office/settings', { reportLineColor: 'azul' })).status).toBe(400);
    const res = await office.api.put('/api/office/settings', { lockChecklistFromSubstatus: 'elaboration', highNetWorthBaseCents: 500_000_000 });
    expect(res.body).toMatchObject({ lockChecklistFromSubstatus: 'elaboration', highNetWorthBaseCents: 500_000_000 });
    expect((await office.api.put('/api/office/settings', { lockChecklistFromSubstatus: null })).body.lockChecklistFromSubstatus).toBeNull();
    const viewer = await createEmployee(env, office.api, ['settings.view']);
    expect((await viewer.api.put('/api/office/settings', { autoGenerateCnd: true })).status).toBe(403);
  });

  it('contratos do escritório', async () => {
    const office = await registerOffice(env);
    const list = await office.api.get('/api/office/contracts');
    expect(list.body[0]).toMatchObject({ name: 'Avaliação gratuita', status: 'active' });
    const emp = await createEmployee(env, office.api, []);
    expect((await emp.api.get('/api/office/contracts')).status).toBe(403);
  });
});

describe('plano: limite e validade dos contratos (COB-12)', () => {
  const YEAR = currentExerciseYear();
  const newCustomer = async (api: ReturnType<typeof client>, i: number) => (await api.post('/api/customers', { name: `Cliente ${i}`, cpfCnpj: VALID_CPFS[i] })).body.id as string;

  it('o cadastro cria a avaliação de 30 dias contados no dia de Brasília', async () => {
    const office = await registerOffice(env);
    const [trial] = await env.ctx.db.select().from(contracts).where(eq(contracts.officeId, office.officeId));
    const today = todayIso();
    expect(trial).toMatchObject({ plan: 'trial', declarationLimit: 30, year: YEAR, startsAt: today, expiresAt: addDaysIso(today, 30), status: 'active' });
  });

  it('limita as declarações do exercício do contrato, com mensagem em português', async () => {
    const office = await registerOffice(env);
    await env.ctx.db.update(contracts).set({ declarationLimit: 2 }).where(eq(contracts.officeId, office.officeId));
    const ids = [await newCustomer(office.api, 0), await newCustomer(office.api, 1), await newCustomer(office.api, 2)];
    expect((await office.api.put(`/api/customers/${ids[0]}/declarations/${YEAR}`, { taxDueCents: 100 })).status).toBe(200);
    expect((await office.api.put(`/api/customers/${ids[1]}/declarations/${YEAR}`, {})).status).toBe(200);
    const over = await office.api.put(`/api/customers/${ids[2]}/declarations/${YEAR}`, {});
    expect(over.status).toBe(409);
    expect(over.body.error).toBe(`Limite de declarações do contrato atingido: 2 no exercício ${YEAR}. Para ampliar o limite, fale com o suporte do Verifco.`);
    // outros caminhos que criam a declaração respeitam o mesmo limite
    expect((await office.api.post('/api/customers/bulk', { ids: [ids[2]], action: 'substatus', value: 'started', year: YEAR })).status).toBe(409);
    // a declaração que já existe continua editável, e exercício sem contrato vigente não tem limite
    expect((await office.api.put(`/api/customers/${ids[0]}/declarations/${YEAR}`, { taxDueCents: 200 })).status).toBe(200);
    expect((await office.api.put(`/api/customers/${ids[2]}/declarations/${YEAR - 1}`, {})).status).toBe(200);
    // cliente excluído deixa de contar
    expect((await office.api.del(`/api/customers/${ids[1]}`)).status).toBe(200);
    expect((await office.api.put(`/api/customers/${ids[2]}/declarations/${YEAR}`, {})).status).toBe(200);
    // contrato ilimitado vigente no exercício libera
    await env.ctx.db.insert(contracts).values({ officeId: office.officeId, name: 'Pacote ilimitado', plan: 'pro', declarationLimit: null, year: YEAR, startsAt: '2020-01-01', expiresAt: '2099-12-31' });
    const extra = await newCustomer(office.api, 3);
    expect((await office.api.put(`/api/customers/${extra}/declarations/${YEAR}`, {})).status).toBe(200);
  });

  it('com o contrato vencido, só consulta: GET, conta e exportações liberados; o resto pede renovação', async () => {
    const office = await registerOffice(env);
    const customerId = (await office.api.post('/api/customers', { name: 'Cliente 4', cpfCnpj: VALID_CPFS[4], email: 'cliente4@ex.com' })).body.id as string;
    const access = await office.api.post(`/api/customers/${customerId}/portal-access`, {});
    expect(access.status).toBe(200);
    const formerEmployee = await createEmployee(env, office.api, ['customer.list']);
    const yesterday = addDaysIso(todayIso(), -1);
    await env.ctx.db.update(contracts).set({ startsAt: addDaysIso(yesterday, -30), expiresAt: yesterday }).where(eq(contracts.officeId, office.officeId));

    // consulta
    expect((await office.api.get('/api/customers')).status).toBe(200);
    expect((await office.api.get('/api/office/contracts')).status).toBe(200);
    expect((await office.api.get(`/api/customers/${customerId}/declarations/${YEAR}`)).status).toBe(200);
    expect((await office.api.post('/api/customers/export', {})).status).toBe(200);
    // escrita da equipe bloqueada, com a mensagem para renovar
    const blocked = await office.api.post('/api/customers', { name: 'Novo', cpfCnpj: VALID_CPFS[5] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/Nenhum contrato do escritório está vigente.*renovar/);
    expect((await office.api.put(`/api/customers/${customerId}/identification`, { name: 'Outro nome' })).status).toBe(403);
    expect((await office.api.del(`/api/customers/${customerId}`)).status).toBe(403);
    expect((await office.api.put('/api/office', { name: 'Outro escritório' })).status).toBe(403);
    // login, conta e avisos continuam
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: office.email, password: 'senha-forte-123' } });
    expect(login.statusCode).toBe(200);
    expect((await office.api.put('/api/account/profile', { name: 'Ana Dona' })).status).toBe(200);
    expect((await office.api.put('/api/auth/favorites', { path: '/kanban', label: 'Kanban', favorite: true })).status).toBe(200);
    expect((await office.api.post('/api/notifications/read-all')).status).toBe(200);
    // revogar acesso continua possível (segurança)
    expect((await office.api.del(`/api/employees/${formerEmployee.userId}`)).status).toBe(200);
    // o portal do cliente não passa pelo bloqueio da equipe
    const portalLogin = await env.app.inject({ method: 'POST', url: '/api/portal/login', payload: { cpf: VALID_CPFS[4], code: access.body.code } });
    expect(portalLogin.statusCode).toBe(200);
    const asCustomer = client(env, portalLogin.json().token);
    expect((await asCustomer.post('/api/portal/messages', { body: 'Enviei os documentos.' })).status).toBe(201);

    // renovado, volta a gravar
    await env.ctx.db.insert(contracts).values({ officeId: office.officeId, name: 'Renovação', plan: 'basic', declarationLimit: 100, year: YEAR, startsAt: todayIso(), expiresAt: addDaysIso(todayIso(), 365) });
    expect((await office.api.post('/api/customers', { name: 'Novo', cpfCnpj: VALID_CPFS[5] })).status).toBe(201);
  });
});

describe('uso do contrato (GET /office/contracts/status)', () => {
  const YEAR = currentExerciseYear();
  const STATUS = '/api/office/contracts/status';
  const newCustomer = async (api: ReturnType<typeof client>, i: number) => (await api.post('/api/customers', { name: `Cliente ${i}`, cpfCnpj: VALID_CPFS[i] })).body.id as string;
  const declare = (api: ReturnType<typeof client>, customerId: string, year = YEAR) => api.put(`/api/customers/${customerId}/declarations/${year}`, {});

  it('mostra só o uso do próprio escritório, com os mesmos números do limite aplicado', async () => {
    const office = await registerOffice(env);
    const other = await registerOffice(env);
    await env.ctx.db.update(contracts).set({ declarationLimit: 3 }).where(eq(contracts.officeId, office.officeId));
    const ids = [await newCustomer(office.api, 0), await newCustomer(office.api, 1), await newCustomer(office.api, 2), await newCustomer(office.api, 3)];
    expect((await declare(office.api, ids[0])).status).toBe(200);
    expect((await declare(office.api, ids[1])).status).toBe(200);
    // outro exercício não consome o limite do pacote
    expect((await declare(office.api, ids[2], YEAR - 1)).status).toBe(200);
    // declarações de outro escritório não contam
    const otherCustomer = await newCustomer(other.api, 0);
    expect((await declare(other.api, otherCustomer)).status).toBe(200);

    const today = todayIso();
    const res = await office.api.get(STATUS);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      today,
      hasContracts: true,
      readOnly: false,
      validUntil: addDaysIso(today, 30),
      daysLeft: 30,
      lastExpiredAt: null,
      nextStartsAt: null,
      exercises: [{ year: YEAR, limit: 3, used: 2, remaining: 1, percent: 67 }],
    });
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0]).toMatchObject({ name: 'Avaliação gratuita', plan: 'trial', year: YEAR, declarationLimit: 3, startsAt: today, daysLeft: 30 });
    const [ownContract] = await env.ctx.db.select().from(contracts).where(eq(contracts.officeId, office.officeId));
    expect(res.body.active[0].id).toBe(ownContract.id);
    expect((await other.api.get(STATUS)).body.exercises).toEqual([{ year: YEAR, limit: 30, used: 1, remaining: 29, percent: 3 }]);

    // no limite mostrado, a criação é recusada; abaixo dele, aceita
    expect((await declare(office.api, ids[3])).status).toBe(200);
    expect((await office.api.get(STATUS)).body.exercises[0]).toEqual({ year: YEAR, limit: 3, used: 3, remaining: 0, percent: 100 });
    expect((await declare(office.api, ids[2])).status).toBe(409);
    // cliente excluído deixa de contar nos dois lugares
    expect((await office.api.del(`/api/customers/${ids[1]}`)).status).toBe(200);
    expect((await office.api.get(STATUS)).body.exercises[0]).toMatchObject({ used: 2, remaining: 1 });
    expect((await declare(office.api, ids[2])).status).toBe(200);

    // pacotes vigentes do mesmo exercício somam; pacote de outro exercício aparece separado
    await env.ctx.db.insert(contracts).values([
      { officeId: office.officeId, name: 'Pacote extra', plan: 'basic', declarationLimit: 2, year: YEAR, startsAt: today, expiresAt: addDaysIso(today, 90) },
      { officeId: office.officeId, name: 'Pacote seguinte', plan: 'pro', declarationLimit: 10, year: YEAR + 1, startsAt: today, expiresAt: addDaysIso(today, 400) },
    ]);
    const more = await office.api.get(STATUS);
    expect(more.body.exercises).toEqual([
      { year: YEAR + 1, limit: 10, used: 0, remaining: 10, percent: 0 },
      { year: YEAR, limit: 5, used: 3, remaining: 2, percent: 60 },
    ]);
    expect(more.body.active.map((c: { name: string }) => c.name)).toEqual(['Avaliação gratuita', 'Pacote extra', 'Pacote seguinte']);
    expect(more.body).toMatchObject({ validUntil: addDaysIso(today, 400), daysLeft: 400 });
  });

  it('com o contrato vencido mostra o modo só consulta, a última expiração e o próximo pacote', async () => {
    const office = await registerOffice(env);
    const customerId = await newCustomer(office.api, 0);
    expect((await declare(office.api, customerId)).status).toBe(200);
    const today = todayIso();
    const yesterday = addDaysIso(today, -1);
    await env.ctx.db.update(contracts).set({ startsAt: addDaysIso(yesterday, -30), expiresAt: yesterday }).where(eq(contracts.officeId, office.officeId));

    const res = await office.api.get(STATUS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      today,
      hasContracts: true,
      readOnly: true,
      active: [],
      validUntil: null,
      daysLeft: null,
      lastExpiredAt: yesterday,
      nextStartsAt: null,
      exercises: [{ year: YEAR, limit: null, used: 1, remaining: null, percent: null }],
    });
    // o que o card diz é o que o servidor aplica
    expect((await office.api.post('/api/customers', { name: 'Novo', cpfCnpj: VALID_CPFS[5] })).status).toBe(403);

    // pacote contratado que ainda não começou: continua só consulta, com a data de início
    const tomorrow = addDaysIso(today, 1);
    await env.ctx.db.insert(contracts).values({ officeId: office.officeId, name: 'Renovação', plan: 'basic', declarationLimit: 100, year: YEAR, startsAt: tomorrow, expiresAt: addDaysIso(tomorrow, 365) });
    expect((await office.api.get(STATUS)).body).toMatchObject({ readOnly: true, nextStartsAt: tomorrow, lastExpiredAt: yesterday });

    // sem nenhum contrato cadastrado não há restrição
    await env.ctx.db.delete(contracts).where(eq(contracts.officeId, office.officeId));
    expect((await office.api.get(STATUS)).body).toMatchObject({ hasContracts: false, readOnly: false, active: [], exercises: [{ year: YEAR, limit: null, used: 1 }] });
  });

  it('exige contracts.view e devolve o escritório de quem consulta', async () => {
    const office = await registerOffice(env);
    const without = await createEmployee(env, office.api, ['customer.list', 'settings.view']);
    expect((await without.api.get(STATUS)).status).toBe(403);
    const viewer = await createEmployee(env, office.api, ['contracts.view']);
    const seen = await viewer.api.get(STATUS);
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual((await office.api.get(STATUS)).body);
    expect((await env.app.inject({ method: 'GET', url: STATUS })).statusCode).toBe(401);
  });
});

describe('funções, colaboradores e grupos', () => {
  it('não aceita duas funções com o mesmo nome', async () => {
    const office = await registerOffice(env);
    expect((await office.api.post('/api/roles', { name: 'Assistente', permissions: ['customer.list'] })).status).toBe(201);
    const dup = await office.api.post('/api/roles', { name: 'assistente', permissions: [] });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain('com este nome');
    expect((await office.api.post('/api/roles', { name: 'Outra', permissions: ['nao.existe'] })).status).toBe(400);
  });

  it('convite pendente pode ser reenviado e o link anterior deixa de valer', async () => {
    const office = await registerOffice(env);
    const roles = (await office.api.get('/api/roles')).body;
    const role = roles.find((r: any) => r.name === 'Contador');
    const created = await office.api.post('/api/employees', { name: 'Bia', email: 'bia@ex.com', roleId: role.id });
    const oldToken = new URL(created.body.inviteLink).searchParams.get('token');

    let list = (await office.api.get('/api/employees')).body;
    expect(list.find((u: any) => u.id === created.body.id).invitePending).toBe(true);

    const sentBefore = env.providers.sentEmails.length;
    const again = await office.api.post(`/api/employees/${created.body.id}/invite`);
    expect(again.status).toBe(200);
    expect(env.providers.sentEmails.length).toBe(sentBefore + 1);
    expect(env.providers.sentEmails.at(-1)!.to).toBe('bia@ex.com');

    const old = await env.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: oldToken, password: 'senha-bia-123' } });
    expect(old.statusCode).toBe(400);
    const newToken = new URL(again.body.inviteLink).searchParams.get('token');
    const ok = await env.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: newToken, password: 'senha-bia-123' } });
    expect(ok.statusCode).toBe(200);

    list = (await office.api.get('/api/employees')).body;
    expect(list.find((u: any) => u.id === created.body.id).invitePending).toBe(false);
    expect((await office.api.post(`/api/employees/${created.body.id}/invite`)).status).toBe(400);
  });

  it('reenvio de convite exige permissão e respeita o escritório', async () => {
    const a = await registerOffice(env);
    const b = await registerOffice(env);
    const role = (await a.api.get('/api/roles')).body.find((r: any) => !r.isSystem);
    const created = await a.api.post('/api/employees', { name: 'Caio', email: `caio-${Date.now()}@ex.com`, roleId: role.id });
    expect((await b.api.post(`/api/employees/${created.body.id}/invite`)).status).toBe(404);
    const viewer = await createEmployee(env, a.api, ['employee.list']);
    expect((await viewer.api.post(`/api/employees/${created.body.id}/invite`)).status).toBe(403);
  });

  it('grupos com contagem de clientes e nomes únicos', async () => {
    const office = await registerOffice(env);
    const g = await office.api.post('/api/customer-groups', { name: 'Família' });
    expect((await office.api.post('/api/customer-groups', { name: 'família' })).status).toBe(409);
    const other = await office.api.post('/api/customer-groups', { name: 'VIP' });
    expect((await office.api.put(`/api/customer-groups/${other.body.id}`, { name: 'FAMÍLIA' })).status).toBe(409);
    expect((await office.api.put(`/api/customer-groups/${other.body.id}`, { name: 'Clientes VIP' })).status).toBe(200);

    const c1 = await office.api.post('/api/customers', { name: 'Um', cpfCnpj: VALID_CPFS[0] });
    const c2 = await office.api.post('/api/customers', { name: 'Dois', cpfCnpj: VALID_CPFS[1] });
    await office.api.post('/api/customers/bulk', { ids: [c1.body.id, c2.body.id], action: 'groups_add', value: [g.body.id] });
    await office.api.del(`/api/customers/${c2.body.id}`);
    const list = (await office.api.get('/api/customer-groups')).body;
    expect(list.find((x: any) => x.id === g.body.id).customers).toBe(1);

    // excluir o grupo não exclui os clientes
    expect((await office.api.del(`/api/customer-groups/${g.body.id}`)).status).toBe(200);
    expect((await office.api.get(`/api/customers/${c1.body.id}`)).body.groups).toEqual([]);
  });
});

describe('conta do usuário', () => {
  it('altera o próprio nome, sem mexer no e-mail', async () => {
    const office = await registerOffice(env);
    expect((await office.api.put('/api/account/profile', { name: 'A' })).status).toBe(400);
    const res = await office.api.put('/api/account/profile', { name: 'Ana Maria Dona', email: 'outro@ex.com' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: 'Ana Maria Dona', email: office.email });
  });

  it('preferência de notificações e encerramento das sessões', async () => {
    const office = await registerOffice(env);
    const pref = await office.api.put('/api/auth/preferences', { notificationsEnabled: false });
    expect(pref.body.user.notificationPrefs.enabled).toBe(false);
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: office.email, password: 'senha-forte-123' } });
    const other = client(env, login.json().token);
    expect((await other.get('/api/auth/me')).status).toBe(200);
    expect((await office.api.post('/api/auth/logout-all')).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
    expect((await office.api.get('/api/auth/me')).status).toBe(401);
  });

  it('exige login', async () => {
    const res = await env.app.inject({ method: 'PUT', url: '/api/account/profile', payload: { name: 'Fulano' } });
    expect(res.statusCode).toBe(401);
  });
});
