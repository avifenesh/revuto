import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SurrealStore } from '../agents/common/src/store/surreal-store.js';
import { createSurrealFetch, retrySurrealRead, surrealErrorMessage } from '../agents/common/src/store/surreal-transport.js';

function transportFailure(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('private upstream response'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
  });
}

test('Surreal HTTP requests abort while waiting for headers', async (t) => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await assert.rejects(createSurrealFetch(25)(`http://127.0.0.1:${address.port}/rpc`), { name: 'TimeoutError' });
});

test('Surreal timeout remains active while reading the response body', { timeout: 5_000 }, async (t) => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('partial'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await createSurrealFetch(1_000)(`http://127.0.0.1:${address.port}/rpc`);
  await assert.rejects(response.text(), (err: unknown) => err instanceof Error && /abort|timeout/i.test(err.name));
});

test('each request gets a fresh deadline and keeps caller cancellation', async () => {
  const signals: AbortSignal[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    assert.ok(init?.signal);
    signals.push(init.signal);
    return new Response('{}');
  };
  const bounded = createSurrealFetch(15_000, fakeFetch);
  const first = new AbortController();
  await bounded('http://localhost/rpc', { signal: first.signal });
  await bounded('http://localhost/rpc');
  first.abort();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.notEqual(signals[0], signals[1]);
  const second = new AbortController();
  await bounded(new Request('http://localhost/rpc', { signal: second.signal }));
  second.abort();
  assert.equal(signals[2].aborted, true);
});

test('read retries recover from one transport failure and stop after three attempts', async () => {
  let calls = 0;
  assert.equal(await retrySurrealRead(async () => {
    if (++calls === 1) throw transportFailure();
    return 'cursor';
  }), 'cursor');
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(retrySurrealRead(async () => { calls++; throw transportFailure(); }));
  assert.equal(calls, 3);
});

test('read retries do not replay cancellation, auth failures, or programming errors', async () => {
  for (const error of [new DOMException('cancelled', 'AbortError'), new Error('Authentication failed'), new TypeError('invalid argument')]) {
    let calls = 0;
    await assert.rejects(retrySurrealRead(async () => { calls++; throw error; }), err => err === error);
    assert.equal(calls, 1);
  }
});

test('store retries cursor reads but never replays ambiguous mutations', async (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'revuto-transport-'));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const store = new SurrealStore(vault, 'owner/repo', { url: 'http://localhost/rpc', namespace: 'test' });
  let calls = 0;
  // Replace only the SDK transport; exercise the public store methods and their retry choices.
  Object.assign(store, { db: { query: async () => {
    if (++calls === 1) throw transportFailure();
    return [[{ val: '2026-10-02T11:00:00Z' }]];
  } } });
  assert.equal(await store.getCursor('review'), '2026-10-02T11:00:00Z');
  assert.equal(calls, 2);
  for (const mutate of [
    () => store.incrCounter('daily'),
    () => store.bumpConcern('id'),
    () => store.claim('key'),
    () => store.setCursor('review', 'new'),
  ]) {
    calls = 0;
    Object.assign(store, { db: { query: async () => { calls++; throw transportFailure(); } } });
    await assert.rejects(mutate(), /Surreal.*owner\/repo.*UND_ERR_HEADERS_TIMEOUT/i);
    assert.equal(calls, 1);
  }
});

test('failed connections release SDK resources', async (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'revuto-transport-'));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const store = new SurrealStore(vault, 'owner/repo', { url: 'http://localhost/rpc', namespace: 'test' });
  let closes = 0;
  Object.assign(store, { db: {
    connect: async () => { throw transportFailure(); },
    close: async () => { closes++; },
  } });
  await assert.rejects(store.connect(), /Surreal.*connect.*owner\/repo.*UND_ERR_HEADERS_TIMEOUT/i);
  assert.equal(closes, 3, 'each failed attempt releases its connection');
});

test('connection retries recover after cleanup and semantic errors keep their message', async (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'revuto-transport-'));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const store = new SurrealStore(vault, 'owner/repo', { url: 'http://localhost/rpc', namespace: 'test' });
  let calls = 0;
  let closes = 0;
  Object.assign(store, { db: {
    connect: async () => { if (++calls === 1) throw transportFailure(); },
    query: async () => [],
    close: async () => { closes++; },
  } });
  await store.connect();
  assert.equal(calls, 2);
  assert.equal(closes, 1);
  const error = new Error('Authentication failed');
  Object.assign(store, { db: { query: async () => { throw error; } } });
  await assert.rejects(store.getCursor('review'), err => err === error);
});

test('diagnostics preserve transport codes without dumping private response details', () => {
  const message = surrealErrorMessage(transportFailure());
  assert.match(message, /UND_ERR_HEADERS_TIMEOUT/);
  assert.doesNotMatch(message, /private upstream response/);
});
