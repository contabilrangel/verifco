import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { sendInbox, upload, whoami } from '../src/api';
import { DEFAULT_CONFIG, type SyncConfig } from '../src/config';
import { VERSION, clientHeader, compareVersions, updateNotice } from '../src/version';

const cfg: SyncConfig = { ...DEFAULT_CONFIG, apiUrl: 'https://verifco.test/api/', token: 'vfk_teste' };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a versão vem do package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.equal(VERSION, '0.3.0');
  assert.equal(clientHeader('0.3.0', 'win32'), 'sync/0.3.0 (win32)');
  assert.equal(clientHeader(), `sync/${VERSION} (${process.platform})`);
});

test('todo pedido leva X-Verifco-Client e o token', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify({ office: { name: 'E' }, token: { name: 't', scope: 'sync' }, duplicate: false, id: 'i1' }), { status: 200 });
  }) as typeof fetch;
  await whoami(cfg);
  await upload(cfg, { destination: 'files', data: Buffer.from('a'), name: 'a.DEC', path: '/a.DEC' });
  await upload(cfg, { destination: 'prefilled', data: Buffer.from('a'), name: 'a.DEC', path: '/a.DEC' });
  await sendInbox(cfg, { data: Buffer.from('a'), name: 'a.DEC', path: '/a.DEC', reason: 'sem_cpf' });
  assert.deepEqual(
    seen.map((s) => s.url),
    ['https://verifco.test/api/sync/whoami', 'https://verifco.test/api/sync/files', 'https://verifco.test/api/sync/prefilled', 'https://verifco.test/api/sync/inbox'],
  );
  for (const s of seen) {
    assert.equal(s.headers['X-Verifco-Client'], `sync/${VERSION} (${process.platform})`);
    assert.equal(s.headers.Authorization, 'Bearer vfk_teste');
  }
});

test('compara versões', () => {
  assert.ok(compareVersions('0.2.0', '0.3.0') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.0', '1.0.1') < 0);
});

test('aviso de atualização: nada quando o servidor não informa ou a versão está em dia', () => {
  assert.equal(updateNotice(undefined), null);
  assert.equal(updateNotice(null), null);
  assert.equal(updateNotice({}), null);
  assert.equal(updateNotice({ latest: '0.3.0', minSupported: '0.2.0', updateAvailable: false, unsupported: false }, '0.3.0'), null);
});

test('aviso de atualização disponível', () => {
  const n = updateNotice({ latest: '0.4.0', minSupported: '0.2.0', updateAvailable: true, unsupported: false }, '0.3.0');
  assert.equal(n?.level, 'update');
  assert.match(n!.text, /versão nova do sincronizador: 0\.4\.0 \(instalada: 0\.3\.0\)/);
  assert.match(n!.text, /Central de downloads do Verifco/);
  // sem os indicadores, compara aqui
  assert.equal(updateNotice({ latest: '0.4.0' }, '0.3.0')?.level, 'update');
  assert.equal(updateNotice({ latest: '0.3.0' }, '0.3.0'), null);
});

test('aviso de versão não aceita', () => {
  const n = updateNotice({ latest: '0.5.0', minSupported: '0.4.0', updateAvailable: true, unsupported: true }, '0.3.0');
  assert.equal(n?.level, 'unsupported');
  assert.match(n!.text, /versão 0\.3\.0 do sincronizador NÃO É MAIS ACEITA/);
  assert.match(n!.text, /mínima aceita: 0\.4\.0/);
  assert.match(n!.text, /Baixe a versão 0\.5\.0 na Central de downloads do Verifco/);
  assert.equal(updateNotice({ minSupported: '0.4.0' }, '0.3.0')?.level, 'unsupported');
});
