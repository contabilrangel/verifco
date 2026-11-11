/**
 * WhatsApp: mídia recebida vira anexo da mensagem (Evolution API e Cloud API da Meta), situação
 * dos envios pela Evolution e conexão da instância por QR Code dentro do Verifco.
 * Os provedores são simulados no `fetch`; os formatos seguem a documentação de cada API.
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { todayIso } from '@verifco/shared';
import { auditLogs, customers, deliveries, jobs, messages } from '../src/db/schema';
import type { Providers } from '../src/integrations/providers';
import { WHATSAPP_CONNECTION_RULE, WHATSAPP_CONNECT_RULE } from '../src/integrations/whatsapp';
import { MEDIA_MAX_BYTES, WHATSAPP_MEDIA_JOB } from '../src/integrations/whatsapp-inbound';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
afterEach(() => {
  env.providers.fetch = realFetch;
  delete (env.providers as Providers).userUrlFetch;
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}
type Reply = { status?: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string> };

/** `fetch` simulado: registra as chamadas e responde JSON ou um arquivo binário. */
function mockFetch(handler: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    let body: any = init?.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const call = { url, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body };
    calls.push(call);
    const r = handler(call);
    if (r.bytes) return new Response(new Uint8Array(r.bytes), { status: r.status ?? 200, headers: { 'content-type': 'application/octet-stream', ...r.headers } });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as typeof fetch;
  return { fn, calls };
}

// começos de arquivo com a assinatura de cada tipo
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF foto do recibo')]);
const PDF = Buffer.from('%PDF-1.7\n informe de rendimentos');
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40, 1)]);
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('planilha')]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

async function officeWithWhatsApp(config: Record<string, unknown>, secrets: Record<string, string>) {
  const office = await registerOffice(env);
  const saved = await office.api.put('/api/integrations/whatsapp', { enabled: true, config, secrets });
  expect(saved.status).toBe(200);
  const token = (saved.body.webhookUrl as string).split('/').pop()!;
  const addCustomer = async (name: string, cpf: string, mobile: string) => {
    const c = await office.api.post('/api/customers', { name, cpfCnpj: cpf });
    await env.ctx.db.update(customers).set({ mobile }).where(eq(customers.id, c.body.id));
    return c.body.id as string;
  };
  return { ...office, token, addCustomer };
}

const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'POST', url: `/api/webhooks/whatsapp/${token}`, payload: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const conversation = (customerId: string) => env.ctx.db.select().from(messages).where(eq(messages.customerId, customerId)).orderBy(messages.createdAt, messages.externalId);
const byExternalId = async (id: string) => (await env.ctx.db.query.messages.findFirst({ where: eq(messages.externalId, id) }))!;
const mediaJobs = (officeId: string) => env.ctx.db.select().from(jobs).where(and(eq(jobs.type, WHATSAPP_MEDIA_JOB), eq(jobs.officeId, officeId)));
const stored = async (officeId: string, fileId: string) => (await env.ctx.files.get(officeId, fileId)).data;

// ---------------------------------------------------------------------------
const evolution = { mode: 'evolution', baseUrl: 'https://evo.exemplo.com.br', instance: 'escritorio' };
let stamp = Math.floor(Date.now() / 1000) - 600;
const upsert = (id: string, phone: string, message: Record<string, unknown>) => ({
  event: 'messages.upsert',
  instance: 'escritorio',
  data: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id }, pushName: 'Cliente', message, messageType: Object.keys(message)[0], messageTimestamp: (stamp += 1) },
});

describe('mídia recebida pela Evolution API', () => {
  it('com o base64 no webhook, o arquivo vira anexo na hora e a legenda vira o texto', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    const maria = await office.addCustomer('Maria', VALID_CPFS[0], '11987650001');
    const m = mockFetch(() => ({ status: 500 }));
    env.providers.fetch = m.fn;

    const res = await post(office.token, upsert('IMG1', '5511987650001', { imageMessage: { caption: 'foto do recibo', mimetype: 'image/jpeg', fileLength: String(JPEG.length) }, base64: JPEG.toString('base64') }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, stored: 1 });
    const [msg] = await conversation(maria);
    expect(msg).toMatchObject({ direction: 'in', channel: 'whatsapp', body: 'foto do recibo', externalId: 'IMG1' });
    expect(msg.attachments).toEqual([{ fileId: expect.any(String), filename: `imagem-whatsapp-${todayIso()}.jpg`, mimeType: 'image/jpeg', size: JPEG.length }]);
    expect(await stored(office.officeId, msg.attachments[0].fileId)).toEqual(JPEG);
    // nada foi pedido ao provedor nem ficou na fila
    expect(m.calls).toEqual([]);
    expect(await mediaJobs(office.officeId)).toEqual([]);

    // áudio sem legenda (com os parâmetros que o WhatsApp põe no tipo) e documento com nome perigoso
    await post(office.token, upsert('AUD1', '5511987650001', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true }, base64: `data:audio/ogg;base64,${OGG.toString('base64')}` }));
    await post(office.token, upsert('DOC1', '5511987650001', { documentWithCaptionMessage: { message: { documentMessage: { fileName: '..\\..\\informe "final".pdf', mimetype: 'application/pdf', caption: 'meu informe' } } }, base64: PDF.toString('base64') }));
    expect(await byExternalId('AUD1')).toMatchObject({ body: '[Áudio]', attachments: [{ filename: `audio-whatsapp-${todayIso()}.ogg`, mimeType: 'audio/ogg', size: OGG.length }] });
    expect(await byExternalId('DOC1')).toMatchObject({ body: 'meu informe', attachments: [{ filename: 'informe final.pdf', mimeType: 'application/pdf', size: PDF.length }] });

    // o reenvio do mesmo evento não grava outro arquivo
    await post(office.token, upsert('IMG1', '5511987650001', { imageMessage: { caption: 'foto do recibo', mimetype: 'image/jpeg' }, base64: JPEG.toString('base64') }));
    expect(await conversation(maria)).toHaveLength(3);
    // a aba Mensagens segue abrindo com as mensagens recebidas
    expect((await office.api.get(`/api/customers/${maria}/messages`)).body.unread).toBe(3);
  });

  it('sem base64 no webhook, a fila pede o arquivo à instância e anexa', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key-secreta' });
    const joao = await office.addCustomer('João', VALID_CPFS[1], '21976540002');
    const m = mockFetch((c) => (c.body?.message?.key?.id === 'DOC2' ? { status: 201, json: { mediaType: 'documentMessage', fileName: 'planilha.xlsx', mimetype: 'application/octet-stream', base64: XLSX.toString('base64') } } : { status: 201, json: { fileName: 'IMG2.jpeg', mimetype: 'image/jpeg', base64: JPEG.toString('base64') } }));
    env.providers.fetch = m.fn;

    // um endereço no corpo do webhook nunca é seguido: o arquivo sai da instância configurada
    const res = await post(office.token, upsert('IMG2', '5521976540002', { imageMessage: { mimetype: 'image/jpeg', url: 'http://169.254.169.254/latest/meta-data', mediaUrl: 'http://10.0.0.1/interno.jpg' }, mediaUrl: 'http://127.0.0.1:5432/' }));
    expect(res.json()).toMatchObject({ received: true, stored: 1 });
    // o webhook respondeu sem falar com o provedor: a mensagem já está na conversa, ainda sem o anexo
    expect(m.calls).toEqual([]);
    expect(await byExternalId('IMG2')).toMatchObject({ body: '[Imagem]', attachments: [] });
    await post(office.token, upsert('DOC2', '5521976540002', { documentMessage: { fileName: 'planilha.xlsx', mimetype: 'application/octet-stream' } }));

    await env.ctx.jobs.drain();
    expect(m.calls.map((c) => c.url)).toEqual(['https://evo.exemplo.com.br/chat/getBase64FromMediaMessage/escritorio', 'https://evo.exemplo.com.br/chat/getBase64FromMediaMessage/escritorio']);
    expect(m.calls[0]).toMatchObject({ method: 'POST', body: { message: { key: { id: 'IMG2', remoteJid: '5521976540002@s.whatsapp.net', fromMe: false } }, convertToMp4: false } });
    expect(m.calls[0].headers.apikey).toBe('evo-key-secreta');
    const img = await byExternalId('IMG2');
    expect(img).toMatchObject({ body: '[Imagem]', attachments: [{ filename: `imagem-whatsapp-${todayIso(img.createdAt)}.jpg`, mimeType: 'image/jpeg', size: JPEG.length }] });
    expect(await stored(office.officeId, img.attachments[0].fileId)).toEqual(JPEG);
    // tipo genérico: vale a extensão do nome, conferida com o conteúdo
    expect(await byExternalId('DOC2')).toMatchObject({ body: '[Documento: planilha.xlsx]', attachments: [{ filename: 'planilha.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: XLSX.length }] });
    expect((await mediaJobs(office.officeId)).map((j) => j.status)).toEqual(['done', 'done']);
    // a chave da instância não fica no job
    expect(JSON.stringify(await mediaJobs(office.officeId))).not.toContain('evo-key-secreta');
    expect(await conversation(joao)).toHaveLength(2);
  });

  it('recusa por tamanho, tipo e conteúdo: a mensagem entra com o motivo e nada é gravado', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    await office.addCustomer('Ana', VALID_CPFS[2], '31988880003');
    const m = mockFetch(() => ({ status: 201, json: { mimetype: 'application/pdf', base64: HTML.toString('base64') } }));
    env.providers.fetch = m.fn;
    const send = (id: string, message: Record<string, unknown>) => post(office.token, upsert(id, '5531988880003', message));

    // tamanho informado acima do limite e vídeo: recusados sem baixar
    await send('BIG1', { documentMessage: { fileName: 'livro-caixa.pdf', mimetype: 'application/pdf', fileLength: { low: MEDIA_MAX_BYTES + 1, high: 0, unsigned: true }, caption: 'livro caixa do ano' } });
    await send('VID1', { videoMessage: { mimetype: 'video/mp4', caption: 'vídeo da obra' } });
    await send('EXE1', { documentMessage: { fileName: 'programa.exe', mimetype: 'application/x-msdownload' } });
    expect(await byExternalId('BIG1')).toMatchObject({ body: 'livro caixa do ano\n[Documento não recebido (livro-caixa.pdf): o arquivo passa de 20 MB.]', attachments: [] });
    expect(await byExternalId('VID1')).toMatchObject({ body: 'vídeo da obra\n[Vídeo não recebido: tipo de arquivo não aceito (video/mp4); aceitos: imagem, PDF, áudio, planilha e documento.]', attachments: [] });
    expect((await byExternalId('EXE1')).body).toBe('[Documento não recebido (programa.exe): tipo de arquivo não aceito (application/x-msdownload); aceitos: imagem, PDF, áudio, planilha e documento.]');
    expect(await mediaJobs(office.officeId)).toEqual([]);

    // base64 do webhook maior que o limite, mesmo sem tamanho informado
    const big = Buffer.concat([JPEG, Buffer.alloc(MEDIA_MAX_BYTES)]);
    const tooBig = await send('BIG2', { imageMessage: { mimetype: 'image/jpeg' }, base64: big.toString('base64') });
    expect(tooBig.statusCode).toBe(200);
    expect((await byExternalId('BIG2')).body).toBe('[Imagem não recebida: o arquivo passa de 20 MB.]');

    // conteúdo que não é do tipo informado (HTML dizendo ser PDF), no webhook e no download
    await send('FAKE1', { documentMessage: { fileName: 'boleto.pdf', mimetype: 'application/pdf' }, base64: HTML.toString('base64') });
    await send('FAKE2', { documentMessage: { fileName: 'boleto.pdf', mimetype: 'application/pdf' } });
    await env.ctx.jobs.drain();
    for (const id of ['FAKE1', 'FAKE2']) {
      expect(await byExternalId(id)).toMatchObject({ body: '[Documento não recebido (boleto.pdf): o conteúdo do arquivo não confere com o tipo informado.]', attachments: [] });
    }
    expect(m.calls).toHaveLength(1);
  });

  it('falha de download: erro definitivo explica na hora; erro passageiro é repetido e explica no fim', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key-secreta' });
    await office.addCustomer('Bia', VALID_CPFS[3], '11955550004');
    let status = 400;
    const m = mockFetch(() => (status === 400 ? { status, json: { status: 400, error: 'Bad Request', response: { message: ['Message not found'] } } } : { status, json: { message: 'Internal Server Error' } }));
    env.providers.fetch = m.fn;

    await post(office.token, upsert('GONE1', '5511955550004', { imageMessage: { mimetype: 'image/jpeg', caption: 'comprovante' } }));
    await env.ctx.jobs.drain();
    expect((await byExternalId('GONE1')).body).toBe('comprovante\n[Imagem não recebida: não foi possível baixar o arquivo: Evolution API respondeu com erro (HTTP 400): Message not found.]');
    expect(m.calls).toHaveLength(1);

    status = 503;
    await post(office.token, upsert('RETRY1', '5511955550004', { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } }));
    await env.ctx.jobs.drain();
    // primeira falha: fica para nova tentativa, sem mexer na mensagem
    const [job] = (await mediaJobs(office.officeId)).filter((j) => j.status === 'queued');
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await byExternalId('RETRY1')).body).toBe('[Áudio]');
    // última tentativa
    await env.ctx.db.update(jobs).set({ runAt: new Date(), attempts: job.maxAttempts - 1 }).where(eq(jobs.id, job.id));
    await env.ctx.jobs.drain();
    const failed = await byExternalId('RETRY1');
    expect(failed.body).toBe('[Áudio não recebido: não foi possível baixar o arquivo: Evolution API respondeu com erro (HTTP 503): Internal Server Error.]');
    expect(failed.attachments).toEqual([]);
    expect(JSON.stringify(await conversation(failed.customerId))).not.toContain('evo-key-secreta');

    // integração desativada antes de a fila rodar
    status = 201;
    await post(office.token, upsert('OFF1', '5511955550004', { imageMessage: { mimetype: 'image/jpeg' } }));
    await office.api.put('/api/integrations/whatsapp', { enabled: false });
    const before = m.calls.length;
    await env.ctx.jobs.drain();
    expect((await byExternalId('OFF1')).body).toBe('[Imagem não recebida: a integração do WhatsApp foi desativada antes do download.]');
    expect(m.calls).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
describe('mídia recebida pela Cloud API da Meta', () => {
  const meta = { mode: 'meta', phoneNumberId: '1098765432' };
  const metaSecrets = { accessToken: 'EAAG-token-secreto', appSecret: 'segredo-do-app' };
  const sign = (raw: string) => `sha256=${createHmac('sha256', 'segredo-do-app').update(raw).digest('hex')}`;
  const LOOKASIDE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=77&ext=1700000000&hash=ATtx';
  const receive = (token: string, message: Record<string, unknown>) => {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '551130000000', phone_number_id: '1098765432' }, messages: [{ from: '5511987650005', timestamp: String((stamp += 1)), ...message }] } }] }],
    });
    return post(token, raw, { 'x-hub-signature-256': sign(raw) });
  };

  it('busca a mídia pelo id, baixa com o token pelo fetch protegido e anexa', async () => {
    const office = await officeWithWhatsApp(meta, metaSecrets);
    const carla = await office.addCustomer('Carla', VALID_CPFS[4], '11987650005');
    const graph = mockFetch((c) => (c.url.endsWith('/MEDIA-DOC') ? { json: { messaging_product: 'whatsapp', url: `${LOOKASIDE}&doc=1`, mime_type: 'application/pdf', sha256: 'x', file_size: PDF.length, id: 'MEDIA-DOC' } } : { json: { messaging_product: 'whatsapp', url: LOOKASIDE, mime_type: 'image/jpeg', sha256: 'x', file_size: JPEG.length, id: 'MEDIA-IMG' } }));
    const download = mockFetch((c) => ({ bytes: c.url.endsWith('&doc=1') ? PDF : JPEG }));
    env.providers.fetch = graph.fn;
    (env.providers as Providers).userUrlFetch = download.fn;

    const res = await receive(office.token, { id: 'wamid.IMG', type: 'image', image: { caption: 'recibo do dentista', mime_type: 'image/jpeg', sha256: 'abc', id: 'MEDIA-IMG' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1 });
    await receive(office.token, { id: 'wamid.DOC', type: 'document', document: { filename: 'informe 2025.pdf', mime_type: 'application/pdf', sha256: 'abc', id: 'MEDIA-DOC' } });
    // o webhook não espera o download
    expect(graph.calls).toEqual([]);
    expect(await byExternalId('wamid.IMG')).toMatchObject({ body: 'recibo do dentista', attachments: [] });

    await env.ctx.jobs.drain();
    expect(graph.calls.map((c) => c.url)).toEqual(['https://graph.facebook.com/v25.0/MEDIA-IMG', 'https://graph.facebook.com/v25.0/MEDIA-DOC']);
    expect(graph.calls[0].headers.authorization).toBe('Bearer EAAG-token-secreto');
    // o endereço devolvido pela Meta passa pelo fetch dos endereços externos, com o mesmo token
    expect(download.calls.map((c) => c.url)).toEqual([LOOKASIDE, `${LOOKASIDE}&doc=1`]);
    expect(download.calls[0].headers.authorization).toBe('Bearer EAAG-token-secreto');
    expect(download.calls[0].headers['user-agent']).toBeTruthy();
    const img = await byExternalId('wamid.IMG');
    expect(img).toMatchObject({ body: 'recibo do dentista', attachments: [{ filename: `imagem-whatsapp-${todayIso(img.createdAt)}.jpg`, mimeType: 'image/jpeg', size: JPEG.length }] });
    expect(await stored(office.officeId, img.attachments[0].fileId)).toEqual(JPEG);
    expect(await byExternalId('wamid.DOC')).toMatchObject({ body: '[Documento: informe 2025.pdf]', attachments: [{ filename: 'informe 2025.pdf', mimeType: 'application/pdf', size: PDF.length }] });
    expect(await conversation(carla)).toHaveLength(2);
    expect(JSON.stringify(await mediaJobs(office.officeId))).not.toContain('EAAG-token-secreto');
  });

  it('recusas: arquivo grande, vídeo, endereço fora da Meta e download que falha', async () => {
    const office = await officeWithWhatsApp(meta, metaSecrets);
    await office.addCustomer('Carla', VALID_CPFS[5], '11987650005');
    const info: Record<string, unknown> = {
      'MEDIA-BIG': { url: LOOKASIDE, mime_type: 'application/pdf', file_size: MEDIA_MAX_BYTES + 1 },
      'MEDIA-LIE': { url: `${LOOKASIDE}&lie=1`, mime_type: 'application/pdf', file_size: 1000 },
      'MEDIA-SSRF': { url: 'https://169.254.169.254/latest/meta-data/', mime_type: 'image/jpeg', file_size: 10 },
      'MEDIA-HTTP': { url: 'http://lookaside.fbsbx.com/arquivo', mime_type: 'image/jpeg', file_size: 10 },
      'MEDIA-404': { url: `${LOOKASIDE}&gone=1`, mime_type: 'audio/ogg', file_size: 10 },
    };
    const graph = mockFetch((c) => {
      const id = c.url.split('/').pop()!;
      return info[id] ? { json: info[id] } : { status: 400, json: { error: { message: 'Unsupported get request. Object with ID does not exist', code: 100 } } };
    });
    const download = mockFetch((c) => (c.url.endsWith('&gone=1') ? { status: 404, json: { error: { message: 'Media expired', code: 131052 } } } : { bytes: Buffer.concat([PDF, Buffer.alloc(MEDIA_MAX_BYTES)]) }));
    env.providers.fetch = graph.fn;
    (env.providers as Providers).userUrlFetch = download.fn;
    const body = async (id: string) => (await byExternalId(id)).body;

    await receive(office.token, { id: 'wamid.VID', type: 'video', video: { mime_type: 'video/mp4', id: 'MEDIA-VID', caption: 'olha isso' } });
    expect(await body('wamid.VID')).toBe('olha isso\n[Vídeo não recebido: tipo de arquivo não aceito (video/mp4); aceitos: imagem, PDF, áudio, planilha e documento.]');
    expect(await mediaJobs(office.officeId)).toEqual([]);

    await receive(office.token, { id: 'wamid.BIG', type: 'document', document: { filename: 'extrato.pdf', mime_type: 'application/pdf', id: 'MEDIA-BIG' } });
    await receive(office.token, { id: 'wamid.LIE', type: 'document', document: { filename: 'extrato.pdf', mime_type: 'application/pdf', id: 'MEDIA-LIE' } });
    await receive(office.token, { id: 'wamid.SSRF', type: 'image', image: { mime_type: 'image/jpeg', id: 'MEDIA-SSRF' } });
    await receive(office.token, { id: 'wamid.HTTP', type: 'image', image: { mime_type: 'image/jpeg', id: 'MEDIA-HTTP' } });
    await receive(office.token, { id: 'wamid.404', type: 'audio', audio: { mime_type: 'audio/ogg; codecs=opus', id: 'MEDIA-404', voice: true } });
    await receive(office.token, { id: 'wamid.NOID', type: 'image', image: { mime_type: 'image/jpeg', id: 'MEDIA-GONE' } });
    await env.ctx.jobs.drain();

    // tamanho informado pela Meta acima do limite: nem baixa; tamanho real acima do informado: para no limite
    expect(await body('wamid.BIG')).toBe('[Documento não recebido (extrato.pdf): o arquivo passa de 20 MB.]');
    expect(await body('wamid.LIE')).toBe('[Documento não recebido (extrato.pdf): o arquivo passa de 20 MB.]');
    // endereço que não é https da Meta não é seguido (o token não sai)
    expect(await body('wamid.SSRF')).toBe('[Imagem não recebida: a Meta não informou um endereço de download válido.]');
    expect(await body('wamid.HTTP')).toBe('[Imagem não recebida: a Meta não informou um endereço de download válido.]');
    expect(await body('wamid.404')).toBe('[Áudio não recebido: não foi possível baixar o arquivo: A Meta não entregou o arquivo (HTTP 404): Media expired – código 131052.]');
    expect(await body('wamid.NOID')).toContain('[Imagem não recebida: não foi possível baixar o arquivo: WhatsApp Cloud API respondeu com erro (HTTP 400): Unsupported get request');
    expect(download.calls.map((c) => c.url)).toEqual([`${LOOKASIDE}&lie=1`, `${LOOKASIDE}&gone=1`]);
    const all = await env.ctx.db.select().from(messages).where(eq(messages.officeId, office.officeId));
    expect(all).toHaveLength(7);
    expect(all.flatMap((m) => m.attachments)).toEqual([]);
    expect(JSON.stringify(all)).not.toContain('EAAG-token-secreto');
  });
});

// ---------------------------------------------------------------------------
describe('situação dos envios pela Evolution API (messages.update)', () => {
  const update = (data: unknown, event = 'messages.update') => ({ event, instance: 'escritorio', data });
  const ack = (keyId: string, status: string | number, extra: Record<string, unknown> = {}) => ({ messageId: 'cm0abc', keyId, remoteJid: '5511933330006@s.whatsapp.net', fromMe: true, status, instanceId: 'inst-1', ...extra });

  it('entrega, leitura e erro atualizam o envio pelo id da mensagem, sem voltar atrás', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    const other = await officeWithWhatsApp(evolution, { apiKey: 'evo-outro' });
    const customerId = await office.addCustomer('Davi', VALID_CPFS[6], '11933330006');
    const send = async (officeId: string, providerMessageId: string, customer: string | null = customerId) =>
      (await env.ctx.db.insert(deliveries).values({ officeId, customerId: customer, channel: 'whatsapp', toAddress: '5511933330006', body: 'oi', status: 'sent', providerMessageId }).returning())[0];
    const status = async (id: string) => {
      const row = await env.ctx.db.query.deliveries.findFirst({ where: eq(deliveries.id, id) });
      return { status: row!.status, error: row!.error };
    };
    const a = await send(office.officeId, '3EB0OUT1');
    const b = await send(office.officeId, '3EB0OUT2');
    const c = await send(office.officeId, '3EB0OUT3');
    const foreign = await send(other.officeId, '3EB0OUT1', null);

    // aceito pelo servidor do WhatsApp: continua "enviado"
    expect((await post(office.token, update(ack('3EB0OUT1', 'SERVER_ACK')))).json()).toMatchObject({ received: true, stored: 0 });
    expect(await status(a.id)).toEqual({ status: 'sent', error: null });
    // entregue
    await post(office.token, update(ack('3EB0OUT1', 'DELIVERY_ACK')));
    expect(await status(a.id)).toEqual({ status: 'delivered', error: null });
    // ack atrasado, leitura e erro tardio não desfazem a entrega
    await post(office.token, update(ack('3EB0OUT1', 'SERVER_ACK')));
    await post(office.token, update(ack('3EB0OUT1', 'READ')));
    await post(office.token, update(ack('3EB0OUT1', 'ERROR')));
    expect(await status(a.id)).toEqual({ status: 'delivered', error: null });
    // o envio com o mesmo id em outro escritório não muda
    expect(await status(foreign.id)).toEqual({ status: 'sent', error: null });

    // erro: falhou, com o motivo; a entrega que chegar depois não reabre
    await post(office.token, update(ack('3EB0OUT2', 'ERROR')));
    expect(await status(b.id)).toEqual({ status: 'failed', error: 'O WhatsApp informou erro no envio da mensagem pela Evolution API. Confira se o número existe e se a instância está conectada.' });
    await post(office.token, update(ack('3EB0OUT2', 'DELIVERY_ACK')));
    expect((await status(b.id)).status).toBe('failed');

    // leitura direto (sem o aviso de entrega), em lista, com o número do Baileys e no formato com `key`
    await post(office.token, update([{ key: { id: '3EB0OUT3', remoteJid: '5511933330006@s.whatsapp.net', fromMe: true }, update: { status: 4 } }], 'MESSAGES_UPDATE'));
    expect(await status(c.id)).toEqual({ status: 'delivered', error: null });
  });

  it('ignora avisos de mensagens recebidas, de outra instância, sem id ou com situação desconhecida', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    const [sent] = await env.ctx.db.insert(deliveries).values({ officeId: office.officeId, channel: 'whatsapp', toAddress: '5511933330007', body: 'oi', status: 'sent', providerMessageId: '3EB0KEEP' }).returning();
    const events = [
      update(ack('3EB0KEEP', 'READ', { fromMe: false })),
      { ...update(ack('3EB0KEEP', 'DELIVERY_ACK')), instance: 'outra' },
      update(ack('3EB0KEEP', 'DELETED')),
      update({ status: 'DELIVERY_ACK', fromMe: true }),
      update(null),
      update('texto'),
      update([null, 5, { keyId: 3 }]),
    ];
    for (const e of events) expect((await post(office.token, e)).statusCode).toBe(200);
    expect(await env.ctx.db.query.deliveries.findFirst({ where: eq(deliveries.id, sent.id) })).toMatchObject({ status: 'sent', error: null });
  });
});

// ---------------------------------------------------------------------------
describe('conectar a Evolution API dentro do Verifco', () => {
  const QR = `data:image/png;base64,${Buffer.alloc(120, 7).toString('base64')}`;

  it('consulta o estado, pede a conexão com o QR Code e mostra o número conectado', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key-secreta' });
    let state = 'close';
    const m = mockFetch((c) => {
      if (c.url.includes('/instance/connectionState/')) return { json: { instance: { instanceName: 'escritorio', state } } };
      if (c.url.includes('/instance/connect/')) return state === 'open' ? { json: { instance: { instanceName: 'escritorio', state: 'open' } } } : { json: { pairingCode: 'WZYEH1YY', code: '2@abc,def,ghi==', base64: QR, count: 1 } };
      if (c.url.includes('/instance/fetchInstances')) return { json: [{ id: 'i1', name: 'escritorio', connectionStatus: 'open', ownerJid: '5511987654321:12@s.whatsapp.net', profileName: 'Escritório Teste' }] };
      return { status: 404, json: {} };
    });
    env.providers.fetch = m.fn;

    const closed = await office.api.get('/api/integrations/whatsapp/connection');
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ state: 'close', number: null, profileName: null, qrImage: null, qrCode: null, pairingCode: null });
    expect(m.calls[0]).toMatchObject({ url: 'https://evo.exemplo.com.br/instance/connectionState/escritorio', method: 'GET' });
    expect(m.calls[0].headers.apikey).toBe('evo-key-secreta');

    const qr = await office.api.post('/api/integrations/whatsapp/connect');
    expect(qr.status).toBe(200);
    expect(qr.body).toEqual({ state: 'connecting', number: null, profileName: null, qrImage: QR, qrCode: '2@abc,def,ghi==', pairingCode: 'WZYEH1YY' });
    expect(m.calls.at(-1)).toMatchObject({ url: 'https://evo.exemplo.com.br/instance/connect/escritorio', method: 'GET' });

    state = 'connecting';
    expect((await office.api.get('/api/integrations/whatsapp/connection')).body.state).toBe('connecting');
    state = 'open';
    const open = await office.api.get('/api/integrations/whatsapp/connection');
    expect(open.body).toEqual({ state: 'open', number: '5511987654321', profileName: 'Escritório Teste', qrImage: null, qrCode: null, pairingCode: null });
    expect(m.calls.at(-1)!.url).toBe('https://evo.exemplo.com.br/instance/fetchInstances?instanceName=escritorio');
    // pedir a conexão com a instância já conectada devolve o estado, sem QR Code
    expect((await office.api.post('/api/integrations/whatsapp/connect')).body).toMatchObject({ state: 'open', number: '5511987654321', qrImage: null });
    for (const r of [closed, qr, open]) expect(JSON.stringify(r.body)).not.toContain('evo-key-secreta');
    // a troca do QR Code (refresh) devolve o mesmo e não entra na auditoria: até aqui, dois pedidos de conexão
    state = 'connecting';
    expect((await office.api.post('/api/integrations/whatsapp/connect', { refresh: true })).body).toMatchObject({ state: 'connecting', qrImage: QR });
    const audited = await env.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.officeId, office.officeId), eq(auditLogs.action, 'integration.connect')));
    expect(audited).toHaveLength(2);
  });

  it('respostas incompletas ou estranhas da instância não derrubam a tela', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    let connect: unknown = { count: 0 };
    const m = mockFetch((c) => {
      if (c.url.includes('/instance/connectionState/')) return { json: { instance: { state: 'connecting' } } };
      if (c.url.includes('/instance/connect/')) return { json: connect };
      return { status: 500, json: { message: 'falhou' } };
    });
    env.providers.fetch = m.fn;
    // o QR Code ainda não foi gerado
    expect((await office.api.post('/api/integrations/whatsapp/connect')).body).toEqual({ state: 'connecting', number: null, profileName: null, qrImage: null, qrCode: null, pairingCode: null });
    // imagem que não é PNG/JPG em base64 (SVG, endereço externo) não chega à tela; fica o código
    connect = { code: '2@so-o-codigo', base64: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==' };
    expect((await office.api.post('/api/integrations/whatsapp/connect')).body).toMatchObject({ state: 'connecting', qrImage: null, qrCode: '2@so-o-codigo' });
    connect = { qrcode: { base64: 'https://evil.example/qr.png', code: 'x'.repeat(3000) }, pairingCode: '<b>' };
    expect((await office.api.post('/api/integrations/whatsapp/connect')).body).toMatchObject({ state: 'connecting', qrImage: null, qrCode: null, pairingCode: null });
    // conectada, mas a instância não informa o número
    connect = { instance: { instanceName: 'escritorio', state: 'open' } };
    expect((await office.api.post('/api/integrations/whatsapp/connect')).body).toEqual({ state: 'open', number: null, profileName: null, qrImage: null, qrCode: null, pairingCode: null });
  });

  it('o erro da Evolution volta com a mensagem dela, sem a chave; na Meta e sem configuração, explica', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key-secreta-9876' });
    env.providers.fetch = mockFetch(() => ({ status: 404, json: { status: 404, error: 'Not Found', response: { message: ['The "escritorio" instance does not exist'] } } })).fn;
    const missing = await office.api.post('/api/integrations/whatsapp/connect');
    expect(missing.status).toBe(502);
    expect(missing.body.error).toBe('Evolution API respondeu com erro (HTTP 404): The "escritorio" instance does not exist.');
    env.providers.fetch = mockFetch(() => ({ status: 401, json: { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } } })).fn;
    const denied = await office.api.get('/api/integrations/whatsapp/connection');
    expect(denied.status).toBe(502);
    expect(denied.body.error).toBe('Credenciais recusadas pelo Evolution API (HTTP 401): Unauthorized. Confira a chave configurada.');
    env.providers.fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.5:8080 apikey=evo-key-secreta-9876' } });
    }) as typeof fetch;
    const offline = await office.api.get('/api/integrations/whatsapp/connection');
    expect(offline.status).toBe(502);
    expect(offline.body.error).toBe('Não foi possível conectar ao Evolution API. Confira o endereço e a conexão.');
    for (const r of [missing, denied, offline]) expect(JSON.stringify(r.body)).not.toContain('evo-key-secreta-9876');

    const meta = await officeWithWhatsApp({ mode: 'meta', phoneNumberId: '1098765432' }, { accessToken: 'EAAG-token' });
    const notEvolution = await meta.api.post('/api/integrations/whatsapp/connect');
    expect(notEvolution.status).toBe(400);
    expect(notEvolution.body.error).toContain('A conexão por QR Code vale só para a Evolution API');
    const empty = await registerOffice(env);
    expect(await empty.api.get('/api/integrations/whatsapp/connection')).toMatchObject({ status: 400, body: { error: 'Salve a configuração do WhatsApp antes de conectar.' } });
  });

  it('exige a permissão de integrações e limita as chamadas por escritório', async () => {
    const office = await officeWithWhatsApp(evolution, { apiKey: 'evo-key' });
    const m = mockFetch((c) => (c.url.includes('/instance/connect/') ? { json: { code: '2@abc', base64: QR } } : { json: { instance: { state: 'close' } } }));
    env.providers.fetch = m.fn;
    const employee = await createEmployee(env, office.api, ['customer.list']);
    expect((await employee.api.get('/api/integrations/whatsapp/connection')).status).toBe(403);
    expect((await employee.api.post('/api/integrations/whatsapp/connect')).status).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/integrations/whatsapp/connection' })).statusCode).toBe(401);
    expect(m.calls).toEqual([]);

    const limits = { state: WHATSAPP_CONNECTION_RULE.max, connect: WHATSAPP_CONNECT_RULE.max };
    env.ctx.config.RATE_LIMIT = true;
    WHATSAPP_CONNECTION_RULE.max = 2;
    WHATSAPP_CONNECT_RULE.max = 1;
    try {
      expect((await office.api.get('/api/integrations/whatsapp/connection')).status).toBe(200);
      expect((await office.api.get('/api/integrations/whatsapp/connection')).status).toBe(200);
      const third = await office.api.get('/api/integrations/whatsapp/connection');
      expect(third.status).toBe(429);
      expect(third.body.error).toBe('Muitas consultas à conexão do WhatsApp. Aguarde um instante e tente de novo.');
      expect((await office.api.post('/api/integrations/whatsapp/connect')).status).toBe(200);
      expect((await office.api.post('/api/integrations/whatsapp/connect')).status).toBe(429);
      // o limite é por escritório: outro escritório segue consultando
      const other = await officeWithWhatsApp(evolution, { apiKey: 'evo-outro' });
      expect((await other.api.get('/api/integrations/whatsapp/connection')).status).toBe(200);
      expect(m.calls).toHaveLength(4);
    } finally {
      env.ctx.config.RATE_LIMIT = false;
      WHATSAPP_CONNECTION_RULE.max = limits.state;
      WHATSAPP_CONNECT_RULE.max = limits.connect;
    }
  });
});
