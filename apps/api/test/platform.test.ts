import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { AI_PROVIDERS } from '@verifco/shared';
import { platformUsers, platformAiConnections, platformSettings, integrations, platformAuditLogs } from '../src/db/schema';
import { createProviders } from '../src/integrations';
import { completeConnection, requestFor } from '../src/integrations/multi-ai';
import type { ResolvedConnection } from '../src/integrations/platform-ai-store';
import { client, createTestEnv, registerOffice, type TestEnv, type Api } from './helpers';

let env: TestEnv; let owner: Api; let developer: Api; let office: Awaited<ReturnType<typeof registerOffice>>;
let ownerId: string; let developerId: string;
beforeAll(async () => {
  env = await createTestEnv();
  const hash = await bcrypt.hash('senha-sistema-123', 10);
  const accounts = await env.ctx.db.insert(platformUsers).values([
    { name: 'Proprietário', email: 'owner@teste.com', passwordHash: hash, role: 'owner' },
    { name: 'Desenvolvedor', email: 'developer@teste.com', passwordHash: hash, role: 'developer' },
  ]).returning();
  ownerId = accounts[0].id; developerId = accounts[1].id;
  owner = client(env, env.app.jwt.sign({ typ: 'platform', sub: ownerId, tv: 0 }));
  developer = client(env, env.app.jwt.sign({ typ: 'platform', sub: developerId, tv: 0 }));
  office = await registerOffice(env);
});
afterAll(async () => env.close());

describe('administração global separada', () => {
  it('login global não aceita contas do contador e tokens não atravessam os painéis', async () => {
    const wrong = await env.app.inject({ method: 'POST', url: '/api/platform/login', payload: { email: office.email, password: 'senha-forte-123' } });
    expect(wrong.statusCode).toBe(401);
    const correct = await env.app.inject({ method: 'POST', url: '/api/platform/login', payload: { email: 'OWNER@teste.com', password: 'senha-sistema-123' } });
    expect(correct.statusCode).toBe(200);
    expect(env.app.jwt.verify<any>(correct.json().token)).toMatchObject({ typ: 'platform', sub: ownerId });
    for (const path of ['/api/platform/me', '/api/platform/offices', '/api/platform/ai', '/api/platform/users', '/api/platform/contracts', '/api/platform/audit']) {
      expect((await office.api.get(path)).status, path).toBe(401);
    }
    expect((await owner.get('/api/customers')).status).toBe(401);
    expect((await owner.get('/api/auth/me')).status).toBe(401);
    expect((await owner.put('/api/integrations/smtp', {})).status).toBe(401);
    expect((await office.api.put('/api/integrations/ai', { secrets: { apiKey: 'tentativa' } })).status).toBe(403);
    expect((await office.api.post('/api/integrations/ai/test')).status).toBe(403);
    expect((await office.api.del('/api/integrations/ai')).status).toBe(403);
    expect((await office.api.get('/api/integrations')).body.some((i: any) => i.provider === 'ai')).toBe(false);
  });
  it('desenvolvedor acompanha operação; somente proprietário altera planos, chaves e contas', async () => {
    for (const path of ['/api/platform/me', '/api/platform/overview', '/api/platform/offices', '/api/platform/contracts', '/api/platform/audit']) {
      expect((await developer.get(path)).status, path).toBe(200);
    }
    expect((await developer.get('/api/platform/ai')).status).toBe(403);
    expect((await developer.get('/api/platform/users')).status).toBe(403);
    expect((await developer.post('/api/platform/ai', {})).status).toBe(403);
    expect((await developer.post('/api/platform/contracts', {})).status).toBe(403);
    expect((await developer.put('/api/platform/offices/' + office.officeId, {})).status).toBe(403);
    const overview = await owner.get('/api/platform/overview');
    expect(overview.body).toMatchObject({ offices: 1, collaborators: 1, queued_jobs: 0, failed_jobs: 0 });
    expect((await owner.get('/api/platform/offices')).body[0]).toMatchObject({ id: office.officeId, collaborators: 1, customers: 0 });
  });
  it('gerencia contratos reais vistos pelo escritório e registra auditoria', async () => {
    const body = { officeId: office.officeId, name: 'Plano de teste', plan: 'pro', declarationLimit: 300, year: 2026,
      startsAt: '2026-01-01', expiresAt: '2027-01-01', hasBackup: true, status: 'active' };
    const saved = await owner.post('/api/platform/contracts', body);
    expect(saved.status).toBe(201);
    expect((await office.api.get('/api/office/contracts')).body.some((c: any) => c.id === saved.body.id)).toBe(true);
    expect((await owner.put('/api/platform/contracts/' + saved.body.id, { ...body, declarationLimit: 500 })).body.declarationLimit).toBe(500);
    expect((await owner.post('/api/platform/contracts', { ...body, expiresAt: '2025-12-31' })).status).toBe(400);
    expect((await owner.post('/api/platform/contracts', { ...body, startsAt: '2026-02-30' })).status).toBe(400);
    expect((await owner.get('/api/platform/audit')).body.some((a: any) => a.action === 'contract.update')).toBe(true);
  });
  it('cria contas da equipe sem retornar senha ou hash, e pagina escritórios', async () => {
    const second = await registerOffice(env, 'Outra empresa');
    expect((await owner.get('/api/platform/offices?limit=1&offset=1')).body).toHaveLength(1);
    expect((await owner.get('/api/platform/offices?search=Outra')).body.map((o: any) => o.id)).toEqual([second.officeId]);
    const body = { name: 'Nova pessoa', email: 'NOVO@teste.com', password: 'senha-inicial-123', role: 'developer' };
    expect((await owner.post('/api/platform/users', body)).status).toBe(201);
    expect((await owner.post('/api/platform/users', body)).status).toBe(409);
    const list = await owner.get('/api/platform/users');
    expect(JSON.stringify(list.body)).not.toContain('senha-inicial-123');
    expect(JSON.stringify(list.body)).not.toContain('passwordHash');
    expect(list.body.some((u: any) => u.email === 'novo@teste.com')).toBe(true);
  });
  it('chaves são globais e cifradas; a escolha funciona em todos os escritórios sem expor segredos', async () => {
    const secret = 'chave-realista-super-secreta';
    const saved = await owner.post('/api/platform/ai', { provider: 'openai', name: 'IA global', model: 'modelo-teste', apiKey: secret, supportsImages: true });
    expect(saved.status).toBe(201); expect(saved.body.keyConfigured).toBe(true);
    const row = await env.ctx.db.query.platformAiConnections.findFirst({ where: eq(platformAiConnections.id, saved.body.id) });
    expect(row!.secretsEnc).not.toContain(secret);
    expect(env.ctx.secrets.decryptJson<any>(row!.secretsEnc).apiKey).toBe(secret);
    expect((await owner.put('/api/platform/ai-default', { id: saved.body.id })).status).toBe(200);
    const fetchMock = (async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + secret);
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Resposta' }] }], usage: { input_tokens: 10, output_tokens: 2 } });
    }) as typeof fetch;
    const providers = createProviders(env.ctx, { fetch: fetchMock });
    const second = await registerOffice(env);
    for (const id of [office.officeId, second.officeId]) expect((await providers.ai.complete(id, { system: 's', messages: [{ role: 'user', content: 'oi' }] })).text).toBe('Resposta');
    const view = await office.api.get('/api/ai/platform-status');
    expect(view.body).toMatchObject({ available: true, provider: 'OpenAI', model: 'modelo-teste' });
    expect(JSON.stringify(view.body)).not.toContain(secret);
    expect(JSON.stringify((await owner.get('/api/platform/ai')).body)).not.toContain(secret);
    expect(JSON.stringify((await owner.get('/api/platform/audit')).body)).not.toContain(secret);
    await owner.put('/api/platform/ai/' + saved.body.id, { provider: 'openai', name: 'IA global', model: 'modelo-teste', apiKey: '', supportsImages: true });
    expect((await env.ctx.db.query.platformAiConnections.findFirst({ where: eq(platformAiConnections.id, saved.body.id) }))!.secretsEnc).toBe(row!.secretsEnc);
    expect((await owner.del('/api/platform/ai/' + saved.body.id)).status).toBe(409);
    await owner.put('/api/platform/ai/' + saved.body.id, { provider: 'openai', name: 'IA global', model: 'modelo-teste', enabled: false });
    await expect(providers.ai.complete(office.officeId, { system: 's', messages: [] })).rejects.toThrow(/desativada/);
    expect((await office.api.get('/api/ai/platform-status')).body.available).toBe(false);
    await owner.put('/api/platform/ai-default', { id: null });
  });
  it('ignora chaves legadas do escritório e restringe URLs e acesso local', async () => {
    await env.ctx.db.insert(integrations).values({ officeId: office.officeId, provider: 'ai', enabled: true, secretsEnc: env.ctx.secrets.encryptJson({ apiKey: 'legada-proibida' }) });
    await expect(createProviders({ ...env.ctx, config: { ...env.ctx.config, ANTHROPIC_API_KEY: undefined } }).ai.complete(office.officeId, { system: 's', messages: [] })).rejects.toThrow(/plataforma não está configurada/);
    for (const baseUrl of ['http://localhost:3333', 'https://169.254.169.254', 'https://10.0.0.1', 'https://user:senha@exemplo.com']) {
      expect((await owner.post('/api/platform/ai', { provider: 'compatible', name: 'Teste', model: 'teste', apiKey: 'secret', baseUrl })).status, baseUrl).toBe(400);
    }
    const ollama = await owner.post('/api/platform/ai', { provider: 'ollama', name: 'Local', model: 'modelo-local', baseUrl: 'http://169.254.169.254' });
    expect(ollama.status).toBe(201); expect(ollama.body.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });
  it('testa uma conexão com pedido mínimo e auditoria sem conteúdo nem segredo', async () => {
    const c = await owner.post('/api/platform/ai', { provider: 'gemini', name: 'Google', model: 'teste', apiKey: 'google-secret' });
    env.providers.fetch = (async (_url, init) => {
      expect(JSON.parse(String(init?.body)).contents[0].parts[0].text).toBe('Responda apenas: conexão disponível.');
      return Response.json({ candidates: [{ content: { parts: [{ text: 'conexão disponível.' }] } }] });
    }) as typeof fetch;
    const test = await owner.post('/api/platform/ai/' + c.body.id + '/test');
    expect(test.body.ok).toBe(true);
    expect((await env.ctx.db.query.platformAiConnections.findFirst({ where: eq(platformAiConnections.id, c.body.id) }))?.status).toBe('connected');
    env.providers.fetch = (async () => Response.json({ error: 'google-secret' }, { status: 401 })) as typeof fetch;
    expect((await owner.post('/api/platform/ai/' + c.body.id + '/test')).body).toMatchObject({ ok: false });
    expect(JSON.stringify(await env.ctx.db.select().from(platformAuditLogs))).not.toContain('google-secret');
  });
  it('revoga sessões imediatamente ao desativar uma conta ou sair', async () => {
    expect((await owner.put('/api/platform/users/' + ownerId + '/active', { isActive: false })).status).toBe(400);
    expect((await owner.put('/api/platform/users/' + developerId + '/active', { isActive: false })).status).toBe(200);
    expect((await developer.get('/api/platform/me')).status).toBe(401);
    expect((await owner.post('/api/platform/logout')).status).toBe(200);
    expect((await owner.get('/api/platform/me')).status).toBe(401);
  });
});

const connection = (provider: string): ResolvedConnection => ({
  id: 'teste', provider, name: 'IA', model: 'modelo', baseUrl: AI_PROVIDERS.find((p) => p.key === provider)!.baseUrl || 'https://exemplo.com/v1',
  apiKey: 'secret', supportsImages: true, enabled: true, secretsEnc: null, lastTestAt: null, status: 'configured', updatedAt: new Date(),
});
describe('formatos das APIs de IA', () => {
  it.each(AI_PROVIDERS.filter((p) => p.protocol === 'chat').map((p) => p.key))('%s envia conversa, imagem e texto no protocolo compatível', async (key) => {
    const c = connection(key); const request = requestFor(c, { system: 's', messages: [{ role: 'user', content: 'oi', files: [
      { filename: 'a.png', mimeType: 'image/png', data: Buffer.from('png') },
      { filename: 'a.csv', mimeType: 'text/csv', data: Buffer.from('a;b') },
    ] }] });
    expect(request.path).toBe('/chat/completions');
    expect(request.body).toMatchObject({ model: 'modelo', messages: [{ role: 'system', content: 's' }, { role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } }, { type: 'text', text: 'a.csv\na;b' }, { type: 'text', text: 'oi' },
    ] }] });
    const reply = await completeConnection(c, { system: 's', messages: [] }, (async () => Response.json({ choices: [{ message: { content: 'resposta' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } })) as typeof fetch);
    expect(reply).toEqual({ text: 'resposta', inputTokens: 4, outputTokens: 2 });
    expect(() => requestFor(c, { system: 's', messages: [{ role: 'user', content: 'oi', files: [{ filename: 'a.pdf', mimeType: 'application/pdf', data: Buffer.from('pdf') }] }] })).toThrow(/não lê este anexo/);
  });
  it('OpenAI usa Responses sem armazenamento, com PDF e histórico; Gemini usa inlineData e papel model', async () => {
    const input = { system: 's', messages: [{ role: 'assistant' as const, content: 'anterior' }, { role: 'user' as const, content: 'oi', files: [{ filename: 'a.pdf', mimeType: 'application/pdf', data: Buffer.from('pdf') }] }] };
    const openai = requestFor(connection('openai'), input);
    expect(openai.path).toBe('/responses');
    expect(openai.body).toMatchObject({ store: false, instructions: 's', input: [{ role: 'assistant', content: 'anterior' },
      { role: 'user', content: [{ type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,cGRm' }, { type: 'input_text', text: 'oi' }] }] });
    const gemini = requestFor(connection('gemini'), input);
    expect(gemini.body).toMatchObject({ contents: [{ role: 'model', parts: [{ text: 'anterior' }] }, { role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: 'cGRm' } }, { text: 'oi' }] }] });
    const response = await completeConnection(connection('gemini'), input, (async () => Response.json({ candidates: [{ content: { parts: [{ text: 'pensamento privado', thought: true }, { text: 'Resposta' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } })) as typeof fetch);
    expect(response).toEqual({ text: 'Resposta', inputTokens: 9, outputTokens: 3 });
  });
  it('não expõe erro remoto, aceita resposta vazia nem troca o serviço para ignorar anexos', async () => {
    await expect(completeConnection(connection('openai'), { system: 's', messages: [] }, (async () => Response.json({ error: { message: 'secret CPF' } }, { status: 401 })) as typeof fetch)).rejects.toThrow('A chave de IA é inválida');
    await expect(completeConnection(connection('deepseek'), { system: 's', messages: [] }, (async () => Response.json({ choices: [] })) as typeof fetch)).rejects.toThrow(/resposta utilizável/);
    const c = { ...connection('groq'), supportsImages: false };
    expect(() => requestFor(c, { system: 's', messages: [{ role: 'user', content: '', files: [{ filename: 'a.png', mimeType: 'image/png', data: Buffer.from('x') }] }] })).toThrow(/não lê este anexo/);
    await expect(completeConnection(connection('gemini'), { system: 's', messages: [] }, (async () => Response.json({
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Resposta pela metade' }] } }],
    })) as typeof fetch)).rejects.toThrow(/não concluiu/);
    await expect(completeConnection(connection('openrouter'), { system: 's', messages: [] }, (async () => Response.json({
      choices: [{ finish_reason: 'content_filter', message: { content: 'Resposta interrompida' } }],
    })) as typeof fetch)).rejects.toThrow(/não concluiu/);
  });
});
