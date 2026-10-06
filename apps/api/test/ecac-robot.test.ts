/**
 * Robô do eCAC pelo SERPRO Integra Contador (COB-1, COB-6/INT-16): procuração, caixa postal
 * (lista, sem abrir o conteúdo), situação fiscal (SITFIS) e baixa das quotas pagas (PAGTOWEB),
 * com o cliente SERPRO real e fetch/mTLS simulados. Nada é inventado quando a resposta não é
 * reconhecida.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { customers, darfs, deliveries, ecacRecords, jobs, offices, procurators } from '../src/db/schema';
import { clearSerproTokens, type MtlsRequest } from '../src/integrations/serpro';
import type { Providers } from '../src/integrations/providers';
import { ECAC_SCHEDULE_JOB, nextAutoSyncAt } from '../src/modules/ecac/jobs';
import { interpretMailboxList, interpretPayments, interpretSitfisProtocol, sitfisPdf } from '../src/modules/ecac/serpro';
import { interpretSitfis, pdfText } from '../src/modules/ecac/sitfis';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(() => {
  env.providers.fetch = realFetch;
  (env.ctx.providers as Providers).mtlsRequest = undefined;
});

const iso = (d: Date) => d.toISOString().slice(0, 10);
const br = (isoDate: string) => isoDate.split('-').reverse().join('/');
const today = iso(new Date());
const in60 = iso(new Date(Date.now() + 60 * 86_400_000));

/** PDF de texto simples (Helvetica), como um relatório gerado por sistema. */
function pdf(lines: string[]): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.font('Helvetica').fontSize(9);
  for (const l of lines) doc.text(l);
  doc.end();
  return done;
}

const sitfisClear = () =>
  pdf([
    'INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO',
    'Certidão Emitida',
    'Certidão Negativa: 1A2B.3C4D.5E6F.7G8H',
    `Emissão: ${br(today)}`,
    `Data de Validade: ${br(in60)}`,
    'Diagnóstico Fiscal na Receita Federal e Procuradoria-Geral da Fazenda Nacional',
    'Não foram detectadas pendências/exigibilidades suspensas nos controles da Receita Federal e da Procuradoria-Geral da Fazenda Nacional.',
  ]);

type Call = { idServico: string; tipo: string; dados: string; contribuinte: string };
type Reply = { status?: number; dados?: unknown };

/** Gateway do Integra Contador simulado: responde por `idServico`. */
function serproGateway(handler: (c: Call, n: number) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const call = { idServico: body.pedidoDados?.idServico, tipo: url.split('/').pop()!, dados: body.pedidoDados?.dados, contribuinte: body.contribuinte?.numero };
    calls.push(call);
    const r = await handler(call, calls.filter((c) => c.idServico === call.idServico).length);
    const status = r.status ?? 200;
    const payload = { status, dados: r.dados === undefined ? '' : typeof r.dados === 'string' ? r.dados : JSON.stringify(r.dados), mensagens: [] };
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls, of: (id: string) => calls.filter((c) => c.idServico === id) };
}

/** Escritório com SERPRO ativo, procurador com certificado e um cliente com procuração e duas quotas abertas. */
async function setup(settings: Record<string, unknown> = {}) {
  const office = await registerOffice(env);
  const file = await env.ctx.files.save({ officeId: office.officeId, data: Buffer.from('pfx'), filename: 'escritorio.pfx', mimeType: 'application/x-pkcs12' });
  const [proc] = await env.ctx.db
    .insert(procurators)
    .values({ officeId: office.officeId, name: 'Escritório (e-CNPJ)', cpfCnpj: '11222333000181', certificateFileId: file.id, certificatePasswordEnc: env.ctx.secrets.encrypt('senha'), certificateExpiresAt: '2099-12-31' })
    .returning();
  const saved = await office.api.put('/api/integrations/serpro', {
    enabled: true,
    config: { contractorCnpj: '11.222.333/0001-81', procuratorId: proc.id },
    secrets: { consumerKey: 'ck', consumerSecret: 'cs' },
  });
  expect(saved.status).toBe(200);
  clearSerproTokens();
  const mtls: MtlsRequest = async () => ({ status: 200, body: JSON.stringify({ access_token: 'a', jwt_token: 'j', expires_in: 2008 }) });
  (env.ctx.providers as Providers).mtlsRequest = mtls;
  await office.api.put('/api/office/settings', settings);
  await env.ctx.db.update(offices).set({ email: 'principal@escritorio.com.br' }).where(eq(offices.id, office.officeId));
  const c = await office.api.post('/api/customers', { name: 'Carla Contribuinte', cpfCnpj: VALID_CPFS[0] });
  await office.api.post('/api/customers/bulk', { ids: [c.body.id], action: 'procurator', value: proc.id });
  const [q1, q2] = await env.ctx.db
    .insert(darfs)
    .values([
      { officeId: office.officeId, customerId: c.body.id, quotaNumber: 1, valueCents: 15000, dueDate: '2026-05-29' },
      { officeId: office.officeId, customerId: c.body.id, quotaNumber: 2, valueCents: 15000, dueDate: '2026-06-30' },
    ])
    .returning();
  return { ...office, customerId: c.body.id as string, q1, q2 };
}

const MAILBOX = {
  codigo: '00',
  conteudo: [
    {
      quantidadeMensagens: '2',
      indicadorUltimaPagina: 'S',
      listaMensagens: [
        {
          codigoSistemaRemetente: '00019',
          dataEnvio: '20260408',
          numeroControle: '2026/000000000032113',
          indicadorLeitura: '0',
          dataLeitura: '',
          dataCiencia: '',
          assuntoModelo: '[IRPF] Declaração do exercício ++VARIAVEL++ processada',
          valorParametroAssunto: '2026',
          relevancia: '2',
          isn: '0001626772',
          descricaoOrigem: 'RECEITA FEDERAL DO BRASIL',
        },
        {
          dataEnvio: '20260301',
          numeroControle: '2026/000000000032001',
          indicadorLeitura: '1',
          dataLeitura: '20260302',
          assuntoModelo: 'Aviso de cobrança',
          relevancia: '1',
          isn: '0001626700',
          descricaoOrigem: 'RECEITA FEDERAL DO BRASIL',
        },
      ],
    },
  ],
};

const PAYMENTS = [
  {
    numeroDocumento: '07202614801234567',
    tipo: { codigo: '4', descricaoAbreviada: 'DARF' },
    dataArrecadacao: '2026-05-20T00:00:00-03:00',
    dataVencimento: '2026-05-29T00:00:00-03:00',
    receitaPrincipal: { codigo: '211', descricao: 'IRPF - Quotas' },
    valorTotal: 150,
    valorPrincipal: 150,
  },
  // carnê-leão (0190) com o mesmo valor e vencimento: não é quota do IRPF
  {
    numeroDocumento: '07202614809999999',
    dataArrecadacao: '2026-06-20T00:00:00-03:00',
    dataVencimento: '2026-06-30T00:00:00-03:00',
    receitaPrincipal: { codigo: '190', descricao: 'Carnê-leão' },
    valorTotal: 150,
    valorPrincipal: 150,
  },
];

describe('interpretação das respostas do SERPRO', () => {
  it('lista da caixa postal, protocolo do SITFIS, PDF e pagamentos (formatos da documentação)', async () => {
    const msgs = interpretMailboxList(JSON.stringify(MAILBOX));
    expect(msgs).toEqual([
      expect.objectContaining({ externalId: 'serpro:0001626772', subject: '[IRPF] Declaração do exercício 2026 processada', receivedAt: '2026-04-08', read: false, relevant: true }),
      expect.objectContaining({ externalId: 'serpro:0001626700', subject: 'Aviso de cobrança', read: true, relevant: false }),
    ]);
    expect(interpretMailboxList({ outro: 1 })).toEqual([]);
    expect(interpretSitfisProtocol({ protocoloRelatorio: '+S7N6c==', tempoEspera: 30 })).toEqual({ protocol: '+S7N6c==', waitMs: 30 });
    expect(interpretSitfisProtocol({})).toEqual({ protocol: null, waitMs: null });
    const doc = await sitfisClear();
    expect(sitfisPdf([{ pdf: doc.toString('base64') }])?.equals(doc)).toBe(true);
    expect(sitfisPdf([{ pdf: Buffer.from('não é pdf, só texto qualquer').toString('base64') }])).toBeNull();
    const pays = interpretPayments(PAYMENTS);
    expect(pays[0]).toEqual({ documentNumber: '07202614801234567', revenueCode: '0211', paidOn: '2026-05-20', dueDate: '2026-05-29', totalCents: 15000, principalCents: 15000 });
    expect(pays[1].revenueCode).toBe('0190');
  });

  it('lê o relatório oficial de exemplo do SERPRO e um relatório com pendências', async () => {
    // exemplo oficial (apicenter.estaleiro.serpro.gov.br, retorno_emitir_relatorio): fonte TrueType com ToUnicode
    const official = readFileSync(new URL('./fixtures/sitfis-exemplo-serpro.pdf', import.meta.url));
    const text = pdfText(official);
    expect(text).toContain('INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO');
    const r = interpretSitfis(text);
    expect(r).toMatchObject({ readable: true, status: 'clear', situation: 'Sem pendências', pendencies: [] });
    expect(r.message).toMatch(/^Não foram detectadas pendências/);
    // o exemplo traz a certidão mascarada (ZZZZ, 99/99/9999): nada de código ou data inventados
    expect(r.certificate).toEqual({ type: 'Negativa', code: null, issuedAt: null, validUntil: null });

    const pending = interpretSitfis(pdfText(await pdf(['Diagnóstico Fiscal na Receita Federal', 'Pendência - Débito (SIEF)', 'Receita 0211 - IRPF', 'Pendência - Omissão de Declaração'])));
    expect(pending).toMatchObject({ status: 'pending', situation: 'Com pendências', pendencies: ['Pendência - Débito (SIEF)', 'Pendência - Omissão de Declaração'] });
    expect(interpretSitfis(pdfText(await pdf(['Relatório qualquer sem as frases do modelo'])))).toMatchObject({ readable: true, status: null, situation: null });
    expect(interpretSitfis(pdfText(Buffer.from('não é PDF')))).toMatchObject({ readable: false, status: null });
  });
});

describe('sincronização do eCAC pelo SERPRO', () => {
  it('procuração, caixa postal, situação fiscal e quotas pagas; avisa no sino e no e-mail principal', async () => {
    const o = await setup({ autoGenerateCnd: true, notifyMainEmailOnEcacChanges: true });
    const report = await sitfisClear();
    const gw = serproGateway((c, n) => {
      switch (c.idServico) {
        case 'OBTERPROCURACAO41':
          return { dados: [{ dtexpiracao: '20301231', nrsistemas: 1, sistemas: ['Caixa Postal - Mensagens'] }] };
        case 'INNOVAMSG63':
          return { dados: { codigo: '00', indicadorMensagensNovas: '1' } };
        case 'MSGCONTRIBUINTE61':
          return { dados: MAILBOX };
        case 'SOLICITARPROTOCOLO91':
          return { dados: { protocoloRelatorio: 'protocolo-123', tempoEspera: 5 } };
        case 'RELATORIOSITFIS92':
          // primeira tentativa ainda em processamento (202), depois o PDF
          return n === 1 ? { status: 202, dados: { tempoEspera: 5 } } : { dados: [{ pdf: report.toString('base64') }] };
        case 'PAGAMENTOS71':
          return { dados: PAYMENTS };
        default:
          return { status: 400, dados: '' };
      }
    });
    env.providers.fetch = gw.fn;

    const res = await o.api.post(`/api/customers/${o.customerId}/ecac/sync`);
    expect(res.status).toBe(202);
    await env.ctx.jobs.drain();
    const job = await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, res.body.job.id) });
    expect(job!.status).toBe('done');
    expect(job!.result!.steps).toEqual([
      'procuração: valid até 2030-12-31',
      'caixa postal: 2 mensagem(ns) listada(s), 1 não lida(s)',
      'situação fiscal: sem pendências',
      'pagamentos: 1 de 2 quota(s) em aberto com pagamento encontrado',
    ]);

    // o conteúdo das mensagens nunca é aberto (abrir dá ciência de intimação)
    expect(gw.of('MSGDETALHAMENTO62')).toHaveLength(0);
    expect(JSON.parse(gw.of('MSGCONTRIBUINTE61')[0].dados)).toEqual({ statusLeitura: '0', indicadorPagina: '0' });
    expect(JSON.parse(gw.of('RELATORIOSITFIS92')[0].dados)).toEqual({ protocoloRelatorio: 'protocolo-123' });
    expect(JSON.parse(gw.of('PAGAMENTOS71')[0].dados)).toEqual({
      codigoReceitaLista: ['0211'],
      intervaloDataArrecadacao: { dataInicial: '2026-01-01', dataFinal: today },
      primeiroDaPagina: 0,
      tamanhoDaPagina: 100,
    });

    const panel = (await o.api.get(`/api/customers/${o.customerId}/ecac`)).body;
    expect(panel.procuration).toMatchObject({ status: 'valid', expiresAt: '2030-12-31', mailboxMessages: 1 });
    expect(panel.mailbox.map((m: any) => [m.subject, m.read, m.source])).toEqual([
      ['[IRPF] Declaração do exercício 2026 processada', false, 'serpro'],
      ['Aviso de cobrança', true, 'serpro'],
    ]);
    expect(panel.simplified).toMatchObject({ kind: 'fiscal_situation', situation: 'Sem pendências', source: 'serpro' });
    expect(panel.simplified.fileId).toBeTruthy();
    expect((await o.api.get(`/api/files/${panel.simplified.fileId}`)).raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(panel.cnd).toMatchObject({ status: 'success', latest: { issuedAt: today, validUntil: in60, fileId: null } });
    const [q1, q2] = await env.ctx.db.select().from(darfs).where(eq(darfs.customerId, o.customerId)).orderBy(darfs.quotaNumber);
    expect(q1).toMatchObject({ status: 'paid', paidAt: '2026-05-20' });
    expect(q2).toMatchObject({ status: 'open', paidAt: null });

    // avisos: sino (escritório, cliente sem responsável) e um e-mail de resumo ao e-mail principal
    const notes = (await o.api.get('/api/notifications')).body.filter((n: any) => n.title === 'Mudanças no eCAC de Carla Contribuinte');
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toMatch(/procuração válida até 31\/12\/2030/);
    expect(notes[0].body).toMatch(/1 mensagem\(ns\) nova\(s\) na caixa postal: \[IRPF\] Declaração do exercício 2026 processada/);
    expect(notes[0].body).toMatch(/quota 1 do IRPF .* paga em 20\/05\/2026/);
    const mails = env.providers.sentEmails.filter((m) => m.officeId === o.officeId && m.subject.startsWith('Mudanças no eCAC'));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'principal@escritorio.com.br', subject: 'Mudanças no eCAC: 1 cliente(s)' });
    expect(mails[0].html).toContain('Carla Contribuinte');

    // segunda rodada sem novidades: nada duplicado e nenhum aviso novo
    const again = await o.api.post(`/api/customers/${o.customerId}/ecac/sync`);
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, again.body.job.id) }))!.status).toBe('done');
    const records = await env.ctx.db.select().from(ecacRecords).where(and(eq(ecacRecords.customerId, o.customerId), eq(ecacRecords.kind, 'mailbox_message')));
    expect(records).toHaveLength(2);
    expect((await o.api.get('/api/notifications')).body.filter((n: any) => n.title === 'Mudanças no eCAC de Carla Contribuinte')).toHaveLength(1);
    expect(env.providers.sentEmails.filter((m) => m.officeId === o.officeId && m.subject.startsWith('Mudanças no eCAC'))).toHaveLength(1);
    expect(await env.ctx.db.select().from(ecacRecords).where(and(eq(ecacRecords.customerId, o.customerId), eq(ecacRecords.kind, 'fiscal_situation')))).toHaveLength(1);

    // indicador 0 depois de já ter listado: as mensagens foram lidas no eCAC, sem nova consulta paga
    const listed = gw.of('MSGCONTRIBUINTE61').length;
    env.providers.fetch = serproGateway((c) =>
      c.idServico === 'INNOVAMSG63' ? { dados: { indicadorMensagensNovas: '0' } } : c.idServico === 'OBTERPROCURACAO41' ? { dados: [{ dtexpiracao: '20301231' }] } : { dados: [] },
    ).fn;
    const third = await o.api.post(`/api/customers/${o.customerId}/ecac/sync`);
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, third.body.job.id) }))!.result!.steps).toContain('caixa postal: nenhuma mensagem nova');
    expect(gw.of('MSGCONTRIBUINTE61')).toHaveLength(listed);
    const after = (await o.api.get(`/api/customers/${o.customerId}/ecac`)).body;
    expect(after.procuration.mailboxMessages).toBe(0);
    expect(after.mailbox.every((m: any) => m.read)).toBe(true);
  });

  it('preferências desligadas: sem SITFIS e sem e-mail; resposta não reconhecida não altera o cadastro', async () => {
    const o = await setup({ autoGenerateCnd: false, notifyMainEmailOnEcacChanges: false });
    // sem quotas abertas: PAGTOWEB (cobrado) nem é chamado
    await env.ctx.db.update(darfs).set({ status: 'paid' }).where(eq(darfs.customerId, o.customerId));
    const gw = serproGateway((c) =>
      c.idServico === 'OBTERPROCURACAO41' ? { dados: [{ dtexpiracao: '20301231' }] } : c.idServico === 'INNOVAMSG63' ? { dados: { algo: 'x' } } : { dados: { semLista: true } },
    );
    env.providers.fetch = gw.fn;
    await o.api.post(`/api/customers/${o.customerId}/ecac/sync`);
    await env.ctx.jobs.drain();
    expect(gw.of('SOLICITARPROTOCOLO91')).toHaveLength(0);
    expect(gw.of('PAGAMENTOS71')).toHaveLength(0);
    const panel = (await o.api.get(`/api/customers/${o.customerId}/ecac`)).body;
    expect(panel.mailbox).toEqual([]);
    expect(panel.cnd.status).toBe('not_requested');
    expect(panel.simplified).toBeNull();
    // houve mudança (procuração), avisada só no sino
    expect((await o.api.get('/api/notifications')).body.some((n: any) => n.title === 'Mudanças no eCAC de Carla Contribuinte')).toBe(true);
    expect(env.providers.sentEmails.filter((m) => m.officeId === o.officeId && m.subject.startsWith('Mudanças no eCAC'))).toHaveLength(0);
    expect(await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, o.officeId))).toHaveLength(0);
  });

  it('relatório SITFIS sem as frases do modelo: guarda o PDF e não deduz situação nem CND', async () => {
    const o = await setup({ autoGenerateCnd: true });
    const odd = await pdf(['Relatório em leiaute desconhecido']);
    env.providers.fetch = serproGateway((c) => {
      if (c.idServico === 'OBTERPROCURACAO41') return { dados: [{ dtexpiracao: '20301231' }] };
      if (c.idServico === 'INNOVAMSG63') return { dados: { indicadorMensagensNovas: '0' } };
      if (c.idServico === 'MSGCONTRIBUINTE61') return { dados: { conteudo: [{ listaMensagens: [] }] } };
      if (c.idServico === 'SOLICITARPROTOCOLO91') return { dados: { protocoloRelatorio: 'p' } };
      if (c.idServico === 'RELATORIOSITFIS92') return { dados: [{ pdf: odd.toString('base64') }] };
      // pagamentos com erro do SERPRO: a etapa falha sem derrubar as outras
      return { status: 500, dados: '' };
    }).fn;
    const res = await o.api.post(`/api/customers/${o.customerId}/ecac/sync`);
    await env.ctx.jobs.drain();
    const job = await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, res.body.job.id) });
    expect(job!.status).toBe('done');
    expect(job!.result!.steps).toContain('situação fiscal: relatório salvo (situação não reconhecida)');
    expect((job!.result!.steps as string[]).some((s) => s.startsWith('pagamentos: falhou'))).toBe(true);
    const panel = (await o.api.get(`/api/customers/${o.customerId}/ecac`)).body;
    expect(panel.simplified).toMatchObject({ situation: null, message: expect.stringMatching(/não tem as frases do modelo oficial/) });
    expect(panel.simplified.fileId).toBeTruthy();
    expect(panel.cnd.status).toBe('not_requested');
    expect((await env.ctx.db.select().from(darfs).where(eq(darfs.customerId, o.customerId))).every((d) => d.status === 'open')).toBe(true);
  });
});

describe('sincronização automática', () => {
  it('calcula a próxima rodada às 6h de Brasília', () => {
    expect(nextAutoSyncAt('daily', new Date('2026-10-06T08:00:00Z')).toISOString()).toBe('2026-10-06T09:00:00.000Z');
    expect(nextAutoSyncAt('daily', new Date('2026-10-06T09:00:00Z')).toISOString()).toBe('2026-10-07T09:00:00.000Z');
    expect(nextAutoSyncAt('weekly', new Date('2026-10-06T10:00:00Z')).toISOString()).toBe('2026-10-13T09:00:00.000Z');
  });

  it('liga pela integração, agenda a próxima rodada e enfileira a sincronização geral; desligar cancela', async () => {
    const o = await setup();
    const scheduled = () => env.ctx.db.select().from(jobs).where(and(eq(jobs.officeId, o.officeId), eq(jobs.type, ECAC_SCHEDULE_JOB), eq(jobs.status, 'queued')));
    expect(await scheduled()).toHaveLength(0);

    expect((await o.api.put('/api/integrations/serpro', { config: { autoSync: 'daily' } })).status).toBe(200);
    let queued = await scheduled();
    expect(queued).toHaveLength(1);
    expect(queued[0].runAt.toISOString()).toBe(nextAutoSyncAt('daily').toISOString());
    // salvar de novo não cria outra cadeia
    await o.api.put('/api/integrations/serpro', { config: { autoSync: 'daily' } });
    expect(await scheduled()).toHaveLength(1);

    // chega a hora: agenda a seguinte e enfileira a sincronização geral (marcada como automática)
    env.providers.fetch = serproGateway((c) =>
      c.idServico === 'OBTERPROCURACAO41' ? { dados: [{ dtexpiracao: '20301231' }] } : c.idServico === 'INNOVAMSG63' ? { dados: { indicadorMensagensNovas: '0' } } : { dados: [] },
    ).fn;
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, queued[0].id));
    await env.ctx.jobs.drain();
    const ran = await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, queued[0].id) });
    expect(ran!.status).toBe('done');
    const office = await env.ctx.db.select().from(jobs).where(and(eq(jobs.officeId, o.officeId), eq(jobs.type, 'ecac.sync_office')));
    expect(office).toHaveLength(1);
    expect(office[0]).toMatchObject({ status: 'done', payload: { scheduled: true } });
    expect(office[0].result).toMatchObject({ total: 1, ok: 1, scheduled: true });
    queued = await scheduled();
    expect(queued).toHaveLength(1);
    expect(queued[0].id).not.toBe(ran!.id);
    // rodada automática sem erro não enche o sino com "concluída"
    expect((await o.api.get('/api/notifications')).body.some((n: any) => n.title === 'Sincronização eCAC concluída')).toBe(false);

    // semanal troca a rodada agendada; desligar remove
    await o.api.put('/api/integrations/serpro', { config: { autoSync: 'weekly' } });
    queued = await scheduled();
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({ mode: 'weekly' });
    await o.api.put('/api/integrations/serpro', { config: { autoSync: '' } });
    expect(await scheduled()).toHaveLength(0);
    const customer = await env.ctx.db.query.customers.findFirst({ where: eq(customers.id, o.customerId) });
    expect(customer!.procurationStatus).toBe('valid');
  });
});
