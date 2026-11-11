import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncState, migrateState, stateKey } from '../src/state';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'verifco-sync-state-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = { path: '/irpf/a.DEC', sentAt: '2026-05-01T12:00:00.000Z', result: 'enviado' as const, customer: 'Maria', year: 2026 };

test('o mesmo conteúdo é controlado por destino (hash + destino)', () => {
  const state = new SyncState(tmp());
  assert.equal(state.has('files', 'abc'), false);
  state.mark('files', 'abc', entry);
  assert.equal(state.has('files', 'abc'), true);
  assert.equal(state.has('prefilled', 'abc'), false);
  assert.equal(state.has('inbox', 'abc'), false);
  state.mark('prefilled', 'abc', { ...entry, path: '/pre/a.DEC' });
  state.mark('inbox', 'def', { ...entry, result: 'caixa de entrada', reason: 'sem_cpf' });
  assert.equal(state.count, 3);
  assert.equal(state.countOf('files'), 1);
  assert.equal(state.countOf('inbox'), 1);
  assert.deepEqual(Object.keys(state.sent).sort(), ['files:abc', 'inbox:def', 'prefilled:abc']);
});

test('migra o state.json da versão 1 (chave só com o hash) deduzindo o destino pela pasta', () => {
  const v1 = { version: 1, sent: { h1: entry, h2: { ...entry, path: '/pre/b.DEC', result: 'já existia' } } };
  const { sent, migrated } = migrateState(v1, (path) => (path.startsWith('/pre/') ? 'prefilled' : 'files'));
  assert.equal(migrated, true);
  assert.deepEqual(Object.keys(sent).sort(), ['files:h1', 'prefilled:h2']);
  assert.equal(sent['files:h1'].destination, 'files');
  assert.equal(sent['files:h1'].customer, 'Maria');
  assert.equal(sent['prefilled:h2'].destination, 'prefilled');
  // sem saber as pastas, tudo conta como documento do cliente
  assert.deepEqual(Object.keys(migrateState(v1).sent).sort(), ['files:h1', 'files:h2']);
});

test('o formato atual passa sem alteração e conteúdo estranho vira estado vazio', () => {
  const v2 = { version: 2, sent: { [stateKey('inbox', 'h9')]: { ...entry, destination: 'inbox', result: 'caixa de entrada' } } };
  const { sent, migrated } = migrateState(v2);
  assert.equal(migrated, false);
  assert.deepEqual(sent, v2.sent);
  assert.deepEqual(migrateState(null), { sent: {}, migrated: false });
  assert.deepEqual(migrateState({ sent: 'x' }).sent, {});
});

test('SyncState converte o arquivo antigo ao abrir e grava no formato novo', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, sent: { h1: entry } }));
  const state = new SyncState(dir);
  assert.equal(state.has('files', 'h1'), true);
  assert.equal(state.has('prefilled', 'h1'), false);
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.deepEqual(Object.keys(saved.sent), ['files:h1']);
  // reabrir não muda nada
  assert.deepEqual(new SyncState(dir).sent, state.sent);

  writeFileSync(join(dir, 'state.json'), '{ quebrado');
  assert.equal(new SyncState(dir).count, 0);
});
