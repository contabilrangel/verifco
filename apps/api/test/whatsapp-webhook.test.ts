/**
 * WhatsApp (COB-8): respostas dos clientes pelo webhook (Evolution API e Cloud API da Meta) e
 * envio de modelo aprovado fora da janela de 24 h.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { customers, deliveries, jobs, messages } from '../src/db/schema';
import { createProviders } from '../src/integrations';
import { WHATSAPP_WEBHOOK_RULE } from '../src/services/rate-limit';
import { queueDelivery } from '../src/services/delivery';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

interface Call {
  url: string;
  body: any;
  rawBody: unknown;
}
function mockFetch(handler: (c: Call) => unknown) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    let body: any = init?.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const call = { url, body, rawBody: init?.body };
    calls.push(call);
    return new Response(JSON.stringify(handler(call)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const metaReply = (c: Call) => (c.url.endsWith('/media') ? { id: 'media-77' } : { messaging_product: 'whatsapp', messages: [{ id: `wamid.${Math.random().toString(36).slice(2)}` }] });

async function officeWithWhatsApp(config: Record<string, unknown>, secrets: Record<string, string>) {
  const office = await registerOffice(env);
  const saved = await office.api.put('/api/integrations/whatsapp', { enabled: true, config, secrets });
  expect(saved.status).toBe(200);
  expect(saved.body.webhookUrl).toMatch(/\/api\/webhooks\/whatsapp\/[\w-]{16,}$/);
  const token = (saved.body.webhookUrl as string).split('/').pop()!;
  const addCustomer = async (name: string, cpf: string, mobile: string, responsibleUserId?: string) => {
    const c = await office.api.post('/api/customers', { name, cpfCnpj: cpf, ...(responsibleUserId ? { responsibleUserId } : {}) });
    await env.ctx.db.update(customers).set({ mobile }).where(eq(customers.id, c.body.id));
    return c.body.id as string;
  };
  return { ...office, token, addCustomer };
}

const evolution = { mode: 'evolution', baseUrl: 'https://evo.exemplo.com.br', instance: 'escritorio' };
const upsert = (id: string, remoteJid: string, message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event: 'messages.upsert',
  instance: 'escritorio',
  data: { key: { remoteJid, fromMe: false, id, ...extra }, pushName: 'Cliente', message, messageType: Object.keys(message)[0], messageTimestamp: Math.floor(Date.now() / 1000) - 60 },
  date_time: new Date().toISOString(),
  sender: '5511900000000@s.whatsapp.net',
  apikey: 'qualquer',
});
const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'POST', url: `/api/webhooks/whatsapp/${token}`, payload: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const conversation = (customerId: string) => env.ctx.db.select().from(messages).where(eq(messages.customerId, customerId));

describe('webhook do WhatsApp: Evolution API', () => {
  it('grava a resposta como mensagem "in" no cliente certo, avisa o responsável e não duplica', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    const accountant = await createEmployee(env, office.api, ['customer.list']);
    const maria = await office.addCustomer('Maria', VALID_CPFS[0], '11987654321', accountant.userId);
    const joao = await office.addCustomer('João', VALID_CPFS[1], '21976543210');

    const res = await post(office.token, upsert('3EB0AAA1', '5511987654321@s.whatsapp.net', { conversation: 'Segue o informe de rendimentos.' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, stored: 1 });
    const inbox = await conversation(maria);
    expect(inbox).toEqual([expect.objectContaining({ direction: 'in', channel: 'whatsapp', body: 'Segue o informe de rendimentos.', externalId: '3EB0AAA1', readAt: null })]);
    expect(await conversation(joao)).toEqual([]);
    const notes = (await accountant.api.get('/api/notifications')).body.filter((n: any) => n.title === 'Nova mensagem de Maria pelo WhatsApp');
    expect(notes).toEqual([expect.objectContaining({ link: `/clientes/${maria}/mensagens`, body: 'Segue o informe de rendimentos.' })]);
    // a aba Mensagens mostra a resposta como não lida
    const tab = (await office.api.get(`/api/customers/${maria}/messages`)).body;
    expect(tab.unread).toBe(1);

    // reenvio do mesmo evento não duplica
    expect((await post(office.token, upsert('3EB0AAA1', '5511987654321@s.whatsapp.net', { conversation: 'Segue o informe de rendimentos.' }))).json()).toMatchObject({ stored: 0 });
    expect(await conversation(maria)).toHaveLength(1);

    // sem o nono dígito, endereçamento por LID, legenda de imagem e documento
    await post(office.token, upsert('3EB0AAA2', '551187654321@s.whatsapp.net', { extendedTextMessage: { text: 'Sem o nove' } }));
    await post(office.token, upsert('3EB0AAA3', '98765432101234@lid', { imageMessage: { caption: 'foto do recibo' } }, { remoteJidAlt: '5511987654321@s.whatsapp.net' }));
    await post(office.token, upsert('3EB0AAA4', '5521976543210@s.whatsapp.net', { documentMessage: { fileName: 'informe.pdf' } }));
    expect((await conversation(maria)).map((m) => m.body).sort()).toEqual(['Segue o informe de rendimentos.', 'Sem o nove', '[Imagem] foto do recibo'].sort());
    expect((await conversation(joao)).map((m) => m.body)).toEqual(['[Documento: informe.pdf]']);
    // a sequência de mensagens gera um aviso só enquanto ele não é lido
    expect((await accountant.api.get('/api/notifications')).body.filter((n: any) => n.title === 'Nova mensagem de Maria pelo WhatsApp')).toHaveLength(1);
  });

  it('ignora mensagens do próprio escritório, de grupos, de outra instância e de números desconhecidos', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    const ana = await office.addCustomer('Ana', VALID_CPFS[2], '31988887777');
    const own = upsert('OWN1', '5531988887777@s.whatsapp.net', { conversation: 'mensagem enviada pelo celular do escritório' });
    own.data.key.fromMe = true;
    expect((await post(office.token, own)).json()).toMatchObject({ stored: 0 });
    expect((await post(office.token, upsert('GRP1', '120363000000000000@g.us', { conversation: 'grupo' }, { participant: '5531988887777@s.whatsapp.net' }))).json()).toMatchObject({ stored: 0 });
    expect((await post(office.token, { ...upsert('OTH1', '5531988887777@s.whatsapp.net', { conversation: 'outra instância' }), instance: 'outra' })).json()).toMatchObject({ stored: 0 });
    expect((await post(office.token, { ...upsert('UPD1', '5531988887777@s.whatsapp.net', { conversation: 'x' }), event: 'messages.update' })).json()).toMatchObject({ stored: 0 });
    expect((await post(office.token, upsert('UNK1', '5541999990000@s.whatsapp.net', { conversation: 'quem é?' }))).json()).toMatchObject({ stored: 0, unknown: 1 });
    expect(await conversation(ana)).toEqual([]);
    expect((await post(office.token, '{nao-e-json')).statusCode).toBe(400);
  });

  it('o token só vale para o próprio escritório e para o WhatsApp', async () => {
    const a = await officeWithWhatsApp(evolution, { apiKey: 'evo-a' });
    const b = await officeWithWhatsApp(evolution, { apiKey: 'evo-b' });
    const ofA = await a.addCustomer('Cliente do A', VALID_CPFS[3], '11955554444');
    // o token de B não alcança o cliente de A, mesmo com o celular dele
    const cross = await post(b.token, upsert('CROSS1', '5511955554444@s.whatsapp.net', { conversation: 'invasão' }));
    expect(cross.json()).toMatchObject({ stored: 0, unknown: 1 });
    expect(await conversation(ofA)).toEqual([]);
    expect((await post('token-que-nao-existe-123456', upsert('X', '5511955554444@s.whatsapp.net', { conversation: 'x' }))).statusCode).toBe(401);
    // token do webhook do Asaas não serve no WhatsApp
    const asaas = await a.api.put('/api/integrations/asaas', { config: { environment: 'sandbox' }, secrets: { apiKey: '$aact_hmlg_teste' } });
    const asaasToken = (asaas.body.webhookUrl as string).split('/').pop()!;
    expect((await post(asaasToken, upsert('X2', '5511955554444@s.whatsapp.net', { conversation: 'x' }))).statusCode).toBe(401);
    // integração desativada: confirma e ignora
    await a.api.put('/api/integrations/whatsapp', { enabled: false });
    expect((await post(a.token, upsert('OFF1', '5511955554444@s.whatsapp.net', { conversation: 'desligado' }))).json()).toMatchObject({ received: true, stored: 0 });
    expect(await conversation(ofA)).toEqual([]);
  });

  it('com o token de autenticação configurado, exige o cabeçalho Authorization', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key', webhookAuthToken: 'token-do-webhook-evo' });
    const ivo = await office.addCustomer('Ivo', VALID_CPFS[5], '11922221111');
    const event = upsert('AUTH1', '5511922221111@s.whatsapp.net', { conversation: 'oi' });
    expect((await post(office.token, event)).statusCode).toBe(401);
    expect((await post(office.token, event, { authorization: 'Bearer outro' })).statusCode).toBe(401);
    expect(await conversation(ivo)).toEqual([]);
    expect((await post(office.token, event, { authorization: 'Bearer token-do-webhook-evo' })).json()).toMatchObject({ stored: 1 });
  });

  it('limita os eventos aceitos por integração', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    await office.addCustomer('Limite', VALID_CPFS[4], '11944443333');
    const max = WHATSAPP_WEBHOOK_RULE.max;
    env.ctx.config.RATE_LIMIT = true;
    WHATSAPP_WEBHOOK_RULE.max = 2;
    try {
      expect((await post(office.token, upsert('L1', '5511944443333@s.whatsapp.net', { conversation: '1' }))).statusCode).toBe(200);
      expect((await post(office.token, upsert('L2', '5511944443333@s.whatsapp.net', { conversation: '2' }))).statusCode).toBe(200);
      const third = await post(office.token, upsert('L3', '5511944443333@s.whatsapp.net', { conversation: '3' }));
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toContain('Muitas requisições');
    } finally {
      env.ctx.config.RATE_LIMIT = false;
      WHATSAPP_WEBHOOK_RULE.max = max;
    }
  });
});

describe('webhook do WhatsApp: Cloud API da Meta', () => {
  const meta = { mode: 'meta', phoneNumberId: '1098765432' };
  const metaSecrets = { accessToken: 'EAAG-token', appSecret: 'segredo-do-app', webhookVerifyToken: 'verifica-123' };
  const sign = (raw: string, secret = 'segredo-do-app') => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const metaEvent = (value: Record<string, unknown>) =>
    JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '551130000000', phone_number_id: '1098765432' }, ...value } }] }] });

  it('confirma o endereço com o token de verificação', async () => {
    const office = await officeWithWhatsApp(meta, metaSecrets);
    const verify = (q: string) => env.app.inject({ method: 'GET', url: `/api/webhooks/whatsapp/${office.token}?${q}` });
    const ok = await verify('hub.mode=subscribe&hub.verify_token=verifica-123&hub.challenge=1158201444');
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    expect(ok.headers['content-type']).toContain('text/plain');
    expect((await verify('hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1158201444')).statusCode).toBe(403);
    expect((await verify('hub.mode=subscribe&hub.verify_token=verifica-123&hub.challenge=%3Cscript%3E')).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/webhooks/whatsapp/token-inexistente-0000000?hub.mode=subscribe' })).statusCode).toBe(401);
  });

  it('aceita só o corpo assinado com a chave do app e grava a resposta do cliente', async () => {
    const office = await officeWithWhatsApp(meta, metaSecrets);
    const carla = await office.addCustomer('Carla', VALID_CPFS[5], '11987650000');
    // o WhatsApp informa alguns números antigos sem o nono dígito
    const raw = metaEvent({ contacts: [{ wa_id: '551187650000', profile: { name: 'Carla' } }], messages: [{ from: '551187650000', id: 'wamid.IN1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Pode me mandar o DARF?' } }] });
    expect((await post(office.token, raw)).statusCode).toBe(401);
    expect((await post(office.token, raw, { 'x-hub-signature-256': sign(raw, 'outro-segredo') })).statusCode).toBe(401);
    expect(await conversation(carla)).toEqual([]);
    const ok = await post(office.token, raw, { 'x-hub-signature-256': sign(raw) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ stored: 1 });
    expect(await conversation(carla)).toEqual([expect.objectContaining({ direction: 'in', channel: 'whatsapp', body: 'Pode me mandar o DARF?', externalId: 'wamid.IN1' })]);
    // corpo alterado depois de assinado é recusado
    expect((await post(office.token, raw.replace('DARF', 'PIX'), { 'x-hub-signature-256': sign(raw) })).statusCode).toBe(401);
    // outro número do mesmo app não é deste escritório
    const other = metaEvent({ messages: [{ from: '5511912345678', id: 'wamid.IN2', timestamp: '1', type: 'text', text: { body: 'x' } }] }).replace('1098765432', '9999999999');
    expect((await post(office.token, other, { 'x-hub-signature-256': sign(other) })).json()).toMatchObject({ stored: 0 });

    // sem a chave secreta configurada, nada é aceito
    await office.api.put('/api/integrations/whatsapp', { secrets: { appSecret: null } });
    expect((await post(office.token, raw, { 'x-hub-signature-256': sign(raw) })).statusCode).toBe(401);
  });

  it('marca como falho o envio que a Meta não entregou', async () => {
    const office = await officeWithWhatsApp(meta, metaSecrets);
    const customerId = await office.addCustomer('Davi', VALID_CPFS[6], '11933332222');
    const [sent] = await env.ctx.db
      .insert(deliveries)
      .values({ officeId: office.officeId, customerId, channel: 'whatsapp', toAddress: '5511933332222', body: 'oi', status: 'sent', providerMessageId: 'wamid.OUT1' })
      .returning();
    const raw = metaEvent({
      statuses: [{ id: 'wamid.OUT1', status: 'failed', timestamp: '1', recipient_id: '5511933332222', errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'Mais de 24 horas desde a última resposta.' } }] }],
    });
    expect((await post(office.token, raw, { 'x-hub-signature-256': sign(raw) })).statusCode).toBe(200);
    const row = await env.ctx.db.query.deliveries.findFirst({ where: eq(deliveries.id, sent.id) });
    expect(row).toMatchObject({ status: 'failed', error: 'A Meta não entregou a mensagem: Mais de 24 horas desde a última resposta (código 131047).' });
  });
});

describe('modelo aprovado fora da janela de 24 h (Meta)', () => {
  const templates = ['darf = aviso_darf | pt_BR | CLIENTE, VALOR, VENCIMENTO | documento', 'mensagem = nova_mensagem | | nome=CLIENTE, texto=MENSAGEM'].join('\n');

  it('valida os modelos ao salvar a integração', async () => {
    const office = await registerOffice(env);
    const bad = await office.api.put('/api/integrations/whatsapp', { config: { mode: 'meta', phoneNumberId: '1', templates: 'darf = Aviso DARF' }, secrets: { accessToken: 't' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Dados inválidos: Modelos aprovados (fora da janela de 24 h): Linha 1: o nome do modelo usa só letras minúsculas, números e _.');
    const good = await office.api.put('/api/integrations/whatsapp', { config: { mode: 'meta', phoneNumberId: '1', templates }, secrets: { accessToken: 't' } });
    expect(good.status).toBe(200);
    expect(good.body.config.templates).toBe(templates);
  });

  it('fora da janela envia o modelo do tipo de envio; dentro dela, a mensagem livre', async () => {
    const office = await officeWithWhatsApp({ mode: 'meta', phoneNumberId: '1098765432', templates }, { accessToken: 'EAAG-token' });
    const customerId = await office.addCustomer('Elisa Souza', VALID_CPFS[7], '11977776666');
    const m = mockFetch(metaReply);
    const wa = createProviders(env.ctx, { fetch: m.fn }).whatsapp;
    const pdf = { filename: 'darf-1.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' };
    const darf = { to: '5511977776666', text: 'Sua guia DARF\nvence em 30/06.', document: pdf, customerId, templateKey: 'darf', values: { CLIENTE: 'Elisa Souza', VALOR: 'R$ 1.500,00', VENCIMENTO: '30/06/2026' } };

    // nunca escreveu: modelo com o PDF no cabeçalho
    await wa.send(office.officeId, darf);
    expect(m.calls.map((c) => c.url.split('/').pop())).toEqual(['media', 'messages']);
    expect(m.calls[1].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511977776666',
      type: 'template',
      template: {
        name: 'aviso_darf',
        language: { code: 'pt_BR' },
        components: [
          { type: 'header', parameters: [{ type: 'document', document: { id: 'media-77', filename: 'darf-1.pdf' } }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Elisa Souza' },
              { type: 'text', text: 'R$ 1.500,00' },
              { type: 'text', text: '30/06/2026' },
            ],
          },
        ],
      },
    });

    // mensagem avulsa: parâmetros nomeados e o texto em uma linha
    m.calls.length = 0;
    await wa.send(office.officeId, { to: '5511977776666', text: 'Olá!\n\nPrecisamos do recibo.', customerId });
    expect(m.calls[0].body.template).toEqual({
      name: 'nova_mensagem',
      language: { code: 'pt_BR' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', parameter_name: 'nome', text: 'Elisa Souza' },
            { type: 'text', parameter_name: 'texto', text: 'Olá! Precisamos do recibo.' },
          ],
        },
      ],
    });

    // resposta do cliente há mais de 24 h: ainda fora da janela
    await env.ctx.db.insert(messages).values({ officeId: office.officeId, customerId, direction: 'in', channel: 'whatsapp', body: 'antiga', createdAt: new Date(Date.now() - 25 * 3600_000) });
    m.calls.length = 0;
    await wa.send(office.officeId, darf);
    expect(m.calls[1].body.type).toBe('template');

    // respondeu há pouco: mensagem livre com o documento
    await env.ctx.db.insert(messages).values({ officeId: office.officeId, customerId, direction: 'in', channel: 'whatsapp', body: 'recente', createdAt: new Date(Date.now() - 3600_000) });
    m.calls.length = 0;
    await wa.send(office.officeId, darf);
    expect(m.calls[1].body).toMatchObject({ type: 'document', document: { id: 'media-77', filename: 'darf-1.pdf', caption: darf.text } });
  });

  it('explica quando o modelo e o envio não combinam e não usa modelo na Evolution', async () => {
    const office = await officeWithWhatsApp({ mode: 'meta', phoneNumberId: '1098765432', templates: 'darf = aviso_darf | pt_BR | CLIENTE | documento\nmensagem = nova_mensagem' }, { accessToken: 'EAAG-token' });
    const customerId = await office.addCustomer('Fábio', VALID_CPFS[0], '11966665555');
    const wa = createProviders(env.ctx, { fetch: mockFetch(metaReply).fn }).whatsapp;
    await expect(wa.send(office.officeId, { to: '5511966665555', text: 'sem anexo', customerId, templateKey: 'darf' })).rejects.toThrow(/leva um PDF no cabeçalho/);
    await expect(
      wa.send(office.officeId, { to: '5511966665555', text: 'com anexo', customerId, document: { filename: 'x.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' } }),
    ).rejects.toThrow(/não leva documento/);

    const evo = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    const evoCustomer = await evo.addCustomer('Gil', VALID_CPFS[1], '11955550000');
    const m = mockFetch(() => ({ key: { id: 'EVO1' } }));
    await createProviders(env.ctx, { fetch: m.fn }).whatsapp.send(evo.officeId, { to: '5511955550000', text: 'oi', customerId: evoCustomer, templateKey: 'darf' });
    expect(m.calls[0].url).toBe('https://evo.exemplo.com.br/message/sendText/escritorio');
  });

  it('o envio pela fila leva o cliente, o tipo e as variáveis, e não guarda as variáveis depois de enviar', async () => {
    const office = await officeWithWhatsApp({ mode: 'meta', phoneNumberId: '1098765432', templates }, { accessToken: 'EAAG-token' });
    const customerId = await office.addCustomer('Helena', VALID_CPFS[2], '11944440000');
    const delivery = await queueDelivery(env.ctx, {
      officeId: office.officeId,
      customerId,
      channel: 'whatsapp',
      templateKey: 'darf',
      values: { VALOR: 'R$ 99,00', VENCIMENTO: '30/09/2026', LINK: 'https://app/portal' },
    });
    const job = await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, 'delivery.send'), eq(jobs.idempotencyKey, delivery.id)) });
    expect(typeof job!.payload.sealed).toBe('string');
    expect(JSON.stringify(job!.payload)).not.toContain('R$ 99,00');
    await env.ctx.jobs.drain();
    const sent = env.providers.sentWhatsApp.find((w) => w.customerId === customerId)!;
    expect(sent).toMatchObject({ templateKey: 'darf', values: expect.objectContaining({ CLIENTE: 'Helena', VALOR: 'R$ 99,00', VENCIMENTO: '30/09/2026' }) });
    const after = await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, job!.id) });
    expect(after!.payload).not.toHaveProperty('sealed');
  });
});
