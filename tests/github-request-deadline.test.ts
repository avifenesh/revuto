import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Octokit } from '@octokit/rest';
import { githubFetchWithDeadline } from '../agents/common/src/github-auth.js';

test('GitHub fetch deadlines abort stuck requests through the installed Octokit adapter and refresh per call', async () => {
  const signals: AbortSignal[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const signal = init!.signal!;
    signals.push(signal);
    if (signals.length > 1) return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const client = new Octokit({ request: { fetch: githubFetchWithDeadline(fakeFetch, 20) } });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(client.request('GET /app/hook/deliveries'));
    assert.equal(signals[0].aborted, true);
    assert.deepEqual((await client.request('GET /app/hook/deliveries')).data, { ok: true });
    assert.notEqual(signals[0], signals[1]);
    assert.equal(signals[1].aborted, false);
  } finally { clearTimeout(keepAlive); }
});

test('GitHub fetch deadlines remain active while Octokit reads the response body', async () => {
  const fakeFetch: typeof fetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
    },
  }), { headers: { 'content-type': 'application/json' } });
  const client = new Octokit({ request: { fetch: githubFetchWithDeadline(fakeFetch, 20) } });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(client.request('GET /app/hook/deliveries'));
  } finally { clearTimeout(keepAlive); }
});

test('GitHub fetch deadlines preserve caller cancellation', async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const fakeFetch: typeof fetch = async (_input, init) => {
    received = init!.signal!;
    return new Promise((_resolve, reject) => {
      received!.addEventListener('abort', () => reject(received!.reason), { once: true });
    });
  };
  const request = githubFetchWithDeadline(fakeFetch)('https://example.test', { signal: controller.signal });
  controller.abort();
  await assert.rejects(request);
  assert.equal(received?.aborted, true);
});
