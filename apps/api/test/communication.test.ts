import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { budgets, checklists, customers, darfs, declarationItems, declarations, deliveries, jobs, messages } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';
import { pdfContent } from './pdf-text';
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
  it('revisa, conta quem não tem e-mail/celular e envia sem duplicar', async () => {
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
    expect(preview.body.withoutEmail).toBe(2);
    expect(preview.body.withoutMobile).toBe(1);
    expect(preview.body.deliveries).toEqual({ email: 1, whatsapp: 0, total: 1 });
    expect(preview.body.skipped).toEqual([expect.objectContaining({ reason: 'no_email', count: 2 })]);
    expect(preview.body.sample.customerName).toBe('Ana Lima');
    expect(preview.body.sample.html).toContain('Ana Lima');

    const requestId = uuid();
    const sent = await api.post('/api/mailing/send', { ...body, requestId });
    // o envio vira um pedido na fila: a resposta traz a revisão e o andamento
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ status: 'queued', repeated: false, customers: 1, deliveries: { email: 1, whatsapp: 0, total: 1 } });
    expect(sent.body.skipped[0].count).toBe(2);
    const again = await api.post('/api/mailing/send', { ...body, requestId });
    expect(again.body).toMatchObject({ repeated: true, jobId: sent.body.jobId });
    await env.ctx.jobs.drain();
    const status = await api.get(`/api/mailing/requests/${requestId}`);
    expect(status.body).toMatchObject({ status: 'done', progress: 100, result: { queued: 1, alreadyQueued: 0, failed: [] } });
    await api.post('/api/mailing/send', { ...body, requestId });
    await env.ctx.jobs.drain();
    const rows = await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId));
    expect(rows).toHaveLength(1);
    expect(env.providers.sentEmails.filter((e) => e.officeId === officeId)).toHaveLength(1);

    // ambos os canais: e-mail para quem tem, WhatsApp para quem tem celular
    const both = await api.post('/api/mailing/send', { ...body, channel: 'both', requestId: uuid() });
    expect(both.body.deliveries).toEqual({ email: 1, whatsapp: 2, total: 3 });
    expect(both.body.customers).toBe(2);
    await env.ctx.jobs.drain();
    expect(env.providers.sentWhatsApp.filter((w) => w.officeId === officeId).map((w) => w.to).sort()).toEqual(['5531988880000', '5531999990000']);
  });

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
  });

  it('não envia para clientes de outro escritório', async () => {
    const a = await registerOffice(env);
    const b = await registerOffice(env);
    const foreign = await customer(b.api, 5);
    const res = await a.api.post('/api/mailing/send', { type: 'marketing', channel: 'email', year: 2026, customerIds: [foreign], requestId: uuid() });
    expect(res.status).toBe(400);
    expect((await a.api.post('/api/mailing/preview', { type: 'marketing', channel: 'email', year: 2026, customerIds: [foreign] })).body.total).toBe(0);
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
    expect((await api.get(`/api/mailing/requests/${requestId}`)).body).toMatchObject({ status: 'done', result: { queued: 1 }, attachments: { total: 1, done: 1, failed: 0 } });
    await api.post('/api/mailing/send', { ...body, requestId });
    await env.ctx.jobs.drain();
    const emails = env.providers.sentEmails.filter((e) => e.officeId === officeId);
    expect(emails).toHaveLength(1);
    expect(emails[0].attachments?.[0].filename).toBe('kit-pos-declaracao-2026-fernanda-kit.pdf');
    expect(emails[0].attachments?.[0].content.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('checklist em PDF e orçamento usam os dados do cliente', async () => {
    const { api, officeId } = await registerOffice(env);
    const a = await customer(api, 2, { name: 'Helena Orc' });
    const b = await customer(api, 3, { name: 'Igor Sem Orc' });
    await env.ctx.db.insert(budgets).values({ officeId, customerId: a, exerciseYear: 2026, amountCents: 50_000, totalCents: 45_000, description: 'Declaração completa', status: 'sent' });
    const prev = await api.post('/api/mailing/preview', { type: 'budget', channel: 'email', year: 2026, customerIds: [a, b] });
    expect(prev.body.skipped[0]).toMatchObject({ reason: 'no_budget', count: 1 });
    expect(prev.body.sample.html).toContain('450,00');
    expect(prev.body.sample.subject).toContain('Declaração IRPF');

    const sent = await api.post('/api/mailing/send', { type: 'checklist_pdf', channel: 'email', year: 2026, customerIds: [a], requestId: uuid() });
    expect(sent.body.deliveries.total).toBe(1);
    await env.ctx.jobs.drain();
    const email = env.providers.sentEmails.find((e) => e.officeId === officeId)!;
    expect(email.attachments?.[0].filename).toMatch(/^checklist-irpf-2026-helena-orc\.pdf$/);
  });
});

describe('malas diretas recentes', () => {
  const keyOf = (requestId: string, customerId: string, channel: string) => `mailing:${requestId}:${customerId}:${channel}`;

  it('lista as do escritório (mais novas primeiro) e o detalhe soma os envios por canal e situação', async () => {
    const { api, officeId } = await registerOffice(env);
    const ana = await customer(api, 0, { name: 'Ana Recente', mobile: '31999990000' });
    const bia = await customer(api, 1, { name: 'Bia Recente', mobile: '31988880000' });
    const caio = await customer(api, 2, { name: 'Caio Sem Contato', email: null });
    const first = await api.post('/api/mailing/send', { type: 'marketing', channel: 'email', year: 2026, customerIds: [ana], requestId: uuid() });
    const second = await api.post('/api/mailing/send', { type: 'monthly', channel: 'both', year: 2026, customerIds: [ana, bia, caio], requestId: uuid() });
    expect(second.status).toBe(202);
    await env.ctx.db.update(jobs).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(jobs.id, first.body.jobId));
    const other = await registerOffice(env);
    const foreign = await other.api.post('/api/mailing/send', { type: 'marketing', channel: 'email', year: 2026, customerIds: [await customer(other.api, 3)], requestId: uuid() });

    const list = await api.get('/api/mailing/runs');
    expect(list.status).toBe(200);
    expect(list.body.map((r: any) => r.id)).toEqual([second.body.jobId, first.body.jobId]);
    expect(list.body[0]).toMatchObject({
      requestId: second.body.requestId,
      type: 'monthly',
      label: 'E-mail mensal',
      channel: 'both',
      status: 'queued',
      customers: 2,
      deliveries: { email: 2, whatsapp: 2, total: 4 },
      skippedCount: 2,
      createdBy: expect.any(String),
    });
    // a lista não traz nomes de clientes nem a lista de destinatários
    expect(JSON.stringify(list.body)).not.toMatch(/Caio|Ana Recente|customerIds/);
    expect((await other.api.get('/api/mailing/runs')).body.map((r: any) => r.id)).toEqual([foreign.body.jobId]);
    expect((await api.get(`/api/mailing/runs/${foreign.body.jobId}`)).status).toBe(404);
    expect((await api.get('/api/mailing/runs/nao-e-uuid')).status).toBe(400);

    await env.ctx.jobs.drain();
    // um WhatsApp ainda na fila e outro recusado pelo provedor (com contato no texto do erro)
    await env.ctx.db
      .update(deliveries)
      .set({ status: 'queued' })
      .where(and(eq(deliveries.officeId, officeId), eq(deliveries.idempotencyKey, keyOf(second.body.requestId, ana, 'whatsapp'))));
    await env.ctx.db
      .update(deliveries)
      .set({ status: 'failed', error: 'Recusado: <c1@ex.com> e +55 (31) 98888-0000 inválidos' })
      .where(and(eq(deliveries.officeId, officeId), eq(deliveries.idempotencyKey, keyOf(second.body.requestId, bia, 'whatsapp'))));

    const detail = await api.get(`/api/mailing/runs/${second.body.jobId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: second.body.jobId,
      status: 'done',
      progress: 100,
      result: { queued: 4, alreadyQueued: 0, failed: [] },
      sending: {
        email: { queued: 0, sent: 2, failed: 0, total: 2 },
        whatsapp: { queued: 1, sent: 0, failed: 1, total: 2 },
        total: { queued: 1, sent: 2, failed: 1, total: 4 },
      },
      failures: { count: 1, items: [{ customerId: bia, name: 'Bia Recente', channel: 'whatsapp', stage: 'delivery', message: 'Recusado: <[e-mail]> e [telefone] inválidos' }] },
    });
    expect(detail.body.skipped.map((s: any) => s.names)).toEqual([['Caio Sem Contato'], ['Caio Sem Contato']]);
    expect(JSON.stringify(detail.body)).not.toMatch(/c1@ex\.com|98888|customerIds/);
    // os totais batem com os envios gravados do pedido
    const stored = await env.ctx.db.select().from(deliveries).where(and(eq(deliveries.officeId, officeId), sql`${deliveries.idempotencyKey} like ${`mailing:${second.body.requestId}:%`}`));
    expect(stored).toHaveLength(detail.body.sending.total.total);
    // o primeiro pedido conta só os envios dele (Ana recebeu nos dois)
    expect((await api.get(`/api/mailing/runs/${first.body.jobId}`)).body.sending).toEqual({
      email: { queued: 0, sent: 1, failed: 0, total: 1 },
      whatsapp: { queued: 0, sent: 0, failed: 0, total: 0 },
      total: { queued: 0, sent: 1, failed: 0, total: 1 },
    });
  });

  it('com anexo: o cliente cujo PDF não foi gerado aparece com o motivo', async () => {
    const { api, officeId } = await registerOffice(env);
    const ok = await customer(api, 2, { name: 'Gil Anexo' });
    const bad = await customer(api, 3, { name: 'Hugo Anexo' });
    const sent = await api.post('/api/mailing/send', { type: 'checklist_pdf', channel: 'email', year: 2026, customerIds: [ok, bad], requestId: uuid() });
    await env.ctx.jobs.drain();
    await env.ctx.db
      .update(jobs)
      .set({ status: 'failed' })
      .where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'mailing.deliver'), eq(jobs.idempotencyKey, `mailing:${sent.body.requestId}:${bad}`)));
    const detail = (await api.get(`/api/mailing/runs/${sent.body.jobId}`)).body;
    expect(detail.attachments).toEqual({ total: 2, done: 1, failed: 1 });
    expect(detail.failures).toEqual({ count: 1, items: [{ customerId: bad, name: 'Hugo Anexo', channel: null, stage: 'attachment', message: 'Não foi possível gerar o anexo em PDF.' }] });
    expect(detail.sending.email.total).toBe(2);
  });

  it('exige permissão de mala direta e mostra a cada um só o que pode acompanhar', async () => {
    const office = await registerOffice(env);
    const c = await customer(office.api, 4, { name: 'Dina Perm' });
    const marketing = await office.api.post('/api/mailing/send', { type: 'marketing', channel: 'email', year: 2026, customerIds: [c], requestId: uuid() });
    const monthly = await office.api.post('/api/mailing/send', { type: 'monthly', channel: 'email', year: 2026, customerIds: [c], requestId: uuid() });

    const nobody = await createEmployee(env, office.api, ['customer.list', 'mailing.list']);
    expect((await nobody.api.get('/api/mailing/runs')).status).toBe(403);
    expect((await nobody.api.get(`/api/mailing/runs/${marketing.body.jobId}`)).status).toBe(403);

    // sem "E-mails enviados": só as próprias
    const sender = await createEmployee(env, office.api, ['customer.list', 'mailing.send_marketing']);
    expect((await sender.api.get('/api/mailing/runs')).body).toEqual([]);
    const own = await sender.api.post('/api/mailing/send', { type: 'marketing', channel: 'email', year: 2026, customerIds: [c], requestId: uuid() });
    expect((await sender.api.get('/api/mailing/runs')).body.map((r: any) => r.id)).toEqual([own.body.jobId]);
    expect((await sender.api.get(`/api/mailing/runs/${marketing.body.jobId}`)).status).toBe(404);

    // com "E-mails enviados": as do escritório, só dos tipos que pode enviar
    const viewer = await createEmployee(env, office.api, ['customer.list', 'mailing.list', 'mailing.send_marketing']);
    const seen = (await viewer.api.get('/api/mailing/runs')).body.map((r: any) => r.id);
    expect(seen.sort()).toEqual([marketing.body.jobId, own.body.jobId].sort());
    expect((await viewer.api.get(`/api/mailing/runs/${monthly.body.jobId}`)).status).toBe(404);
    expect((await viewer.api.get(`/api/mailing/runs/${own.body.jobId}`)).status).toBe(200);
    expect((await office.api.get('/api/mailing/runs')).body).toHaveLength(3);
    await env.ctx.jobs.drain();
  });

  it('carteira restrita: o contador acompanha só as que pediu, sem nomes de clientes fora da carteira dele', async () => {
    const o = await registerOffice(env);
    const acc = await createEmployee(env, o.api, ['customer.list', 'mailing.list', 'mailing.send_monthly']);
    const mine = await customer(o.api, 5, { name: 'Dora Minha' });
    const noEmail = await customer(o.api, 6, { name: 'Fábio Sem Email', email: null });
    const theirs = await customer(o.api, 7, { name: 'Edu Alheio' });
    await env.ctx.db.update(customers).set({ responsibleUserId: acc.userId }).where(inArray(customers.id, [mine, noEmail]));
    await o.api.put('/api/office/settings', { restrictCustomersToResponsible: true });

    const ownerRun = await o.api.post('/api/mailing/send', { type: 'monthly', channel: 'email', year: 2026, customerIds: [mine, theirs], requestId: uuid() });
    const accRun = await acc.api.post('/api/mailing/send', { type: 'monthly', channel: 'email', year: 2026, requestId: uuid() });
    expect(accRun.status).toBe(202);
    expect(accRun.body.customers).toBe(1);
    await env.ctx.jobs.drain();
    await env.ctx.db
      .update(deliveries)
      .set({ status: 'failed', error: 'Caixa cheia' })
      .where(and(eq(deliveries.officeId, o.officeId), eq(deliveries.idempotencyKey, keyOf(accRun.body.requestId, mine, 'email'))));

    expect((await acc.api.get('/api/mailing/runs')).body.map((r: any) => r.id)).toEqual([accRun.body.jobId]);
    expect((await acc.api.get(`/api/mailing/runs/${ownerRun.body.jobId}`)).status).toBe(404);
    const detail = (await acc.api.get(`/api/mailing/runs/${accRun.body.jobId}`)).body;
    expect(detail.failures).toEqual({ count: 1, items: [{ customerId: mine, name: 'Dora Minha', channel: 'email', stage: 'delivery', message: 'Caixa cheia' }] });
    // quem ficou de fora na revisão aparece só na contagem
    expect(detail.skipped).toEqual([expect.objectContaining({ reason: 'no_email', count: 1, names: [] })]);

    // a cliente passou para outro responsável: o contador deixa de ver o nome dela
    await env.ctx.db.update(customers).set({ responsibleUserId: o.userId }).where(eq(customers.id, mine));
    const later = (await acc.api.get(`/api/mailing/runs/${accRun.body.jobId}`)).body;
    expect(later.failures).toEqual({ count: 1, items: [] });
    expect(JSON.stringify(later)).not.toMatch(/Dora|Edu|Fábio/);

    // o dono vê todas, com os nomes
    expect((await o.api.get('/api/mailing/runs')).body).toHaveLength(2);
    expect((await o.api.get(`/api/mailing/runs/${accRun.body.jobId}`)).body.failures.items[0].name).toBe('Dora Minha');
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

describe('mala direta: checklist digital (INT-2)', () => {
  it('gera link e código que funcionam, libera o checklist e guarda o histórico mascarado; a prévia não gera acesso', async () => {
    const { api, officeId } = await registerOffice(env);
    const rita = await customer(api, 0, { name: 'Rita Checklist', mobile: '31977770000' });
    const locked = await customer(api, 1, { name: 'Sergio Bloqueado' });
    await env.ctx.db.insert(declarations).values({ officeId, customerId: locked, exerciseYear: 2026, checklistLocked: true });
    const body = { type: 'checklist_digital', channel: 'both', year: 2026, customerIds: [rita, locked] };

    const preview = await api.post('/api/mailing/preview', body);
    expect(preview.body.sample.customerName).toBe('Rita Checklist');
    expect(preview.body.sample.html).toContain('<strong>(gerado no envio)</strong>');
    expect(preview.body.sample.text).toContain('(gerado no envio)');
    expect(preview.body.skipped).toEqual([expect.objectContaining({ reason: 'checklist_locked', count: 1, names: ['Sergio Bloqueado'] })]);
    // a prévia não cria checklist nem gera link
    expect(await env.ctx.db.select().from(checklists).where(eq(checklists.officeId, officeId))).toHaveLength(0);

    const requestId = uuid();
    expect((await api.post('/api/mailing/send', { ...body, requestId })).status).toBe(202);
    await env.ctx.jobs.drain();
    const mail = env.providers.sentEmails.find((m) => m.officeId === officeId)!;
    const [, link, token] = /href="([^"]*\/checklist\/([\w-]+))"/.exec(mail.html)!;
    const code = /<strong>(\d{6})<\/strong>/.exec(mail.html)![1];
    expect(link).not.toContain('/portal');
    const wa = env.providers.sentWhatsApp.find((w) => w.officeId === officeId)!;
    expect(wa.text).toContain(link);
    expect(wa.text).toContain(code);

    // o link e o código abrem o checklist do exercício, criado no envio
    const login = await customerLogin(env, token, VALID_CPFS[0], code);
    expect(login.status).toBe(200);
    const view = await login.api!.get(`/api/portal/checklists/${login.body.checklistId}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ exerciseYear: 2026, readOnly: false });
    const office = await api.get(`/api/customers/${rita}/checklist?year=2026`);
    expect(office.body.checklist.sentAt).not.toBeNull();
    expect(office.body.checklist.accessExpiresAt).not.toBeNull();

    // histórico (envios e mensagens) com link e código mascarados
    const stored = await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId));
    expect(stored).toHaveLength(2);
    for (const d of stored) {
      expect(d.body).not.toContain(token);
      expect(d.body).not.toContain(code);
      expect(d.body).toContain('••••••');
    }
    const chat = await env.ctx.db.select().from(messages).where(eq(messages.officeId, officeId));
    expect(chat).toHaveLength(1);
    expect(chat[0].body).not.toContain(code);
    // o conteúdo real, cifrado no job de envio, é apagado depois da entrega
    const sendJobs = await env.ctx.db.select().from(jobs).where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'delivery.send')));
    expect(sendJobs).toHaveLength(2);
    expect(sendJobs.every((j) => j.status === 'done' && !('sealed' in j.payload))).toBe(true);

    // repetir o pedido não gera outro acesso: o enviado continua valendo
    await api.post('/api/mailing/send', { ...body, requestId });
    await env.ctx.jobs.drain();
    expect(await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId))).toHaveLength(2);
    expect((await customerLogin(env, token, VALID_CPFS[0], code)).status).toBe(200);
    // quem estava bloqueado não ganhou checklist
    expect(await env.ctx.db.select().from(checklists).where(eq(checklists.officeId, officeId))).toHaveLength(1);
  });
});

describe('mala direta: orçamento (INT-5)', () => {
  it('envia pelo fluxo do financeiro (link de aprovação, "Enviado", etapa) e pula quem já aprovou', async () => {
    const { api, officeId } = await registerOffice(env);
    const paula = await customer(api, 2, { name: 'Paula Rascunho' });
    const quintino = await customer(api, 3, { name: 'Quintino Aprovado' });
    const renato = await customer(api, 4, { name: 'Renato Recusado' });
    const boleto = (await api.get('/api/finance/payment-methods')).body.find((m: any) => m.type === 'boleto');
    const draft = await api.post('/api/finance/budgets', { customerId: paula, exerciseYear: 2026, category: 'irpf', amountCents: 60_000, paymentMethodId: boleto.id, installments: 3, description: 'Declaração completa' });
    expect(draft.status).toBe(201);
    const approved = await api.post('/api/finance/budgets', { customerId: quintino, exerciseYear: 2026, category: 'irpf', amountCents: 50_000, status: 'approved' });
    expect(approved.body.status).toBe('approved');
    await env.ctx.db.insert(budgets).values({ officeId, customerId: renato, exerciseYear: 2026, amountCents: 40_000, totalCents: 40_000, status: 'rejected' });
    const body = { type: 'budget', channel: 'email', year: 2026, customerIds: [paula, quintino, renato] };

    const preview = await api.post('/api/mailing/preview', body);
    expect(preview.body.type.templateKey).toBe('budget_digital');
    expect(preview.body.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'budget_approved', count: 1, names: ['Quintino Aprovado'] }),
        expect.objectContaining({ reason: 'no_budget', count: 1, names: ['Renato Recusado'] }),
      ]),
    );
    expect(preview.body.sample.html).toMatch(/600,00 \(3x de R\$\s200,00\)/);
    expect(preview.body.sample.html).toContain('href="(gerado no envio)"');
    // a prévia não gera link nem muda o orçamento
    expect(await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, draft.body.id) })).toMatchObject({ status: 'draft', approvalTokenHash: null, sentAt: null });

    const sent = await api.post('/api/mailing/send', { ...body, requestId: uuid() });
    expect(sent.body.customers).toBe(1);
    await env.ctx.jobs.drain();
    const row = await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, draft.body.id) });
    expect(row?.status).toBe('sent');
    expect(row?.sentAt).not.toBeNull();
    const mails = env.providers.sentEmails.filter((m) => m.officeId === officeId);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain('Declaração IRPF');
    expect(mails[0].html).toMatch(/600,00 \(3x de R\$\s200,00\)/);
    const token = /\/orcamento\/([\w-]+)"/.exec(mails[0].html)![1];
    const pub = await env.app.inject({ method: 'GET', url: `/api/public/budgets/${token}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().budget).toMatchObject({ status: 'sent', totalCents: 60_000, installments: 3 });
    const decl = await env.ctx.db.query.declarations.findFirst({ where: and(eq(declarations.customerId, paula), eq(declarations.exerciseYear, 2026)) });
    expect(decl?.substatus).toBe('budget_sent');
    expect((await env.ctx.db.query.budgets.findFirst({ where: eq(budgets.id, approved.body.id) }))?.status).toBe('approved');
  });
});

describe('checklist em PDF na mala direta (INT-8, CON-4)', () => {
  it('é o mesmo PDF da etapa Documentação: sem os itens removidos e com os acrescentados pelo escritório', async () => {
    const { api, officeId } = await registerOffice(env);
    const lia = await customer(api, 7, { name: 'Lia Documentos' });
    await transmittedDeclaration(officeId, lia, 2025);
    const created = await api.post(`/api/customers/${lia}/checklist`, { year: 2026 });
    expect(created.status).toBe(201);
    const alfa = created.body.sections.flatMap((s: any) => s.items).find((i: any) => i.title.includes('Empresa Alfa'));
    expect((await api.put(`/api/checklists/${created.body.id}/items/${alfa.id}`, { status: 'removed' })).status).toBe(200);
    expect((await api.post(`/api/checklists/${created.body.id}/items`, { section: 'income', title: 'Recibo do aluguel de junho' })).status).toBe(201);

    await api.post('/api/mailing/send', { type: 'checklist_pdf', channel: 'email', year: 2026, customerIds: [lia], requestId: uuid() });
    await env.ctx.jobs.drain();
    const attachment = env.providers.sentEmails.find((m) => m.officeId === officeId)!.attachments![0];
    expect(attachment.filename).toBe('checklist-irpf-2026-lia-documentos.pdf');
    const mailed = pdfContent(attachment.content);
    expect(mailed.join('\n')).not.toContain('Empresa Alfa');
    expect(mailed).toContain('Recibo do aluguel de junho');
    expect(mailed).toContain('Bem: Apartamento');

    const step = await api.get(`/api/customers/${lia}/checklist-pdf?year=2026`);
    expect(mailed).toEqual(pdfContent(step.raw.rawPayload));
    const sample = await api.get(`/api/mailing/attachment-preview?type=checklist_pdf&customerId=${lia}&year=2026`);
    expect(pdfContent(sample.raw.rawPayload)).toEqual(mailed);
  });
});

describe('texto do WhatsApp (CON-5)', () => {
  it('decodifica apóstrofo, aspas e &amp; e quebra a linha em <div>, igual na prévia e no envio', async () => {
    const { api, officeId } = await registerOffice(env);
    const maria = await customer(api, 5, { name: "Maria D'Ávila", mobile: '31966660000' });
    await api.put('/api/email-templates/monthly', {
      subject: 'Novidades',
      body: '<div>Olá, {{CLIENTE}}!</div><div class="aviso">Lembretes do "mês" &amp; prazos</div><ul><li class="item">Informe de rendimentos</li></ul>',
    });
    const body = { type: 'monthly', channel: 'whatsapp', year: 2026, customerIds: [maria] };
    const expected = `Olá, Maria D'Ávila!\nLembretes do "mês" & prazos\n• Informe de rendimentos`;
    const preview = await api.post('/api/mailing/preview', body);
    expect(preview.body.sample.text).toBe(expected);

    await api.post('/api/mailing/send', { ...body, requestId: uuid() });
    await env.ctx.jobs.drain();
    expect(env.providers.sentWhatsApp.find((w) => w.officeId === officeId)?.text).toBe(expected);
    const [stored] = await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId));
    expect(stored.body).toBe(expected);
    const [chat] = await env.ctx.db.select().from(messages).where(eq(messages.officeId, officeId));
    expect(chat.body).toBe(expected);

    // o envio avulso, de um cliente só, passa pelo mesmo conversor
    expect((await api.post(`/api/customers/${maria}/checklist-pdf/send`, { year: 2026, channel: 'whatsapp' })).status).toBe(200);
    await env.ctx.jobs.drain();
    const single = env.providers.sentWhatsApp.filter((w) => w.officeId === officeId).at(-1)!;
    expect(single.text).toContain("Olá, Maria D'Ávila!");
    expect(single.text).not.toMatch(/&#39;|&quot;|&amp;/);
  });
});

describe('mala direta em lote (DAD-5)', () => {
  it('a requisição só registra o pedido; o job grava envios, mensagens e jobs em lote e não duplica ao repetir', async () => {
    const { api, officeId, userId } = await registerOffice(env);
    await env.ctx.jobs.drain();
    const many = Array.from({ length: 450 }, (_, i) => ({
      officeId,
      name: `Lote ${String(i).padStart(3, '0')}`,
      cpfCnpj: `9${String(i).padStart(10, '0')}`,
      email: `lote${i}@ex.com`,
      mobile: '31955550000',
      responsibleUserId: userId,
    }));
    await env.ctx.db.insert(customers).values(many);
    const body = { type: 'monthly', channel: 'both', year: 2026 };
    const requestId = uuid();
    const sent = await api.post('/api/mailing/send', { ...body, requestId });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ status: 'queued', customers: 450, deliveries: { email: 450, whatsapp: 450, total: 900 }, truncated: false });
    // a requisição não grava envios: só o pedido
    const countOf = async () => (await env.ctx.db.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.officeId, officeId))).length;
    expect(await countOf()).toBe(0);
    expect((await api.post('/api/mailing/send', { ...body, requestId })).body).toMatchObject({ repeated: true, jobId: sent.body.jobId });

    // roda só o job do pedido: os envios ficam na fila do job de envio
    expect(await env.ctx.jobs.runNext()).toBe(true);
    const status = (await api.get(`/api/mailing/requests/${requestId}`)).body;
    expect(status).toMatchObject({ status: 'done', progress: 100, result: { queued: 900, alreadyQueued: 0, failed: [] } });
    expect(await countOf()).toBe(900);
    expect(await env.ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.officeId, officeId))).toHaveLength(450);
    const queued = await env.ctx.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'delivery.send'), eq(jobs.status, 'queued')));
    expect(queued).toHaveLength(900);
    const [one] = await env.ctx.db.select().from(deliveries).where(and(eq(deliveries.officeId, officeId), eq(deliveries.channel, 'email'))).limit(1);
    expect(one.body).toContain('Ana Dona');

    // os envios na fila não interessam ao resto do teste
    await env.ctx.db.update(jobs).set({ status: 'done' }).where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'delivery.send')));

    // pedido que falhou volta para a fila quando é repetido e não duplica o que já foi gravado
    await env.ctx.db.update(jobs).set({ status: 'failed', error: 'conexão perdida' }).where(eq(jobs.id, sent.body.jobId));
    expect((await api.get(`/api/mailing/requests/${requestId}`)).body).toMatchObject({ status: 'failed', error: expect.stringMatching(/Tente de novo/) });
    const retry = await api.post('/api/mailing/send', { ...body, requestId });
    expect(retry.body).toMatchObject({ repeated: true, status: 'queued', jobId: sent.body.jobId });
    expect(await env.ctx.jobs.runNext()).toBe(true);
    expect((await api.get(`/api/mailing/requests/${requestId}`)).body).toMatchObject({ status: 'done', result: { queued: 0, alreadyQueued: 900 } });
    expect(await countOf()).toBe(900);
    expect(await env.ctx.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.officeId, officeId), eq(jobs.type, 'mailing.plan')))).toHaveLength(1);
  });

  it('avisa quando a seleção passa do limite de destinatários em vez de cortar em silêncio', async () => {
    const { api, officeId } = await registerOffice(env);
    const rows = Array.from({ length: 5001 }, (_, i) => ({ officeId, name: `Cliente ${String(i).padStart(4, '0')}`, cpfCnpj: `8${String(i).padStart(10, '0')}`, email: `c${i}@lote.com` }));
    for (let i = 0; i < rows.length; i += 1000) await env.ctx.db.insert(customers).values(rows.slice(i, i + 1000));
    const body = { type: 'marketing', channel: 'email', year: 2026 };
    const preview = await api.post('/api/mailing/preview', body);
    expect(preview.body).toMatchObject({ truncated: true, matched: 5001, limit: 5000, total: 5000 });
    const sent = await api.post('/api/mailing/send', { ...body, requestId: uuid() });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ truncated: true, matched: 5001, customers: 5000 });
    // o aviso já está no pedido; o envio em si não precisa rodar aqui
    await env.ctx.db.delete(jobs).where(eq(jobs.id, sent.body.jobId));
    // dentro do limite, sem aviso
    const few = await api.post('/api/mailing/preview', { ...body, filters: { email: 'without' } });
    expect(few.body).toMatchObject({ truncated: false, total: 0 });
  });
});
