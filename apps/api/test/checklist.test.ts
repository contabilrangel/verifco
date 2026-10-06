import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { checklists, declarations } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { PDF, PNG, addPreviousYear, customerLogin, issueAccess, officeWithCustomer, setSubstatus, upload } from './portal-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const YEAR = 2026;

async function withChecklist(cpf: string, prevItems: Parameters<typeof addPreviousYear>[4] = []) {
  const o = await officeWithCustomer(env, cpf);
  if (prevItems.length) await addPreviousYear(env, o.officeId, o.customerId, YEAR - 1, prevItems);
  const created = await o.api.post(`/api/customers/${o.customerId}/checklist`, { year: YEAR });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  return { ...o, checklist: created.body };
}

const allItems = (c: any) => c.sections.flatMap((s: any) => s.items);
const itemTitled = (c: any, title: string) => allItems(c).find((i: any) => i.title === title);

describe('checklist digital (escritório)', () => {
  it('cria a partir da declaração do ano anterior e não duplica', async () => {
    const o = await officeWithCustomer(env, VALID_CPFS[0]);
    const before = await o.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`);
    expect(before.status).toBe(200);
    expect(before.body.checklist).toBeNull();
    expect(before.body.previous).toEqual({ exerciseYear: YEAR - 1, hasDeclaration: false, items: 0 });

    await addPreviousYear(env, o.officeId, o.customerId, YEAR - 1, [
      { kind: 'dependent', ownerName: 'Pedro Souza', ownerCpf: VALID_CPFS[1] },
      { kind: 'income_pj', counterpartyName: 'Acme Ltda', counterpartyDoc: '11222333000181', ownerCpf: VALID_CPFS[0] },
      { kind: 'income_exclusive', counterpartyName: 'Acme Ltda', counterpartyDoc: '11222333000181' },
      { kind: 'payment', counterpartyName: 'Clínica Sorriso', extra: { nature: 'health' }, ownerCpf: VALID_CPFS[1], ownerName: 'Pedro Souza' },
      { kind: 'asset', groupCode: '01', description: 'Casa em Recife' },
      { kind: 'debt', description: 'Financiamento da casa' },
      { kind: 'rural_income', description: 'Venda de gado' },
    ]);
    const res = await o.api.post(`/api/customers/${o.customerId}/checklist`, { year: YEAR });
    expect(res.status).toBe(201);
    const c = res.body;
    expect(c.sections.map((s: any) => s.section)).toEqual(['identification', 'family', 'income', 'payments', 'assets_debts', 'rural', 'files']);
    expect(c.sections.every((s: any) => s.status === 'open')).toBe(true);
    expect(itemTitled(c, 'Dependente: Pedro Souza')).toMatchObject({ section: 'family', fromPreviousYear: true, ownerCpf: VALID_CPFS[1], status: 'pending' });
    expect(allItems(c).filter((i: any) => i.title === 'Informe de rendimentos — Acme Ltda')).toHaveLength(1);
    expect(itemTitled(c, 'Comprovantes de pagamento — Clínica Sorriso')).toMatchObject({ section: 'payments', ownerName: 'Pedro Souza' });
    expect(itemTitled(c, 'Bem: Casa em Recife').section).toBe('assets_debts');
    expect(itemTitled(c, 'Dívida: Financiamento da casa').section).toBe('assets_debts');
    expect(itemTitled(c, 'Livro-caixa da atividade rural').section).toBe('rural');
    // identificação e arquivos não têm histórico: itens padrão
    const ident = c.sections.find((s: any) => s.section === 'identification');
    expect(ident.items.length).toBeGreaterThan(0);
    expect(ident.items.every((i: any) => !i.fromPreviousYear)).toBe(true);
    expect(c.fromPreviousYear).toBe(6); // as duas linhas da Acme viram um item só

    // uma vez criado, mudanças no ano anterior não entram e não se cria outro
    await addPreviousYear(env, o.officeId, o.customerId, YEAR - 1, [{ kind: 'asset', groupCode: '02', description: 'Carro novo' }]);
    const again = await o.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`);
    expect(itemTitled(again.body.checklist, 'Bem: Carro novo')).toBeUndefined();
    expect((await o.api.post(`/api/customers/${o.customerId}/checklist`, { year: YEAR })).status).toBe(409);
  });

  it('sem histórico usa só os itens padrão', async () => {
    const { checklist } = await withChecklist(VALID_CPFS[1]);
    expect(checklist.fromPreviousYear).toBe(0);
    expect(checklist.sections.every((s: any) => s.items.length > 0)).toBe(true);
    expect(itemTitled(checklist, 'Última declaração entregue')).toBeDefined();
  });

  it('edita, adiciona, remove itens e reabre seções', async () => {
    const o = await withChecklist(VALID_CPFS[2]);
    const id = o.checklist.id;
    const added = await o.api.post(`/api/checklists/${id}/items`, { section: 'payments', title: 'Recibos da escola', ownerName: 'Ana', ownerCpf: VALID_CPFS[3] });
    expect(added.status).toBe(201);
    const item = itemTitled(added.body, 'Recibos da escola');
    expect(item).toMatchObject({ section: 'payments', createdBy: 'office', ownerCpf: VALID_CPFS[3] });
    expect((await o.api.post(`/api/checklists/${id}/items`, { section: 'payments', title: 'X', ownerCpf: '123' })).status).toBe(400);
    expect((await o.api.post(`/api/checklists/${id}/items`, { section: 'summary', title: 'Resumo' })).status).toBe(400);

    const edited = await o.api.put(`/api/checklists/${id}/items/${item.id}`, { title: 'Recibos da escola 2025', status: 'removed' });
    expect(itemTitled(edited.body, 'Recibos da escola 2025').status).toBe('removed');

    const removed = await o.api.del(`/api/checklists/${id}/items/${item.id}`);
    expect(itemTitled(removed.body, 'Recibos da escola 2025')).toBeUndefined();
    expect((await o.api.del(`/api/checklists/${id}/items/${item.id}`)).status).toBe(404);

    // o cliente finaliza uma seção e o escritório reabre
    const { token, code } = await issueAccess(o.api, id);
    const cust = await customerLogin(env, token, VALID_CPFS[2], code);
    await cust.api!.post(`/api/portal/checklists/${id}/sections/rural/finish`, { status: 'no_documents' });
    const reopened = await o.api.post(`/api/checklists/${id}/sections/rural/reopen`);
    expect(reopened.body.sections.find((s: any) => s.section === 'rural').status).toBe('open');
  });

  it('exige permissão e isola escritórios e clientes restritos', async () => {
    const o = await withChecklist(VALID_CPFS[3]);
    const id = o.checklist.id;
    const viewer = await createEmployee(env, o.api, ['customer.list', 'checklist_digital.view']);
    expect((await viewer.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`)).status).toBe(200);
    expect((await viewer.api.post(`/api/checklists/${id}/items`, { section: 'income', title: 'Informe' })).status).toBe(403);
    expect((await viewer.api.post(`/api/checklists/${id}/access`, { channels: [] })).status).toBe(403);
    expect((await viewer.api.get(`/api/checklists/${id}/zip`)).status).toBe(403);
    expect((await viewer.api.del(`/api/checklists/${id}`)).status).toBe(403);
    const nobody = await createEmployee(env, o.api, ['customer.list']);
    expect((await nobody.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`)).status).toBe(403);
    expect((await nobody.api.post(`/api/customers/${o.customerId}/checklist`, { year: YEAR + 1 })).status).toBe(403);

    // outro escritório: 404 em tudo
    const other = await registerOffice(env, 'Outro Escritório');
    expect((await other.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`)).status).toBe(404);
    expect((await other.api.post(`/api/checklists/${id}/items`, { section: 'income', title: 'Informe' })).status).toBe(404);
    expect((await other.api.post(`/api/checklists/${id}/access`, { channels: [] })).status).toBe(404);
    expect((await other.api.get(`/api/checklists/${id}/zip`)).status).toBe(404);
    expect((await other.api.del(`/api/checklists/${id}`)).status).toBe(404);

    // escritório que restringe clientes ao responsável
    const editor = await createEmployee(env, o.api, ['customer.list', 'checklist_digital.view', 'checklist_digital.edit']);
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    expect((await editor.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`)).status).toBe(404);
    expect((await editor.api.post(`/api/checklists/${id}/items`, { section: 'income', title: 'Informe' })).status).toBe(404);
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: false });
  });

  it('envia o acesso por e-mail e WhatsApp; um novo código invalida o anterior', async () => {
    const o = await withChecklist(VALID_CPFS[4]);
    const id = o.checklist.id;
    const sent = await o.api.post(`/api/checklists/${id}/access`, { channels: ['email', 'whatsapp'] });
    expect(sent.status).toBe(200);
    expect(sent.body.link).toMatch(/\/checklist\/[\w-]{20,}$/);
    expect(sent.body.code).toMatch(/^\d{6}$/);
    await env.ctx.jobs.drain();
    const mail = env.providers.sentEmails.find((m) => m.to === o.customerEmail);
    expect(mail?.html).toContain(sent.body.link);
    expect(mail?.html).toContain(sent.body.code);
    const wa = env.providers.sentWhatsApp.find((m) => m.text.includes(sent.body.link));
    expect(wa?.text).toContain(sent.body.code);
    expect(wa?.to).toBe('5511987654321');

    // só hashes ficam gravados
    const row = await env.ctx.db.query.checklists.findFirst({ where: eq(checklists.id, id) });
    expect(row!.sentAt).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(sent.body.code);
    expect(JSON.stringify(row)).not.toContain(sent.body.link.split('/checklist/')[1]);

    const old = { token: sent.body.link.split('/checklist/')[1], code: sent.body.code };
    const fresh = await issueAccess(o.api, id);
    expect((await customerLogin(env, old.token, VALID_CPFS[4], old.code)).status).toBe(404);
    expect((await customerLogin(env, fresh.token, VALID_CPFS[4], fresh.code)).status).toBe(200);

    // sem contato, não envia
    const c2 = await o.api.post('/api/customers', { name: 'Sem Contato', cpfCnpj: VALID_CPFS[5] });
    const ch2 = await o.api.post(`/api/customers/${c2.body.id}/checklist`, { year: YEAR });
    expect((await o.api.post(`/api/checklists/${ch2.body.id}/access`, { channels: ['email'] })).status).toBe(400);
    expect((await o.api.post(`/api/checklists/${ch2.body.id}/access`, { channels: ['whatsapp'] })).status).toBe(400);
  });

  it('exclui o checklist mantendo os documentos do cliente', async () => {
    const o = await withChecklist(VALID_CPFS[6]);
    const item = allItems(o.checklist)[0];
    expect((await upload(env, o.token, `/api/checklists/${o.checklist.id}/items/${item.id}/files`, [{ name: 'rg.pdf', data: PDF }])).status).toBe(201);
    expect((await o.api.del(`/api/checklists/${o.checklist.id}`)).status).toBe(200);
    expect((await o.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`)).body.checklist).toBeNull();
    const docs = await env.ctx.db.query.documents.findMany({ where: (t, { eq: e }) => e(t.customerId, o.customerId) });
    expect(docs).toHaveLength(1);
  });
});

describe('checklist do cliente', () => {
  it('entra com CPF + código e limita as tentativas', async () => {
    const o = await withChecklist(VALID_CPFS[0]);
    const { token, code } = await issueAccess(o.api, o.checklist.id);
    const info = await env.app.inject({ method: 'POST', url: '/api/portal/checklist-link', payload: { token } });
    expect(info.json()).toEqual({ officeName: 'Escritório Teste', exerciseYear: YEAR });
    expect((await env.app.inject({ method: 'POST', url: '/api/portal/checklist-link', payload: { token: 'x'.repeat(32) } })).statusCode).toBe(404);

    expect((await customerLogin(env, token, VALID_CPFS[1], code)).status).toBe(401);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect((await customerLogin(env, token, VALID_CPFS[0], wrong)).status).toBe(401);
    // 5 falhas: bloqueia mesmo com o código certo
    const blocked = await customerLogin(env, token, VALID_CPFS[0], code);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/Aguarde/);

    const o2 = await withChecklist(VALID_CPFS[1]);
    const a2 = await issueAccess(o2.api, o2.checklist.id);
    const ok = await customerLogin(env, a2.token, '111.444.777-35', a2.code);
    expect(ok.status).toBe(200);
    expect(ok.body.checklistId).toBe(o2.checklist.id);
    const view = await ok.api!.get(`/api/portal/checklists/${o2.checklist.id}`);
    expect(view.status).toBe(200);
    expect(view.body.customerFirstName).toBe('Maria');
    expect(view.body.readOnly).toBe(false);
    const row = await env.ctx.db.query.checklists.findFirst({ where: eq(checklists.id, o2.checklist.id) });
    expect(row!.lastCustomerAccessAt).not.toBeNull();
    // o token do checklist não abre o portal
    expect((await ok.api!.get('/api/portal/overview')).status).toBe(403);
    // nem as rotas do escritório
    expect((await ok.api!.get(`/api/customers/${o2.customerId}/checklist?year=${YEAR}`)).status).toBe(401);
  });

  it('marca itens, envia arquivos, inclui outro documento e finaliza seções', async () => {
    const o = await withChecklist(VALID_CPFS[2], [
      { kind: 'dependent', ownerName: 'Pedro', ownerCpf: VALID_CPFS[3] },
      { kind: 'income_pj', counterpartyName: 'Acme', counterpartyDoc: '11222333000181' },
    ]);
    await setSubstatus(env, o.officeId, o.customerId, YEAR, 'elaboration');
    const id = o.checklist.id;
    const { token, code } = await issueAccess(o.api, id);
    const cust = (await customerLogin(env, token, VALID_CPFS[2], code)).api!;
    const custToken = (await customerLogin(env, token, VALID_CPFS[2], code)).body.token as string;

    const dep = itemTitled(o.checklist, 'Dependente: Pedro');
    const income = itemTitled(o.checklist, 'Informe de rendimentos — Acme');
    const ident = o.checklist.sections.find((s: any) => s.section === 'identification').items;

    // "Não tenho mais" só para itens do ano anterior
    expect((await cust.put(`/api/portal/checklists/${id}/items/${ident[0].id}`, { status: 'removed' })).status).toBe(400);
    const marked = await cust.put(`/api/portal/checklists/${id}/items/${dep.id}`, { status: 'removed', customerNote: 'Pedro casou e saiu de casa.' });
    expect(itemTitled(marked.body, 'Dependente: Pedro')).toMatchObject({ status: 'removed', customerNote: 'Pedro casou e saiu de casa.' });

    // uploads: tipos aceitos, conteúdo conferido e limite de 20 MB
    const up = await upload(env, custToken, `/api/portal/checklists/${id}/items/${income.id}/files`, [
      { name: 'informe.pdf', data: PDF, type: 'application/pdf' },
      { name: 'foto.png', data: PNG, type: 'image/png' },
    ]);
    expect(up.status).toBe(201);
    const withFiles = itemTitled(up.body, 'Informe de rendimentos — Acme');
    expect(withFiles.status).toBe('sent');
    expect(withFiles.files.map((f: any) => f.filename)).toEqual(['informe.pdf', 'foto.png']);
    expect(withFiles.files[0].uploadedBy).toBe('customer');
    expect((await upload(env, custToken, `/api/portal/checklists/${id}/items/${income.id}/files`, [{ name: 'virus.exe', data: Buffer.from('MZ') }])).status).toBe(400);
    expect((await upload(env, custToken, `/api/portal/checklists/${id}/items/${income.id}/files`, [{ name: 'falso.pdf', data: Buffer.from('MZ executável') }])).status).toBe(400);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20 * 1024 * 1024 + 10, 32)]);
    const tooBig = await upload(env, custToken, `/api/portal/checklists/${id}/items/${income.id}/files`, [{ name: 'grande.pdf', data: big }]);
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error).toMatch(/20 MB/);

    // download do próprio arquivo e exclusão
    const fileId = withFiles.files[1].id;
    const dl = await env.app.inject({ method: 'GET', url: `/api/portal/checklists/${id}/files/${withFiles.files[0].id}`, headers: { authorization: `Bearer ${custToken}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const afterDel = await cust.del(`/api/portal/checklists/${id}/files/${fileId}`);
    expect(itemTitled(afterDel.body, 'Informe de rendimentos — Acme').files).toHaveLength(1);

    // outro documento
    const other = await cust.post(`/api/portal/checklists/${id}/items`, { section: 'files', title: 'Carta do banco' });
    expect(other.status).toBe(201);
    expect(itemTitled(other.body.checklist, 'Carta do banco').createdBy).toBe('customer');
    expect((await cust.del(`/api/portal/checklists/${id}/items/${income.id}`)).status).toBe(403);

    // "concluída" exige que não haja pendentes
    const identPending = await cust.post(`/api/portal/checklists/${id}/sections/identification/finish`, { status: 'done' });
    expect(identPending.status).toBe(400);
    expect(identPending.body.error).toMatch(/pendente/);

    // família concluída (dependente removido); rendimentos ok
    expect((await cust.post(`/api/portal/checklists/${id}/sections/income/finish`, { status: 'done' })).status).toBe(200);
    // seção finalizada fica fechada para o cliente
    expect((await cust.put(`/api/portal/checklists/${id}/items/${income.id}`, { customerNote: 'x' })).status).toBe(409);

    // com documentos pendentes: notifica e marca a declaração com documentos faltantes
    const pending = await cust.post(`/api/portal/checklists/${id}/sections/identification/finish`, { status: 'pending_documents', note: 'Mando o comprovante semana que vem.' });
    expect(pending.status).toBe(200);
    const decl = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.id, (await env.ctx.db.query.checklists.findFirst({ where: eq(checklists.id, id) }))!.declarationId) });
    expect(decl!.substatus).toBe('missing_documents');
    const notes = (await o.api.get('/api/notifications')).body;
    expect(notes.some((n: any) => n.title.includes('Identificação') && n.body.includes('pendentes') && n.link === `/clientes/${o.customerId}/irpf/documentacao`)).toBe(true);

    // o cliente pode retomar a seção pendente (e só ela)
    expect((await cust.post(`/api/portal/checklists/${id}/sections/income/reopen`)).status).toBe(409);
    expect((await cust.post(`/api/portal/checklists/${id}/sections/identification/reopen`)).status).toBe(200);

    // "sem documentos" resolve os pendentes da seção
    let last: any;
    for (const s of ['identification', 'family', 'payments', 'assets_debts', 'rural', 'files']) {
      last = await cust.post(`/api/portal/checklists/${id}/sections/${s}/finish`, { status: 'no_documents' });
      expect(last.status).toBe(200);
    }
    expect(last.body.finishedAt).not.toBeNull();
    expect(last.body.sections.find((s: any) => s.section === 'payments').items.every((i: any) => i.status === 'not_applicable')).toBe(true);
    expect((await o.api.get('/api/notifications')).body.some((n: any) => n.title.includes('concluiu o checklist'))).toBe(true);

    // o escritório vê os arquivos e baixa tudo em .zip
    const office = await o.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`);
    expect(office.body.checklist.filesCount).toBe(1);
    expect(office.body.checklist.finishedAt).not.toBeNull();
    const zipRes = await env.app.inject({ method: 'GET', url: `/api/checklists/${id}/zip`, headers: { authorization: `Bearer ${o.token}` } });
    expect(zipRes.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(zipRes.rawPayload);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(names).toEqual(['03 Rendimentos/Informe de rendimentos — Acme/informe.pdf']);
    const officeFile = await env.app.inject({ method: 'GET', url: `/api/checklists/${id}/files/${withFiles.files[0].id}?inline=1`, headers: { authorization: `Bearer ${o.token}` } });
    expect(officeFile.headers['content-disposition']).toMatch(/^inline/);

    // reabrir pelo escritório desfaz a conclusão
    const reopened = await o.api.post(`/api/checklists/${id}/sections/files/reopen`);
    expect(reopened.body.finishedAt).toBeNull();
  });

  it('respeita o modo consulta, o bloqueio por status e o bloqueio manual', async () => {
    const o = await withChecklist(VALID_CPFS[5]);
    const id = o.checklist.id;
    const item = allItems(o.checklist)[0];
    const { token, code } = await issueAccess(o.api, id);
    const cust = (await customerLogin(env, token, VALID_CPFS[5], code)).api!;
    const edit = () => cust.put(`/api/portal/checklists/${id}/items/${item.id}`, { status: 'sent' });

    await o.api.put('/api/office/settings', { checklistReadOnlyAfterStart: true });
    await setSubstatus(env, o.officeId, o.customerId, YEAR, 'review');
    expect((await edit()).status).toBe(200);
    await setSubstatus(env, o.officeId, o.customerId, YEAR, 'ecac_waiting');
    const ro = await edit();
    expect(ro.status).toBe(403);
    expect(ro.body.error).toMatch(/consulta/);
    const view = await cust.get(`/api/portal/checklists/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.readOnly).toBe(true);
    const officeView = await o.api.get(`/api/customers/${o.customerId}/checklist?year=${YEAR}`);
    expect(officeView.body.lock.readOnly).toBe(true);

    await o.api.put('/api/office/settings', { checklistReadOnlyAfterStart: false, lockChecklistFromSubstatus: 'review' });
    await setSubstatus(env, o.officeId, o.customerId, YEAR, 'elaboration');
    expect((await edit()).status).toBe(200);
    await setSubstatus(env, o.officeId, o.customerId, YEAR, 'review');
    expect((await edit()).status).toBe(403);
    expect((await upload(env, (await customerLogin(env, token, VALID_CPFS[5], code)).body.token, `/api/portal/checklists/${id}/items/${item.id}/files`, [{ name: 'a.pdf', data: PDF }])).status).toBe(403);

    await o.api.put('/api/office/settings', { lockChecklistFromSubstatus: null });
    expect((await edit()).status).toBe(200);
    const locked = await o.api.put(`/api/checklists/${id}/lock`, { locked: true });
    expect(locked.body.lock.readOnly).toBe(true);
    expect((await edit()).status).toBe(403);
    await o.api.put(`/api/checklists/${id}/lock`, { locked: false });
    expect((await edit()).status).toBe(200);
  });

  it('um cliente não acessa o checklist de outro', async () => {
    const a = await withChecklist(VALID_CPFS[6]);
    const b = await withChecklist(VALID_CPFS[7]);
    const accA = await issueAccess(a.api, a.checklist.id);
    const custA = (await customerLogin(env, accA.token, VALID_CPFS[6], accA.code)).api!;
    const itemB = allItems(b.checklist)[0];
    expect((await custA.get(`/api/portal/checklists/${b.checklist.id}`)).status).toBe(403);
    expect((await custA.put(`/api/portal/checklists/${b.checklist.id}/items/${itemB.id}`, { status: 'sent' })).status).toBe(403);
    // item de outro checklist pelo checklist próprio
    expect((await custA.put(`/api/portal/checklists/${a.checklist.id}/items/${itemB.id}`, { status: 'sent' })).status).toBe(404);
    // CPF de outro cliente com o link de A
    const accB = await issueAccess(b.api, b.checklist.id);
    expect((await customerLogin(env, accA.token, VALID_CPFS[7], accB.code)).status).toBe(401);
    // sem token
    expect((await env.app.inject({ method: 'GET', url: `/api/portal/checklists/${a.checklist.id}` })).statusCode).toBe(401);
  });
});

describe('checklist em PDF', () => {
  it('baixa, visualiza e envia por e-mail (anexo) e WhatsApp', async () => {
    const o = await officeWithCustomer(env, VALID_CPFS[3]);
    await addPreviousYear(env, o.officeId, o.customerId, YEAR - 1, [{ kind: 'asset', groupCode: '01', description: 'Apartamento' }]);
    // sem checklist digital: usa a mesma montagem do ano anterior
    const pdf = await env.app.inject({ method: 'GET', url: `/api/customers/${o.customerId}/checklist-pdf?year=${YEAR}`, headers: { authorization: `Bearer ${o.token}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/^attachment/);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    const sent = await o.api.post(`/api/customers/${o.customerId}/checklist-pdf/send`, { year: YEAR, channel: 'email' });
    expect(sent.status).toBe(200);
    await o.api.post(`/api/customers/${o.customerId}/checklist-pdf/send`, { year: YEAR, channel: 'whatsapp' });
    await env.ctx.jobs.drain();
    const mail = env.providers.sentEmails.find((m) => m.to === o.customerEmail && m.subject.includes('Checklist'));
    expect(mail?.attachments?.[0].filename).toBe(`checklist-irpf-${YEAR}.pdf`);
    expect(mail?.attachments?.[0].content.subarray(0, 4).toString()).toBe('%PDF');
    const wa = env.providers.sentWhatsApp.filter((m) => m.officeId === o.officeId).at(-1);
    expect(wa?.document?.filename).toBe(`checklist-irpf-${YEAR}.pdf`);

    // permissões: só visualizar não permite baixar nem enviar
    const viewer = await createEmployee(env, o.api, ['customer.list', 'checklist_pdf.view']);
    expect((await viewer.api.get(`/api/customers/${o.customerId}/checklist-pdf?year=${YEAR}&inline=1`)).status).toBe(200);
    expect((await viewer.api.get(`/api/customers/${o.customerId}/checklist-pdf?year=${YEAR}`)).status).toBe(403);
    expect((await viewer.api.post(`/api/customers/${o.customerId}/checklist-pdf/send`, { year: YEAR, channel: 'email' })).status).toBe(403);
    const other = await registerOffice(env);
    expect((await other.api.get(`/api/customers/${o.customerId}/checklist-pdf?year=${YEAR}`)).status).toBe(404);
  });
});
