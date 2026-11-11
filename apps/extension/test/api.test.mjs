// Cliente da API (lib/api.js) com um fetch de mentira. Rodar: node --test (em apps/extension).
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/format.js';
import '../lib/api.js';

const Api = globalThis.VerifcoApi;
const SETTINGS = { webUrl: 'https://app.exemplo.com.br', apiUrl: '', token: 'vfk_abcdefghijklmnopqrstuvwxyz' };

/** fetch de mentira: guarda as chamadas e responde com a fila de respostas. */
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body = null, text = null } = next ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (text !== null) throw new SyntaxError('não é JSON');
        return body;
      },
    };
  };
  return { fn, calls };
}
const make = (fetch, settings = SETTINGS) => Api.createApi({ fetch: fetch.fn, getSettings: async () => settings, version: '0.2.0' });

test('buildRequest: endereço, token e identificação da extensão', () => {
  const req = Api.buildRequest(SETTINGS, '0.2.0', '/sync/whoami', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(req.url, 'https://app.exemplo.com.br/api/sync/whoami');
  assert.deepEqual(req.init.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer vfk_abcdefghijklmnopqrstuvwxyz',
    'X-Verifco-Client': 'extension/0.2.0 (chrome)',
  });
  // endereço próprio da API tem preferência
  assert.equal(Api.buildRequest({ ...SETTINGS, apiUrl: 'https://api.exemplo.com.br/' }, '0.2.0', '/x').url, 'https://api.exemplo.com.br/api/x');
});

test('sem configuração: erro claro, sem chamar a rede', async () => {
  const fetch = fakeFetch();
  await assert.rejects(make(fetch, { webUrl: '', apiUrl: '', token: '' }).whoami(), (err) => err instanceof Api.ApiError && err.code === 'not_configured' && /Configure/.test(err.message));
  await assert.rejects(make(fetch, { ...SETTINGS, token: '' }).whoami(), /Configure/);
  assert.equal(fetch.calls.length, 0);
  assert.equal(Api.isConfigured(SETTINGS), true);
  assert.equal(Api.isConfigured({ webUrl: 'x', token: 't' }), false);
});

test('toda chamada leva X-Verifco-Client e Authorization', async () => {
  const fetch = fakeFetch(
    { body: { office: { id: 'o', name: 'E' }, token: { name: 't', scope: 'extension' } } },
    { body: [] },
    { status: 201, body: { id: 'd' } },
    { status: 201, body: { id: 'p' } },
    { body: { results: [{ index: 0, ok: true, recordId: 'r' }] } },
  );
  const api = make(fetch);
  const file = new Blob(['x'], { type: 'application/pdf' });
  await api.whoami();
  await api.customers('ana');
  await api.sendDocument({ file, filename: 'a.pdf', cpf: '52998224725' });
  await api.sendPrefilled({ file, filename: 'a.pdf', cpf: '52998224725', year: 2026 });
  await api.sendRecord({ kind: 'other', cpf: '52998224725', data: {} });
  assert.equal(fetch.calls.length, 5);
  for (const call of fetch.calls) {
    assert.equal(call.init.headers['X-Verifco-Client'], 'extension/0.2.0 (chrome)', call.url);
    assert.equal(call.init.headers.Authorization, `Bearer ${SETTINGS.token}`, call.url);
  }
});

test('whoami: com e sem o bloco client', async () => {
  const fetch = fakeFetch(
    { body: { office: { id: 'o1', name: 'Escritório' }, token: { name: 'Chrome', scope: 'extension' } } },
    { body: { office: { id: 'o1', name: 'Escritório' }, token: { name: 'Chrome', scope: 'extension' }, client: { latest: '0.3.0', minSupported: '0.2.0', updateAvailable: true, unsupported: false } } },
  );
  const api = make(fetch);
  const old = await api.whoami();
  assert.equal(old.office.name, 'Escritório');
  assert.equal(old.client, null);
  const cur = await api.whoami();
  assert.deepEqual(cur.client, { latest: '0.3.0', minSupported: '0.2.0', updateAvailable: true, unsupported: false });
});

test('erros: mensagem do servidor, padrão por status e falha de rede', async () => {
  const fetch = fakeFetch({ status: 404, body: { error: 'Cliente não encontrado.' } }, { status: 401, text: '<html>' }, { status: 500, body: {} }, new TypeError('Failed to fetch'));
  const api = make(fetch);
  await assert.rejects(api.whoami(), (err) => err instanceof Api.ApiError && err.status === 404 && err.message === 'Cliente não encontrado.');
  await assert.rejects(api.whoami(), (err) => err.status === 401 && /Token recusado/.test(err.message));
  await assert.rejects(api.whoami(), (err) => err.message === 'Erro 500 na API do Verifco.');
  await assert.rejects(api.whoami(), (err) => err.code === 'network' && err.status === 0 && /Não foi possível falar/.test(err.message));
});

test('customers: monta a busca e normaliza a lista', async () => {
  const fetch = fakeFetch({ body: [{ cpf: '529.982.247-25', name: 'Ana', procurationStatus: 'valid', hasProcurator: true }] });
  const list = await make(fetch).customers(' João & cia ', 20);
  assert.equal(fetch.calls[0].url, 'https://app.exemplo.com.br/api/sync/customers?q=Jo%C3%A3o%20%26%20cia&limit=20');
  assert.deepEqual(list, [{ cpf: '52998224725', name: 'Ana', procurationStatus: 'valid', hasProcurator: true }]);
});

test('customers: servidor antigo devolve tudo e o filtro é feito aqui', async () => {
  const legacy = [
    { cpf: '52998224725', name: 'Ana Souza', procurationStatus: 'valid', procurator: { name: 'P', cpfCnpj: '1' } },
    { cpf: '11144477735', name: 'Bruno Lima', procurationStatus: 'valid', procurator: { name: 'P', cpfCnpj: '1' } },
  ];
  const fetch = fakeFetch({ body: legacy }, { body: legacy }, { body: { error: 'x' } });
  const api = make(fetch);
  assert.deepEqual((await api.customers('bruno')).map((c) => c.name), ['Bruno Lima']);
  assert.deepEqual((await api.customers('529982')).map((c) => c.name), ['Ana Souza']);
  assert.deepEqual(await api.customers(''), []); // resposta que não é lista
});

test('sendDocument: formulário com os campos do contrato', async () => {
  const fetch = fakeFetch({ status: 201, body: { id: 'd1', customer: { id: 'c', name: 'Ana' }, year: 2026, duplicate: false } });
  const file = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
  const res = await make(fetch).sendDocument({ file, filename: 'C:\\docs\\informe.pdf', cpf: '529.982.247-25', year: 2026, category: 'income_report', origin: 'https://x.gov.br/p', title: 'Informe' });
  assert.equal(res.id, 'd1');
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://app.exemplo.com.br/api/sync/documents');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], undefined); // o navegador põe o boundary
  const form = init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('cpf'), '52998224725');
  assert.equal(form.get('ano'), '2026');
  assert.equal(form.get('categoria'), 'income_report');
  assert.equal(form.get('origem'), 'https://x.gov.br/p');
  assert.equal(form.get('titulo'), 'Informe');
  assert.equal(form.get('file').name, 'informe.pdf');
  assert.equal(form.get('file').size, 8);
});

test('sendDocument: opcionais vazios não vão; categoria padrão "other"; origem limitada', async () => {
  const fetch = fakeFetch({ status: 200, body: { id: 'd1', duplicate: true } }, { status: 200, body: {} });
  const api = make(fetch);
  await api.sendDocument({ file: new Blob(['x']), filename: 'a.txt', cpf: '52998224725' });
  const form = fetch.calls[0].init.body;
  assert.equal(form.has('ano'), false);
  assert.equal(form.has('origem'), false);
  assert.equal(form.has('titulo'), false);
  assert.equal(form.get('categoria'), 'other');
  await api.sendDocument({ file: new Blob(['x']), filename: 'a.txt', cpf: '52998224725', origin: 'x'.repeat(900), title: 't'.repeat(300) });
  assert.equal(fetch.calls[1].init.body.get('origem').length, 500);
  assert.equal(fetch.calls[1].init.body.get('titulo').length, 200);
});

test('sendPrefilled: file + cpf + ano em /sync/prefilled', async () => {
  const fetch = fakeFetch({ status: 201, body: { id: 's1', year: 2026, duplicate: false } });
  await make(fetch).sendPrefilled({ file: new Blob(['x']), filename: 'pre.dec', cpf: '52998224725', year: 2026 });
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://app.exemplo.com.br/api/sync/prefilled');
  assert.deepEqual([...init.body.keys()].sort(), ['ano', 'cpf', 'file']);
  assert.equal(init.body.get('ano'), '2026');
});

test('sendRecord: manda { records: [..] } e trata a recusa do item', async () => {
  const fetch = fakeFetch(
    { body: { results: [{ index: 0, ok: true, recordId: 'r1', duplicate: false, effects: ['cnd'] }], ok: 1, failed: 0 } },
    { body: { results: [{ index: 0, ok: false, error: 'Cliente não encontrado.', status: 404 }], ok: 0, failed: 1 } },
    { body: {} },
  );
  const api = make(fetch);
  const record = { kind: 'cnd', cpf: '52998224725', data: { status: 'success' } };
  const ok = await api.sendRecord(record);
  assert.equal(ok.recordId, 'r1');
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://app.exemplo.com.br/api/sync/ecac-records');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { records: [record] });
  await assert.rejects(api.sendRecord(record), (err) => err.message === 'Cliente não encontrado.' && err.status === 404);
  await assert.rejects(api.sendRecord(record), /Resposta inesperada/);
});
