import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { auditLogs, budgets, cashbookEntries, checklists, copilotEnrollments, customers, documents } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

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

  it('status da declaração em massa segue as regras da declaração (finalizar e situação eCAC)', async () => {
    const office = await registerOffice(env);
    const ids: string[] = [];
    for (const cpf of VALID_CPFS.slice(0, 2)) ids.push((await office.api.post('/api/customers', { name: `Cliente ${cpf}`, cpfCnpj: cpf })).body.id);
    const editor = await createEmployee(env, office.api, ['customer.list', 'declaration.view', 'declaration.edit']);
    const decl = async (id: string) => (await office.api.get(`/api/customers/${id}/declarations/2026`)).body;

    // sem a permissão de finalizar, o lote inteiro é recusado e nenhuma declaração é finalizada
    const denied = await editor.api.post('/api/customers/bulk', { ids, action: 'substatus', value: 'finished', year: 2026 });
    expect(denied.status).toBe(403);
    for (const id of ids) expect((await decl(id)).stage).toBe('not_started');

    // malha fina em massa leva junto a situação eCAC, como na troca de status da declaração
    const mesh = await editor.api.post('/api/customers/bulk', { ids, action: 'substatus', value: 'ecac_fine_mesh', year: 2026 });
    expect(mesh.status).toBe(200);
    expect(mesh.body).toMatchObject({ affected: 2, stage: 'transmitted' });
    for (const id of ids) expect(await decl(id)).toMatchObject({ stage: 'transmitted', substatus: 'ecac_fine_mesh', ecacStatus: 'fine_mesh' });
    // auditoria de/para por declaração
    const logs = await env.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.officeId, office.officeId), eq(auditLogs.action, 'substatus')));
    expect(logs.map((l) => l.data)).toEqual([
      { from: 'not_started', to: 'ecac_fine_mesh', bulk: true },
      { from: 'not_started', to: 'ecac_fine_mesh', bulk: true },
    ]);
    expect(new Set(logs.map((l) => l.entityId)).size).toBe(2);

    // com a permissão, finaliza o lote
    const fin = await office.api.post('/api/customers/bulk', { ids, action: 'substatus', value: 'finished', year: 2026 });
    expect(fin.status).toBe(200);
    for (const id of ids) {
      const d = await decl(id);
      expect(d).toMatchObject({ stage: 'finished', substatus: 'finished', ecacStatus: 'fine_mesh' });
      expect(d.finishedAt).toBeTruthy();
    }
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

/** Registros de auditoria do escritório para uma entidade (mais antigos primeiro). */
const auditOf = (officeId: string, entity: string) =>
  env.ctx.db.query.auditLogs.findMany({ where: and(eq(auditLogs.officeId, officeId), eq(auditLogs.entity, entity)), orderBy: (t, { asc }) => [asc(t.createdAt)] });

describe('auditoria (CON-11)', () => {
  it('registra a exportação de clientes com a contagem e os filtros, sem os dados', async () => {
    const { api, officeId, userId } = await registerOffice(env);
    await api.post('/api/customers', { name: 'Gabi Exporta', cpfCnpj: VALID_CPFS[0], email: 'gabi@ex.com' });
    await api.post('/api/customers', { name: 'Hugo Exporta', cpfCnpj: VALID_CPFS[1] });
    expect((await api.post('/api/customers/export', { filters: { email: 'with', page: 3, groups: '' } })).status).toBe(200);
    const [log] = (await auditOf(officeId, 'customer')).filter((l) => l.action === 'export');
    expect(log).toMatchObject({ userId, entityId: null, data: { count: 1, filters: { email: 'with' }, ids: 0 } });
    // sem nome, CPF ou e-mail dos clientes no registro
    expect(JSON.stringify(log.data)).not.toMatch(/Gabi|gabi@|52998224725/);
  });

  it('registra procurador, endereço, grupo, documento e exclusões de linhas', async () => {
    const { api, officeId } = await registerOffice(env);
    const c = await api.post('/api/customers', { name: 'Ivo Audita', cpfCnpj: VALID_CPFS[2] });
    const p = await api.post('/api/procurators', { name: 'Procurador Um', cpfCnpj: '11.222.333/0001-81' });
    await api.put(`/api/procurators/${p.body.id}`, { name: 'Procurador Dois', cpfCnpj: '11222333000181' });
    await api.del(`/api/procurators/${p.body.id}`);
    expect((await auditOf(officeId, 'procurator')).map((l) => [l.action, l.data?.name])).toEqual([
      ['create', 'Procurador Um'],
      ['update', 'Procurador Dois'],
      ['delete', 'Procurador Dois'],
    ]);
    await api.put(`/api/customers/${c.body.id}/address`, { address: { city: 'Recife' } });
    expect((await auditOf(officeId, 'customer')).map((l) => l.action)).toContain('update_address');
    const g = await api.post('/api/customer-groups', { name: 'Antigo' });
    await api.put(`/api/customer-groups/${g.body.id}`, { name: 'Novo' });
    expect((await auditOf(officeId, 'customer_group')).map((l) => [l.action, l.data?.name])).toEqual([
      ['create', 'Antigo'],
      ['update', 'Novo'],
    ]);
    const decl = await api.put(`/api/customers/${c.body.id}/declarations/2026`, {});
    const item = await api.post(`/api/declarations/${decl.body.id}/items`, { kind: 'income_exempt', description: 'Poupança', valueCents: 1_000 });
    await api.del(`/api/declarations/${decl.body.id}/items/${item.body.item.id}`);
    const declLog = (await auditOf(officeId, 'declaration')).find((l) => l.action === 'delete_item');
    expect(declLog).toMatchObject({ entityId: decl.body.id, data: { itemId: item.body.item.id, kind: 'income_exempt' } });
  });
});

describe('auditoria (CON-11): documento, livro caixa e Copiloto', () => {
  it('registra a troca de categoria do documento e as exclusões de lançamentos e documentos', async () => {
    const { api, officeId } = await registerOffice(env);
    const c = (await api.post('/api/customers', { name: 'Júlia Audita', cpfCnpj: VALID_CPFS[3] })).body.id as string;
    const file = await env.ctx.files.save({ officeId, data: Buffer.from('%PDF-1.4\n%%EOF\n'), filename: 'informe.pdf', mimeType: 'application/pdf' });
    const [doc] = await env.ctx.db.insert(documents).values({ officeId, customerId: c, fileId: file.id, category: 'other' }).returning();
    expect((await api.patch(`/api/documents/${doc.id}`, { category: 'income_report' })).status).toBe(200);
    expect((await auditOf(officeId, 'document'))[0]).toMatchObject({ action: 'update', entityId: doc.id, data: { category: 'income_report', from: 'other' } });

    const [entry] = await env.ctx.db
      .insert(cashbookEntries)
      .values({ officeId, customerId: c, year: 2025, kind: 'payment', entryDate: '2025-03-05', code: 'P10.01.00012', valueCents: 1_000 })
      .returning();
    expect((await api.del(`/api/cashbook/entries/${entry.id}`)).status).toBe(200);
    expect((await auditOf(officeId, 'cashbook'))[0]).toMatchObject({ action: 'delete_entry', entityId: c, data: { entryId: entry.id, kind: 'payment', entryDate: '2025-03-05' } });

    await api.post('/api/copilot/enrollments', { customerId: c });
    const added = await api.post(`/api/customers/${c}/copilot/entries`, { kind: 'income', year: 2026, month: 1, category: 'salary', description: 'Pró-labore', amountCents: 100 });
    expect((await api.del(`/api/copilot/entries/${added.body.id}`)).status).toBe(200);
    expect((await auditOf(officeId, 'copilot_entry'))[0]).toMatchObject({ action: 'delete', entityId: added.body.id, data: { customerId: c, kind: 'income' } });
    const [copilotDoc] = await env.ctx.db.insert(documents).values({ officeId, customerId: c, fileId: file.id, category: 'copilot' }).returning();
    expect((await api.del(`/api/customers/${c}/copilot/documents/${copilotDoc.id}`)).status).toBe(200);
    expect((await auditOf(officeId, 'copilot_document'))[0]).toMatchObject({ action: 'delete', entityId: copilotDoc.id, data: { customerId: c } });
  });
});

describe('exclusão de cliente (DAD-9)', () => {
  const pub = (method: 'GET' | 'POST', url: string) => env.app.inject({ method, url }).then((r) => ({ status: r.statusCode, body: r.json() }));
  const sendBudget = async (api: Api, customerId: string) => {
    const b = await api.post('/api/finance/budgets', { customerId, exerciseYear: 2026, type: 'fixed', category: 'irpf', amountCents: 50_000 });
    const sent = await api.post(`/api/finance/budgets/${b.body.id}/send`, { channels: ['email'] });
    expect(sent.status).toBe(200);
    return { id: b.body.id as string, token: new URL(sent.body.link).pathname.split('/').pop()! };
  };

  it('libera a vaga do Copiloto, cancela a proposta enviada (link 410) e invalida portal e checklist', async () => {
    const { api, officeId } = await registerOffice(env);
    const ids: string[] = [];
    for (const [i, cpf] of VALID_CPFS.slice(0, 6).entries()) ids.push((await api.post('/api/customers', { name: `Cliente ${i}`, cpfCnpj: cpf, email: `c${i}@ex.com` })).body.id);
    // plano de avaliação: 5 clientes no Copiloto
    for (const id of ids.slice(0, 5)) expect((await api.post('/api/copilot/enrollments', { customerId: id })).status).toBe(201);
    expect((await api.post('/api/copilot/enrollments', { customerId: ids[5] })).status).toBe(409);
    const proposal = await sendBudget(api, ids[0]);
    expect((await pub('GET', `/api/public/budgets/${proposal.token}`)).status).toBe(200);
    expect((await api.post(`/api/customers/${ids[0]}/portal-access`)).status).toBe(200);
    const checklist = await api.post(`/api/customers/${ids[0]}/checklist`, { year: 2026 });
    expect((await api.post(`/api/checklists/${checklist.body.id}/access`, { channels: [] })).status).toBe(200);

    expect((await api.del(`/api/customers/${ids[0]}`)).status).toBe(200);

    expect((await api.get('/api/copilot/enrollments')).body).toMatchObject({ limit: 5, used: 4 });
    expect((await api.post('/api/copilot/enrollments', { customerId: ids[5] })).status).toBe(201);
    const enrollment = await env.ctx.db.query.copilotEnrollments.findFirst({ where: eq(copilotEnrollments.customerId, ids[0]) });
    expect(enrollment!.status).toBe('inactive');
    const link = await pub('GET', `/api/public/budgets/${proposal.token}`);
    expect(link.status).toBe(410);
    expect(link.body.error).toBe('Esta proposta não está mais disponível. Fale com o escritório.');
    expect((await pub('POST', `/api/public/budgets/${proposal.token}/approve`)).status).toBe(410);
    const budget = await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, proposal.id) });
    expect(budget!.status).toBe('canceled');
    expect(await env.ctx.db.query.billings.findFirst({ where: (t, { eq: e }) => e(t.budgetId, proposal.id) })).toBeUndefined();
    const customer = await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, ids[0]) });
    expect(customer).toMatchObject({ portalEnabled: false, portalCodeHash: null, portalCodeExpiresAt: null });
    expect(customer!.deletedAt).toBeInstanceOf(Date);
    const cl = await env.ctx.db.query.checklists.findFirst({ where: eq(checklists.id, checklist.body.id) });
    expect(cl!.accessExpiresAt).toBeNull();
    const log = (await auditOf(officeId, 'customer')).find((l) => l.action === 'delete');
    expect(log!.data).toMatchObject({ canceledBudgets: 1 });
  });

  it('a exclusão em massa faz o mesmo, e o link de proposta já aprovada também responde 410', async () => {
    const { api } = await registerOffice(env);
    const ids: string[] = [];
    for (const [i, cpf] of VALID_CPFS.slice(0, 2).entries()) ids.push((await api.post('/api/customers', { name: `Cliente ${i}`, cpfCnpj: cpf, email: `m${i}@ex.com` })).body.id);
    for (const id of ids) await api.post('/api/copilot/enrollments', { customerId: id });
    const open = await sendBudget(api, ids[0]);
    const approved = await sendBudget(api, ids[1]);
    expect((await pub('POST', `/api/public/budgets/${approved.token}/approve`)).status).toBe(200);

    expect((await api.post('/api/customers/bulk', { ids, action: 'delete' })).body.affected).toBe(2);

    expect((await api.get('/api/copilot/enrollments')).body.used).toBe(0);
    const rows = await env.ctx.db.select().from(copilotEnrollments).where(inArray(copilotEnrollments.customerId, ids));
    expect(rows.map((r) => r.status)).toEqual(['inactive', 'inactive']);
    expect((await pub('GET', `/api/public/budgets/${open.token}`)).status).toBe(410);
    expect((await pub('GET', `/api/public/budgets/${approved.token}`)).status).toBe(410);
    const statuses = await env.ctx.db.select({ id: budgets.id, status: budgets.status }).from(budgets).where(inArray(budgets.id, [open.id, approved.id]));
    expect(Object.fromEntries(statuses.map((b) => [b.id, b.status]))).toEqual({ [open.id]: 'canceled', [approved.id]: 'approved' });
  });
});
