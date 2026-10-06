import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { apiTokens, darfs, declarations, documents, jobs } from '../src/db/schema';
import { syncCustomerViaSerpro } from '../src/modules/ecac/jobs';
import { interpretMailbox, interpretProcuration } from '../src/modules/ecac/serpro';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { fakePdf, multipart, send } from './robot-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

async function officeWithToken(scope: 'sync' | 'extension' = 'sync') {
  const office = await registerOffice(env);
  const t = await office.api.post('/api/robot/tokens', { name: `Robô ${scope}`, scope });
  return { ...office, token: t.body.token as string, tokenId: t.body.id as string };
}

describe('tokens de máquina', () => {
  it('cria token vfk_ guardado só como hash, mostra uma vez e revoga', async () => {
    const office = await registerOffice(env);
    const created = await office.api.post('/api/robot/tokens', { name: 'Computador da recepção', scope: 'sync' });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^vfk_[A-Za-z0-9_-]{40,}$/);
    expect(created.body.tokenHash).toBeUndefined();
    const row = await env.ctx.db.query.apiTokens.findFirst({ where: eq(apiTokens.id, created.body.id) });
    expect(row!.tokenHash).not.toContain(created.body.token);
    expect(row!.tokenHash).toHaveLength(64);

    const list = await office.api.get('/api/robot/tokens');
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
    expect(list.body[0]).toMatchObject({ name: 'Computador da recepção', scope: 'sync', active: true, prefix: created.body.token.slice(0, 8) });

    const who = await send(env, created.body.token, 'GET', '/api/sync/whoami');
    expect(who.status).toBe(200);
    expect(who.body.token).toEqual({ name: 'Computador da recepção', scope: 'sync' });
    const used = await env.ctx.db.query.apiTokens.findFirst({ where: eq(apiTokens.id, created.body.id) });
    expect(used!.lastUsedAt).not.toBeNull();

    expect((await office.api.del(`/api/robot/tokens/${created.body.id}`)).status).toBe(200);
    expect((await send(env, created.body.token, 'GET', '/api/sync/whoami')).status).toBe(401);
    expect((await office.api.del(`/api/robot/tokens/${created.body.id}`)).status).toBe(404);
  });

  it('exige token válido, respeita o escopo e a permissão de gestão', async () => {
    const office = await registerOffice(env);
    expect((await send(env, null, 'GET', '/api/sync/customers')).status).toBe(401);
    expect((await send(env, 'vfk_invalido_mas_com_tamanho_suficiente', 'GET', '/api/sync/customers')).status).toBe(401);
    // JWT de usuário não serve para a API de máquina
    expect((await send(env, office.token, 'GET', '/api/sync/customers')).status).toBe(401);

    const ext = await office.api.post('/api/robot/tokens', { name: 'Chrome', scope: 'extension' });
    const up = await send(env, ext.body.token, 'POST', '/api/sync/files', { multipart: multipart({}, { name: '52998224725-IRPF-A-2026-2025-ORIGI.DEC', content: 'x' }) });
    expect(up.status).toBe(403);

    const emp = await createEmployee(env, office.api, ['customer.list']);
    expect((await emp.api.post('/api/robot/tokens', { name: 'X', scope: 'sync' })).status).toBe(403);
    expect((await emp.api.get('/api/robot/tokens')).status).toBe(403);

    const other = await registerOffice(env);
    expect((await other.api.del(`/api/robot/tokens/${ext.body.id}`)).status).toBe(404);
  });

  it('central de downloads entrega os pacotes da extensão e do sincronizador', async () => {
    const office = await registerOffice(env);
    const JSZip = (await import('jszip')).default;
    const ext = await env.app.inject({ method: 'GET', url: '/api/robot/downloads/extension', headers: { authorization: `Bearer ${office.token}` } });
    expect(ext.statusCode).toBe(200);
    const extZip = await JSZip.loadAsync(ext.rawPayload);
    expect(Object.keys(extZip.files)).toEqual(expect.arrayContaining(['verifco-extensao/manifest.json', 'verifco-extensao/content/parsers.js']));
    const sync = await env.app.inject({ method: 'GET', url: '/api/robot/downloads/sync', headers: { authorization: `Bearer ${office.token}` } });
    const syncZip = await JSZip.loadAsync(sync.rawPayload);
    expect(Object.keys(syncZip.files)).toEqual(expect.arrayContaining(['verifco-sincronizador/package.json', 'verifco-sincronizador/src/cli.ts']));
    expect(Object.keys(syncZip.files).some((n) => n.includes('node_modules'))).toBe(false);
    expect((await send(env, null, 'GET', '/api/robot/downloads/sync')).status).toBe(401);
    expect((await office.api.get('/api/robot/downloads/outro')).status).toBe(400);
  });

  it('lista os clientes com procurador para o robô', async () => {
    const { api, token } = await officeWithToken('extension');
    const p = await api.post('/api/procurators', { name: 'Procurador', cpfCnpj: '11.222.333/0001-81' });
    const a = await api.post('/api/customers', { name: 'Com procurador', cpfCnpj: VALID_CPFS[0] });
    await api.post('/api/customers', { name: 'Sem procurador', cpfCnpj: VALID_CPFS[1] });
    await api.post('/api/customers/bulk', { ids: [a.body.id], action: 'procurator', value: p.body.id });
    const res = await send(env, token, 'GET', '/api/sync/customers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ cpf: VALID_CPFS[0], name: 'Com procurador', procurationStatus: 'validating', procurator: { name: 'Procurador', cpfCnpj: '11222333000181' } }]);
  });
});

describe('arquivos do sincronizador', () => {
  it('vincula ao cliente pelo CPF do nome do arquivo e atualiza a declaração', async () => {
    const { api, token } = await officeWithToken('sync');
    const c = await api.post('/api/customers', { name: 'Maria', cpfCnpj: VALID_CPFS[0] });
    const name = `${VALID_CPFS[0]}-IRPF-A-2026-2025-ORIGI.DEC`;
    const up = await send(env, token, 'POST', '/api/sync/files', {
      multipart: multipart({ caminho: `C:\\Arquivos de Programas RFB\\IRPF2026\\transmitidas\\${name}` }, { name, content: 'conteudo-dec' }),
    });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ customer: { id: c.body.id }, year: 2026, type: 'dec', pattern: 'irpf', duplicate: false });
    const doc = await env.ctx.db.query.documents.findFirst({ where: eq(documents.id, up.body.documentId) });
    expect(doc).toMatchObject({ uploadedBy: 'sync', category: 'irpf_declaration', processingStatus: 'not_applicable', customerId: c.body.id });
    const decl = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, c.body.id) });
    expect(decl!.exerciseYear).toBe(2026);
    expect(decl!.sourceFileId).toBe(up.body.fileId);
    expect(decl!.elaborationStatus).toBe('ok');

    // o mesmo conteúdo não é gravado de novo
    const again = await send(env, token, 'POST', '/api/sync/files', { multipart: multipart({}, { name, content: 'conteudo-dec' }) });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);

    // PDF com CPF no início do nome e ano informado: documento a processar
    const pdf = await send(env, token, 'POST', '/api/sync/files', {
      multipart: multipart({ ano: '2026' }, { name: `${VALID_CPFS[0]} informe banco.pdf`, content: fakePdf('informe'), type: 'application/pdf' }),
    });
    expect(pdf.status).toBe(201);
    expect(pdf.body).toMatchObject({ type: 'pdf', pattern: 'cpf_prefix', elaborationStatus: 'not_processed' });
  });

  it('pede o CPF quando o nome não segue o padrão e não cruza escritórios', async () => {
    const { api, token } = await officeWithToken('sync');
    await api.post('/api/customers', { name: 'João', cpfCnpj: VALID_CPFS[1] });
    const noCpf = await send(env, token, 'POST', '/api/sync/files', { multipart: multipart({ ano: '2026' }, { name: 'declaracao.dbk', content: 'x' }) });
    expect(noCpf.status).toBe(422);
    expect(noCpf.body.error).toContain('cpf');
    const noYear = await send(env, token, 'POST', '/api/sync/files', { multipart: multipart({ cpf: VALID_CPFS[1] }, { name: 'declaracao.dbk', content: 'x' }) });
    expect(noYear.status).toBe(400);
    const ok = await send(env, token, 'POST', '/api/sync/files', { multipart: multipart({ cpf: VALID_CPFS[1], ano: '2025', tipo: 'dbk' }, { name: 'declaracao.dbk', content: 'x' }) });
    expect(ok.status).toBe(201);
    expect(ok.body.type).toBe('dbk');

    // cliente com o mesmo CPF em outro escritório não é alcançado por este token
    const other = await registerOffice(env);
    await other.api.post('/api/customers', { name: 'Outro', cpfCnpj: VALID_CPFS[2] });
    const cross = await send(env, token, 'POST', '/api/sync/files', { multipart: multipart({}, { name: `${VALID_CPFS[2]}-IRPF-A-2026-2025-ORIGI.REC`, content: 'r' }) });
    expect(cross.status).toBe(404);
    const invalid = await send(env, token, 'POST', '/api/sync/files', { multipart: multipart({ cpf: '123', ano: '2026' }, { name: 'a.pdf', content: 'x' }) });
    expect(invalid.status).toBe(400);
  });
});

describe('registros do eCAC enviados pela extensão', () => {
  it('grava os registros e aplica no cadastro (procuração, CND, caixa postal, declaração, DARF)', async () => {
    const { api, token } = await officeWithToken('extension');
    const c = await api.post('/api/customers', { name: 'Paulo', cpfCnpj: VALID_CPFS[3] });
    const cpf = VALID_CPFS[3];
    const res = await send(env, token, 'POST', '/api/sync/ecac-records', {
      json: {
        records: [
          { kind: 'procuration', cpf, data: { status: 'valid', expiresAt: '2030-01-31', govbrLevel: 'gold' } },
          { kind: 'cnd', cpf, data: { status: 'success', issuedAt: '2026-04-02', validUntil: '2026-10-01' }, file: { filename: 'cnd.pdf', mimeType: 'application/pdf', base64: fakePdf('cnd').toString('base64') } },
          { kind: 'mailbox_message', cpf, externalId: 'msg-1', data: { subject: 'Intimação', read: false } },
          { kind: 'mailbox_message', cpf, externalId: 'msg-2', data: { subject: 'Aviso', read: true } },
          { kind: 'declaration', cpf, year: 2026, externalId: '12.34.56.78.90-12', data: { status: 'processed', type: 'Ajuste anual', isRectification: false, taxation: 'simplified', receiptNumber: '1234567890' } },
          { kind: 'darf', cpf, year: 2026, data: { valueCents: 15000, dueDate: '2026-05-29', quotaNumber: 1 } },
          { kind: 'income_statement', cpf, year: 2026, data: { issuedAt: '2026-03-10', description: 'Extrato DIRPF' } },
          { kind: 'cnd', cpf: VALID_CPFS[7], data: { status: 'success' } },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(7);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[7]).toMatchObject({ ok: false, status: 404 });

    // reenviar a mesma mensagem não duplica
    await send(env, token, 'POST', '/api/sync/ecac-records', { json: { kind: 'mailbox_message', cpf, externalId: 'msg-1', data: { subject: 'Intimação', read: false } } });

    const panel = (await api.get(`/api/customers/${c.body.id}/ecac`)).body;
    expect(panel.procuration).toMatchObject({ status: 'valid', expiresAt: '2030-01-31', govbrLevel: 'gold', mailboxMessages: 1 });
    expect(panel.cnd.status).toBe('success');
    expect(panel.cnd.latest.fileId).toBeTruthy();
    expect(panel.cnd.latest.validUntil).toBe('2026-10-01');
    expect(panel.mailbox).toHaveLength(2);
    expect(panel.declarations[0]).toMatchObject({ year: 2026, status: 'processed', isRectification: false, taxation: 'simplified', source: 'extension' });
    expect(panel.darfs[0]).toMatchObject({ valueCents: 15000, dueDate: '2026-05-29', source: 'ecac', year: 2026 });
    expect(panel.incomeStatements[0]).toMatchObject({ year: 2026, issuedAt: '2026-03-10' });
    const decl = await env.ctx.db.query.declarations.findFirst({ where: eq(declarations.customerId, c.body.id) });
    expect(decl).toMatchObject({ ecacStatus: 'processed', taxation: 'simplified', receiptNumber: '1234567890' });
    const darfRows = await env.ctx.db.select().from(darfs).where(eq(darfs.customerId, c.body.id));
    expect(darfRows).toHaveLength(1);

    // token do sincronizador não envia registros interpretados
    const syncTok = await api.post('/api/robot/tokens', { name: 'Sync', scope: 'sync' });
    expect((await send(env, syncTok.body.token, 'POST', '/api/sync/ecac-records', { json: { kind: 'cnd', cpf, data: {} } })).status).toBe(403);
  });
});

describe('aba eCAC do cliente', () => {
  it('mostra credenciais só como configuradas e o aviso da CND automática', async () => {
    const { api } = await registerOffice(env);
    const c = await api.post('/api/customers', { name: 'Lia', cpfCnpj: VALID_CPFS[4] });
    let panel = (await api.get(`/api/customers/${c.body.id}/ecac`)).body;
    expect(panel.credentials).toEqual({ hasLogin: false, hasPassword: false });
    expect(panel.cnd.autoGenerateCnd).toBe(false);
    expect(panel.lastSync).toBeNull();

    await api.put(`/api/customers/${c.body.id}/credentials`, { ecacLogin: VALID_CPFS[4], ecacPassword: 'senha-secreta' });
    await api.put('/api/office/settings', { autoGenerateCnd: true });
    const res = await api.get(`/api/customers/${c.body.id}/ecac`);
    panel = res.body;
    expect(panel.credentials).toEqual({ hasLogin: true, hasPassword: true });
    expect(panel.cnd.autoGenerateCnd).toBe(true);
    expect(res.raw.body).not.toContain('senha-secreta');
    expect(res.raw.body).not.toContain('ecacPasswordEnc');
  });

  it('solicitar sincronização enfileira ecac.sync e registra erro claro sem SERPRO', async () => {
    const { api } = await registerOffice(env);
    const c = await api.post('/api/customers', { name: 'Rui', cpfCnpj: VALID_CPFS[5] });
    const first = await api.post(`/api/customers/${c.body.id}/ecac/sync`);
    expect(first.status).toBe(202);
    expect(first.body.job.type).toBe('ecac.sync');
    const second = await api.post(`/api/customers/${c.body.id}/ecac/sync`);
    expect(second.body.alreadyQueued).toBe(true);
    expect(second.body.job.id).toBe(first.body.job.id);
    await env.ctx.jobs.drain();
    const panel = (await api.get(`/api/customers/${c.body.id}/ecac`)).body;
    expect(panel.lastSync.status).toBe('failed');
    expect(panel.lastSync.error).toMatch(/SERPRO/);
    // nada foi inventado: sem registros e cadastro intacto
    expect(panel.declarations).toEqual([]);
    expect(panel.procuration.status).toBe('none');

    const office = await api.post('/api/robot/sync-office');
    expect(office.status).toBe(202);
    await env.ctx.jobs.drain();
    const overview = (await api.get('/api/robot/overview')).body;
    expect(overview.lastOfficeSync.status).toBe('failed');
    expect(overview.lastOfficeSync.error).toMatch(/SERPRO não configurada/);
    // sem a integração (ou sem configurá-la no escritório) nunca aparece como ativa
    expect(['missing', 'not_configured']).toContain(overview.serpro);
  });

  it('sincronização geral que falha (sem SERPRO) avisa quem pediu no sino, só na última tentativa', async () => {
    const office = await registerOffice(env);
    const requester = await createEmployee(env, office.api, ['ecac.sync']);
    const colleague = await createEmployee(env, office.api, ['ecac.sync']);
    const failedNotes = async (a: typeof office.api) => (await a.get('/api/notifications')).body.filter((n: any) => n.title === 'Sincronização do eCAC falhou');

    const res = await requester.api.post('/api/robot/sync-office');
    expect(res.status).toBe(202);
    await env.ctx.jobs.drain();
    const job = await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, res.body.job.id) });
    expect(job!.status).toBe('failed');
    const mine = await failedNotes(requester.api);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ userId: requester.userId, link: '/admin/robo', body: job!.error });
    expect(mine[0].body).toMatch(/SERPRO não configurada/);
    // o aviso é de quem pediu, não do escritório inteiro
    expect(await failedNotes(colleague.api)).toHaveLength(0);
    expect((await requester.api.get('/api/notifications')).body.some((n: any) => n.title === 'Sincronização eCAC concluída')).toBe(false);

    // com nova tentativa prevista, ainda não avisa; avisa uma vez quando esgota
    const retried = await env.ctx.jobs.enqueue('ecac.sync_office', {}, { officeId: office.officeId, userId: colleague.userId, maxAttempts: 2 });
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, retried.id) }))!.status).toBe('queued');
    expect(await failedNotes(colleague.api)).toHaveLength(0);
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, retried.id));
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, retried.id) }))!.status).toBe('failed');
    expect(await failedNotes(colleague.api)).toHaveLength(1);
  });

  it('interpreta as respostas do SERPRO de forma defensiva (cliente falso injetado)', async () => {
    const { api } = await registerOffice(env);
    const p = await api.post('/api/procurators', { name: 'Procurador', cpfCnpj: '11.222.333/0001-81' });
    const c = await api.post('/api/customers', { name: 'Sara', cpfCnpj: VALID_CPFS[2] });
    await api.post('/api/customers/bulk', { ids: [c.body.id], action: 'procurator', value: p.body.id });
    const calls: any[] = [];
    const fake = {
      call: async (req: any) => {
        calls.push(req);
        if (req.idSistema === 'PROCURACOES') return { pending: false, dados: [{ dtexpiracao: '20300131', nrsistemas: 1 }] };
        return { pending: false, dados: { conteudo: [{ indicadorMensagensNovas: '1' }] } };
      },
    };
    const customer = (await env.ctx.db.query.customers.findFirst({ where: (t, { eq: e }) => e(t.id, c.body.id) }))!;
    const res = await syncCustomerViaSerpro(env.ctx, fake, customer);
    expect(res.steps[0]).toContain('valid até 2030-01-31');
    expect(calls[0]).toMatchObject({ idSistema: 'PROCURACOES', idServico: 'OBTERPROCURACAO41', contribuinte: VALID_CPFS[2], dados: { outorgante: VALID_CPFS[2], outorgado: '11222333000181', tipoOutorgado: '2' } });
    const panel = (await api.get(`/api/customers/${c.body.id}/ecac`)).body;
    expect(panel.procuration).toMatchObject({ status: 'valid', expiresAt: '2030-01-31', mailboxMessages: 1 });

    // resposta sem campos reconhecíveis: registra, mas não altera o cadastro
    expect(interpretProcuration({ algo: 'x' })).toBeNull();
    expect(interpretMailbox({ outro: 'y' })).toBeNull();
    expect(interpretProcuration([{ dataExpiracao: '01/02/2020' }], '2026-10-06')).toEqual({ status: 'expired', expiresAt: '2020-02-01' });
  });

  it('lançamento manual com arquivo, remoção e permissões', async () => {
    const office = await registerOffice(env);
    const c = await office.api.post('/api/customers', { name: 'Bia', cpfCnpj: VALID_CPFS[6] });
    const mp = multipart(
      { kind: 'income_statement', year: '2026', data: JSON.stringify({ issuedAt: '2026-03-15', description: 'Extrato baixado no eCAC' }) },
      { name: 'extrato.pdf', content: fakePdf('extrato'), type: 'application/pdf' },
    );
    const created = await send(env, office.token, 'POST', `/api/customers/${c.body.id}/ecac/records`, { multipart: mp });
    expect(created.status).toBe(201);
    expect(created.body.source).toBe('manual');
    const panel = (await office.api.get(`/api/customers/${c.body.id}/ecac`)).body;
    expect(panel.incomeStatements[0]).toMatchObject({ year: 2026, issuedAt: '2026-03-15', description: 'Extrato baixado no eCAC' });
    const file = await office.api.get(`/api/files/${panel.incomeStatements[0].fileId}`);
    expect(file.status).toBe(200);

    const bad = await office.api.post(`/api/customers/${c.body.id}/ecac/records`, { kind: 'nao_existe' });
    expect(bad.status).toBe(400);

    const viewer = await createEmployee(env, office.api, ['customer.list', 'ecac.view']);
    expect((await viewer.api.get(`/api/customers/${c.body.id}/ecac`)).status).toBe(200);
    expect((await viewer.api.post(`/api/customers/${c.body.id}/ecac/sync`)).status).toBe(403);
    expect((await viewer.api.post(`/api/customers/${c.body.id}/ecac/records`, { kind: 'other' })).status).toBe(403);
    const nobody = await createEmployee(env, office.api, ['customer.list']);
    expect((await nobody.api.get(`/api/customers/${c.body.id}/ecac`)).status).toBe(403);

    expect((await office.api.del(`/api/customers/${c.body.id}/ecac/records/${created.body.id}`)).status).toBe(200);
    expect((await office.api.get(`/api/customers/${c.body.id}/ecac`)).body.incomeStatements).toEqual([]);

    // outro escritório não enxerga o cliente
    const other = await registerOffice(env);
    expect((await other.api.get(`/api/customers/${c.body.id}/ecac`)).status).toBe(404);
    expect((await other.api.post(`/api/customers/${c.body.id}/ecac/sync`)).status).toBe(404);
  });
});
