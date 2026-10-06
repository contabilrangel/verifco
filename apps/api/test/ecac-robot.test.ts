/**
 * Robô do eCAC pelo SERPRO Integra Contador (COB-1, DAD-2 e INT-15): caixa postal, situação
 * fiscal, pagamentos das quotas, um job por cliente com o pai somando o andamento, rodada
 * diária e a situação do login do procurador dono do certificado.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { brazilToday } from '@verifco/shared';
import { auditLogs, customers, darfs, declarations, ecacRecords, integrations, jobs, procurators } from '../src/db/schema';
import type { Providers } from '../src/integrations/providers';
import { clearSerproTokens } from '../src/integrations/serpro';
import { DAILY_TRIGGER, nextDailyRun, registerJobs, robotTiming, scheduleEcacDailySync } from '../src/modules/ecac/jobs';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
const realFetch = globalThis.fetch;
let waits: number[] = [];
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(() => {
  clearSerproTokens();
  env.providers.fetch = realFetch;
  (env.ctx.providers as Providers).mtlsRequest = async () => ({ status: 200, body: JSON.stringify({ access_token: 'acesso', jwt_token: 'jwt', expires_in: 2000 }) });
  waits = [];
  robotTiming.sleep = async (ms) => {
    waits.push(ms);
  };
});

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

interface GatewayCall {
  tipo: string;
  servico: string;
  contribuinte: string;
  dados: any;
}
type GatewayReply = { status?: number; dados?: unknown; mensagens?: { codigo: string; texto: string }[] };

/** Gateway do Integra Contador simulado: responde por serviço (e pela vez da chamada ao serviço). */
function serproGateway(handler: (c: GatewayCall, n: number) => GatewayReply | undefined) {
  const calls: GatewayCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const raw = body.pedidoDados?.dados;
    const call = { tipo: url.split('/').pop()!, servico: body.pedidoDados?.idServico, contribuinte: body.contribuinte?.numero, dados: raw ? JSON.parse(raw) : '' };
    calls.push(call);
    const r = handler(call, calls.filter((c) => c.servico === call.servico && c.contribuinte === call.contribuinte).length) ?? {};
    const status = r.status ?? 200;
    const text = JSON.stringify({ status, dados: JSON.stringify(r.dados ?? {}), mensagens: r.mensagens ?? [] });
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

async function officeWithSerpro() {
  const office = await registerOffice(env);
  const file = await env.ctx.files.save({ officeId: office.officeId, data: Buffer.from('pfx-falso'), filename: 'escritorio.pfx', mimeType: 'application/x-pkcs12' });
  const [cert] = await env.ctx.db
    .insert(procurators)
    .values({
      officeId: office.officeId,
      name: 'Escritório (e-CNPJ)',
      cpfCnpj: '11222333000181',
      authType: 'certificate_cloud',
      certificateFileId: file.id,
      certificatePasswordEnc: env.ctx.secrets.encrypt('senha-do-pfx'),
      certificateExpiresAt: '2099-12-31',
    })
    .returning();
  const saved = await office.api.put('/api/integrations/serpro', {
    enabled: true,
    config: { contractorCnpj: '11.222.333/0001-81', procuratorId: cert.id },
    secrets: { consumerKey: 'consumer-key', consumerSecret: 'consumer-secret' },
  });
  expect(saved.status).toBe(200);
  const addCustomer = async (name: string, cpf: string) => {
    const c = await office.api.post('/api/customers', { name, cpfCnpj: cpf });
    await office.api.post('/api/customers/bulk', { ids: [c.body.id], action: 'procurator', value: cert.id });
    return c.body.id as string;
  };
  return { ...office, cert, addCustomer };
}

const procurationOk = { dados: [{ dtexpiracao: '20301231', nrsistemas: 1 }] };
const pdf = Buffer.from('%PDF-1.4\n% relatório de situação fiscal\n%%EOF\n');

describe('sincronização pelo SERPRO (COB-1)', () => {
  it('grava a caixa postal sem duplicar, a situação fiscal com o PDF e marca as quotas pagas', async () => {
    const office = await officeWithSerpro();
    const customerId = await office.addCustomer('Maria Contribuinte', VALID_CPFS[0]);
    const today = brazilToday();
    const [decl] = await env.ctx.db.insert(declarations).values({ officeId: office.officeId, customerId, exerciseYear: Number(today.slice(0, 4)) }).returning();
    const quota = (quotaNumber: number, dueDate: string, valueCents: number, source = 'generated') =>
      env.ctx.db.insert(darfs).values({ officeId: office.officeId, customerId, declarationId: decl.id, quotaNumber, dueDate, valueCents, source }).returning();
    const d1 = addDays(today, -5);
    const d2 = addDays(today, 3);
    const d3 = addDays(today, 60);
    const d4 = addDays(today, -2);
    const [q1] = await quota(1, d1, 150_000);
    const [q2] = await quota(2, d2, 151_500, 'edited');
    const [q3] = await quota(3, d3, 150_000);
    const [q4] = await quota(4, d4, 9_900);
    const doc = (n: string, revenue: string, due: string, paidOn: string, principal: number, total: number) => ({
      numeroDocumento: n,
      tipo: { codigo: '4', descricao: 'DOCUMENTO DE ARRECADAÇÃO DE RECEITAS FEDERAIS', descricaoAbreviada: 'DARF' },
      dataArrecadacao: `${paidOn}T00:00:00-03:00`,
      dataVencimento: `${due}T00:00:00-03:00`,
      receitaPrincipal: { codigo: revenue, descricao: 'IRPF', extensaoReceita: null },
      valorTotal: total,
      valorPrincipal: principal,
      desmembramentos: [{ sequencial: '1', receitaPrincipal: { codigo: revenue }, dataVencimento: `${due}T00:00:00-03:00`, valorTotal: null }],
    });
    const gateway = serproGateway((c, n) => {
      switch (c.servico) {
        case 'OBTERPROCURACAO41':
          return procurationOk;
        case 'INNOVAMSG63':
          return { dados: { codigo: '00', conteudo: [{ indicadorMensagensNovas: '1' }] } };
        case 'MSGCONTRIBUINTE61':
          return {
            dados: {
              codigo: '00',
              conteudo: [
                {
                  quantidadeMensagens: '2',
                  indicadorUltimaPagina: 'S',
                  listaMensagens: [
                    { isn: '0001626772', assuntoModelo: '[IRPF] Declaração do exercício ++VARIAVEL++ processada', valorParametroAssunto: '2026', dataEnvio: '20260408', indicadorLeitura: '0', dataLeitura: '', relevancia: '2', descricaoOrigem: 'RECEITA FEDERAL DO BRASIL', numeroControle: '2026/000000000032113' },
                    { isn: '0001626771', assuntoModelo: 'Termo de intimação', valorParametroAssunto: '', dataEnvio: '20260301', indicadorLeitura: '1', dataLeitura: '20260302', relevancia: '1', descricaoOrigem: 'RECEITA FEDERAL DO BRASIL', numeroControle: '2026/000000000032112' },
                  ],
                },
              ],
            },
          };
        case 'SOLICITARPROTOCOLO91':
          return { dados: { protocoloRelatorio: 'PROTO+abc/123==', tempoEspera: 1500 } };
        case 'RELATORIOSITFIS92':
          return n === 1 ? { status: 202, dados: { tempoEspera: 4000 }, mensagens: [{ codigo: '[Sucesso-Sitfis-SC02]', texto: 'Em processamento.' }] } : { dados: [{ pdf: pdf.toString('base64') }] };
        case 'PAGAMENTOS71':
          return {
            dados: [
              doc('07201', '211', d1, d1, 1500, 1500),
              doc('07202', '211', d2, addDays(today, -1), 1500, 1515),
              doc('07203', '190', d4, d4, 99, 99),
              doc('07204', '0211', d3, addDays(today, -1), 1500, 1500),
            ],
          };
      }
      return undefined;
    });
    env.providers.fetch = gateway.fn;

    const res = await office.api.post('/api/robot/sync-office');
    expect(res.status).toBe(202);
    await env.ctx.jobs.drain();

    // caixa postal: as duas mensagens, com o assunto montado e a leitura do e-CAC
    const mailbox = await env.ctx.db.select().from(ecacRecords).where(and(eq(ecacRecords.customerId, customerId), eq(ecacRecords.kind, 'mailbox_message')));
    expect(mailbox.map((r) => r.data.externalId).sort()).toEqual(['0001626771', '0001626772']);
    const unreadRow = mailbox.find((r) => r.data.externalId === '0001626772')!;
    expect(unreadRow.data).toMatchObject({ subject: '[IRPF] Declaração do exercício 2026 processada', receivedAt: '2026-04-08', read: false, relevant: true });
    expect(mailbox.find((r) => r.data.externalId === '0001626771')!.data.read).toBe(true);
    let row = await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, customerId) });
    expect(row!.ecacMailboxMessages).toBe(1);

    // situação fiscal: protocolo, espera indicada, relatório pendente e depois o PDF
    expect(waits).toEqual([1500, 4000]);
    const report = gateway.calls.filter((c) => c.servico === 'RELATORIOSITFIS92');
    expect(report).toHaveLength(2);
    expect(report[0]).toMatchObject({ tipo: 'Emitir', dados: { protocoloRelatorio: 'PROTO+abc/123==' } });
    const fiscal = await env.ctx.db.select().from(ecacRecords).where(and(eq(ecacRecords.customerId, customerId), eq(ecacRecords.kind, 'fiscal_situation')));
    expect(fiscal).toHaveLength(1);
    expect(fiscal[0]).toMatchObject({ source: 'serpro', data: expect.objectContaining({ issuedAt: today }) });
    const stored = await env.ctx.files.get(office.officeId, fiscal[0].fileId!);
    expect(stored.data.equals(pdf)).toBe(true);
    expect(stored.row.mimeType).toBe('application/pdf');
    const panel = (await office.api.get(`/api/customers/${customerId}/ecac`)).body;
    expect(panel.simplified).toMatchObject({ kind: 'fiscal_situation', fileId: fiscal[0].fileId });
    expect(panel.mailbox[0].subject).toBe('[IRPF] Declaração do exercício 2026 processada');

    // pagamentos: receita 0211 no período das quotas; paga a de mesmo vencimento e valor (principal ou total)
    const payments = gateway.calls.filter((c) => c.servico === 'PAGAMENTOS71');
    expect(payments).toHaveLength(1);
    expect(payments[0].dados).toEqual({
      codigoReceitaLista: ['0211'],
      intervaloDataArrecadacao: { dataInicial: `${d1.slice(0, 4)}-01-01`, dataFinal: today },
      primeiroDaPagina: 0,
      tamanhoDaPagina: 100,
    });
    const quotaRow = async (id: string) => (await env.ctx.db.query.darfs.findFirst({ where: eq(darfs.id, id) }))!;
    expect(await quotaRow(q1.id)).toMatchObject({ status: 'paid', paidAt: d1 });
    expect(await quotaRow(q2.id)).toMatchObject({ status: 'paid', paidAt: addDays(today, -1) });
    // outra receita não paga a quota; a quota longe do vencimento não é conferida pela rotina
    expect(await quotaRow(q4.id)).toMatchObject({ status: 'open', paidAt: null });
    expect(await quotaRow(q3.id)).toMatchObject({ status: 'open', paidAt: null });
    const paidLogs = await env.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.officeId, office.officeId), eq(auditLogs.action, 'darf.serpro_paid')));
    expect(paidLogs.map((l) => l.entityId).sort()).toEqual([q1.id, q2.id].sort());

    // resultado do cliente e aviso de conclusão para quem pediu
    const child = await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'ecac.sync'), eq(jobs.officeId, office.officeId)) });
    expect(child!.status).toBe('done');
    expect(child!.result!.steps).toEqual(
      expect.arrayContaining(['mensagens da caixa postal: 2 consultada(s), 2 nova(s)', 'situação fiscal: relatório emitido', 'pagamentos do DARF: 2 de 3 quota(s) em aberto encontrada(s) paga(s)']),
    );
    const overview = (await office.api.get('/api/robot/overview')).body;
    expect(overview.lastOfficeSync).toMatchObject({ status: 'done', progress: 100, result: expect.objectContaining({ total: 1, ok: 1, failed: 0 }) });
    const notes = (await office.api.get('/api/notifications')).body.filter((n: any) => n.title === 'Sincronização eCAC concluída');
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('1 de 1 cliente(s) sincronizado(s).');

    // de novo: mensagens não duplicam, a situação fiscal não é pedida outra vez (30 dias)
    expect((await office.api.post('/api/robot/sync-office')).status).toBe(202);
    await env.ctx.jobs.drain();
    const again = await env.ctx.db.select().from(ecacRecords).where(and(eq(ecacRecords.customerId, customerId), eq(ecacRecords.kind, 'mailbox_message')));
    expect(again).toHaveLength(2);
    expect(gateway.calls.filter((c) => c.servico === 'SOLICITARPROTOCOLO91')).toHaveLength(1);
    // procuração e indicador ficam num registro só por cliente (a rotina diária não acumula cópias)
    const snapshots = await env.ctx.db.select().from(ecacRecords).where(and(eq(ecacRecords.customerId, customerId), eq(ecacRecords.source, 'serpro')));
    expect(snapshots.filter((r) => r.kind === 'procuration')).toHaveLength(1);
    expect(snapshots.filter((r) => r.kind === 'other')).toHaveLength(1);

    // o pedido de um cliente só confere também a quota longe do vencimento
    const one = await office.api.post(`/api/customers/${customerId}/ecac/sync`);
    expect(one.status).toBe(202);
    await env.ctx.jobs.drain();
    expect(await quotaRow(q3.id)).toMatchObject({ status: 'paid', paidAt: addDays(today, -1) });
    expect(await quotaRow(q4.id)).toMatchObject({ status: 'open' });
    // o relatório do dia já existe: não pede outro
    expect(gateway.calls.filter((c) => c.servico === 'SOLICITARPROTOCOLO91')).toHaveLength(1);
    row = await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, customerId) });
    expect(row!.ecacMailboxMessages).toBe(1);
  });

  it('sem mensagem nova nem pendente, não consulta a lista (bilhetada); procuração vencida pula as consultas', async () => {
    const office = await officeWithSerpro();
    const customerId = await office.addCustomer('João', VALID_CPFS[1]);
    let expired = false;
    const gateway = serproGateway((c) => {
      if (c.servico === 'OBTERPROCURACAO41') return expired ? { dados: [{ dtexpiracao: '20200131' }] } : procurationOk;
      if (c.servico === 'INNOVAMSG63') return { dados: { codigo: '00', conteudo: [{ indicadorMensagensNovas: '0' }] } };
      if (c.servico === 'SOLICITARPROTOCOLO91') return { dados: { tempoEspera: 30000 } };
      return undefined;
    });
    env.providers.fetch = gateway.fn;
    await office.api.post('/api/robot/sync-office');
    await env.ctx.jobs.drain();
    expect(gateway.calls.map((c) => c.servico)).toEqual(['OBTERPROCURACAO41', 'INNOVAMSG63', 'SOLICITARPROTOCOLO91']);
    const child = await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'ecac.sync'), eq(jobs.officeId, office.officeId)) });
    expect(child!.result!.steps).toContain('situação fiscal: o SERPRO não liberou o protocolo agora; nova tentativa na próxima sincronização');
    expect((await env.ctx.db.select().from(ecacRecords).where(and(eq(ecacRecords.customerId, customerId), eq(ecacRecords.kind, 'fiscal_situation')))).length).toBe(0);

    expired = true;
    gateway.calls.length = 0;
    await office.api.post(`/api/customers/${customerId}/ecac/sync`);
    await env.ctx.jobs.drain();
    expect(gateway.calls.map((c) => c.servico)).toEqual(['OBTERPROCURACAO41', 'INNOVAMSG63']);
    const last = (await office.api.get(`/api/customers/${customerId}/ecac`)).body.lastSync;
    expect(last.result.steps).toContain('demais consultas não feitas: a procuração eletrônica venceu');
  });
});

describe('sincronização geral em um job por cliente (DAD-2)', () => {
  it('retoma o pai quando um filho foi abandonado sem tentativas e não perde o aviso (A + E)', async () => {
    const office = await officeWithSerpro();
    const customerId = await office.addCustomer('Cliente interrompido', VALID_CPFS[0]);
    const parent = await env.ctx.jobs.enqueue('ecac.sync_office', {}, { officeId: office.officeId, userId: office.userId, maxAttempts: 1 });
    await env.ctx.db.update(jobs).set({ status: 'running', attempts: 1, lockedAt: null, payload: { fanout: { total: 1, ok: 0, failed: 0, errors: [] } } }).where(eq(jobs.id, parent.id));
    await env.ctx.db.insert(jobs).values({ type: 'ecac.sync', officeId: office.officeId, parentId: parent.id, status: 'running', attempts: 2, maxAttempts: 2, lockedAt: new Date(Date.now() - 600_000), payload: { customerId, customerName: 'Cliente interrompido', parentJobId: parent.id } });
    await env.ctx.jobs.drain();
    const overview = (await office.api.get('/api/robot/overview')).body;
    expect(overview.lastOfficeSync).toMatchObject({ id: parent.id, status: 'done', result: { total: 1, ok: 0, failed: 1, errors: [expect.objectContaining({ customerId, error: expect.stringContaining('interrompida') })] } });
    await env.ctx.jobs.drain();
    const notes = (await office.api.get('/api/notifications')).body.filter((n: any) => n.title === 'Sincronização eCAC concluída');
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('0 de 1 cliente(s) sincronizado(s), 1 com erro.');
  });

  it('o pai soma o andamento dos clientes e avisa quem pediu quando o último termina', async () => {
    const office = await officeWithSerpro();
    const requester = await createEmployee(env, office.api, ['ecac.sync']);
    await office.addCustomer('Ana Primeira', VALID_CPFS[2]);
    const failing = await office.addCustomer('Bruno Segundo', VALID_CPFS[3]);
    // sem procurador e inativo não entram
    await office.api.post('/api/customers', { name: 'Carla Sem Procurador', cpfCnpj: VALID_CPFS[4] });
    const inactive = await office.addCustomer('Davi Inativo', VALID_CPFS[5]);
    await env.ctx.db.update(customers).set({ status: 'inactive' }).where(eq(customers.id, inactive));
    env.providers.fetch = serproGateway((c) => {
      if (c.servico === 'OBTERPROCURACAO41' && c.contribuinte === VALID_CPFS[3]) {
        return { status: 403, mensagens: [{ codigo: '[AcessoNegado-ICGERENCIADOR-022]', texto: 'Procuração não encontrada.' }] };
      }
      if (c.servico === 'OBTERPROCURACAO41') return procurationOk;
      if (c.servico === 'INNOVAMSG63') return { dados: { codigo: '00', conteudo: [{ indicadorMensagensNovas: '0' }] } };
      return undefined;
    }).fn;

    const res = await requester.api.post('/api/robot/sync-office');
    expect(res.status).toBe(202);
    await env.ctx.jobs.drain();
    const children = await env.ctx.db.select().from(jobs).where(and(eq(jobs.type, 'ecac.sync'), eq(jobs.officeId, office.officeId)));
    expect(children).toHaveLength(2);
    expect(children.every((j) => j.payload.parentJobId === res.body.job.id && j.createdByUserId === requester.userId)).toBe(true);
    // o cliente com erro ainda tem nova tentativa: a sincronização segue em andamento
    const failed = children.find((j) => j.payload.customerId === failing)!;
    expect(failed.status).toBe('queued');
    let overview = (await requester.api.get('/api/robot/overview')).body;
    expect(overview.lastOfficeSync).toMatchObject({ id: res.body.job.id, status: 'running', progress: 50, result: expect.objectContaining({ total: 2, ok: 1, failed: 0 }) });
    expect((await requester.api.post('/api/robot/sync-office')).body.alreadyQueued).toBe(true);
    const doneNotes = async () => (await requester.api.get('/api/notifications')).body.filter((n: any) => n.title === 'Sincronização eCAC concluída');
    expect(await doneNotes()).toHaveLength(0);

    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, failed.id));
    await env.ctx.jobs.drain();
    overview = (await requester.api.get('/api/robot/overview')).body;
    expect(overview.lastOfficeSync).toMatchObject({ status: 'done', progress: 100, result: expect.objectContaining({ total: 2, ok: 1, failed: 1 }) });
    expect(overview.lastOfficeSync.result.errors).toEqual([expect.objectContaining({ customerId: failing, name: 'Bruno Segundo', error: expect.stringContaining('Procuração não encontrada') })]);
    const notes = await doneNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: requester.userId, body: '1 de 2 cliente(s) sincronizado(s), 1 com erro.' });
    // só um aviso, mesmo com outra rodada de drain
    await env.ctx.jobs.drain();
    expect(await doneNotes()).toHaveLength(1);
  });

  it('sem clientes com procurador, termina na hora com o aviso de 0 de 0', async () => {
    const office = await officeWithSerpro();
    const res = await office.api.post('/api/robot/sync-office');
    await env.ctx.jobs.drain();
    const overview = (await office.api.get('/api/robot/overview')).body;
    expect(overview.lastOfficeSync).toMatchObject({ id: res.body.job.id, status: 'done', result: expect.objectContaining({ total: 0 }) });
    const notes = (await office.api.get('/api/notifications')).body.filter((n: any) => n.title === 'Sincronização eCAC concluída');
    expect(notes.map((n: any) => n.body)).toEqual(['0 de 0 cliente(s) sincronizado(s).']);
  });
});

describe('rodada diária do robô', () => {
  it('nextDailyRun cai entre 3h e 6h de Brasília, sempre depois de agora', () => {
    for (const now of [new Date('2026-10-06T12:00:00Z'), new Date('2026-10-06T05:00:00Z'), new Date('2026-12-31T23:30:00Z')]) {
      const at = nextDailyRun('2f1d0c9e-7b55-4c1c-9a0b-3d4e5f6a7b8c', now);
      // 3h–6h em Brasília = 6h–9h UTC
      expect(at.getUTCHours()).toBeGreaterThanOrEqual(6);
      expect(at.getUTCHours()).toBeLessThan(9);
      expect(at.getTime()).toBeGreaterThan(now.getTime());
      expect(at.getTime() - now.getTime()).toBeLessThanOrEqual(86_400_000);
    }
  });

  it('agenda uma por escritório e dia (idempotente), encadeia a próxima e para com o SERPRO desativado', async () => {
    const office = await officeWithSerpro();
    const daily = () =>
      env.ctx.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, 'ecac.sync_office'), eq(jobs.officeId, office.officeId)));
    let rows = await daily();
    expect(rows).toHaveLength(1);
    const first = rows[0];
    expect(first).toMatchObject({ status: 'queued', payload: { trigger: DAILY_TRIGGER }, idempotencyKey: `daily:${office.officeId}:${brazilToday(first.runAt)}` });
    expect(first.runAt.getTime()).toBeGreaterThan(Date.now());

    // agendar de novo (outro salvamento, nova chamada, API reiniciando) não duplica
    expect((await scheduleEcacDailySync(env.ctx, office.officeId)).id).toBe(first.id);
    await office.api.put('/api/integrations/serpro', { enabled: true });
    await registerJobs(env.ctx);
    expect(await daily()).toHaveLength(1);
    const overview = (await office.api.get('/api/robot/overview')).body;
    expect(new Date(overview.nextAutoSync).getTime()).toBe(first.runAt.getTime());
    // a rodada futura não aparece como a última nem segura o botão manual
    expect(overview.lastOfficeSync).toBeNull();
    const manual = await office.api.post('/api/robot/sync-office');
    expect(manual.body.alreadyQueued).toBe(false);
    await env.ctx.jobs.drain();

    // chegou a hora: agenda a do dia seguinte antes de sincronizar
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, first.id));
    await env.ctx.jobs.drain();
    rows = await daily();
    const ran = rows.find((r) => r.id === first.id)!;
    expect(ran.status).toBe('done');
    const next = rows.filter((r) => r.payload.trigger === DAILY_TRIGGER && r.status === 'queued');
    expect(next).toHaveLength(1);
    expect(next[0].runAt.getTime()).toBeGreaterThan(Date.now());
    expect(next[0].idempotencyKey).toBe(`daily:${office.officeId}:${brazilToday(next[0].runAt)}`);
    // sempre um dia depois do que rodou (mesmo que esta tenha rodado antes da hora marcada)
    expect(brazilToday(next[0].runAt) > brazilToday(first.runAt)).toBe(true);
    // a rodada automática sem erro não enche o sino
    expect((await office.api.get('/api/notifications')).body.filter((n: any) => /automática/.test(n.title))).toHaveLength(0);

    // desativar o SERPRO tira da fila a próxima rodada
    await office.api.put('/api/integrations/serpro', { enabled: false });
    expect((await daily()).filter((r) => r.status === 'queued')).toHaveLength(0);
    // e uma rodada que já estava na fila não roda nem reagenda
    const stale = await env.ctx.jobs.enqueue('ecac.sync_office', { trigger: DAILY_TRIGGER }, { officeId: office.officeId, maxAttempts: 1 });
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, stale.id) }))!.result).toMatchObject({ skipped: true });
    expect((await daily()).filter((r) => r.status === 'queued')).toHaveLength(0);
  });

  it('ao subir a API, escritórios com SERPRO ativo ganham a rodada que faltar', async () => {
    const office = await officeWithSerpro();
    await env.ctx.db.delete(jobs).where(and(eq(jobs.type, 'ecac.sync_office'), eq(jobs.officeId, office.officeId)));
    await registerJobs(env.ctx);
    const rows = await env.ctx.db.select().from(jobs).where(and(eq(jobs.type, 'ecac.sync_office'), eq(jobs.officeId, office.officeId)));
    expect(rows).toEqual([expect.objectContaining({ status: 'queued', payload: { trigger: DAILY_TRIGGER } })]);
    // SERPRO desativado direto no banco: não agenda
    await env.ctx.db.delete(jobs).where(eq(jobs.id, rows[0].id));
    await env.ctx.db.update(integrations).set({ enabled: false }).where(and(eq(integrations.officeId, office.officeId), eq(integrations.provider, 'serpro')));
    await registerJobs(env.ctx);
    expect(await env.ctx.db.select().from(jobs).where(and(eq(jobs.type, 'ecac.sync_office'), eq(jobs.officeId, office.officeId)))).toHaveLength(0);
  });
});

describe('login do procurador dono do certificado (INT-15)', () => {
  const procurator = async (id: string) => (await env.ctx.db.query.procurators.findFirst({ where: eq(procurators.id, id) }))!;
  const dashboardLogin = async (api: Awaited<ReturnType<typeof registerOffice>>['api']) =>
    (await api.get(`/api/dashboard?year=${new Date().getFullYear()}`)).body.charts.procuratorLogin;

  it('o teste da integração grava ok, erro do certificado ou vencido; falha de rede não muda', async () => {
    const office = await officeWithSerpro();
    expect((await procurator(office.cert.id)).loginStatus).toBe('unknown');

    const ok = await office.api.post('/api/integrations/serpro/test');
    expect(ok.body.ok).toBe(true);
    let p = await procurator(office.cert.id);
    expect(p.loginStatus).toBe('ok');
    expect(p.lastValidatedAt).toBeInstanceOf(Date);
    expect(await dashboardLogin(office.api)).toMatchObject({ loginOk: 1, loginError: 0 });

    (env.ctx.providers as Providers).mtlsRequest = async () => {
      throw Object.assign(new Error('mac verify failure'), { code: 'ERR_CRYPTO' });
    };
    expect((await office.api.post('/api/integrations/serpro/test')).body.ok).toBe(false);
    expect((await procurator(office.cert.id)).loginStatus).toBe('error');
    expect(await dashboardLogin(office.api)).toMatchObject({ loginOk: 0, loginError: 1 });

    (env.ctx.providers as Providers).mtlsRequest = async () => ({ status: 401, body: '{}' });
    await office.api.post('/api/integrations/serpro/test');
    expect((await procurator(office.cert.id)).loginStatus).toBe('error');

    // timeout não diz nada sobre o certificado
    await env.ctx.db.update(procurators).set({ loginStatus: 'ok' }).where(eq(procurators.id, office.cert.id));
    (env.ctx.providers as Providers).mtlsRequest = async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    };
    expect((await office.api.post('/api/integrations/serpro/test')).body.ok).toBe(false);
    expect((await procurator(office.cert.id)).loginStatus).toBe('ok');

    await env.ctx.db.update(procurators).set({ certificateExpiresAt: '2020-01-31' }).where(eq(procurators.id, office.cert.id));
    expect((await office.api.post('/api/integrations/serpro/test')).body.message).toContain('venceu em 31/01/2020');
    p = await procurator(office.cert.id);
    expect(p.loginStatus).toBe('expired');
    expect(await dashboardLogin(office.api)).toMatchObject({ loginOk: 0, loginError: 1 });
  });

  it('o uso pelo robô também grava o login', async () => {
    const office = await officeWithSerpro();
    await office.addCustomer('Eva', VALID_CPFS[6]);
    env.providers.fetch = serproGateway((c) => (c.servico === 'OBTERPROCURACAO41' ? procurationOk : { dados: { codigo: '00', conteudo: [{ indicadorMensagensNovas: '0' }] } })).fn;
    await office.api.post('/api/robot/sync-office');
    await env.ctx.jobs.drain();
    const p = await procurator(office.cert.id);
    expect(p.loginStatus).toBe('ok');
    expect(p.lastValidatedAt).toBeInstanceOf(Date);
  });
});
