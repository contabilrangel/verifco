/**
 * WhatsApp de entrada e modelos aprovados (COB-8): webhook da Evolution e da Meta grava a resposta
 * do cliente na aba Mensagens (casando pelo celular), com autenticação do webhook; no modo Meta,
 * fora da janela de 24 h vai o modelo aprovado e os status de envio da Meta atualizam o envio.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { customers, deliveries, messages } from '../src/db/schema';
import { createProviders } from '../src/integrations';
import { parseEvolutionWebhook, parseMetaWebhook, phoneKey, templateParam } from '../src/integrations/whatsapp';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(() => {
  env.providers.fetch = realFetch;
});

type Sent = { url: string; body: any };
function graph() {
  const calls: Sent[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    let body: any = init?.body;
    if (typeof body === 'string') body = JSON.parse(body);
    calls.push({ url, body });
    const json = url.endsWith('/media') ? { id: 'media-1' } : { messaging_product: 'whatsapp', messages: [{ id: `wamid.${calls.length}` }] };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const webhook = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'POST', url, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), headers: { 'content-type': 'application/json', ...headers } });

const evolutionMsg = (from: string, text: string, id = `3EB0${Math.random().toString(16).slice(2, 10)}`, extra: Record<string, unknown> = {}) => ({
  event: 'messages.upsert',
  instance: 'escritorio',
  data: { key: { remoteJid: from, fromMe: false, id }, pushName: 'Cliente', message: { conversation: text }, messageType: 'conversation', messageTimestamp: Math.floor(Date.now() / 1000), ...extra },
});

async function office(mode: 'evolution' | 'meta', extra: { config?: Record<string, unknown>; secrets?: Record<string, string> } = {}) {
  const o = await registerOffice(env);
  const body =
    mode === 'evolution'
      ? { enabled: true, config: { mode, baseUrl: 'https://evo.exemplo.com.br', instance: 'escritorio', ...extra.config }, secrets: { apiKey: 'evo-key-123', ...extra.secrets } }
      : { enabled: true, config: { mode, phoneNumberId: '1098765432', ...extra.config }, secrets: { accessToken: 'EAAG-token', ...extra.secrets } };
  const saved = await o.api.put('/api/integrations/whatsapp', body);
  expect(saved.status).toBe(200);
  expect(saved.body.webhookUrl).toMatch(/\/api\/webhooks\/whatsapp\/[\w-]{16,}$/);
  const token = String(saved.body.webhookUrl).split('/').pop()!;
  const c = await o.api.post('/api/customers', { name: 'Marcos Cliente', cpfCnpj: VALID_CPFS[0] });
  await env.ctx.db.update(customers).set({ mobile: '(11) 98765-4321' }).where(eq(customers.id, c.body.id));
  return { ...o, token, path: `/api/webhooks/whatsapp/${token}`, customerId: c.body.id as string };
}

describe('normalização', () => {
  it('compara celulares com e sem o nono dígito e achata o texto do modelo', () => {
    expect(phoneKey('5511987654321')).toBe(phoneKey('551187654321'));
    expect(phoneKey('+55 (11) 98765-4321')).toBe('551187654321');
    expect(phoneKey('5511987654321')).not.toBe(phoneKey('5521987654321'));
    expect(phoneKey('14155550123')).toBe('14155550123');
    expect(templateParam('Olá!\n\nSegue o DARF.\tVence     amanhã')).toBe('Olá! · Segue o DARF. · Vence amanhã');
    expect(templateParam('x'.repeat(1200))).toHaveLength(1000);
  });

  it('lê os formatos da Evolution e da Meta, ignorando grupos, ecos e reações', () => {
    expect(parseEvolutionWebhook(evolutionMsg('5511987654321@s.whatsapp.net', 'Oi', 'A1'))).toEqual([expect.objectContaining({ id: 'A1', from: '5511987654321', text: 'Oi', name: 'Cliente' })]);
    expect(parseEvolutionWebhook({ ...evolutionMsg('5511987654321@s.whatsapp.net', 'Oi'), event: 'MESSAGES_UPSERT' })).toHaveLength(1);
    expect(parseEvolutionWebhook(evolutionMsg('120363000000000000@g.us', 'grupo'))).toEqual([]);
    expect(parseEvolutionWebhook({ ...evolutionMsg('5511987654321@s.whatsapp.net', 'eco'), data: { key: { remoteJid: '5511987654321@s.whatsapp.net', fromMe: true, id: 'X' }, message: { conversation: 'eco' } } })).toEqual([]);
    expect(parseEvolutionWebhook({ event: 'connection.update', data: {} })).toEqual([]);
    expect(parseEvolutionWebhook(evolutionMsg('5511987654321@s.whatsapp.net', 'Oi'), 'outra-instancia')).toEqual([]);
    const doc = parseEvolutionWebhook({ ...evolutionMsg('5511987654321@s.whatsapp.net', ''), data: { key: { remoteJid: '5511987654321@s.whatsapp.net', id: 'D1' }, message: { documentMessage: { fileName: 'informe.pdf', caption: 'segue' } } } });
    expect(doc[0].text).toBe('[Documento recebido pelo WhatsApp: informe.pdf. Abra a conversa no WhatsApp do escritório para ver o arquivo.] segue');

    const meta = parseMetaWebhook(
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '1098765432' },
                  contacts: [{ wa_id: '5511987654321', profile: { name: 'Marcos' } }],
                  messages: [
                    { from: '5511987654321', id: 'wamid.IN1', timestamp: '1760000000', type: 'text', text: { body: 'Recebi, obrigado' } },
                    { from: '5511987654321', id: 'wamid.R1', type: 'reaction', reaction: { emoji: '👍' } },
                  ],
                  statuses: [{ id: 'wamid.OUT', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }],
                },
              },
            ],
          },
        ],
      },
      '1098765432',
    );
    expect(meta.messages).toEqual([{ id: 'wamid.IN1', from: '5511987654321', name: 'Marcos', text: 'Recebi, obrigado', at: new Date(1760000000 * 1000).toISOString() }]);
    expect(meta.statuses).toEqual([{ id: 'wamid.OUT', status: 'failed', error: expect.stringMatching(/últimas 24 h/) }]);
    expect(parseMetaWebhook({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'outro' }, messages: [{ from: '1', id: 'x', type: 'text', text: { body: 'a' } }] } }] }] }, '1098765432').messages).toEqual([]);
  });
});

describe('webhook da Evolution API', () => {
  it('grava a resposta na aba Mensagens do cliente certo, sem duplicar, e avisa no sino', async () => {
    const o = await office('evolution');
    // o WhatsApp manda o número antigo, sem o nono dígito
    const payload = evolutionMsg('551187654321@s.whatsapp.net', 'Bom dia! Já mandei o informe do banco.', 'MSG-1');
    const r = await webhook(o.path, payload);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ received: true, messages: 1 });
    await webhook(o.path, payload); // a Evolution repete o aviso
    await env.ctx.jobs.drain();

    const conv = await o.api.get(`/api/customers/${o.customerId}/messages`);
    const inbound = conv.body.messages.filter((m: any) => m.direction === 'in');
    expect(inbound).toEqual([expect.objectContaining({ channel: 'whatsapp', body: 'Bom dia! Já mandei o informe do banco.', readAt: null })]);
    expect(conv.body.unread).toBe(1);
    const notes = (await o.api.get('/api/notifications')).body;
    expect(notes.filter((n: any) => n.title === 'Nova mensagem de Marcos Cliente pelo WhatsApp')).toHaveLength(1);
    expect(notes.find((n: any) => n.title === 'Nova mensagem de Marcos Cliente pelo WhatsApp').link).toBe(`/clientes/${o.customerId}/mensagens`);

    // ecos do próprio escritório e grupos não viram mensagem; número sem cliente avisa o escritório
    await webhook(o.path, { ...payload, data: { ...payload.data, key: { ...payload.data.key, id: 'ECO', fromMe: true } } });
    await webhook(o.path, evolutionMsg('120363000000000000@g.us', 'grupo', 'G1'));
    await webhook(o.path, evolutionMsg('5521912345678@s.whatsapp.net', 'Quem é?', 'U1'));
    await env.ctx.jobs.drain();
    expect(await env.ctx.db.select().from(messages).where(and(eq(messages.customerId, o.customerId), eq(messages.direction, 'in')))).toHaveLength(1);
    const unknown = (await o.api.get('/api/notifications')).body.find((n: any) => n.title === 'Mensagem de WhatsApp de número sem cliente');
    expect(unknown.body).toBe('+5521912345678 (Cliente): Quem é?');
  });

  it('recusa token inválido, não cruza escritórios e ignora com a integração desligada', async () => {
    const a = await office('evolution');
    const b = await office('evolution');
    expect((await webhook('/api/webhooks/whatsapp/token-que-nao-existe-123', evolutionMsg('5511987654321@s.whatsapp.net', 'x'))).statusCode).toBe(401);
    expect((await webhook('/api/webhooks/whatsapp/curto', evolutionMsg('5511987654321@s.whatsapp.net', 'x'))).statusCode).toBe(401);
    // mesmo celular nos dois escritórios: a mensagem vai só para o escritório do token
    await webhook(a.path, evolutionMsg('5511987654321@s.whatsapp.net', 'Para o escritório A', 'X-A'));
    await env.ctx.jobs.drain();
    expect((await a.api.get(`/api/customers/${a.customerId}/messages`)).body.messages.some((m: any) => m.body === 'Para o escritório A')).toBe(true);
    expect((await b.api.get(`/api/customers/${b.customerId}/messages`)).body.messages).toEqual([]);

    await b.api.put('/api/integrations/whatsapp', { enabled: false });
    const off = await webhook(b.path, evolutionMsg('5511987654321@s.whatsapp.net', 'desligada', 'X-B'));
    expect(off.json()).toMatchObject({ ignored: expect.stringMatching(/desativada/) });
    await env.ctx.jobs.drain();
    expect((await b.api.get(`/api/customers/${b.customerId}/messages`)).body.messages).toEqual([]);
  });
});

describe('webhook da Cloud API (Meta)', () => {
  const metaPayload = (id: string, text: string, statuses: unknown[] = []) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '551130000000', phone_number_id: '1098765432' },
              contacts: [{ wa_id: '5511987654321', profile: { name: 'Marcos' } }],
              messages: text ? [{ from: '5511987654321', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] : [],
              statuses,
            },
          },
        ],
      },
    ],
  });
  const sign = (raw: string, secret: string) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  it('verificação do webhook usa o token da URL', async () => {
    const o = await office('meta');
    const ok = await env.app.inject({ method: 'GET', url: `${o.path}?hub.mode=subscribe&hub.verify_token=${o.token}&hub.challenge=1158201444` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    expect((await env.app.inject({ method: 'GET', url: `${o.path}?hub.mode=subscribe&hub.verify_token=outro&hub.challenge=1` })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: `/api/webhooks/whatsapp/token-invalido-12345678?hub.mode=subscribe&hub.verify_token=token-invalido-12345678&hub.challenge=1` })).statusCode).toBe(403);
  });

  it('com App Secret, exige a assinatura; grava a mensagem e marca o envio recusado pela Meta', async () => {
    const o = await office('meta', { secrets: { appSecret: 'segredo-do-app' } });
    const raw = JSON.stringify(metaPayload('wamid.IN1', 'Pode mandar o boleto?'));
    expect((await webhook(o.path, raw)).statusCode).toBe(401);
    expect((await webhook(o.path, raw, { 'x-hub-signature-256': sign(raw, 'outro-segredo') })).statusCode).toBe(401);
    const ok = await webhook(o.path, raw, { 'x-hub-signature-256': sign(raw, 'segredo-do-app') });
    expect(ok.statusCode).toBe(200);
    await env.ctx.jobs.drain();
    const conv = (await o.api.get(`/api/customers/${o.customerId}/messages`)).body;
    expect(conv.messages).toEqual([expect.objectContaining({ direction: 'in', channel: 'whatsapp', body: 'Pode mandar o boleto?' })]);

    // envio anterior recusado pela Meta (fora da janela): o status do webhook marca a falha
    const [d] = await env.ctx.db
      .insert(deliveries)
      .values({ officeId: o.officeId, customerId: o.customerId, channel: 'whatsapp', toAddress: '5511987654321', body: 'oi', status: 'sent', providerMessageId: 'wamid.OUT1' })
      .returning();
    const st = JSON.stringify(metaPayload('', '', [{ id: 'wamid.OUT1', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }]));
    const res = await webhook(o.path, st, { 'x-hub-signature-256': sign(st, 'segredo-do-app') });
    expect(res.json()).toMatchObject({ statuses: 1 });
    const failed = await env.ctx.db.query.deliveries.findFirst({ where: eq(deliveries.id, d.id) });
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/não escreveu nas últimas 24 h/) });
  });

  it('fora da janela de 24 h usa o modelo aprovado; dentro dela, texto livre', async () => {
    const o = await office('meta', { config: { templateName: 'aviso_escritorio', templateLanguage: 'pt_BR' } });
    const g = graph();
    const providers = createProviders(env.ctx, { fetch: g.fn });

    // cliente nunca escreveu: modelo com o texto em {{1}}
    await providers.whatsapp.send(o.officeId, { to: '5511987654321', text: 'Olá, Marcos!\nSeu DARF vence amanhã.' });
    expect(g.calls[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511987654321',
      type: 'template',
      template: { name: 'aviso_escritorio', language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Olá, Marcos! · Seu DARF vence amanhã.' }] }] },
    });
    // PDF fora da janela sem cabeçalho de documento no modelo: erro claro, nada enviado
    await expect(
      providers.whatsapp.send(o.officeId, { to: '5511987654321', text: 'DARF', document: { filename: 'darf.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' } }),
    ).rejects.toThrow(/cabeçalho de documento/);
    expect(g.calls).toHaveLength(1);

    // com cabeçalho de documento, o PDF vai no modelo
    await o.api.put('/api/integrations/whatsapp', { config: { templateDocument: true } });
    await providers.whatsapp.send(o.officeId, { to: '5511987654321', text: 'DARF', document: { filename: 'darf.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' } });
    expect(g.calls[1].url).toMatch(/\/media$/);
    expect(g.calls[2].body.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'document', document: { id: 'media-1', filename: 'darf.pdf' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'DARF' }] },
    ]);

    // o cliente escreveu (webhook): dentro da janela, mensagem livre
    await webhook(o.path, metaPayload('wamid.IN2', 'Oi!'));
    await env.ctx.jobs.drain();
    await providers.whatsapp.send(o.officeId, { to: '5511987654321', text: 'Recebido, obrigado.' });
    expect(g.calls.at(-1)!.body).toMatchObject({ type: 'text', text: { body: 'Recebido, obrigado.' } });
  });
});
