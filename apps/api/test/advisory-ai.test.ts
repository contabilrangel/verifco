import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_LIMITS } from '../src/modules/advisory/ai-service';
import type { AiProvider } from '../src/integrations/providers';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type TestEnv } from './helpers';
import { R, seedDeclaration, seedDocument, upload } from './advisory-helpers';

let env: TestEnv;
const calls: Parameters<AiProvider['complete']>[1][] = [];
beforeAll(async () => {
  env = await createTestEnv();
  // registra o que foi enviado à IA, mantendo as respostas simuladas do MemoryProviders
  const original = env.providers.ai.complete;
  env.providers.ai = {
    complete: async (officeId, input) => {
      calls.push(input);
      return original(officeId, input);
    },
  };
});
afterAll(async () => env.close());

async function officeWithCustomer(cpf = VALID_CPFS[0]) {
  const office = await registerOffice(env);
  const c = await office.api.post('/api/customers', { name: 'Marta Souza', cpfCnpj: cpf });
  return { ...office, customerId: c.body.id as string };
}

describe('assistentes de IA', () => {
  it('conversa com contexto do cliente, anexos e documentos; reinicia e avalia', async () => {
    const o = await officeWithCustomer();
    await seedDeclaration(env, o.officeId, o.customerId, 2026, [
      { kind: 'income_pj', description: 'Salário', counterpartyName: 'Acme SA', valueCents: R(120_000), withheldCents: R(20_000), extra: { nature: 'salary' } },
      { kind: 'asset', groupCode: '01', description: 'Apartamento', valueCents: R(500_000), prevValueCents: R(500_000) },
    ]);
    const doc = await seedDocument(env, o.officeId, o.customerId, 'informe.pdf', '%PDF-1.4 teste', 'application/pdf');

    const empty = await o.api.get(`/api/customers/${o.customerId}/ai/ir`);
    expect(empty.body.conversation).toBeNull();

    const up = await upload(env, o.token, `/api/customers/${o.customerId}/ai/attachments`, [{ filename: 'extrato.csv', content: 'data;valor\n01/01/2025;100,00', type: 'text/csv' }]);
    expect(up.status).toBe(201);

    env.providers.aiReplies.push('Resposta do especialista em IR.');
    const sent = await o.api.post(`/api/customers/${o.customerId}/ai/ir/messages`, {
      content: 'Posso deduzir a previdência privada?',
      year: 2026,
      attachments: [up.body[0].fileId],
      documentIds: [doc.id],
    });
    expect(sent.status).toBe(200);
    expect(sent.body.assistantMessage.content).toBe('Resposta do especialista em IR.');
    expect(sent.body.userMessage.attachments.map((a: any) => a.filename).sort()).toEqual(['extrato.csv', 'informe.pdf']);
    const call = calls[calls.length - 1];
    expect(call.system).toContain('Marta Souza');
    expect(call.system).toContain('Acme SA');
    expect(call.system).not.toContain(VALID_CPFS[0]);
    const last = call.messages[call.messages.length - 1];
    expect(last.files?.[0].filename).toBe('informe.pdf');
    expect(last.content).toContain('01/01/2025;100,00');

    await o.api.post(`/api/customers/${o.customerId}/ai/ir/messages`, { content: 'E o limite?', year: 2026 });
    const conv = await o.api.get(`/api/customers/${o.customerId}/ai/ir`);
    expect(conv.body.messages).toHaveLength(4);
    // a segunda chamada leva o histórico
    expect(calls[calls.length - 1].messages).toHaveLength(3);

    const rate = await o.api.put(`/api/ai/messages/${sent.body.assistantMessage.id}/rating`, { rating: 1 });
    expect(rate.body.rating).toBe(1);
    expect((await o.api.put(`/api/ai/messages/${sent.body.userMessage.id}/rating`, { rating: 1 })).status).toBe(404);

    const restart = await o.api.post(`/api/customers/${o.customerId}/ai/ir/restart`);
    expect(restart.body.archived).toBe(true);
    expect((await o.api.get(`/api/customers/${o.customerId}/ai/ir`)).body.conversation).toBeNull();

    const docs = await o.api.get(`/api/customers/${o.customerId}/ai/documents`);
    expect(docs.body.map((d: any) => d.filename)).toEqual(['informe.pdf']);
  });

  it('erro claro quando a IA não está configurada ou demora demais, sem gravar nada', async () => {
    const o = await officeWithCustomer(VALID_CPFS[1]);
    const saved = env.providers.ai;
    env.providers.ai = {
      complete: async () => {
        throw new Error('Integração de IA não configurada para o escritório');
      },
    };
    const r = await o.api.post(`/api/customers/${o.customerId}/ai/capital_gain/messages`, { content: 'Oi', year: 2026 });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/não está configurada/);

    env.providers.ai = { complete: () => new Promise((resolve) => setTimeout(() => resolve({ text: 'tarde' }), 500)) };
    const old = AI_LIMITS.chatTimeoutMs;
    AI_LIMITS.chatTimeoutMs = 50;
    const t = await o.api.post(`/api/customers/${o.customerId}/ai/capital_gain/messages`, { content: 'Oi', year: 2026 });
    AI_LIMITS.chatTimeoutMs = old;
    env.providers.ai = saved;
    expect(t.status).toBe(504);
    expect((await o.api.get(`/api/customers/${o.customerId}/ai/capital_gain`)).body.conversation).toBeNull();
  });

  it('defesa administrativa da malha fina com CPF preenchido localmente e PDF', async () => {
    const o = await officeWithCustomer(VALID_CPFS[2]);
    env.providers.aiReplies.push('Entendi a notificação.');
    await o.api.post(`/api/customers/${o.customerId}/ai/fine_mesh/messages`, { content: 'Recebi notificação de despesas médicas', year: 2026 });
    env.providers.aiReplies.push('MINUTA — conferir antes de protocolar\n\n[NOME DO CONTRIBUINTE], CPF [CPF DO CONTRIBUINTE], vem apresentar...');
    const def = await o.api.post(`/api/customers/${o.customerId}/ai/fine_mesh/defense`, { year: 2026, notes: 'Recibos do dentista anexos' });
    expect(def.status).toBe(201);
    expect(def.body.kind).toBe('fine_mesh_defense');
    expect(def.body.result).toContain('Marta Souza, CPF 390.533.447-05');
    const call = calls[calls.length - 1];
    expect(JSON.stringify(call)).not.toContain(VALID_CPFS[2]);
    expect(call.messages.at(-1)?.content).toContain('Recibos do dentista');
    const list = await o.api.get(`/api/customers/${o.customerId}/ai/analyses?kind=fine_mesh_defense`);
    expect(list.body).toHaveLength(1);
    const pdf = await o.api.get(`/api/ai/analyses/${def.body.id}/pdf`);
    expect(pdf.raw.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('assessor financeiro: job gera a análise, permite avaliar, baixar e gerar novamente', async () => {
    const o = await officeWithCustomer(VALID_CPFS[3]);
    const d1 = await seedDocument(env, o.officeId, o.customerId, 'fatura.pdf', '%PDF-1.4 fatura', 'application/pdf');
    const d2 = await seedDocument(env, o.officeId, o.customerId, 'extrato.txt', 'saldo 1000', 'text/plain');
    expect((await o.api.post(`/api/customers/${o.customerId}/ai/analyses`, { documentIds: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 11 }, () => d1.id);
    expect((await o.api.post(`/api/customers/${o.customerId}/ai/analyses`, { documentIds: tooMany })).status).toBe(400);

    env.providers.aiReplies.push('## Resumo\n- Gastos com cartão altos\n\n| Item | Valor |\n|---|---|\n| Cartão | R$ 5.000 |');
    const created = await o.api.post(`/api/customers/${o.customerId}/ai/analyses`, { documentIds: [d1.id, d2.id] });
    expect(created.status).toBe(202);
    expect(created.body.status).toBe('queued');
    await env.ctx.jobs.drain();
    const done = await o.api.get(`/api/ai/analyses/${created.body.id}`);
    expect(done.body.status).toBe('done');
    expect(done.body.result).toContain('Resumo');
    const call = calls[calls.length - 1];
    expect(call.messages[0].files?.map((f) => f.filename)).toEqual(['fatura.pdf']);
    expect(call.messages[0].content).toContain('saldo 1000');

    expect((await o.api.put(`/api/ai/analyses/${created.body.id}/rating`, { rating: -1 })).body.rating).toBe(-1);
    const pdf = await o.api.get(`/api/ai/analyses/${created.body.id}/pdf`);
    expect(pdf.raw.headers['content-type']).toContain('pdf');
    const again = await o.api.post(`/api/ai/analyses/${created.body.id}/regenerate`);
    expect(again.status).toBe(202);
    expect(again.body.id).not.toBe(created.body.id);
    expect((await o.api.get(`/api/customers/${o.customerId}/ai/analyses`)).body).toHaveLength(2);

    // falha da IA fica registrada na análise
    const saved = env.providers.ai;
    env.providers.ai = {
      complete: async () => {
        throw new Error('sem chave da API');
      },
    };
    await env.ctx.jobs.drain();
    env.providers.ai = saved;
    const failed = await o.api.get(`/api/ai/analyses/${again.body.id}`);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.result).toMatch(/não está configurada/);
  });

  it('permissões: ai.use, IRPFM exige também irpfm.view e copiloto exige cliente habilitado', async () => {
    const o = await officeWithCustomer(VALID_CPFS[4]);
    const noAi = await createEmployee(env, o.api, ['customer.list']);
    expect((await noAi.api.get(`/api/customers/${o.customerId}/ai/ir`)).status).toBe(403);
    expect((await noAi.api.get(`/api/customers/${o.customerId}/ai/documents`)).status).toBe(403);
    const aiOnly = await createEmployee(env, o.api, ['customer.list', 'ai.use']);
    expect((await aiOnly.api.get(`/api/customers/${o.customerId}/ai/ir`)).status).toBe(200);
    expect((await aiOnly.api.get(`/api/customers/${o.customerId}/ai/irpfm`)).status).toBe(403);
    expect((await o.api.get(`/api/customers/${o.customerId}/ai/irpfm`)).status).toBe(200);
    expect((await o.api.get(`/api/customers/${o.customerId}/ai/copilot`)).status).toBe(403);
    await o.api.post('/api/copilot/enrollments', { customerId: o.customerId });
    expect((await o.api.get(`/api/customers/${o.customerId}/ai/copilot`)).status).toBe(200);
    expect((await o.api.get(`/api/customers/${o.customerId}/ai/inexistente`)).status).toBe(400);
  });

  it('isolamento entre escritórios', async () => {
    const o = await officeWithCustomer(VALID_CPFS[5]);
    env.providers.aiReplies.push('ok');
    const sent = await o.api.post(`/api/customers/${o.customerId}/ai/ir/messages`, { content: 'Oi', year: 2026 });
    const doc = await seedDocument(env, o.officeId, o.customerId, 'a.pdf', '%PDF', 'application/pdf');
    const other = await registerOffice(env);
    const oc = await other.api.post('/api/customers', { name: 'Outro', cpfCnpj: VALID_CPFS[6] });
    expect((await other.api.get(`/api/customers/${o.customerId}/ai/ir`)).status).toBe(404);
    expect((await other.api.put(`/api/ai/messages/${sent.body.assistantMessage.id}/rating`, { rating: 1 })).status).toBe(404);
    // documento de outro escritório não pode ser anexado
    const r = await other.api.post(`/api/customers/${oc.body.id}/ai/ir/messages`, { content: 'Oi', year: 2026, documentIds: [doc.id] });
    expect(r.status).toBe(400);
    const r2 = await other.api.post(`/api/customers/${oc.body.id}/ai/ir/messages`, { content: 'Oi', year: 2026, attachments: [doc.fileId] });
    expect(r2.status).toBe(404);
  });
});
