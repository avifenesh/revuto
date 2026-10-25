/**
 * Webhook ingress hardening: floods, malformed and unsigned requests, retargeted
 * PRs, the App identity in round counting, and who a daily cap can refuse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';

import { coalescingDispatcher, createWebhookServer, shouldReviewPullRequest, type PullRequestWebhook } from '../daemon/src/github-webhook.js';
import { historicalReviewRounds, reserveReviewBudget } from '../daemon/src/review-rounds.js';
import type { ReviewerConfig } from '../agents/common/src/config.js';

const event = (sha: string, action = 'synchronize', changes?: Record<string, unknown>): PullRequestWebhook => ({
  action, number: 7, installation: { id: 1 },
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r', owner: { login: 'o' } },
  pull_request: { draft: false, html_url: 'https://github.com/o/r/pull/7', head: { sha } },
  ...(changes ? { changes } : {}),
});

test('a burst of deliveries for one PR runs at most one review and keeps the newest head', async () => {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const d = coalescingDispatcher(async (e) => { seen.push(e.pull_request.head.sha); if (seen.length === 1) await gate; }, () => {});
  d.dispatch(event('h0'));
  await new Promise((r) => setImmediate(r));
  for (let i = 1; i <= 200; i++) d.dispatch(event(`h${i}`));
  assert.equal(d.pending(), 1, 'one waiting delivery, not 200');
  release();
  for (let i = 0; i < 20 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, ['h0', 'h200']);
});

test('a retargeted PR is reviewed again; other edits are not', () => {
  assert.ok(shouldReviewPullRequest(event('h', 'edited', { base: { ref: { from: 'dev' } } })));
  assert.ok(!shouldReviewPullRequest(event('h', 'edited', { title: { from: 'x' } })));
  assert.ok(!shouldReviewPullRequest(event('h', 'edited')));
});

function server() {
  const config = { github: { app: { path: '/github/webhook', host: '127.0.0.1', port: 0, allowedOwners: [], webhookSecretEnv: 'X' } } } as unknown as ReviewerConfig;
  const errors: unknown[] = [];
  const s = createWebhookServer(config, { secret: 's', processPullRequest: async () => {}, onError: (e) => errors.push(e) });
  return { s, errors };
}

const raw = (port: number, request: string, trickle = false): Promise<{ status: string; ms: number }> => new Promise((resolve, reject) => {
  const started = Date.now();
  const sock = connect(port, '127.0.0.1', () => {
    if (trickle) {
      sock.write(request);
      const timer = setInterval(() => { if (!sock.destroyed) sock.write('x'); }, 100);
      sock.on('close', () => clearInterval(timer));
    } else sock.write(request);
  });
  let data = '';
  sock.on('data', (b) => { data += b; if (data.includes('\r\n')) { resolve({ status: data.split('\r\n')[0]!, ms: Date.now() - started }); sock.destroy(); } });
  sock.on('error', reject);
});

test('malformed, unsigned and oversized requests are answered without reading a body or crashing', async () => {
  const { s, errors } = server();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  try {
    assert.match((await raw(port, 'GET //% HTTP/1.1\r\nHost: x\r\n\r\n')).status, / 400 /, 'a bad request line is a 400, not a crash');
    const unsigned = await raw(port, 'POST /github/webhook HTTP/1.1\r\nHost: x\r\nX-GitHub-Event: pull_request\r\nContent-Length: 2000000\r\n\r\n', true);
    assert.match(unsigned.status, / 401 /);
    assert.ok(unsigned.ms < 1000, `an unsigned request is refused before its body (${unsigned.ms}ms)`);
    const big = await raw(port, `POST /github/webhook HTTP/1.1\r\nHost: x\r\nX-Hub-Signature-256: sha256=${'0'.repeat(64)}\r\nContent-Length: 9999999\r\n\r\n`, true);
    assert.match(big.status, / 413 /);
    assert.equal(s.requestTimeout, 15_000);
    assert.equal(errors.length, 0);
  } finally { await new Promise<void>((r) => s.close(() => r())); }
});

test('only the App bot account counts as the App in round seeding', async () => {
  const signed = '<!-- revuto-signed -->\nreview';
  const reviews = [
    { id: 1, submitted_at: 't', user: { login: 'revuto-review', type: 'User' }, body: signed },
    { id: 2, submitted_at: 't', user: { login: 'revuto-review[bot]', type: 'User' }, body: signed },
    { id: 3, submitted_at: 't', user: { login: 'revuto-review[bot]', type: 'Bot' }, body: signed },
  ];
  const auth = { login: 'revuto-review[bot]', octokit: { paginate: async () => reviews, pulls: { listReviews: () => {} } } } as never;
  assert.equal(await historicalReviewRounds(auth, 'o/r', 7), 1);
});

test('a daily cap never refuses a maintainer, and a per-author cap stops one author', async () => {
  const counters = new Map<string, number>();
  const store = {
    getCounter: async (k: string) => counters.get(k) ?? 0,
    incrCounter: async (k: string, by = 1) => { counters.set(k, (counters.get(k) ?? 0) + by); return counters.get(k)!; },
  } as never;
  const req = { prNumber: 1, headSha: 'h', maxRounds: 100, day: 'd', dailyReviews: 1, historical: async () => 0 };
  assert.equal((await reserveReviewBudget(store, { ...req, author: 'stranger' })).allowed, true);
  assert.equal((await reserveReviewBudget(store, { ...req, prNumber: 2, author: 'stranger' })).allowed, false, 'the repo cap is spent');
  assert.equal((await reserveReviewBudget(store, { ...req, prNumber: 3, author: 'maint', maintainer: true })).allowed, true, 'a maintainer still gets reviewed');
  const per = { ...req, dailyReviews: 0, dailyReviewsPerAuthor: 2 };
  assert.equal((await reserveReviewBudget(store, { ...per, prNumber: 4, author: 'flood' })).allowed, true);
  assert.equal((await reserveReviewBudget(store, { ...per, prNumber: 5, author: 'flood' })).allowed, true);
  assert.equal((await reserveReviewBudget(store, { ...per, prNumber: 6, author: 'flood' })).allowed, false);
  assert.equal((await reserveReviewBudget(store, { ...per, prNumber: 7, author: 'other' })).allowed, true);
});
