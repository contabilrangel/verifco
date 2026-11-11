import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { REARM_BACKOFF, STARTUP_BACKOFF, TRANSIENT_BACKOFF, WAITING_BACKOFF, backoffDelay, formatDelay } from '../src/backoff';
import { ApiError } from '../src/api';
import { DEFAULT_CONFIG, type SyncConfig } from '../src/config';
import { connectWithBackoff } from '../src/engine';

const cfg: SyncConfig = { ...DEFAULT_CONFIG, apiUrl: 'https://verifco.test', token: 'vfk_teste' };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a espera dobra a cada tentativa até o teto', () => {
  const s = (n: number) => backoffDelay(n, STARTUP_BACKOFF) / 1000;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 50, 5000].map(s), [5, 10, 20, 40, 80, 160, 300, 300, 300, 300]);
  assert.equal(backoffDelay(-3, STARTUP_BACKOFF), 5_000);
  assert.equal(backoffDelay(Number.NaN, STARTUP_BACKOFF), 5_000);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => backoffDelay(n, TRANSIENT_BACKOFF) / 60_000), [1, 2, 4, 8, 15, 15]);
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => backoffDelay(n, WAITING_BACKOFF) / 60_000), [15, 30, 60, 120, 120]);
  assert.deepEqual([0, 1, 4, 9].map((n) => backoffDelay(n, REARM_BACKOFF) / 1000), [30, 60, 300, 300]);
});

test('formata a espera para o log', () => {
  assert.equal(formatDelay(5_000), '5 segundos');
  assert.equal(formatDelay(1_000), '1 segundo');
  assert.equal(formatDelay(60_000), '1 minuto');
  assert.equal(formatDelay(15 * 60_000), '15 minutos');
  assert.equal(formatDelay(2 * 60 * 60_000), '2 horas');
});

test('ao iniciar sem rede, insiste com espera crescente até conectar', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= 3) throw new TypeError('fetch failed');
    if (calls === 4) return new Response('{"error":"Indisponível"}', { status: 503 });
    return new Response(JSON.stringify({ office: { name: 'Escritório' }, token: { name: 'pc', scope: 'sync' } }), { status: 200 });
  }) as typeof fetch;
  const waits: number[] = [];
  const who = await connectWithBackoff(cfg, async (ms) => void waits.push(ms));
  assert.equal(who.office.name, 'Escritório');
  assert.equal(calls, 5);
  assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000]);
});

test('ao iniciar, token recusado (401/403) é definitivo', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{"error":"Token inválido"}', { status });
    }) as typeof fetch;
    const waits: number[] = [];
    await assert.rejects(
      connectWithBackoff(cfg, async (ms) => void waits.push(ms)),
      (err: unknown) => err instanceof ApiError && err.status === status,
    );
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  }
});
