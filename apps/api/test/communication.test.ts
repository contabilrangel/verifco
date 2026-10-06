import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { budgets, darfs, declarationItems, declarations, deliveries } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

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
    expect(sent.status).toBe(200);
    expect(sent.body.queued).toBe(1);
    expect(sent.body.skipped[0].count).toBe(2);
    const again = await api.post('/api/mailing/send', { ...body, requestId });
    expect(again.body.queued).toBe(0);
    expect(again.body.alreadyQueued).toBe(1);
    const rows = await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId));
    expect(rows).toHaveLength(1);
    await env.ctx.jobs.drain();
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
    expect(sent.body.queued).toBe(1);
    await env.ctx.jobs.drain();
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
    expect(sent.body.queued).toBe(1);
    await env.ctx.jobs.drain();
    const email = env.providers.sentEmails.find((e) => e.officeId === officeId)!;
    expect(email.attachments?.[0].filename).toMatch(/^checklist-irpf-2026-helena-orc\.pdf$/);
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
