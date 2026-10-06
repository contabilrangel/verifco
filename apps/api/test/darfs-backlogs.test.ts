import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brazilToday } from '@verifco/shared';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';
import { FAKE_PDF, upload } from './upload-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const YEAR = 2026;

async function setup(api: Api, opts: { email?: string | null; mobile?: string } = {}) {
  const c = await api.post('/api/customers', { name: 'João Pereira', cpfCnpj: VALID_CPFS[0], email: opts.email === undefined ? 'joao@ex.com' : opts.email });
  if (opts.mobile) await api.put(`/api/customers/${c.body.id}/identification`, { name: 'João Pereira', mobile: opts.mobile });
  const d = await api.put(`/api/customers/${c.body.id}/declarations/${YEAR}`, { taxDueCents: 300_001 });
  return { customerId: c.body.id as string, declarationId: d.body.id as string };
}

describe('DARF', () => {
  it('gera quotas a partir do imposto a pagar e protege a substituição', async () => {
    const { api } = await registerOffice(env);
    const { declarationId } = await setup(api);
    const gen = await api.post(`/api/declarations/${declarationId}/darfs/generate`, { quotas: 3, firstDueDate: '2026-05-29' });
    expect(gen.status).toBe(201);
    expect(gen.body.darfs.map((d: any) => [d.quotaNumber, d.valueCents, d.dueDate])).toEqual([
      [1, 100_001, '2026-05-29'],
      [2, 100_000, '2026-06-30'],
      [3, 100_000, '2026-07-31'],
    ]);
    expect((await api.post(`/api/declarations/${declarationId}/darfs/generate`, { quotas: 2, firstDueDate: '2026-05-29' })).status).toBe(409);
    const replaced = await api.post(`/api/declarations/${declarationId}/darfs/generate`, { quotas: 8, firstDueDate: '2026-05-29', totalCents: 20_000, replace: true });
    expect(replaced.body.count).toBe(4);
    expect(replaced.body.warning).toContain('até 4');
    const list = await api.get(`/api/declarations/${declarationId}/darfs`);
    expect(list.body.darfs).toHaveLength(4);
    // quota paga impede gerar de novo
    await api.put(`/api/darfs/${list.body.darfs[0].id}`, { paidAt: '2026-05-28' });
    expect((await api.post(`/api/declarations/${declarationId}/darfs/generate`, { quotas: 1, firstDueDate: '2026-05-29', replace: true })).status).toBe(409);
  });

  it('cria, edita, marca como paga e calcula a situação', async () => {
    const { api } = await registerOffice(env);
    const { declarationId } = await setup(api);
    const today = brazilToday();
    const created = await api.post(`/api/declarations/${declarationId}/darfs`, { valueCents: 50_000, dueDate: '2020-01-31' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ quotaNumber: 1, status: 'overdue', sendStatus: 'not_sent' });
    const second = await api.post(`/api/declarations/${declarationId}/darfs`, { valueCents: 50_000, dueDate: '2099-12-31' });
    expect(second.body).toMatchObject({ quotaNumber: 2, status: 'open' });
    expect((await api.post(`/api/declarations/${declarationId}/darfs`, { valueCents: 0, dueDate: '2099-12-31' })).status).toBe(400);
    const paid = await api.put(`/api/darfs/${created.body.id}`, { paidAt: today });
    expect(paid.body).toMatchObject({ status: 'paid', paidAt: today });
    const reopened = await api.put(`/api/darfs/${created.body.id}`, { paidAt: null, dueDate: '2099-11-30', valueCents: 51_000 });
    expect(reopened.body).toMatchObject({ status: 'open', valueCents: 51_000, dueDate: '2099-11-30' });
    expect((await api.del(`/api/darfs/${second.body.id}`)).status).toBe(200);
    expect((await api.get(`/api/declarations/${declarationId}/darfs`)).body.darfs).toHaveLength(1);
  });

  it('anexa o PDF, envia por e-mail/WhatsApp e respeita o envio automático', async () => {
    const { api, token } = await registerOffice(env);
    const { declarationId } = await setup(api, { mobile: '11987654321' });
    const d = (await api.post(`/api/declarations/${declarationId}/darfs`, { valueCents: 150_000, dueDate: '2099-05-29' })).body;
    expect((await api.post(`/api/darfs/${d.id}/send`, { channel: 'email' })).status).toBe(400); // sem PDF
    const bad = await upload(env, token, `/api/darfs/${d.id}/file`, [{ name: 'guia.txt', content: 'texto', type: 'text/plain' }]);
    expect(bad.status).toBe(400);
    const up = await upload(env, token, `/api/darfs/${d.id}/file`, [{ name: 'darf-1.pdf', content: FAKE_PDF, type: 'application/pdf' }]);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ autoSend: 'off', file: { filename: 'darf-1.pdf' } });

    const sent = await api.post(`/api/darfs/${d.id}/send`, { channel: 'email' });
    expect(sent.status).toBe(200);
    await api.post(`/api/darfs/${d.id}/send`, { channel: 'whatsapp' });
    await env.ctx.jobs.drain();
    const mail = env.providers.sentEmails.find((m) => m.to === 'joao@ex.com');
    expect(mail?.html).toContain('R$');
    expect(mail?.html).toContain('29/05/2099');
    expect(mail?.attachments?.[0].filename).toBe('darf-1.pdf');
    expect(env.providers.sentWhatsApp.find((w) => w.to === '5511987654321')?.document?.filename).toBe('darf-1.pdf');
    const listed = (await api.get(`/api/declarations/${declarationId}/darfs`)).body.darfs[0];
    expect(listed.sendStatus).toBe('sent');
    expect(listed.lastSend.channel).toBe('whatsapp');

    // envio automático ao anexar
    await api.put('/api/office/settings', { autoSendDarfEmail: true });
    const before = env.providers.sentEmails.length;
    const auto = await upload(env, token, `/api/darfs/${d.id}/file`, [{ name: 'darf-1-v2.pdf', content: FAKE_PDF, type: 'application/pdf' }]);
    expect(auto.body.autoSend).toBe('sent');
    await env.ctx.jobs.drain();
    expect(env.providers.sentEmails.length).toBe(before + 1);
    expect(env.providers.sentEmails.at(-1)?.attachments?.[0].filename).toBe('darf-1-v2.pdf');
  });

  it('envio automático sem e-mail do cliente não falha', async () => {
    const { api, token } = await registerOffice(env);
    await api.put('/api/office/settings', { autoSendDarfEmail: true });
    const { declarationId } = await setup(api, { email: null });
    const d = (await api.post(`/api/declarations/${declarationId}/darfs`, { valueCents: 150_000, dueDate: '2099-05-29' })).body;
    const up = await upload(env, token, `/api/darfs/${d.id}/file`, [{ name: 'guia.pdf', content: FAKE_PDF, type: 'application/pdf' }]);
    expect(up.status).toBe(200);
    expect(up.body.autoSend).toBe('no_email');
  });

  it('permissões e isolamento', async () => {
    const office = await registerOffice(env);
    const { declarationId } = await setup(office.api);
    const d = (await office.api.post(`/api/declarations/${declarationId}/darfs`, { valueCents: 150_000, dueDate: '2099-05-29' })).body;
    const viewer = await createEmployee(env, office.api, ['customer.list', 'darf.view']);
    expect((await viewer.api.get(`/api/declarations/${declarationId}/darfs`)).status).toBe(200);
    expect((await viewer.api.post(`/api/declarations/${declarationId}/darfs`, { valueCents: 1, dueDate: '2099-01-01' })).status).toBe(403);
    expect((await viewer.api.put(`/api/darfs/${d.id}`, { paidAt: '2026-01-01' })).status).toBe(403);
    expect((await viewer.api.post(`/api/darfs/${d.id}/send`, { channel: 'email' })).status).toBe(403);
    const noView = await createEmployee(env, office.api, ['customer.list']);
    expect((await noView.api.get(`/api/declarations/${declarationId}/darfs`)).status).toBe(403);

    const other = await registerOffice(env);
    expect((await other.api.get(`/api/declarations/${declarationId}/darfs`)).status).toBe(404);
    expect((await other.api.put(`/api/darfs/${d.id}`, { valueCents: 1_000 })).status).toBe(404);
    expect((await other.api.del(`/api/darfs/${d.id}`)).status).toBe(404);
    expect((await other.api.post(`/api/darfs/${d.id}/send`, { channel: 'email' })).status).toBe(404);
    expect((await upload(env, other.token, `/api/darfs/${d.id}/file`, [{ name: 'x.pdf', content: FAKE_PDF, type: 'application/pdf' }])).status).toBe(404);
  });
});

describe('documentos faltantes', () => {
  it('muda o subestado ao criar e volta ao baixar a última pendência', async () => {
    const { api } = await registerOffice(env);
    const { declarationId } = await setup(api);
    await api.patch(`/api/declarations/${declarationId}/substatus`, { substatus: 'elaboration' });
    const a = await api.post(`/api/declarations/${declarationId}/backlogs`, { description: 'Informe de rendimentos do Banco Y', dueDate: '2020-04-10' });
    expect(a.status).toBe(201);
    expect(a.body.overdue).toBe(true);
    const b = await api.post(`/api/declarations/${declarationId}/backlogs`, { description: 'Recibo do dentista <Dra. Ana>' });
    const decl = async () => (await api.get(`/api/customers/${a.body.customerId}/declarations/${YEAR}`)).body;
    expect((await decl()).substatus).toBe('missing_documents');
    expect((await api.post(`/api/declarations/${declarationId}/backlogs`, { description: 'x' })).status).toBe(400);

    const resolved = await api.put(`/api/backlogs/${a.body.id}`, { resolved: true });
    expect(resolved.body.resolvedAt).toBeTruthy();
    expect(resolved.body.overdue).toBe(false);
    expect((await decl()).substatus).toBe('missing_documents');
    await api.del(`/api/backlogs/${b.body.id}`);
    expect((await decl()).substatus).toBe('elaboration');
    // reabrir volta para documentos faltantes
    await api.put(`/api/backlogs/${a.body.id}`, { resolved: false });
    expect((await decl()).substatus).toBe('missing_documents');
    const list = await api.get(`/api/declarations/${declarationId}/backlogs`);
    expect(list.body).toHaveLength(1);
  });

  it('não muda o subestado fora do preenchimento', async () => {
    const { api } = await registerOffice(env);
    const { customerId, declarationId } = await setup(api);
    await api.post(`/api/declarations/${declarationId}/backlogs`, { description: 'Extrato da corretora' });
    expect((await api.get(`/api/customers/${customerId}/declarations/${YEAR}`)).body.substatus).toBe('not_started');
  });

  it('envia a lista em aberto por e-mail e WhatsApp', async () => {
    const { api } = await registerOffice(env);
    const { declarationId } = await setup(api, { mobile: '11912345678' });
    expect((await api.post(`/api/declarations/${declarationId}/backlogs/send`, { channel: 'email' })).status).toBe(400);
    await api.post(`/api/declarations/${declarationId}/backlogs`, { description: 'Recibo do dentista <Dra. Ana>', dueDate: '2099-04-10' });
    const done = await api.post(`/api/declarations/${declarationId}/backlogs`, { description: 'Já entregue' });
    await api.put(`/api/backlogs/${done.body.id}`, { resolved: true });
    const sent = await api.post(`/api/declarations/${declarationId}/backlogs/send`, { channel: 'email' });
    expect(sent.body.count).toBe(1);
    await api.post(`/api/declarations/${declarationId}/backlogs/send`, { channel: 'whatsapp' });
    await env.ctx.jobs.drain();
    const mail = env.providers.sentEmails.find((m) => m.to === 'joao@ex.com' && m.subject.includes('Pendências'));
    expect(mail?.html).toContain('<li>Recibo do dentista &lt;Dra. Ana&gt; <em>(até 10/04/2099)</em></li>');
    expect(mail?.html).not.toContain('Já entregue');
    const wa = env.providers.sentWhatsApp.find((w) => w.to === '5511912345678');
    expect(wa?.text).toContain('• Recibo do dentista');
  });

  it('permissões e isolamento', async () => {
    const office = await registerOffice(env);
    const { declarationId } = await setup(office.api);
    const b = (await office.api.post(`/api/declarations/${declarationId}/backlogs`, { description: 'Informe do INSS' })).body;
    const viewer = await createEmployee(env, office.api, ['declaration.view']);
    expect((await viewer.api.get(`/api/declarations/${declarationId}/backlogs`)).status).toBe(200);
    expect((await viewer.api.post(`/api/declarations/${declarationId}/backlogs`, { description: 'Outro doc' })).status).toBe(403);
    expect((await viewer.api.put(`/api/backlogs/${b.id}`, { resolved: true })).status).toBe(403);
    expect((await viewer.api.post(`/api/declarations/${declarationId}/backlogs/send`, { channel: 'email' })).status).toBe(403);
    const other = await registerOffice(env);
    expect((await other.api.get(`/api/declarations/${declarationId}/backlogs`)).status).toBe(404);
    expect((await other.api.put(`/api/backlogs/${b.id}`, { resolved: true })).status).toBe(404);
    expect((await other.api.del(`/api/backlogs/${b.id}`)).status).toBe(404);
    expect((await other.api.post(`/api/declarations/${declarationId}/backlogs/send`, { channel: 'email' })).status).toBe(404);
  });
});
