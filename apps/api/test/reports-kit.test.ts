import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { KIT_ATTACHMENTS_MAX_BYTES } from '@verifco/shared';
import { darfs, declarationItems, declarations, deliveries, documents, files } from '../src/db/schema';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const uuid = () => crypto.randomUUID();

async function newCustomer(api: Api, i: number, name: string, extra: { mobile?: string } = {}) {
  const email = `kit${i}@ex.com`;
  const c = await api.post('/api/customers', { name, cpfCnpj: VALID_CPFS[i], email });
  expect(c.status).toBe(201);
  if (extra.mobile) expect((await api.put(`/api/customers/${c.body.id}/identification`, { name, email, mobile: extra.mobile })).status).toBe(200);
  return c.body.id as string;
}

async function declaration(officeId: string, customerId: string, data: Partial<typeof declarations.$inferInsert> = {}) {
  const [d] = await env.ctx.db
    .insert(declarations)
    .values({ officeId, customerId, exerciseYear: 2026, stage: 'transmitted', substatus: 'ecac_processed', taxation: 'complete', taxDueCents: 90_000, ...data })
    .returning();
  await env.ctx.db.insert(declarationItems).values({ officeId, declarationId: d.id, kind: 'income_pj', counterpartyName: 'Empresa Alfa Ltda', valueCents: 10_000_000, withheldCents: 1_200_000 });
  return d;
}

const save = (officeId: string, filename: string, content: string, mimeType = 'application/pdf') => env.ctx.files.save({ officeId, data: Buffer.from(content), filename, mimeType });

/** Documento do cliente na declaração; `at` ordena (o mais recente de cada categoria é o sugerido). */
async function doc(officeId: string, customerId: string, declarationId: string, category: string, filename: string, at: string, uploadedBy = 'office') {
  const file = await save(officeId, filename, `conteúdo de ${filename}`, filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
  await env.ctx.db.insert(documents).values({ officeId, customerId, declarationId, fileId: file.id, category, uploadedBy, createdAt: new Date(at) });
  return file;
}

/** Declaração transmitida com recibo, duas versões do .DEC, um informe, um arquivo do copiloto, duas quotas e o pacote da elaboração. */
async function scenario(i: number, name: string, customer: { mobile?: string } = {}) {
  const office = await registerOffice(env, `Escritório Kit ${i}`);
  const { api, officeId } = office;
  const cid = await newCustomer(api, i, name, customer);
  const d = await declaration(officeId, cid);
  const receipt = await doc(officeId, cid, d.id, 'receipt', 'recibo-de-entrega.pdf', '2026-05-10T12:00:00Z');
  const decOld = await doc(officeId, cid, d.id, 'irpf_declaration', 'declaracao-original.DEC', '2026-05-01T12:00:00Z', 'sync');
  const decNew = await doc(officeId, cid, d.id, 'irpf_declaration', 'declaracao-retificadora.DEC', '2026-05-09T12:00:00Z', 'sync');
  const informe = await doc(officeId, cid, d.id, 'income_report', 'informe-banco.pdf', '2026-03-01T12:00:00Z', 'customer');
  const copilot = await doc(officeId, cid, d.id, 'copilot', 'planilha-copiloto.pdf', '2026-03-02T12:00:00Z');
  const quota1 = await save(officeId, 'darf.pdf', 'guia da 1ª quota');
  const quota2 = await save(officeId, 'darf.pdf', 'guia da 2ª quota');
  await env.ctx.db.insert(darfs).values([
    { officeId, customerId: cid, declarationId: d.id, quotaNumber: 1, valueCents: 45_000, dueDate: '2026-05-29', fileId: quota1.id, status: 'paid', paidAt: '2026-05-20' },
    { officeId, customerId: cid, declarationId: d.id, quotaNumber: 2, valueCents: 45_000, dueDate: '2026-06-30', fileId: quota2.id },
    { officeId, customerId: cid, declarationId: d.id, quotaNumber: 3, valueCents: 45_000, dueDate: '2026-07-31' },
  ]);
  const pack = await save(officeId, 'conferencia-2026.zip', 'pacote', 'application/zip');
  await env.ctx.db.update(declarations).set({ exportedFileId: pack.id }).where(eq(declarations.id, d.id));
  return { ...office, cid, d, receipt, decOld, decNew, informe, copilot, quota1, quota2, pack };
}

const kitDeliveries = (officeId: string) => env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId));

describe('kit pós-declaração com anexos', () => {
  it('lista os documentos da declaração e sugere recibo, declaração mais recente e DARF em aberto', async () => {
    const s = await scenario(0, 'Vera Kit');
    // documento de outro exercício do mesmo cliente não entra
    const [other] = await env.ctx.db.insert(declarations).values({ officeId: s.officeId, customerId: s.cid, exerciseYear: 2025 }).returning();
    await doc(s.officeId, s.cid, other.id, 'receipt', 'recibo-2025.pdf', '2025-05-10T12:00:00Z');

    const res = await s.api.get(`/api/declarations/${s.d.id}/kit/attachments`);
    expect(res.status).toBe(200);
    expect(res.body.maxBytes).toBe(20 * 1024 * 1024);
    const options = res.body.options as { fileId: string; source: string; label: string; filename: string; size: number; suggested: boolean }[];
    expect(options.map((o) => [o.filename, o.source, o.label, o.suggested])).toEqual([
      ['recibo-de-entrega.pdf', 'document', 'Recibo de entrega', true],
      ['declaracao-retificadora.DEC', 'document', 'Declaração (.DEC)', true],
      ['declaracao-original.DEC', 'document', 'Declaração (.DEC)', false],
      ['informe-banco.pdf', 'document', 'Informe de rendimentos', false],
      ['darf.pdf', 'darf', 'DARF · 1ª quota · paga', false],
      ['darf.pdf', 'darf', 'DARF · 2ª quota · vence em 30/06/2026', true],
      ['conferencia-2026.zip', 'export', 'Pacote de conferência da elaboração (.zip)', false],
    ]);
    expect(options.find((o) => o.filename === 'recibo-de-entrega.pdf')!.size).toBe(Buffer.byteLength('conteúdo de recibo-de-entrega.pdf'));
    expect(options.some((o) => o.fileId === s.copilot.id)).toBe(false);
  });

  it('envia o resumo com os anexos escolhidos no e-mail, grava a escolha na entrega e não duplica', async () => {
    const s = await scenario(1, 'Wagner Kit', { mobile: '11987654321' });
    const requestId = uuid();
    const body = { channels: ['email', 'whatsapp'], attachmentIds: [s.receipt.id, s.decNew.id, s.quota2.id, s.quota1.id], requestId };
    const sent = await s.api.post(`/api/declarations/${s.d.id}/kit/send`, body);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ queued: 2, alreadyQueued: 0, skipped: [] });
    expect(sent.body.attachments.map((a: any) => [a.filename, a.label])).toEqual([
      ['recibo-de-entrega.pdf', 'Recibo de entrega'],
      ['declaracao-retificadora.DEC', 'Declaração (.DEC)'],
      ['darf.pdf', 'DARF · 2ª quota · vence em 30/06/2026'],
      ['darf (2).pdf', 'DARF · 1ª quota · paga'],
    ]);
    const again = await s.api.post(`/api/declarations/${s.d.id}/kit/send`, body);
    expect(again.body).toMatchObject({ queued: 0, alreadyQueued: 2 });

    // o registro da entrega guarda o que foi anexado: cópias, não os arquivos de origem
    const rows = await kitDeliveries(s.officeId);
    expect(rows).toHaveLength(2);
    const mail = rows.find((r) => r.channel === 'email')!;
    const wa = rows.find((r) => r.channel === 'whatsapp')!;
    expect(mail.templateKey).toBe('customer_document');
    expect(mail.attachments.map((a) => a.filename)).toEqual(['kit-pos-declaracao-2026-wagner-kit.pdf', 'recibo-de-entrega.pdf', 'declaracao-retificadora.DEC', 'darf.pdf', 'darf (2).pdf']);
    const originals = [s.receipt.id, s.decNew.id, s.quota2.id, s.quota1.id];
    expect(mail.attachments.some((a) => originals.includes(a.fileId))).toBe(false);
    expect(wa.attachments.map((a) => a.filename)).toEqual(['kit-pos-declaracao-2026-wagner-kit.pdf']);
    const detail = await s.api.get(`/api/deliveries/${mail.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.attachments.map((a: any) => a.filename)).toContain('recibo-de-entrega.pdf');

    // a guia é trocada depois do pedido: o e-mail sai com o que foi escolhido na hora
    await env.ctx.files.remove(s.officeId, s.quota2.id);
    await env.ctx.jobs.drain();
    const emails = env.providers.sentEmails.filter((e) => e.officeId === s.officeId);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe('kit1@ex.com');
    expect(emails[0].attachments!.map((a) => a.filename)).toEqual(mail.attachments.map((a) => a.filename));
    expect(emails[0].attachments![0].content.subarray(0, 4).toString()).toBe('%PDF');
    expect(emails[0].attachments![1].content.toString()).toBe('conteúdo de recibo-de-entrega.pdf');
    expect(emails[0].attachments![3].content.toString()).toBe('guia da 2ª quota');
    expect(emails[0].attachments![2].contentType).toBe('application/octet-stream');
    const whats = env.providers.sentWhatsApp.filter((m) => m.officeId === s.officeId);
    expect(whats).toHaveLength(1);
    expect(whats[0].document?.filename).toBe('kit-pos-declaracao-2026-wagner-kit.pdf');
    expect((await kitDeliveries(s.officeId)).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('sem anexos, o kit vai só com o resumo', async () => {
    const s = await scenario(2, 'Xênia Kit');
    const sent = await s.api.post(`/api/declarations/${s.d.id}/kit/send`, { channels: ['email', 'whatsapp'], requestId: uuid() });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ queued: 1, attachments: [], skipped: [{ channel: 'whatsapp', reason: 'O cliente não tem celular cadastrado.' }] });
    const [row] = await kitDeliveries(s.officeId);
    expect(row.attachments.map((a) => a.filename)).toEqual(['kit-pos-declaracao-2026-xenia-kit.pdf']);
  });

  it('recusa anexo de fora da declaração, soma acima de 20 MB, declaração não transmitida e anexos sem e-mail', async () => {
    const s = await scenario(3, 'Yara Kit', { mobile: '11987654321' });
    const send = (body: Record<string, unknown>, id = s.d.id) => s.api.post(`/api/declarations/${id}/kit/send`, { channels: ['email'], requestId: uuid(), ...body });

    // arquivo do escritório que não é desta declaração (nem documento do copiloto)
    const loose = await save(s.officeId, 'solto.pdf', 'arquivo solto');
    for (const fileId of [loose.id, s.copilot.id, uuid()]) {
      const r = await send({ attachmentIds: [fileId] });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/não pertence a esta declaração/);
    }

    // um documento grande: o tamanho vem do cadastro do arquivo, sem carregar o conteúdo
    const [big] = await env.ctx.db
      .insert(files)
      .values({ officeId: s.officeId, storageKey: `${s.officeId}/teste/grande`, filename: 'extratos.pdf', mimeType: 'application/pdf', size: KIT_ATTACHMENTS_MAX_BYTES - 10, sha256: 'x' })
      .returning();
    await env.ctx.db.insert(documents).values({ officeId: s.officeId, customerId: s.cid, declarationId: s.d.id, fileId: big.id, category: 'bank_statement', uploadedBy: 'office' });
    const over = await send({ attachmentIds: [big.id, s.receipt.id] });
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('Os anexos escolhidos somam 20,0 MB e passam do limite de 20,0 MB do e-mail. Desmarque algum anexo.');
    // sozinho cabe nos anexos, mas não com o resumo em PDF
    const withKit = await send({ attachmentIds: [big.id] });
    expect(withKit.status).toBe(400);
    expect(withKit.body.error).toMatch(/^O resumo do kit \(\d+ KB\) e os anexos escolhidos \(20,0 MB\) passam do limite de 20,0 MB do e-mail\. Desmarque algum anexo\.$/);

    const whatsOnly = await send({ channels: ['whatsapp'], attachmentIds: [s.receipt.id] });
    expect(whatsOnly.status).toBe(400);
    expect(whatsOnly.body.error).toMatch(/vão só no e-mail do kit/);

    await env.ctx.db.update(declarations).set({ stage: 'filling', substatus: 'elaboration' }).where(eq(declarations.id, s.d.id));
    const early = await send({ attachmentIds: [] });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('O kit é enviado depois da transmissão da declaração.');
    // nada foi enfileirado nas recusas
    expect(await kitDeliveries(s.officeId)).toHaveLength(0);
  });

  it('respeita a permissão do kit, a dos arquivos de origem e o escritório', async () => {
    const s = await scenario(4, 'Zeca Kit');
    const noKit = await createEmployee(env, s.api, ['declaration.view']);
    expect((await noKit.api.get(`/api/declarations/${s.d.id}/kit/attachments`)).status).toBe(403);
    expect((await noKit.api.post(`/api/declarations/${s.d.id}/kit/send`, { channels: ['email'], requestId: uuid() })).status).toBe(403);

    // envia o kit, mas não abre documentos, DARF nem o pacote da elaboração: não anexa nenhum deles
    const kitOnly = await createEmployee(env, s.api, ['post_declaration.send_kit']);
    expect((await kitOnly.api.get(`/api/declarations/${s.d.id}/kit/attachments`)).body.options).toEqual([]);
    const blocked = await kitOnly.api.post(`/api/declarations/${s.d.id}/kit/send`, { channels: ['email'], attachmentIds: [s.receipt.id], requestId: uuid() });
    expect(blocked.status).toBe(400);
    expect((await kitOnly.api.post(`/api/declarations/${s.d.id}/kit/send`, { channels: ['email'], requestId: uuid() })).status).toBe(200);

    // com a etapa DARF, vê só as guias
    const darfUser = await createEmployee(env, s.api, ['post_declaration.send_kit', 'darf.view']);
    const seen = (await darfUser.api.get(`/api/declarations/${s.d.id}/kit/attachments`)).body.options as { source: string }[];
    expect(seen.map((o) => o.source)).toEqual(['darf', 'darf']);

    const other = await registerOffice(env);
    expect((await other.api.get(`/api/declarations/${s.d.id}/kit/attachments`)).status).toBe(404);
    expect((await other.api.post(`/api/declarations/${s.d.id}/kit/send`, { channels: ['email'], requestId: uuid() })).status).toBe(404);
  });
});

describe('modelo Orçamento (cópia do orçamento aprovado)', () => {
  it('orçamento aprovado vai com o template “Orçamento”, sem link; para aprovar continua o “Orçamento (digital)”', async () => {
    const { api, officeId } = await registerOffice(env, 'Escritório Modelos');
    const cid = await newCustomer(api, 5, 'Alba Orçamento');
    const create = (extra: Record<string, unknown>) => api.post('/api/finance/budgets', { customerId: cid, exerciseYear: 2026, type: 'fixed', category: 'irpf', amountCents: 60_000, description: 'Declaração completa', ...extra });
    const approved = await create({ status: 'approved' });
    expect(approved.status).toBe(201);

    const requestId = uuid();
    const copy = await api.post(`/api/finance/budgets/${approved.body.id}/send`, { channels: ['email'], requestId });
    expect(copy.status).toBe(200);
    expect(copy.body).toMatchObject({ status: 'approved', link: null });
    // a mesma operação repetida não manda de novo
    await api.post(`/api/finance/budgets/${approved.body.id}/send`, { channels: ['email'], requestId });
    const rows = await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId));
    expect(rows).toHaveLength(1);
    expect(rows[0].templateKey).toBe('budget');
    expect(rows[0].subject).toBe('Proposta de serviço — Declaração IRPF 2026');
    expect(rows[0].body).toContain('Declaração completa');
    expect(rows[0].body).toMatch(/R\$\s600,00/);
    expect(rows[0].body).not.toMatch(/href=|\{\{/);
    expect((await api.post(`/api/finance/budgets/${approved.body.id}/send`, { channels: ['whatsapp'] })).status).toBe(400);

    // rascunho de outro serviço: segue o envio para aprovação, com o link
    const draft = await create({ category: 'capital_gain' });
    const sent = await api.post(`/api/finance/budgets/${draft.body.id}/send`, { channels: ['email'] });
    expect(sent.status).toBe(200);
    expect(sent.body.link).toMatch(/^http/);
    const digital = (await env.ctx.db.select().from(deliveries).where(eq(deliveries.officeId, officeId))).filter((r) => r.templateKey === 'budget_digital');
    expect(digital).toHaveLength(1);
    expect(digital[0].body).toContain('Ver e aprovar a proposta');
  });
});
