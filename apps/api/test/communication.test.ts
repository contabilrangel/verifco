import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, count, eq, ne, sql } from 'drizzle-orm';
import { MAILING_MAX_RECIPIENTS, formatMoney } from '@verifco/shared';
import { budgets, customers, darfs, declarationItems, declarations, deliveries, jobs, messages } from '../src/db/schema';
import { sha256 } from '../src/lib/crypto';
import { htmlToText } from '../src/services/delivery';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';
import { customerLogin } from './portal-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const uuid = () => crypto.randomUUID();

async function customer(api: Api, i: number, data: { name?: string; email?: string | null; mobile?: string | null } = {}) {
  const name = data.name ?? `Cliente ${i}`;
  const c = await api.post('/api/customers', { name, cpfCnpj: VALID_CPFS[i], email: data.email === undefined ? `c${i}@ex.com` : data.email });
  expect(c.status).toBe(201);
  if (data.mobile) await api.put(`/api/customers/${c.body.id}/identification`, { name, email: data.email === undefined ? `c${i}@ex.com` : data.email, mobile: data.mobile });
  return c.body.id as string;
}

/** Texto das páginas de um PDF do pdfkit (fluxos comprimidos, texto em hexadecimal nos operadores TJ). */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const t of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      out.push([...t[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join(''));
    }
  }
  return out.join('\n');
}

async function transmittedDeclaration(officeId: string, customerId: string, year: number) {
  const [d] = await env.ctx.db
    .insert(declarations)
    .values({ officeId, customerId, exerciseYear: year, stage: 'transmitted', substatus: 'ecac_processed', taxation: 'complete', taxDueCents: 345_678, receiptNumber: '12.34.56.78.90-12' })
    .returning();
  await env.ctx.db.insert(declarationItems).values([
    { officeId, declarationId: d.id, kind: 'income_pj', counterpartyName: 'Empresa Alfa Ltda', counterpartyDoc: '11222333000181', valueCents: 12_000_000, withheldCents: 1_500_000, extra: { officialPensionCents: 900_000 } },
    { officeId, declarationId: d.id, kind: 'payment', counterpartyName: 'Clínica Saúde', counterpartyDoc: '11144477735', valueCents: 800_000, extra: { nature: 'health' } },
    { officeId, declarationId: d.id, kind: 'asset', groupCode: '01', description: 'Apartamento', prevValueCents: 30_000_000, valueCents: 30_000_000 },
    { officeId, declarationId: d.id, kind: 'asset', groupCode: '06', description: 'Conta corrente', prevValueCents: 1_000_000, valueCents: 3_000_000 },
  ]);
  await env.ctx.db.insert(darfs).values([
    { officeId, customerId, declarationId: d.id, quotaNumber: 1, valueCents: 172_839, dueDate: `${year}-05-29` },
    { officeId, customerId, declarationId: d.id, quotaNumber: 2, valueCents: 172_839, dueDate: `${year}-06-30` },
  ]);
  return d;
}

describe('templates de e-mail', () => {
  it('lista os 14, personaliza com HTML sanitizado e restaura o padrão', async () => {
    const { api } = await registerOffice(env);
    const list = await api.get('/api/email-templates');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(14);
    expect(list.body.every((t: any) => t.customized === false)).toBe(true);

    const put = await api.put('/api/email-templates/marketing', {
      subject: '<b>Promoção</b> para {{CLIENTE}}',
      body: '<p onclick="steal()">Olá {{CLIENTE}}</p><script>alert(1)</script><a href="javascript:alert(1)">clique</a><p>{{VALOR_INEXISTENTE}}</p>',
    });
    expect(put.status).toBe(200);
    expect(put.body.customized).toBe(true);
    expect(put.body.subject).toBe('Promoção para {{CLIENTE}}');
    expect(put.body.body).not.toMatch(/script|onclick|javascript/i);
    expect(put.body.unknownVariables).toEqual(['VALOR_INEXISTENTE']);

    const got = await api.get('/api/email-templates/marketing');
    expect(got.body.customized).toBe(true);
    expect(got.body.body).toContain('<p>Olá {{CLIENTE}}</p>');
    expect(got.body.variables.map((v: any) => v.name)).toContain('CLIENTE');

    const preview = await api.post('/api/email-templates/marketing/preview', { body: '<p>Oi {{CLIENTE}} {{CODIGO}}</p><img src=x onerror=alert(1)>' });
    expect(preview.body.html).toContain('Oi Maria Aparecida Souza {{CODIGO}}');
    expect(preview.body.html).not.toContain('onerror');
    expect(preview.body.unknownVariables).toEqual(['CODIGO']);

    expect((await api.del('/api/email-templates/marketing')).body.customized).toBe(false);
    expect((await api.get('/api/email-templates/marketing')).body.customized).toBe(false);

    // salvar igual ao padrão não cria personalização
    const def = (await api.get('/api/email-templates/planning')).body;
    const same = await api.put('/api/email-templates/planning', { subject: def.defaultSubject, body: def.defaultBody });
    expect(same.body.customized).toBe(false);
    expect((await api.put('/api/email-templates/inexistente', { subject: 'a', body: '<p>b</p>' })).status).toBe(400);
    expect((await api.put('/api/email-templates/monthly', { subject: 'a', body: '<script>x</script>' })).status).toBe(400);
  });

  it('exige permissão e isola por escritório', async () => {
    const a = await registerOffice(env);
    const b = await registerOffice(env);
    await a.api.put('/api/email-templates/monthly', { subject: 'Mensal A', body: '<p>Só do escritório A</p>' });
    expect((await b.api.get('/api/email-templates/monthly')).body.subject).not.toBe('Mensal A');

    const reader = await createEmployee(env, a.api, ['email_template.list']);
    expect((await reader.api.get('/api/email-templates')).status).toBe(200);
    expect((await reader.api.put('/api/email-templates/monthly', { subject: 'x', body: '<p>y</p>' })).status).toBe(403);
    expect((await reader.api.del('/api/email-templates/monthly')).status).toBe(403);
    const nobody = await createEmployee(env, a.api, ['customer.list']);
    expect((await nobody.api.get('/api/email-templates')).status).toBe(403);
  });
});

describe('mala direta', () => {
  it('revisa, conta quem não tem e-mail/celular e envia pela fila sem duplicar', async () => {
    const { api, officeId } = await registerOffice(env);
    const ids = [
      await customer(api, 0, { name: 'Ana Lima', mobile: '31999990000' }),
      await customer(api, 1, { name: 'Bruno Reis', email: null, mobile: '31988880000' }),
      await customer(api, 2, { name: 'Carla Dias', email: null }),
    ];
    const body = { type: 'marketing', channel: 'email', year: 2026, customerIds: ids };
    const preview = await api.post('/api/mailing/preview', body);
    expect(preview.status).toBe(200);
    expect(preview.body.total).toBe(3);
    expect(preview.body.truncated).toBe(false);
    expect(preview.body.withoutEmail).toBe(2);
    expect(preview.body.withoutMobile).toBe(1);
    expect(preview.body.deliveries).toEqual({ email: 1, whatsapp: 0, total: 1 });
    expect(preview.body.skipped).toEqual([expect.objectContaining({ reason: 'no_email', count: 2 })]);
    expect(preview.body.sample.customerName).toBe('Ana Lima');
    expect(preview.body.sample.html).toContain('Ana Lima');

    // a requisição só registra: os envios saem do job
    const requestId = uuid();
    const sent = await api.post('/api/mailing/send', { ...body, requestId });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ status: 'queued', alreadyRequested: false, customers: 1, deliveries: { email: 1, whatsapp: 0, total: 1 } });
    expect(sent.body.skipped[0].count).toBe(2);
    expect(await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId))).toHaveLength(0);

    const again = await api.post('/api/mailing/send', { ...body, requestId });
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ id: sent.body.id, alreadyRequested: true });
    await env.ctx.jobs.drain();
    const rows = await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId));
    expect(rows).toHaveLength(1);
    expect(env.providers.sentEmails.filter((e) => e.officeId === officeId)).toHaveLength(1);

    // andamento: concluída, com o que entrou na fila
    const run = await api.get(`/api/mailing/runs/${sent.body.id}`);
    expect(run.body).toMatchObject({ status: 'done', progress: 100, type: { key: 'marketing' }, progressDetail: { total: 1, processed: 1, queued: 1, errorCount: 0 } });
    expect((await api.get('/api/mailing/runs')).body.map((r: any) => r.id)).toContain(sent.body.id);
    // repetir depois de concluída também não reenvia
    await api.post('/api/mailing/send', { ...body, requestId });
    await env.ctx.jobs.drain();
    expect(await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId))).toHaveLength(1);

    // ambos os canais: e-mail para quem tem, WhatsApp para quem tem celular
    const both = await api.post('/api/mailing/send', { ...body, channel: 'both', requestId: uuid() });
    expect(both.body.deliveries).toEqual({ email: 1, whatsapp: 2, total: 3 });
    expect(both.body.customers).toBe(2);
    await env.ctx.jobs.drain();
    expect(env.providers.sentWhatsApp.filter((w) => w.officeId === officeId).map((w) => w.to).sort()).toEqual(['5531988880000', '5531999990000']);
  });

  it('mala direta grande: lotes sem uma consulta por cliente, andamento gravado e limite explícito (DAD-5)', async () => {
    const { api, officeId } = await registerOffice(env);
    const many = 450;
    await env.ctx.db.insert(customers).values(
      Array.from({ length: many }, (_, i) => ({ officeId, name: `Cliente ${String(i).padStart(3, '0')}`, cpfCnpj: String(10_000_000_000 + i), email: `lote${i}@ex.com`, mobile: '31999990000' })),
    );
    const sent = await api.post('/api/mailing/send', { type: 'monthly', channel: 'both', year: 2026, requestId: uuid() });
    expect(sent.status).toBe(202);
    expect(sent.body.customers).toBe(many);
    expect(sent.body.deliveries.total).toBe(many * 2);

    // conta as idas ao banco só durante o job da mala direta
    const pg = (env.ctx.db as unknown as { $client: { query: (...a: unknown[]) => Promise<unknown> } }).$client;
    const original = pg.query;
    let queries = 0;
    pg.query = function (this: unknown, ...a: unknown[]) {
      queries++;
      return original.apply(this, a);
    };
    const progress: number[] = [];
    const job = await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, sent.body.id) });
    try {
      // executa só o job da mala direta (os envios ficam na fila)
      await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() + 3600_000) }).where(and(eq(jobs.status, 'queued'), ne(jobs.id, job!.id)));
      const before = queries;
      await env.ctx.jobs.runNext();
      queries -= before;
      for (const row of await env.ctx.db.select({ p: jobs.progress }).from(jobs).where(eq(jobs.id, job!.id))) progress.push(row.p);
    } finally {
      pg.query = original;
    }
    // 450 clientes × 2 canais = 900 envios; uma consulta por envio passaria de 900 (antes: ~10 por envio)
    expect(queries).toBeLessThan(60);
    expect(progress).toEqual([100]);
    const run = (await api.get(`/api/mailing/runs/${sent.body.id}`)).body;
    expect(run.progressDetail).toMatchObject({ total: many, processed: many, queued: many * 2 });
    const [{ n }] = await env.ctx.db.select({ n: count() }).from(deliveries).where(eq(deliveries.officeId, officeId));
    expect(n).toBe(many * 2);
    const chats = await env.ctx.db.select({ n: count() }).from(messages).where(eq(messages.officeId, officeId));
    expect(chats[0].n).toBe(many);
    const sendJobs = await env.ctx.db.select({ n: count() }).from(jobs).where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'delivery.send')));
    expect(sendJobs[0].n).toBe(many * 2);
    // os 900 envios não precisam sair aqui (e atrasariam a fila dos próximos testes)
    await env.ctx.db.delete(jobs).where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'delivery.send')));

    // acima do limite: a revisão avisa e o envio é recusado (nada é cortado em silêncio)
    const original5000 = MAILING_MAX_RECIPIENTS;
    expect(original5000).toBe(5000);
    await env.ctx.db.insert(customers).values(
      Array.from({ length: 5000 - many + 1 }, (_, i) => ({ officeId, name: `Extra ${String(i).padStart(4, '0')}`, cpfCnpj: String(20_000_000_000 + i), email: `extra${i}@ex.com` })),
    );
    const big = await api.post('/api/mailing/preview', { type: 'monthly', channel: 'email', year: 2026 });
    expect(big.body).toMatchObject({ matched: 5001, truncated: true, limit: 5000 });
    const refused = await api.post('/api/mailing/send', { type: 'monthly', channel: 'email', year: 2026, requestId: uuid() });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/5\.001 clientes/);
  }, 60_000);

  it('seleciona por filtros (grupo e e-mail) e respeita permissões por tipo', async () => {
    const office = await registerOffice(env);
    const g = await office.api.post('/api/customer-groups', { name: 'Premium' });
    const a = await customer(office.api, 3, { name: 'Daniel' });
    await customer(office.api, 4, { name: 'Elisa' });
    await office.api.put(`/api/customers/${a}/identification`, { name: 'Daniel', email: 'c3@ex.com', groupIds: [g.body.id] });
    const byGroup = await office.api.post('/api/mailing/preview', { type: 'monthly', channel: 'email', year: 2026, filters: { groups: [g.body.id] } });
    expect(byGroup.body.total).toBe(1);
    expect(byGroup.body.recipients[0].name).toBe('Daniel');
    const withEmail = await office.api.post('/api/mailing/preview', { type: 'monthly', channel: 'email', year: 2026, filters: { email: 'with' } });
    expect(withEmail.body.total).toBe(2);

    const mkt = await createEmployee(env, office.api, ['mailing.send_marketing']);
    expect((await mkt.api.post('/api/mailing/preview', { type: 'marketing', channel: 'email', year: 2026 })).status).toBe(200);
    expect((await mkt.api.post('/api/mailing/send', { type: 'monthly', channel: 'email', year: 2026, requestId: uuid() })).status).toBe(403);
    expect((await mkt.api.post('/api/mailing/send', { type: 'kit', channel: 'email', year: 2026, requestId: uuid() })).status).toBe(403);
    const types = (await mkt.api.get('/api/mailing/types')).body;
    expect(types.find((t: any) => t.key === 'marketing').allowed).toBe(true);
    expect(types.find((t: any) => t.key === 'kit').allowed).toBe(false);

    // andamento: quem não tem "E-mails enviados" vê só as próprias malas diretas
    const own = await mkt.api.post('/api/mailing/send', { type: 'marketing', channel: 'email', year: 2026, requestId: uuid() });
    const ownerRun = await office.api.post('/api/mailing/send', { type: 'monthly', channel: 'email', year: 2026, requestId: uuid() });
    expect((await mkt.api.get('/api/mailing/runs')).body.map((r: any) => r.id)).toEqual([own.body.id]);
    expect((await mkt.api.get(`/api/mailing/runs/${ownerRun.body.id}`)).status).toBe(404);
    expect((await office.api.get('/api/mailing/runs')).body.map((r: any) => r.id).sort()).toEqual([own.body.id, ownerRun.body.id].sort());
    const nobody = await createEmployee(env, office.api, ['customer.list']);
    expect((await nobody.api.get('/api/mailing/runs')).status).toBe(403);
  });

  it('não envia para clientes de outro escritório', async () => {
    const a = await registerOffice(env);
    const b = await registerOffice(env);
    const foreign = await customer(b.api, 5);
    const res = await a.api.post('/api/mailing/send', { type: 'marketing', channel: 'email', year: 2026, customerIds: [foreign], requestId: uuid() });
    expect(res.status).toBe(400);
    expect((await a.api.post('/api/mailing/preview', { type: 'marketing', channel: 'email', year: 2026, customerIds: [foreign] })).body.total).toBe(0);
    const ownRun = await b.api.post('/api/mailing/send', { type: 'marketing', channel: 'email', year: 2026, customerIds: [foreign], requestId: uuid() });
    expect((await a.api.get(`/api/mailing/runs/${ownRun.body.id}`)).status).toBe(404);
  });

  it('kit pós-declaração: gera o PDF por cliente e anexa; pula quem não transmitiu', async () => {
    const { api, officeId } = await registerOffice(env, 'Contábil Kit');
    const withDecl = await customer(api, 0, { name: 'Fernanda Kit' });
    const without = await customer(api, 1, { name: 'Gustavo Sem' });
    await transmittedDeclaration(officeId, withDecl, 2026);
    const body = { type: 'kit', channel: 'email', year: 2026, customerIds: [withDecl, without] };
    const preview = await api.post('/api/mailing/preview', body);
    expect(preview.body.skipped).toEqual([expect.objectContaining({ reason: 'no_declaration', count: 1, names: ['Gustavo Sem'] })]);
    expect(preview.body.sample.attachment).toMatch(/Kit/);

    const pdf = await api.get(`/api/mailing/attachment-preview?type=kit&customerId=${withDecl}&year=2026`);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    const requestId = uuid();
    const sent = await api.post('/api/mailing/send', { ...body, requestId });
    expect(sent.body.deliveries.total).toBe(1);
    await env.ctx.jobs.drain();
    await api.post('/api/mailing/send', { ...body, requestId });
    await env.ctx.jobs.drain();
    const emails = env.providers.sentEmails.filter((e) => e.officeId === officeId);
    expect(emails).toHaveLength(1);
    expect(emails[0].attachments?.[0].filename).toBe('kit-pos-declaracao-2026-fernanda-kit.pdf');
    expect(emails[0].attachments?.[0].content.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('checklist em PDF: o mesmo da etapa Documentação, com os ajustes do escritório (INT-8/CON-4)', async () => {
    const { api, officeId } = await registerOffice(env);
    const a = await customer(api, 2, { name: 'Helena Pdf' });
    const [prev] = await env.ctx.db.insert(declarations).values({ officeId, customerId: a, exerciseYear: 2025 }).returning();
    await env.ctx.db.insert(declarationItems).values({ officeId, declarationId: prev.id, kind: 'asset', groupCode: '01', description: 'Casa na praia' });
    const created = await api.post(`/api/customers/${a}/checklist`, { year: 2026 });
    const items = created.body.sections.flatMap((s: any) => s.items);
    const house = items.find((i: any) => i.title === 'Bem: Casa na praia');
    expect(house).toBeDefined();
    // o escritório tira um item e acrescenta outro
    await api.put(`/api/checklists/${created.body.id}/items/${house.id}`, { status: 'removed' });
    await api.post(`/api/checklists/${created.body.id}/items`, { section: 'payments', title: 'Recibos da escola de musica' });

    const step = await api.get(`/api/customers/${a}/checklist-pdf?year=2026&inline=1`);
    const preview = await api.get(`/api/mailing/attachment-preview?type=checklist_pdf&customerId=${a}&year=2026`);
    for (const buf of [step.raw.rawPayload, preview.raw.rawPayload]) {
      const text = pdfText(buf);
      expect(text).toContain('Recibos da escola de musica');
      expect(text).not.toContain('Casa na praia');
    }

    const sent = await api.post('/api/mailing/send', { type: 'checklist_pdf', channel: 'email', year: 2026, customerIds: [a], requestId: uuid() });
    expect(sent.body.deliveries.total).toBe(1);
    await env.ctx.jobs.drain();
    const email = env.providers.sentEmails.find((e) => e.officeId === officeId)!;
    expect(email.attachments?.[0].filename).toBe('checklist-irpf-2026-helena-pdf.pdf');
    const text = pdfText(email.attachments![0].content);
    expect(text).toContain('Recibos da escola de musica');
    expect(text).not.toContain('Casa na praia');
  });

  it('checklist digital: cria o checklist, gera link e código por cliente e mascara no histórico (INT-2)', async () => {
    const { api, officeId } = await registerOffice(env);
    const fresh = await customer(api, 3, { name: 'Igor Novo', mobile: '31977770000' });
    const already = await customer(api, 4, { name: 'Julia Antiga' });
    const locked = await customer(api, 5, { name: 'Kaio Fechado' });
    const old = await api.post(`/api/customers/${already}/checklist`, { year: 2026 });
    const oldAccess = await api.post(`/api/checklists/${old.body.id}/access`, { channels: [] });
    const closed = await api.post(`/api/customers/${locked}/checklist`, { year: 2026 });
    await api.put(`/api/checklists/${closed.body.id}/lock`, { locked: true });

    const body = { type: 'checklist_digital', channel: 'both', year: 2026, customerIds: [fresh, already, locked] };
    const preview = await api.post('/api/mailing/preview', { ...body, previewCustomerId: fresh });
    expect(preview.body.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'checklist_locked', count: 1, names: ['Kaio Fechado'] })]));
    expect(preview.body.sample.html).toContain('(gerado no envio)');
    expect(preview.body.sample.text).toContain('(gerado no envio)');
    // a prévia não cria nada
    expect((await api.get(`/api/customers/${fresh}/checklist?year=2026`)).body.checklist).toBeNull();

    const sent = await api.post('/api/mailing/send', { ...body, requestId: uuid() });
    expect(sent.body.customers).toBe(2);
    await env.ctx.jobs.drain();

    // o cliente sem checklist ganhou um, já enviado, e entra com o link e o código do e-mail
    const view = (await api.get(`/api/customers/${fresh}/checklist?year=2026`)).body.checklist;
    expect(view).not.toBeNull();
    expect(view.sentAt).not.toBeNull();
    const mail = env.providers.sentEmails.find((e) => e.officeId === officeId && e.to === 'c3@ex.com')!;
    const link = /href="([^"]+\/checklist\/[\w-]+)"/.exec(mail.html)![1];
    const token = link.split('/checklist/')[1];
    const code = /<strong>(\d{6})<\/strong>/.exec(mail.html)![1];
    expect((await customerLogin(env, token, VALID_CPFS[3], code)).status).toBe(200);
    const wa = env.providers.sentWhatsApp.find((w) => w.officeId === officeId && w.to === '5531977770000')!;
    expect(wa.text).toContain(code);
    expect(wa.text).toContain(link);

    // quem já tinha checklist recebe um par novo; o anterior deixa de valer
    const mailOld = env.providers.sentEmails.find((e) => e.officeId === officeId && e.to === 'c4@ex.com')!;
    const tokenOld = /\/checklist\/([\w-]+)"/.exec(mailOld.html)![1];
    const codeOld = /<strong>(\d{6})<\/strong>/.exec(mailOld.html)![1];
    expect((await customerLogin(env, oldAccess.body.link.split('/checklist/')[1], VALID_CPFS[4], oldAccess.body.code)).status).toBe(404);
    expect((await customerLogin(env, tokenOld, VALID_CPFS[4], codeOld)).status).toBe(200);
    // o bloqueado ficou de fora
    expect(env.providers.sentEmails.some((e) => e.officeId === officeId && e.to === 'c5@ex.com')).toBe(false);

    // histórico (envios e conversa) com link e código mascarados
    const stored = await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId));
    expect(stored).toHaveLength(3);
    for (const d of stored) {
      expect(d.body).not.toContain(code);
      expect(d.body).not.toContain(token);
      expect(d.body).not.toContain(codeOld);
      expect(d.body).toContain('••••••');
    }
    const chat = await env.ctx.db.select().from(messages).where(eq(messages.customerId, fresh));
    expect(chat[0].body).not.toContain(code);
  });

  it('orçamento: usa o fluxo do financeiro e nunca manda aprovado ou recusado (INT-5)', async () => {
    const { api, officeId } = await registerOffice(env);
    const draft = await customer(api, 0, { name: 'Lia Rascunho' });
    const sentB = await customer(api, 1, { name: 'Marcos Enviado' });
    const approved = await customer(api, 2, { name: 'Nina Aprovada' });
    const rejected = await customer(api, 3, { name: 'Otto Recusado' });
    const none = await customer(api, 4, { name: 'Paula Sem' });
    const insert = (customerId: string, status: string, extra: Partial<typeof budgets.$inferInsert> = {}) =>
      env.ctx.db
        .insert(budgets)
        .values({ officeId, customerId, exerciseYear: 2026, amountCents: 50_000, totalCents: 45_000, description: 'Declaração completa', status, ...extra })
        .returning()
        .then((r) => r[0]);
    const bDraft = await insert(draft, 'draft', { installments: 3 });
    const bSent = await insert(sentB, 'sent', { approvalTokenHash: 'antigo' });
    const bApproved = await insert(approved, 'approved');
    const bRejected = await insert(rejected, 'rejected');

    const body = { type: 'budget', channel: 'email', year: 2026, customerIds: [draft, sentB, approved, rejected, none] };
    const prev = await api.post('/api/mailing/preview', { ...body, previewCustomerId: draft });
    expect(prev.body.type.templateKey).toBe('budget_digital');
    const reasons = Object.fromEntries(prev.body.skipped.map((s: any) => [s.reason, s.names]));
    expect(reasons).toEqual({ no_budget: ['Paula Sem'], budget_approved: ['Nina Aprovada'], budget_rejected: ['Otto Recusado'] });
    expect(prev.body.sample.html).toContain(`${formatMoney(45_000)} (3x de ${formatMoney(15_000)})`);
    expect(prev.body.sample.html).toContain('(gerado no envio)');
    // a prévia não mexe no orçamento
    expect((await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, bDraft.id) }))!.status).toBe('draft');

    const sent = await api.post('/api/mailing/send', { ...body, requestId: uuid() });
    expect(sent.body.customers).toBe(2);
    await env.ctx.jobs.drain();

    for (const [b, email] of [
      [bDraft, 'c0@ex.com'],
      [bSent, 'c1@ex.com'],
    ] as const) {
      const row = (await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, b.id) }))!;
      expect(row.status).toBe('sent');
      expect(row.sentAt).not.toBeNull();
      const mail = env.providers.sentEmails.find((e) => e.officeId === officeId && e.to === email)!;
      const token = /\/orcamento\/([\w-]+)/.exec(mail.html)![1];
      // o link do e-mail é o de aprovação online do financeiro
      expect(row.approvalTokenHash).toBe(sha256(token));
      expect((await env.app.inject({ method: 'GET', url: `/api/public/budgets/${token}` })).statusCode).toBe(200);
      const decl = await env.ctx.db.query.declarations.findFirst({ where: and(eq(declarations.customerId, b.customerId), eq(declarations.exerciseYear, 2026)) });
      expect(decl!.substatus).toBe('budget_sent');
    }
    expect((await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, bApproved.id) }))!.status).toBe('approved');
    expect((await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, bRejected.id) }))!.status).toBe('rejected');
    const to = env.providers.sentEmails.filter((e) => e.officeId === officeId).map((e) => e.to);
    expect(to.sort()).toEqual(['c0@ex.com', 'c1@ex.com']);

    // aprovado entre a revisão e o envio: fica de fora na hora, sem erro
    const late = await customer(api, 5, { name: 'Rui Tardio' });
    const bLate = await insert(late, 'draft');
    const req2 = await api.post('/api/mailing/send', { ...body, customerIds: [late], requestId: uuid() });
    await env.ctx.db.update(budgets).set({ status: 'approved' }).where(eq(budgets.id, bLate.id));
    await env.ctx.jobs.drain();
    const run = (await api.get(`/api/mailing/runs/${req2.body.id}`)).body;
    expect(run.status).toBe('done');
    expect(run.progressDetail.skipped).toEqual([expect.objectContaining({ reason: 'budget_approved', count: 1, names: ['Rui Tardio'] })]);
    expect(run.progressDetail.queued).toBe(0);
  });

  it('WhatsApp e prévia usam o mesmo texto, com entidades e <div> convertidos (CON-5)', async () => {
    const { api, officeId } = await registerOffice(env);
    const id = await customer(api, 6, { name: "Maria D'Ávila \"Mel\"", mobile: '31966660000' });
    await api.put('/api/email-templates/monthly', { subject: 'Mensal', body: '<div>Olá, {{CLIENTE}}!</div><div>Linha &amp; 2</div><div><br></div><p>Veja <a href="https://ex.com/a?b=1&amp;c=2">o guia</a>.</p>' });
    const body = { type: 'monthly', channel: 'whatsapp', year: 2026, customerIds: [id] };
    const preview = await api.post('/api/mailing/preview', body);
    const expected = 'Olá, Maria D\'Ávila "Mel"!\nLinha & 2\n\nVeja o guia: https://ex.com/a?b=1&c=2.';
    expect(preview.body.sample.text).toBe(expected);
    await api.post('/api/mailing/send', { ...body, requestId: uuid() });
    await env.ctx.jobs.drain();
    const wa = env.providers.sentWhatsApp.find((w) => w.officeId === officeId)!;
    expect(wa.text).toBe(expected);
    const [row] = await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId));
    expect(row.body).toBe(expected);
  });
});

describe('htmlToText (CON-5)', () => {
  it('decodifica todas as entidades numa passada e mantém a estrutura', () => {
    expect(htmlToText('<p>Olá, Maria D&#39;Ávila &quot;Mel&quot;!</p>')).toBe('Olá, Maria D\'Ávila "Mel"!');
    expect(htmlToText('<p>a &amp;lt; b &#x41; &eacute; &nbsp;fim</p>')).toBe('a &lt; b A é fim');
    expect(htmlToText('<p>Um</p>\n\n   <p>Dois<br/>linha</p><ul><li class="x">A</li><li>B</li></ul><p>Fim</p>')).toBe('Um\n\nDois\nlinha\n\n• A\n• B\n\nFim');
    expect(htmlToText('<div>a</div><div>b</div><div><br></div><div>c</div>')).toBe('a\nb\n\nc');
    expect(htmlToText('<p>Acesse <a href="https://x.com/p">https://x.com/p</a> ou <a href=\'mailto:a@b.com\'>escreva</a></p>')).toBe('Acesse https://x.com/p ou escreva (a@b.com)');
    expect(htmlToText('<table><tr><td>Valor</td><td>R$ 1</td></tr></table>')).toBe('Valor R$ 1');
    expect(htmlToText('<p>x</p><script>alert(1)</script><style>p{}</style>')).toBe('x');
  });
});

describe('e-mails enviados', () => {
  it('lista com filtros, mostra o conteúdo e reenvia os que falharam', async () => {
    const { api, officeId } = await registerOffice(env);
    const ok = await customer(api, 0, { name: 'Joana Ok' });
    const bad = await customer(api, 1, { name: 'Kleber Falha', email: 'falha@ex.com' });
    const original = env.providers.email.send;
    env.providers.email.send = async (oid, msg) => {
      if (msg.to === 'falha@ex.com' && oid === officeId) throw new Error('Caixa inexistente');
      return original(oid, msg);
    };
    try {
      await api.post('/api/mailing/send', { type: 'monthly', channel: 'email', year: 2026, customerIds: [ok, bad], requestId: uuid() });
      // o job tenta 3 vezes com espera; força a execução imediata das novas tentativas
      for (let i = 0; i < 4; i++) {
        await env.ctx.jobs.drain();
        await env.ctx.db.execute(sql`update jobs set run_at = now() where status = 'queued'`);
      }
      const all = await api.get('/api/deliveries');
      expect(all.body.total).toBe(2);
      const failed = await api.get('/api/deliveries?status=failed');
      expect(failed.body.total).toBe(1);
      expect(failed.body.data[0].customerName).toBe('Kleber Falha');
      expect((await api.get('/api/deliveries?search=joana')).body.total).toBe(1);
      expect((await api.get('/api/deliveries?templateKey=monthly&channel=email')).body.total).toBe(2);
      expect((await api.get('/api/deliveries?channel=whatsapp')).body.total).toBe(0);
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      expect((await api.get(`/api/deliveries?from=${today}&to=${today}`)).body.total).toBe(2);
      expect((await api.get('/api/deliveries?to=2000-01-01')).body.total).toBe(0);

      const id = failed.body.data[0].id;
      const detail = await api.get(`/api/deliveries/${id}`);
      expect(detail.body.error).toContain('Caixa inexistente');
      expect(detail.body.body).toContain('Kleber Falha');
      expect(detail.body.canResend).toBe(true);
      expect(detail.body.idempotencyKey).toBeUndefined();

      const okId = (await api.get('/api/deliveries?status=sent')).body.data[0].id;
      expect((await api.post(`/api/deliveries/${okId}/resend`)).status).toBe(409);
    } finally {
      env.providers.email.send = original;
    }
    const id = (await api.get('/api/deliveries?status=failed')).body.data[0].id;
    expect((await api.post(`/api/deliveries/${id}/resend`)).status).toBe(200);
    expect((await api.post(`/api/deliveries/${id}/resend`)).status).toBe(409);
    await env.ctx.jobs.drain();
    expect((await api.get(`/api/deliveries/${id}`)).body.status).toBe('sent');
  });

  it('exige mailing.list e isola por escritório', async () => {
    const a = await registerOffice(env);
    const b = await registerOffice(env);
    const c = await customer(a.api, 6);
    await a.api.post('/api/mailing/send', { type: 'marketing', channel: 'email', year: 2026, customerIds: [c], requestId: uuid() });
    await env.ctx.jobs.drain();
    const id = (await a.api.get('/api/deliveries')).body.data[0].id;
    expect((await b.api.get(`/api/deliveries/${id}`)).status).toBe(404);
    expect((await b.api.get('/api/deliveries')).body.total).toBe(0);
    expect((await b.api.post(`/api/deliveries/${id}/resend`)).status).toBe(404);
    const emp = await createEmployee(env, a.api, ['customer.list']);
    expect((await emp.api.get('/api/deliveries')).status).toBe(403);
    const viewer = await createEmployee(env, a.api, ['mailing.list']);
    expect((await viewer.api.get('/api/deliveries')).status).toBe(200);
    expect((await viewer.api.post(`/api/deliveries/${id}/resend`)).status).toBe(403);
  });
});
