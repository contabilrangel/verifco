import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type SyncConfig } from '../src/config';
import { Syncer } from '../src/engine';
import { classifyFile } from '../src/identify';
import { planFile } from '../src/routing';
import { SyncState } from '../src/state';
import { irpfHeader } from './helpers';

const MIN = 60_000;
const realFetch = globalThis.fetch;
const dirs: string[] = [];
const syncers: Syncer[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const s of syncers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Reply = { status: number; body?: unknown };

/** API de mentira: guarda os pedidos e responde conforme `reply` (por rota: files, prefilled, inbox). */
function fakeApi(reply: (route: string, form: FormData) => Reply) {
  const calls: { route: string; form: FormData }[] = [];
  const api = { calls, reply, routes: () => calls.map((c) => c.route) };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).split('/api/sync/')[1];
    const form = init?.body as FormData;
    calls.push({ route, form });
    const r = api.reply(route, form);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return api;
}

const ok = (route: string): Reply => (route === 'inbox' ? { status: 201, body: { id: 'i1', duplicate: false } } : { status: 201, body: { duplicate: false, customer: { id: 'c1', name: 'Maria' }, year: 2026 } });
const notRegistered: Reply = { status: 404, body: { error: 'Cliente com CPF/CNPJ 52998224725 não encontrado.' } };

/** Pastas temporárias (declarações e pré-preenchidas) e um sincronizador com relógio controlado. */
function setup(overrides: Partial<SyncConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verifco-sync-engine-'));
  dirs.push(root);
  const folder = join(root, 'declaracoes');
  const pre = join(root, 'pre');
  mkdirSync(folder);
  mkdirSync(pre);
  const cfg: SyncConfig = { ...DEFAULT_CONFIG, apiUrl: 'https://verifco.test', token: 'vfk_teste', useDefaultFolders: false, folders: [folder], prefilledFolders: [pre], debounceMs: 20, ...overrides };
  const clock = { t: Date.parse('2026-05-01T12:00:00Z') };
  const fatal: number[] = [];
  const state = new SyncState(join(root, 'dados'));
  const syncer = new Syncer(cfg, state, (e) => void fatal.push(e.status), { now: () => clock.t, rearm: { baseMs: 20, maxMs: 40 } });
  syncers.push(syncer);
  const write = (dir: string, name: string, content: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  return { root, folder, pre, cfg, clock, fatal, state, syncer, write };
}

const DEC = '52998224725-IRPF-A-2026-2025-ORIGI.DEC';

// ---------------------------------------------------------------- decisões (sem rede)

test('decisão: identificado vai para o cliente ou para as pré-preenchidas', () => {
  assert.deepEqual(planFile(classifyFile(`/irpf/${DEC}`)), { action: 'upload', destination: 'files' });
  assert.deepEqual(planFile(classifyFile(`/pre/${DEC}`, { prefilledFolders: ['/pre'] })), { action: 'upload', destination: 'prefilled' });
  assert.deepEqual(planFile(classifyFile('/irpf/renomeado.DEC', { header: irpfHeader(2026, '52998224725') })), { action: 'upload', destination: 'files' });
});

test('decisão: o que não dá para identificar vai para a caixa de entrada (sem_cpf) ou só para o log', () => {
  const mismatch = planFile(classifyFile('/irpf/11144477735-IRPF-A-2026-2025-ORIGI.DEC', { header: irpfHeader(2026, '52998224725') }));
  assert.equal(mismatch.action, 'inbox');
  assert.ok(mismatch.action === 'inbox' && mismatch.reason === 'sem_cpf' && mismatch.cpf === null && mismatch.year === 2026);
  assert.ok(mismatch.action === 'inbox' && /diferente do CPF do conteúdo/.test(mismatch.why));

  const semCpf = planFile(classifyFile('/p/IRPF2026/declaracao.DEC'));
  assert.deepEqual(semCpf, { action: 'inbox', reason: 'sem_cpf', why: 'CPF não identificado no nome do arquivo', cpf: null, year: 2026 });
  assert.equal(planFile(classifyFile('/p/copia.DBK')).action, 'inbox');
  assert.equal(planFile(classifyFile('/p/recibo.REC')).action, 'inbox');

  // PDF e XML sem CPF no nome (ajuda e tabelas do próprio programa): só no log
  assert.deepEqual(planFile(classifyFile('/p/IRPF2026/help/ajuda.pdf')), { action: 'skip', why: 'CPF não identificado no nome do arquivo' });
  assert.equal(planFile(classifyFile('/p/IRPF2026/tabelas.xml')).action, 'skip');
  // …a não ser numa pasta de pré-preenchidas, onde tudo é do escritório
  assert.equal(planFile(classifyFile('/pre/informe.pdf', { prefilledFolders: ['/pre'] })).action, 'inbox');

  const semAno = planFile(classifyFile('/docs/52998224725 informe.pdf'));
  assert.ok(semAno.action === 'inbox' && semAno.reason === 'sem_cpf' && semAno.cpf === '52998224725' && semAno.year === null);
});

// ---------------------------------------------------------------- envios

test('o mesmo conteúdo copiado para a pasta das pré-preenchidas é enviado também para lá', async () => {
  const t = setup();
  const api = fakeApi(ok);
  const a = t.write(t.folder, DEC, 'conteudo');
  await t.syncer.enqueue(a);
  const b = t.write(t.pre, DEC, 'conteudo');
  await t.syncer.enqueue(b);
  assert.deepEqual(api.routes(), ['files', 'prefilled']);
  assert.equal(t.state.count, 2);
  // nada é reenviado nas varreduras seguintes
  await t.syncer.scan([t.folder, t.pre], { quiet: true });
  assert.deepEqual(api.routes(), ['files', 'prefilled']);
  assert.equal(t.syncer.stats.sent, 2);
  assert.equal(t.syncer.stats.known, 2);
});

test('cliente não cadastrado: vai uma vez para a caixa de entrada e o envio é tentado de novo com espera', async () => {
  const t = setup();
  const api = fakeApi((route) => (route === 'files' ? notRegistered : ok(route)));
  const file = t.write(t.folder, DEC, 'conteudo');
  await t.syncer.scan([t.folder], { quiet: true });
  assert.deepEqual(api.routes(), ['files', 'inbox']);
  const inbox = api.calls[1].form;
  assert.equal(inbox.get('motivo'), 'cliente_nao_cadastrado');
  assert.equal(inbox.get('cpf'), '52998224725');
  assert.equal(inbox.get('ano'), '2026');
  assert.equal(inbox.get('caminho'), file);
  assert.equal((inbox.get('file') as File).name, DEC);
  assert.equal(t.state.has('inbox', Object.keys(t.state.sent)[0].split(':')[1]), true);
  assert.equal(t.syncer.pendingCount, 1);

  // dentro da espera (15 min), nem a varredura periódica nem o temporizador reenviam
  t.clock.t += 10 * MIN;
  await t.syncer.scan([t.folder], { quiet: true });
  t.syncer.retryPending();
  await t.syncer.idle();
  assert.equal(api.calls.length, 2);

  // vencida a espera: tenta o envio de novo, sem repetir a caixa de entrada; a espera dobra
  t.clock.t += 6 * MIN;
  t.syncer.retryPending();
  await t.syncer.idle();
  assert.deepEqual(api.routes(), ['files', 'inbox', 'files']);
  t.clock.t += 20 * MIN;
  await t.syncer.scan([t.folder], { quiet: true });
  assert.equal(api.calls.length, 3);

  // o cliente foi cadastrado: a próxima tentativa envia e encerra a pendência
  api.reply = ok;
  t.clock.t += 11 * MIN;
  await t.syncer.scan([t.folder], { quiet: true });
  assert.deepEqual(api.routes(), ['files', 'inbox', 'files', 'files']);
  assert.equal(t.syncer.pendingCount, 0);
  assert.equal(t.syncer.stats.sent, 1);
  assert.equal(t.syncer.stats.inbox, 1);
  assert.equal(t.state.count, 2);
});

test('CPF do nome diferente do conteúdo: só a caixa de entrada (sem_cpf), nunca /sync/files', async () => {
  const t = setup();
  const api = fakeApi(ok);
  t.write(t.folder, '11144477735-IRPF-A-2026-2025-ORIGI.DEC', irpfHeader(2026, '52998224725'));
  await t.syncer.scan([t.folder], { quiet: true });
  await t.syncer.scan([t.folder], { quiet: true });
  assert.deepEqual(api.routes(), ['inbox']);
  assert.equal(api.calls[0].form.get('motivo'), 'sem_cpf');
  assert.equal(api.calls[0].form.has('cpf'), false);
  assert.equal(api.calls[0].form.get('ano'), '2026');
  assert.equal(t.state.countOf('inbox'), 1);
  assert.equal(t.state.countOf('files'), 0);
});

test('arquivo renomeado é identificado pelo cabeçalho; não identificado vai para a caixa de entrada', async () => {
  const t = setup();
  const api = fakeApi(ok);
  t.write(t.folder, 'a - maria.DEC', irpfHeader(2026, '52998224725'));
  t.write(t.folder, 'b - sem nada.DEC', 'conteudo sem cabecalho');
  t.write(t.folder, 'c - manual.pdf', '%PDF-1.7');
  await t.syncer.scan([t.folder], { quiet: true });
  assert.deepEqual(api.routes().sort(), ['files', 'inbox']);
  const files = api.calls.find((c) => c.route === 'files')!.form;
  assert.equal(files.get('cpf'), '52998224725');
  assert.equal(files.get('ano'), '2026');
  assert.equal(api.calls.find((c) => c.route === 'inbox')!.form.get('motivo'), 'sem_cpf');
  assert.equal(t.syncer.stats.skipped, 1);
});

test('servidor sem caixa de entrada (404/405): fica só no log e não insiste até a próxima conferência de versão', async () => {
  for (const status of [404, 405]) {
    const t = setup();
    const api = fakeApi((route) => (route === 'inbox' ? { status, body: { error: 'Not Found' } } : ok(route)));
    t.write(t.folder, 'sem-cpf-1.DEC', 'um');
    t.write(t.folder, 'sem-cpf-2.DEC', 'dois');
    await t.syncer.scan([t.folder], { quiet: true });
    assert.deepEqual(api.routes(), ['inbox']); // o segundo arquivo nem tenta
    t.clock.t += 24 * 60 * MIN;
    await t.syncer.scan([t.folder], { quiet: true });
    t.syncer.retryPending();
    await t.syncer.idle();
    assert.equal(api.calls.length, 1);
    assert.equal(t.syncer.pendingCount, 0);
    assert.equal(t.state.count, 0);

    // conferência de versão feita (servidor atualizado): volta a tentar
    api.reply = ok;
    t.syncer.resetInbox();
    await t.syncer.scan([t.folder], { quiet: true });
    assert.deepEqual(api.routes(), ['inbox', 'inbox', 'inbox']);
    assert.equal(t.state.countOf('inbox'), 2);
  }
});

test('--sem-caixa-de-entrada: nada vai para a caixa de entrada', async () => {
  const t = setup({ inbox: false });
  const api = fakeApi((route) => (route === 'files' ? notRegistered : ok(route)));
  t.write(t.folder, DEC, 'conteudo');
  t.write(t.folder, 'sem-cpf.DEC', 'outro');
  await t.syncer.scan([t.folder], { quiet: true });
  assert.deepEqual(api.routes(), ['files']);
  assert.equal(t.syncer.stats.inbox, 0);
  assert.equal(t.syncer.stats.skipped, 1);
});

test('erro do servidor ou de conexão: nova tentativa em 1 minuto, depois 2…', async () => {
  const t = setup();
  let down = true;
  const api = fakeApi((route) => (down ? { status: 503, body: { error: 'Indisponível' } } : ok(route)));
  t.write(t.folder, DEC, 'conteudo');
  await t.syncer.scan([t.folder], { quiet: true });
  assert.equal(api.calls.length, 1);
  assert.equal(t.syncer.stats.failed, 1);
  t.clock.t += MIN - 1;
  t.syncer.retryPending();
  await t.syncer.idle();
  assert.equal(api.calls.length, 1);
  t.clock.t += 1;
  t.syncer.retryPending();
  await t.syncer.idle();
  assert.equal(api.calls.length, 2);
  t.clock.t += MIN; // a segunda espera é de 2 minutos
  t.syncer.retryPending();
  await t.syncer.idle();
  assert.equal(api.calls.length, 2);
  down = false;
  t.clock.t += MIN;
  t.syncer.retryPending();
  await t.syncer.idle();
  assert.equal(api.calls.length, 3);
  assert.equal(t.syncer.stats.sent, 1);
  assert.equal(t.syncer.pendingCount, 0);
});

test('arquivo recusado (400/422) é tentado de novo pela varredura periódica; conteúdo alterado é enviado na hora', async () => {
  const t = setup();
  const api = fakeApi(() => ({ status: 422, body: { error: 'CPF não identificado' } }));
  const file = t.write(t.folder, DEC, 'conteudo');
  await t.syncer.scan([t.folder], { quiet: true });
  await t.syncer.scan([t.folder], { quiet: true });
  assert.deepEqual(api.routes(), ['files']);
  t.clock.t += 15 * MIN;
  await t.syncer.scan([t.folder], { quiet: true });
  assert.deepEqual(api.routes(), ['files', 'files']);
  // arquivo regravado com outro conteúdo: não espera
  api.reply = ok;
  writeFileSync(file, 'conteudo novo, maior');
  await t.syncer.enqueue(file);
  assert.equal(api.calls.length, 3);
  assert.equal(t.syncer.stats.sent, 1);
});

test('token recusado (401/403) continua definitivo e a fila não segue', async () => {
  const t = setup();
  const api = fakeApi(() => ({ status: 401, body: { error: 'Token revogado' } }));
  t.write(t.folder, DEC, 'conteudo');
  t.write(t.folder, '11144477735-IRPF-A-2026-2025-ORIGI.DEC', 'outro');
  await t.syncer.scan([t.folder], { quiet: true });
  assert.equal(api.calls.length, 1);
  assert.equal(t.syncer.fatal?.status, 401);
  assert.deepEqual(t.fatal, [401]);
});

test('falha ao gravar o controle depois do envio: a fila segue e o arquivo é tentado de novo', async () => {
  const t = setup();
  const api = fakeApi(ok);
  const mark = t.state.mark.bind(t.state);
  let first = true;
  t.state.mark = (...args: Parameters<SyncState['mark']>) => {
    if (first) {
      first = false;
      throw new Error('disco cheio');
    }
    mark(...args);
  };
  t.write(t.folder, DEC, 'conteudo');
  t.write(t.folder, '11144477735-IRPF-A-2026-2025-ORIGI.DEC', 'outro');
  await t.syncer.scan([t.folder], { quiet: true });
  assert.equal(api.calls.length, 2);
  assert.equal(t.state.count, 1);
  assert.equal(t.syncer.pendingCount, 1);
  // o que não ficou registrado é reenviado depois da espera (a API reconhece o repetido)
  t.clock.t += MIN;
  t.syncer.retryPending();
  await t.syncer.idle();
  assert.equal(api.calls.length, 3);
  assert.equal(t.state.count, 2);
});

test('uma falha inesperada num arquivo não derruba a fila', async () => {
  const t = setup();
  const api = fakeApi(ok);
  const inner = t.syncer as unknown as { process: (path: string) => Promise<void> };
  const real = inner.process.bind(t.syncer);
  let first = true;
  inner.process = async (path) => {
    if (first) {
      first = false;
      throw new Error('EBUSY: arquivo em uso');
    }
    return real(path);
  };
  await t.syncer.enqueue(t.write(t.folder, DEC, 'conteudo'));
  await t.syncer.enqueue(t.write(t.folder, '11144477735-IRPF-A-2026-2025-ORIGI.DEC', 'outro'));
  assert.equal(api.calls.length, 1);
  assert.equal(t.syncer.stats.sent, 1);
});

// ---------------------------------------------------------------- observador

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

test('erro do observador: a pasta volta a ser observada e o que mudou no intervalo é enviado', async () => {
  const t = setup();
  const api = fakeApi(ok);
  t.syncer.watch([t.folder]);
  assert.equal(t.syncer.watching(t.folder), true);
  const watcher = (t.syncer as unknown as { watchers: Map<string, EventEmitter> }).watchers.get(t.folder)!;
  watcher.emit('error', new Error('EPERM: operação não permitida'));
  assert.equal(t.syncer.watching(t.folder), false);
  t.write(t.folder, DEC, 'gravado enquanto a pasta estava sem observação');
  assert.ok(await waitFor(() => t.syncer.watching(t.folder)), 'a pasta deveria voltar a ser observada');
  assert.ok(await waitFor(() => api.calls.length === 1), 'o arquivo gravado no intervalo deveria ser enviado');
  // e o observador novo funciona
  t.write(t.folder, '11144477735-IRPF-A-2026-2025-ORIGI.DEC', 'outro');
  assert.ok(await waitFor(() => api.calls.length === 2), 'alterações novas deveriam ser enviadas');
});

test('pasta que some: o sincronizador segue tentando observar até ela voltar', async () => {
  const t = setup();
  fakeApi(ok);
  const later = join(t.root, 'depois');
  t.syncer.watch([later]);
  assert.equal(t.syncer.watching(later), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t.syncer.watching(later), false);
  mkdirSync(later);
  assert.ok(await waitFor(() => t.syncer.watching(later)));
});
