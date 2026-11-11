import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { currentExerciseYear } from '@verifco/shared';
import { deliveries, files, messages } from '../src/db/schema';
import { VALID_CPFS, client, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';
import { PDF, PNG, customerLogin, issueAccess } from './portal-helpers';
import { upload } from './upload-helpers';

/**
 * Caixa de mensagens do escritório (conversas de todos os clientes, não lidas) e anexos no chat,
 * nos dois sentidos, com o download conferido pela conversa.
 */
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

type Office = Awaited<ReturnType<typeof registerOffice>>;

async function newCustomer(api: Api, name: string, cpf: string, extra: Record<string, unknown> = {}) {
  const res = await api.post('/api/customers', { name, cpfCnpj: cpf, email: `${cpf}@cliente.com`, ...extra });
  if (res.status !== 201) throw new Error(`cliente: ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

/** Libera o portal do cliente e devolve o token e o cliente HTTP dele. */
async function portalOf(office: Office, customerId: string, cpf: string) {
  const access = await office.api.post(`/api/customers/${customerId}/portal-access`);
  const login = await env.app.inject({ method: 'POST', url: '/api/portal/login', payload: { cpf, code: access.body.code, officeId: office.officeId } });
  if (login.statusCode !== 200) throw new Error(`portal: ${login.body}`);
  const token = login.json().token as string;
  return { token, api: client(env, token) };
}

/** Mensagem gravada direto no banco, com a data escolhida (a ordem da caixa depende dela). */
async function addMessage(officeId: string, customerId: string, direction: 'in' | 'out', body: string, at: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  const [row] = await env.ctx.db
    .insert(messages)
    .values({ officeId, customerId, direction, channel: 'portal', body, createdAt: new Date(at), ...extra })
    .returning();
  return row;
}

const countFiles = async (officeId: string) => (await env.ctx.db.select({ id: files.id }).from(files).where(eq(files.officeId, officeId))).length;
const names = (res: { body: any }) => res.body.data.map((t: any) => t.customer.name);

describe('caixa de mensagens do escritório', () => {
  it('uma linha por cliente com conversa: última mensagem, não lidas, busca, filtro e paginação', async () => {
    const office = await registerOffice(env);
    const ana = await newCustomer(office.api, 'Ana Lima', VALID_CPFS[0]);
    const bruno = await newCustomer(office.api, 'Bruno Costa', VALID_CPFS[1]);
    const carla = await newCustomer(office.api, 'Carla Dias', VALID_CPFS[2]);
    const excluido = await newCustomer(office.api, 'Dario Excluído', VALID_CPFS[3]);
    await newCustomer(office.api, 'Elisa Sem Conversa', VALID_CPFS[4]);

    await addMessage(office.officeId, ana, 'out', 'Olá, Ana!', '2026-03-01T10:00:00Z', { authorUserId: office.userId, readAt: new Date() });
    await addMessage(office.officeId, ana, 'in', 'Segue a dúvida sobre o informe.', '2026-03-01T11:00:00Z');
    await addMessage(office.officeId, ana, 'in', `${'Texto longo '.repeat(20)}fim`, '2026-03-03T09:00:00Z');
    await addMessage(office.officeId, bruno, 'in', 'Bom dia', '2026-03-02T08:00:00Z', { readAt: new Date() });
    await addMessage(office.officeId, bruno, 'out', 'Bom dia, Bruno! Recebemos tudo.', '2026-03-02T09:00:00Z', { authorUserId: office.userId });
    await addMessage(office.officeId, carla, 'in', '', '2026-03-04T12:00:00Z', {
      attachments: [{ fileId: '00000000-0000-4000-8000-000000000001', filename: 'informe.pdf', mimeType: 'application/pdf', size: 10 }],
    });
    await addMessage(office.officeId, excluido, 'in', 'Ainda estou aqui?', '2026-03-05T12:00:00Z');
    expect((await office.api.del(`/api/customers/${excluido}`)).status).toBe(200);

    const all = await office.api.get('/api/messages/threads');
    expect(all.status).toBe(200);
    // da conversa mais recente para a mais antiga; sem o cliente excluído e sem quem não tem conversa
    expect(names(all)).toEqual(['Carla Dias', 'Ana Lima', 'Bruno Costa']);
    expect(all.body).toMatchObject({ total: 3, page: 1, pages: 1 });
    const [tCarla, tAna, tBruno] = all.body.data;
    expect(tCarla).toMatchObject({ customer: { id: carla, name: 'Carla Dias' }, unread: 1, lastMessage: { direction: 'in', preview: 'Anexo', hasAttachments: true, authorName: 'Carla Dias' } });
    expect(tAna.unread).toBe(2);
    expect(tAna.lastMessage.preview.length).toBe(140);
    expect(tAna.lastMessage.preview.endsWith('…')).toBe(true);
    expect(tAna.lastMessage.hasAttachments).toBe(false);
    expect(new Date(tAna.lastMessage.createdAt).toISOString()).toBe('2026-03-03T09:00:00.000Z');
    // mensagem do escritório por último: autor é quem enviou, nada por ler
    expect(tBruno).toMatchObject({ unread: 0, lastMessage: { direction: 'out', preview: 'Bom dia, Bruno! Recebemos tudo.', authorName: 'Ana Dona' } });
    // a linha não leva o corpo inteiro nem os arquivos
    expect(Object.keys(tCarla.lastMessage).sort()).toEqual(['authorName', 'channel', 'createdAt', 'direction', 'hasAttachments', 'id', 'preview']);

    expect((await office.api.get('/api/messages/unread-count')).body).toEqual({ count: 3, threads: 2 });
    expect(names(await office.api.get('/api/messages/threads?filter=unread'))).toEqual(['Carla Dias', 'Ana Lima']);
    expect(names(await office.api.get('/api/messages/threads?q=bruno'))).toEqual(['Bruno Costa']);
    expect(names(await office.api.get(`/api/messages/threads?q=${VALID_CPFS[0].slice(0, 6)}`))).toEqual(['Ana Lima']);
    expect((await office.api.get('/api/messages/threads?filter=unread&q=bruno')).body).toMatchObject({ total: 0, data: [] });

    const p2 = await office.api.get('/api/messages/threads?pageSize=2&page=2');
    expect(p2.body).toMatchObject({ total: 3, page: 2, pageSize: 2, pages: 2 });
    expect(names(p2)).toEqual(['Bruno Costa']);
    expect((await office.api.get('/api/messages/threads?filter=outra')).status).toBe(400);

    // abrir a conversa marca como lida e a contagem acompanha
    expect((await office.api.post(`/api/customers/${ana}/messages/read`)).status).toBe(200);
    expect((await office.api.get('/api/messages/unread-count')).body).toEqual({ count: 1, threads: 1 });
    expect(names(await office.api.get('/api/messages/threads?filter=unread'))).toEqual(['Carla Dias']);
    expect((await office.api.get('/api/messages/threads')).body.data[1]).toMatchObject({ customer: { id: ana }, unread: 0 });
  });

  it('respeita o escopo por responsável, a permissão e o escritório', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['customer.list']);
    const mine = await newCustomer(office.api, 'Fábio do Colaborador', VALID_CPFS[0], { responsibleUserId: emp.userId });
    const other = await newCustomer(office.api, 'Gabi do Dono', VALID_CPFS[1]);
    await addMessage(office.officeId, mine, 'in', 'Oi, sou o Fábio', '2026-04-01T10:00:00Z');
    await addMessage(office.officeId, other, 'in', 'Oi, sou a Gabi', '2026-04-02T10:00:00Z');
    await addMessage(office.officeId, other, 'in', 'Tem alguém aí?', '2026-04-02T11:00:00Z');

    // sem a restrição, quem lista clientes vê todas as conversas
    expect(names(await emp.api.get('/api/messages/threads'))).toEqual(['Gabi do Dono', 'Fábio do Colaborador']);
    expect((await emp.api.get('/api/messages/unread-count')).body).toEqual({ count: 3, threads: 2 });

    await office.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    const scoped = await emp.api.get('/api/messages/threads');
    expect(scoped.body.total).toBe(1);
    expect(names(scoped)).toEqual(['Fábio do Colaborador']);
    expect((await emp.api.get('/api/messages/threads?q=gabi')).body.total).toBe(0);
    expect((await emp.api.get('/api/messages/unread-count')).body).toEqual({ count: 1, threads: 1 });
    // o dono continua vendo tudo
    expect((await office.api.get('/api/messages/threads')).body.total).toBe(2);
    expect((await office.api.get('/api/messages/unread-count')).body).toEqual({ count: 3, threads: 2 });

    // sem a permissão de ver clientes, nem a caixa nem a contagem
    const noPerm = await createEmployee(env, office.api, ['mailing.list']);
    expect((await noPerm.api.get('/api/messages/threads')).status).toBe(403);
    expect((await noPerm.api.get('/api/messages/unread-count')).status).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/messages/threads' })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/api/messages/unread-count' })).statusCode).toBe(401);

    // outro escritório não vê nada daqui
    const stranger = await registerOffice(env, 'Outro Escritório');
    expect((await stranger.api.get('/api/messages/threads')).body).toMatchObject({ total: 0, data: [] });
    expect((await stranger.api.get('/api/messages/unread-count')).body).toEqual({ count: 0, threads: 0 });
  });
});

describe('anexos no chat', () => {
  it('escritório e cliente trocam arquivos; as listagens trazem os anexos e cada lado baixa os da conversa', async () => {
    const office = await registerOffice(env);
    const customerId = await newCustomer(office.api, 'Helena Prado', VALID_CPFS[5]);
    const portal = await portalOf(office, customerId, VALID_CPFS[5]);

    // escritório → cliente: texto e dois arquivos (o tipo vem da extensão conferida, não do navegador)
    const sent = await upload(
      env,
      office.token,
      `/api/customers/${customerId}/messages`,
      [
        { name: 'recibo.pdf', content: PDF, type: 'text/html' },
        { name: 'foto.png', content: PNG },
      ],
      { body: '  Seguem os recibos.  ' },
    );
    expect(sent.status).toBe(201);
    const out = sent.body.messages.at(-1);
    expect(out).toMatchObject({ direction: 'out', channel: 'portal', body: 'Seguem os recibos.', authorName: 'Ana Dona' });
    expect(out.attachments).toHaveLength(2);
    expect(out.attachments[0]).toEqual({ fileId: expect.any(String), filename: 'recibo.pdf', mimeType: 'application/pdf', size: PDF.length });
    expect(out.attachments[1]).toMatchObject({ filename: 'foto.png', mimeType: 'image/png', size: PNG.length });
    expect(JSON.stringify(sent.body)).not.toContain('storageKey');

    // o cliente vê os anexos e baixa pelo portal
    const inbox = await portal.api.get('/api/portal/messages');
    expect(inbox.body.messages[0].attachments).toEqual(out.attachments);
    expect(JSON.stringify(inbox.body)).not.toContain('storageKey');
    const got = await portal.api.get(`/api/portal/messages/${out.id}/attachments/${out.attachments[0].fileId}`);
    expect(got.status).toBe(200);
    expect(got.raw.rawPayload.equals(PDF)).toBe(true);
    expect(got.raw.headers['content-type']).toBe('application/pdf');
    expect(String(got.raw.headers['content-disposition'])).toContain("attachment; filename*=UTF-8''recibo.pdf");
    expect(got.raw.headers['x-content-type-options']).toBe('nosniff');

    // cliente → escritório: só o arquivo, sem texto
    const reply = await upload(env, portal.token, '/api/portal/messages', [{ name: 'informe banco.pdf', content: PDF }]);
    expect(reply.status).toBe(201);
    const incoming = reply.body.messages.at(-1);
    expect(incoming).toMatchObject({ fromMe: true, body: '' });
    expect(incoming.attachments).toEqual([{ fileId: expect.any(String), filename: 'informe banco.pdf', mimeType: 'application/pdf', size: PDF.length }]);

    // o escritório vê na conversa, na caixa e no sino, e baixa pela rota da conversa
    const conv = await office.api.get(`/api/customers/${customerId}/messages`);
    expect(conv.body.unread).toBe(1);
    expect(conv.body.messages.at(-1).attachments).toEqual(incoming.attachments);
    const thread = (await office.api.get('/api/messages/threads')).body.data[0];
    expect(thread).toMatchObject({ customer: { id: customerId }, unread: 1, lastMessage: { preview: 'Anexo', hasAttachments: true } });
    const note = (await office.api.get('/api/notifications')).body.find((n: any) => n.link === `/clientes/${customerId}/mensagens`);
    expect(note).toMatchObject({ title: 'Nova mensagem de Helena Prado', body: 'Anexo' });
    const file = await office.api.get(`/api/customers/${customerId}/messages/${incoming.id}/attachments/${incoming.attachments[0].fileId}`);
    expect(file.status).toBe(200);
    expect(file.raw.rawPayload.equals(PDF)).toBe(true);
    // PDF e imagem podem abrir no navegador quando pedido
    const inline = await office.api.get(`/api/customers/${customerId}/messages/${incoming.id}/attachments/${incoming.attachments[0].fileId}?inline=1`);
    expect(String(inline.raw.headers['content-disposition'])).toContain('inline');

    // quem manda só texto em JSON continua funcionando, e a mensagem vem com a lista vazia
    const text = await office.api.post(`/api/customers/${customerId}/messages`, { body: 'Recebido, obrigada!' });
    expect(text.status).toBe(201);
    expect(text.body.messages.at(-1)).toMatchObject({ body: 'Recebido, obrigada!', attachments: [] });
    const textReply = await portal.api.post('/api/portal/messages', { body: 'De nada.' });
    expect(textReply.body.messages.at(-1)).toMatchObject({ body: 'De nada.', attachments: [] });
  });

  it('nega o download fora da conversa: outro escritório, outro cliente, fora do escopo e arquivo de outra mensagem', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['customer.list', 'message.send']);
    const ivo = await newCustomer(office.api, 'Ivo Reis', VALID_CPFS[6]);
    const julia = await newCustomer(office.api, 'Júlia Melo', VALID_CPFS[7], { responsibleUserId: emp.userId });
    const ivoPortal = await portalOf(office, ivo, VALID_CPFS[6]);
    const juliaPortal = await portalOf(office, julia, VALID_CPFS[7]);

    const toIvo = (await upload(env, office.token, `/api/customers/${ivo}/messages`, [{ name: 'ivo.pdf', content: PDF }], { body: 'Para o Ivo' })).body.messages.at(-1);
    const toJulia = (await upload(env, office.token, `/api/customers/${julia}/messages`, [{ name: 'julia.pdf', content: PDF }])).body.messages.at(-1);
    const ivoFile = toIvo.attachments[0].fileId as string;
    const juliaFile = toJulia.attachments[0].fileId as string;
    const officeUrl = (customerId: string, messageId: string, fileId: string) => `/api/customers/${customerId}/messages/${messageId}/attachments/${fileId}`;
    const portalUrl = (messageId: string, fileId: string) => `/api/portal/messages/${messageId}/attachments/${fileId}`;

    // cada cliente baixa só o que é da própria conversa
    expect((await ivoPortal.api.get(portalUrl(toIvo.id, ivoFile))).status).toBe(200);
    expect((await ivoPortal.api.get(portalUrl(toJulia.id, juliaFile))).status).toBe(404);
    expect((await juliaPortal.api.get(portalUrl(toIvo.id, ivoFile))).status).toBe(404);
    // nem misturando a própria mensagem com o arquivo da outra
    expect((await ivoPortal.api.get(portalUrl(toIvo.id, juliaFile))).status).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: portalUrl(toIvo.id, ivoFile) })).statusCode).toBe(401);
    // o token do escritório não vale no portal, nem o do portal nas rotas do escritório
    expect((await office.api.get(portalUrl(toIvo.id, ivoFile))).status).toBe(401);
    expect((await ivoPortal.api.get(officeUrl(ivo, toIvo.id, ivoFile))).status).toBe(401);

    // o acesso só do checklist (link) não abre anexos de mensagem
    const checklist = await office.api.post(`/api/customers/${ivo}/checklist`, { year: currentExerciseYear() });
    const access = await issueAccess(office.api, checklist.body.id);
    const linkOnly = await customerLogin(env, access.token, VALID_CPFS[6], access.code);
    expect((await linkOnly.api!.get(portalUrl(toIvo.id, ivoFile))).status).toBe(403);

    // escritório: a mensagem tem de ser do cliente da rota e o arquivo, da mensagem
    expect((await office.api.get(officeUrl(ivo, toIvo.id, ivoFile))).status).toBe(200);
    expect((await office.api.get(officeUrl(julia, toIvo.id, ivoFile))).status).toBe(404);
    expect((await office.api.get(officeUrl(ivo, toIvo.id, juliaFile))).status).toBe(404);
    // um arquivo qualquer do escritório não sai por uma mensagem que não o cita
    const loose = await env.ctx.files.save({ officeId: office.officeId, data: PDF, filename: 'solto.pdf', mimeType: 'application/pdf' });
    expect((await office.api.get(officeUrl(ivo, toIvo.id, loose.id))).status).toBe(404);
    // a rota genérica de arquivos não entrega anexo de mensagem: só a rota da conversa
    expect((await office.api.get(`/api/files/${ivoFile}`)).status).toBe(404);

    // outro escritório (escritório e cliente dele)
    const stranger = await registerOffice(env, 'Outro Escritório');
    const strangerCustomer = await newCustomer(stranger.api, 'Ivo Reis', VALID_CPFS[6]);
    const strangerPortal = await portalOf(stranger, strangerCustomer, VALID_CPFS[6]);
    expect((await stranger.api.get(officeUrl(ivo, toIvo.id, ivoFile))).status).toBe(404);
    expect((await stranger.api.get(officeUrl(strangerCustomer, toIvo.id, ivoFile))).status).toBe(404);
    expect((await strangerPortal.api.get(portalUrl(toIvo.id, ivoFile))).status).toBe(404);

    // sem permissão de ver clientes: 403; com a restrição por responsável, só os próprios clientes
    const noPerm = await createEmployee(env, office.api, ['mailing.list']);
    expect((await noPerm.api.get(officeUrl(ivo, toIvo.id, ivoFile))).status).toBe(403);
    expect((await emp.api.get(officeUrl(ivo, toIvo.id, ivoFile))).status).toBe(200);
    await office.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    expect((await emp.api.get(officeUrl(ivo, toIvo.id, ivoFile))).status).toBe(404);
    expect((await emp.api.get(officeUrl(julia, toJulia.id, juliaFile))).status).toBe(200);
  });

  it('limites: quantidade, tamanho, tipo, conteúdo e mensagem vazia; nada fica gravado quando recusa', async () => {
    const office = await registerOffice(env);
    const customerId = await newCustomer(office.api, 'Karen Luz', VALID_CPFS[0]);
    const portal = await portalOf(office, customerId, VALID_CPFS[0]);
    const before = await countFiles(office.officeId);
    const targets = [
      { token: office.token, url: `/api/customers/${customerId}/messages` },
      { token: portal.token, url: '/api/portal/messages' },
    ];
    const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);

    for (const t of targets) {
      const send = (list: { name: string; content: Buffer | string }[], fields: Record<string, string> = {}) => upload(env, t.token, t.url, list, fields);

      const six = await send(Array.from({ length: 6 }, (_, i) => ({ name: `a${i}.pdf`, content: PDF })));
      expect(six.status).toBe(413);
      expect(six.body.error).toBe('Envie no máximo 5 arquivos por vez.');

      const tooBig = await send([{ name: 'grande.pdf', content: big }]);
      expect(tooBig.status).toBe(413);
      expect(tooBig.body.error).toBe('O arquivo “grande.pdf” passa de 10 MB. Envie um arquivo menor.');

      for (const name of ['programa.exe', 'pagina.html', 'notas.txt', 'pacote.zip', 'contrato.docx']) {
        const refused = await send([{ name, content: 'conteudo' }]);
        expect(refused.status, name).toBe(400);
        expect(refused.body.error).toContain(`O arquivo “${name}” não é aceito.`);
        expect(refused.body.error).toContain('PDF, imagem');
      }

      // extensão aceita com conteúdo de outro tipo
      const fake = await send([{ name: 'falso.pdf', content: '<html><script>alert(1)</script></html>' }]);
      expect(fake.status).toBe(400);
      expect(fake.body.error).toBe('O conteúdo de “falso.pdf” não corresponde ao tipo do arquivo.');

      expect((await send([{ name: 'vazio.pdf', content: Buffer.alloc(0) }])).status).toBe(400);
      // um arquivo recusado derruba o envio inteiro (o válido não entra sozinho)
      expect((await send([{ name: 'ok.pdf', content: PDF }, { name: 'virus.exe', content: 'MZ' }], { body: 'Dois arquivos' })).status).toBe(400);

      // formulário sem texto e sem arquivo, e texto longo demais
      const empty = await send([], { body: '   ' });
      expect(empty.status).toBe(400);
      expect(empty.body.error).toBe('Escreva a mensagem ou anexe um arquivo.');
      expect((await send([{ name: 'ok.pdf', content: PDF }], { body: 'x'.repeat(4001) })).status).toBe(400);
    }
    expect((await office.api.post(`/api/customers/${customerId}/messages`, {})).status).toBe(400);
    expect((await portal.api.post('/api/portal/messages', { body: '' })).status).toBe(400);

    expect((await office.api.get(`/api/customers/${customerId}/messages`)).body.messages).toHaveLength(0);
    expect(await countFiles(office.officeId)).toBe(before);

    // no limite passa: 5 arquivos, um deles com exatamente 10 MB
    const exact = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 - PDF.length)]);
    const five = await upload(env, portal.token, '/api/portal/messages', [{ name: 'limite.pdf', content: exact }, ...Array.from({ length: 4 }, (_, i) => ({ name: `p${i}.png`, content: PNG }))]);
    expect(five.status).toBe(201);
    expect(five.body.messages.at(-1).attachments).toHaveLength(5);
    expect(five.body.messages.at(-1).attachments[0].size).toBe(10 * 1024 * 1024);
    expect(await countFiles(office.officeId)).toBe(before + 5);
  });

  it('também por WhatsApp: o anexo segue como documento do envio e aparece na conversa', async () => {
    const office = await registerOffice(env);
    const customerId = await newCustomer(office.api, 'Léo Braga', VALID_CPFS[1]);
    await office.api.put(`/api/customers/${customerId}/identification`, { name: 'Léo Braga', mobile: '11987654321' });
    const url = `/api/customers/${customerId}/messages`;

    const sent = await upload(env, office.token, url, [{ name: 'guia.pdf', content: PDF }], { body: 'Segue a guia.', whatsapp: 'true' });
    expect(sent.status).toBe(201);
    const msg = sent.body.messages.at(-1);
    expect(msg).toMatchObject({ channel: 'whatsapp', body: 'Segue a guia.' });
    expect(msg.attachments).toEqual([{ fileId: expect.any(String), filename: 'guia.pdf', mimeType: 'application/pdf', size: PDF.length }]);
    await env.ctx.jobs.drain();
    const wa = env.providers.sentWhatsApp.find((m) => m.officeId === office.officeId);
    expect(wa).toMatchObject({ text: 'Segue a guia.', document: { filename: 'guia.pdf', contentType: 'application/pdf' } });
    expect(wa!.document!.content.equals(PDF)).toBe(true);
    const [delivery] = await env.ctx.db.select().from(deliveries).where(and(eq(deliveries.officeId, office.officeId), eq(deliveries.customerId, customerId)));
    expect(delivery.attachments).toEqual([{ fileId: msg.attachments[0].fileId, filename: 'guia.pdf' }]);
    // uma mensagem só na conversa (não duplica portal + WhatsApp)
    expect((await office.api.get(url)).body.messages).toHaveLength(1);
    expect((await office.api.get(`${url}/${msg.id}/attachments/${msg.attachments[0].fileId}`)).status).toBe(200);

    // pelo WhatsApp: um anexo por mensagem e sempre com texto
    const before = await countFiles(office.officeId);
    const two = await upload(env, office.token, url, [{ name: 'a.pdf', content: PDF }, { name: 'b.pdf', content: PDF }], { body: 'Dois', whatsapp: 'true' });
    expect(two.status).toBe(400);
    expect(two.body.error).toContain('um anexo por mensagem');
    const noText = await upload(env, office.token, url, [{ name: 'a.pdf', content: PDF }], { whatsapp: 'true' });
    expect(noText.status).toBe(400);
    expect(noText.body.error).toBe('Para enviar por WhatsApp, escreva a mensagem.');

    // sem celular o envio é recusado e o arquivo não fica gravado
    const noPhone = await newCustomer(office.api, 'Sem Celular', VALID_CPFS[2]);
    const refused = await upload(env, office.token, `/api/customers/${noPhone}/messages`, [{ name: 'a.pdf', content: PDF }], { body: 'Oi', whatsapp: 'true' });
    expect(refused.status).toBe(400);
    expect(await countFiles(office.officeId)).toBe(before);
    expect((await office.api.get(`/api/customers/${noPhone}/messages`)).body.messages).toHaveLength(0);
  });
});
