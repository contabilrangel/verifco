import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upload } from '../src/api';
import { DEFAULT_CONFIG, type SyncConfig } from '../src/config';
import { Syncer } from '../src/engine';
import { SyncState } from '../src/state';

const cfg: SyncConfig = { ...DEFAULT_CONFIG, apiUrl: 'https://verifco.test', token: 'vfk_teste' };
const realFetch = globalThis.fetch;
const dirs: string[] = [];

/** Troca o fetch por um que guarda o formulário enviado e responde como a API. */
function captureFetch() {
  const sent: { url: string; form: FormData }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), form: init?.body as FormData });
    return new Response(JSON.stringify({ duplicate: false, customer: { id: 'c1', name: 'Maria' }, year: 2026 }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('upload envia a data do arquivo em modificadoEm (ISO 8601) para /sync/files', async () => {
  const sent = captureFetch();
  const modifiedAt = new Date('2026-05-20T01:30:00.000Z');
  await upload(cfg, { destination: 'files', data: Buffer.from('r'), name: 'a.REC', path: '/x/a.REC', cpf: '52998224725', year: 2026, type: 'rec', modifiedAt });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://verifco.test/api/sync/files');
  assert.equal(sent[0].form.get('modificadoEm'), '2026-05-20T01:30:00.000Z');
  assert.equal(sent[0].form.get('tipo'), 'rec');
});

test('upload sem data válida, ou para as pré-preenchidas, não envia modificadoEm', async () => {
  const sent = captureFetch();
  await upload(cfg, { destination: 'files', data: Buffer.from('r'), name: 'a.REC', path: '/x/a.REC' });
  await upload(cfg, { destination: 'files', data: Buffer.from('r'), name: 'a.REC', path: '/x/a.REC', modifiedAt: new Date('x') });
  await upload(cfg, { destination: 'prefilled', data: Buffer.from('p'), name: 'p.pdf', path: '/x/p.pdf', modifiedAt: new Date() });
  assert.deepEqual(
    sent.map((s) => s.form.has('modificadoEm')),
    [false, false, false],
  );
});

test('o sincronizador envia a data de modificação (mtime) do .REC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verifco-sync-'));
  dirs.push(dir);
  const file = join(dir, '52998224725-IRPF-A-2026-2025-ORIGI.REC');
  writeFileSync(file, 'recibo');
  const mtime = new Date('2026-05-20T23:45:10.000Z');
  utimesSync(file, mtime, mtime);

  const sent = captureFetch();
  const syncer = new Syncer({ ...cfg, folders: [dir] }, new SyncState(join(dir, '.dados')));
  await syncer.enqueue(file);
  assert.equal(syncer.stats.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].form.get('modificadoEm'), mtime.toISOString());
  assert.equal(sent[0].form.get('cpf'), '52998224725');
});
