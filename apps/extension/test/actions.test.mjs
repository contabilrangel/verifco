// Envios (lib/actions.js) com API e histórico de teste. Rodar: node --test (em apps/extension).
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/format.js';
import '../lib/statuses.js';
import '../lib/capture.js';
import '../lib/actions.js';

const CLIENT = { cpf: '52998224725', name: 'Ana Souza' };

function setup(overrides = {}) {
  const calls = [];
  const logs = [];
  const api = {
    sendDocument: async (args) => (calls.push(['document', args]), { id: 'd1', customer: { id: 'c', name: 'Ana Souza' }, year: 2026, duplicate: false }),
    sendPrefilled: async (args) => (calls.push(['prefilled', args]), { id: 's1', customer: { id: 'c', name: 'Ana Souza' }, year: 2026, duplicate: false }),
    sendRecord: async (record) => (calls.push(['record', record]), { ok: true, recordId: 'r1' }),
    ...overrides,
  };
  const actions = globalThis.VerifcoActions.createActions({ api, log: async (entry) => void logs.push(entry) });
  return { actions, calls, logs };
}
const file = (size = 10, name = 'informe.pdf') => ({ size, name });

test('sem cliente: não chama a API nem anota', async () => {
  const { actions, calls, logs } = setup();
  const res = await actions.sendFile({ client: null, file: file() });
  assert.deepEqual(res, { ok: false, error: 'Escolha o cliente antes de enviar.' });
  assert.equal(calls.length + logs.length, 0);
});

test('sendFile: documento com ano e categoria; anota o envio', async () => {
  const { actions, calls, logs } = setup();
  const res = await actions.sendFile({ client: CLIENT, file: file(), year: '2026', category: 'darf', maxBytes: 100 });
  assert.equal(res.ok, true);
  assert.equal(res.message, 'Enviado para Ana Souza, exercício 2026.');
  assert.equal(calls[0][0], 'document');
  assert.equal(calls[0][1].cpf, '52998224725');
  assert.equal(calls[0][1].year, 2026);
  assert.equal(calls[0][1].category, 'darf');
  assert.deepEqual(logs, [{ cpf: '52998224725', name: 'Ana Souza', what: 'Arquivo: informe.pdf', ok: true, detail: 'Enviado para Ana Souza, exercício 2026.' }]);
});

test('sendFile: ano em branco é aceito no documento e exigido na pré-preenchida', async () => {
  const { actions, calls } = setup();
  assert.equal((await actions.sendFile({ client: CLIENT, file: file(), year: '' })).ok, true);
  assert.equal(calls[0][1].year, null);
  const pre = await actions.sendFile({ client: CLIENT, file: file(), year: '', prefilled: true });
  assert.deepEqual(pre, { ok: false, error: 'Informe o exercício da pré-preenchida.' });
  const ok = await actions.sendFile({ client: CLIENT, file: file(), year: 2026, prefilled: true });
  assert.equal(ok.ok, true);
  assert.equal(calls[1][0], 'prefilled');
  assert.equal((await actions.sendFile({ client: CLIENT, file: file(), year: '26' })).error, 'Informe o exercício com 4 dígitos (ex.: 2026).');
});

test('sendFile: vazio, grande demais, duplicado e erro da API', async () => {
  const { actions, calls, logs } = setup({
    sendDocument: async () => {
      throw new Error('Cliente não encontrado.');
    },
  });
  assert.equal((await actions.sendFile({ client: CLIENT, file: file(0) })).error, 'O arquivo está vazio.');
  assert.match((await actions.sendFile({ client: CLIENT, file: file(30 * 1024 * 1024), maxBytes: 25 * 1024 * 1024 })).error, /limite é 25,0 MB/);
  assert.equal(calls.length, 0);
  const res = await actions.sendFile({ client: CLIENT, file: file() });
  assert.deepEqual(res, { ok: false, error: 'Cliente não encontrado.' });
  assert.equal(logs.at(-1).ok, false);
  assert.equal(logs.at(-1).detail, 'Cliente não encontrado.');
  const dup = setup({ sendDocument: async () => ({ id: 'd', customer: { name: 'Ana Souza' }, year: 2026, duplicate: true }) });
  const again = await dup.actions.sendFile({ client: CLIENT, file: file() });
  assert.equal(again.duplicate, true);
  assert.equal(again.message, 'Já estava no Verifco (Ana Souza, 2026).');
});

test('registerPage: registro "other" com ou sem imagem', async () => {
  const { actions, calls, logs } = setup();
  const page = { title: 'Meu Imposto de Renda', url: 'https://x.gov.br/p', text: 'texto', fromSelection: false, truncated: false };
  const res = await actions.registerPage({ client: CLIENT, page });
  assert.equal(res.ok, true);
  assert.equal(res.withScreenshot, false);
  const record = calls[0][1];
  assert.equal(record.kind, 'other');
  assert.equal(record.cpf, '52998224725');
  assert.equal(record.data.title, 'Meu Imposto de Renda');
  assert.equal(record.data.text, 'texto');
  assert.equal(record.data.url, 'https://x.gov.br/p');
  assert.equal(record.file, undefined);
  assert.equal(logs[0].what, 'Página: Meu Imposto de Renda');
  const shot = { filename: 't.png', mimeType: 'image/png', base64: 'AAAA' };
  const withShot = await actions.registerPage({ client: CLIENT, page: { ...page, fromSelection: true }, screenshot: shot });
  assert.equal(withShot.withScreenshot, true);
  assert.deepEqual(calls[1][1].file, shot);
  assert.equal(logs[1].what, 'Seleção: Meu Imposto de Renda');
  const empty = await actions.registerPage({ client: CLIENT, page: { ...page, text: '  ' } });
  assert.equal(empty.error, 'Não há texto nem imagem para registrar.');
});

test('sendDeclarationStatus: registro "declaration" com ano e situação válidos', async () => {
  const { actions, calls, logs } = setup();
  const res = await actions.sendDeclarationStatus({ client: CLIENT, year: '2026', status: 'fine_mesh', receiptNumber: ' 12.34.56 ' });
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0][1], { kind: 'declaration', cpf: '52998224725', year: 2026, data: { status: 'fine_mesh', receiptNumber: '12.34.56' } });
  assert.equal(logs[0].what, 'Situação da declaração 2026: Malha fina');
  await actions.sendDeclarationStatus({ client: CLIENT, year: 2025, status: 'processed', receiptNumber: '' });
  assert.deepEqual(calls[1][1].data, { status: 'processed' });
  assert.equal((await actions.sendDeclarationStatus({ client: CLIENT, year: '', status: 'processed' })).error, 'Informe o exercício com 4 dígitos (ex.: 2026).');
  assert.equal((await actions.sendDeclarationStatus({ client: CLIENT, year: 2026, status: 'inventada' })).error, 'Escolha a situação da declaração.');
  assert.equal(calls.length, 2);
});

test('sendCnd: registro "cnd" com validade e código opcionais', async () => {
  const { actions, calls } = setup();
  const res = await actions.sendCnd({ client: CLIENT, status: 'success', validUntil: '2027-04-01', code: ' AB12.CD34 ' });
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0][1], { kind: 'cnd', cpf: '52998224725', data: { status: 'success', validUntil: '2027-04-01', code: 'AB12.CD34' } });
  await actions.sendCnd({ client: CLIENT, status: 'pending_issues', validUntil: '', code: '' });
  assert.deepEqual(calls[1][1].data, { status: 'pending_issues' });
  assert.equal((await actions.sendCnd({ client: CLIENT, status: 'success', validUntil: '01/04/2027' })).error, 'Data de validade inválida.');
  assert.equal((await actions.sendCnd({ client: CLIENT, status: '' })).error, 'Escolha a situação da CND.');
  assert.equal(calls.length, 2);
});
