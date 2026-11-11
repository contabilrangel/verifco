import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOG_KEEP, LOG_MAX_BYTES, rotateIfNeeded, rotateLog } from '../src/log';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpLog = () => {
  const d = mkdtempSync(join(tmpdir(), 'verifco-sync-log-'));
  dirs.push(d);
  return join(d, 'sync.log');
};
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

test('limites da rotação: ~5 MB e 3 arquivos anteriores', () => {
  assert.equal(LOG_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(LOG_KEEP, 3);
});

test('só rotaciona ao atingir o tamanho', () => {
  const log = tmpLog();
  assert.equal(rotateIfNeeded(log, 10), false); // ainda não existe
  writeFileSync(log, '123456789');
  assert.equal(rotateIfNeeded(log, 10), false);
  assert.equal(read(log), '123456789');
  writeFileSync(log, '1234567890');
  assert.equal(rotateIfNeeded(log, 10), true);
  assert.equal(read(log), null);
  assert.equal(read(`${log}.1`), '1234567890');
});

test('mantém os 3 últimos arquivos e descarta o mais antigo', () => {
  const log = tmpLog();
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    writeFileSync(log, n);
    rotateLog(log);
  }
  assert.equal(read(log), null);
  assert.equal(read(`${log}.1`), 'e');
  assert.equal(read(`${log}.2`), 'd');
  assert.equal(read(`${log}.3`), 'c');
  assert.equal(read(`${log}.4`), null);
});
