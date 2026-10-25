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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GithubAuth } from '../agents/common/src/github-auth.js';
import { scopedInstallationToken, tokenHookAuth } from '../agents/common/src/github-auth.js';
import { unreviewedOutcome } from '../agents/common/src/run-agent.js';
import { reviewOnePr } from '../daemon/src/jobs.js';

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

test('deliveries in the same tick still run one review at a time', async () => {
  let active = 0, peak = 0, runs = 0;
  const d = coalescingDispatcher(async () => { active++; peak = Math.max(peak, active); runs++; await new Promise((r) => setTimeout(r, 20)); active--; }, () => {});
  for (let i = 0; i < 5; i++) d.dispatch(event(`h${i}`));
  // While the first review runs, the drains scheduled by the rest of the burst have
  // finished; a late delivery must wait for the running review, not start beside it.
  await new Promise((r) => setTimeout(r, 5));
  d.dispatch(event('late'));
  for (let i = 0; i < 50 && (runs < 2 || active > 0); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(peak, 1, 'never two reviews of one PR at once');
  assert.equal(runs, 2, 'the burst collapsed into one review, then the late head');
});

test('installation tokens name the repository on every mint, and every request carries one', async () => {
  const calls: unknown[] = [];
  const mint = scopedInstallationToken(async (o) => { calls.push(o); return { token: `t${calls.length}` }; }, 'owner/repo');
  assert.equal(await mint(), 't1');
  assert.deepEqual(calls[0], { type: 'installation', repositoryNames: ['repo'] });
  const auth = tokenHookAuth(mint);
  const sent: any[] = [];
  const request = Object.assign(async (endpoint: any) => { sent.push(endpoint); return { status: 200 }; },
    { endpoint: { merge: (route: string, params: any) => ({ url: route, ...params, headers: {} }) } });
  await auth.hook(request, 'GET /repos/owner/repo', {});
  assert.equal(sent[0].headers.authorization, 't2'.replace(/^/, 'token '));
  assert.deepEqual(calls[1], { type: 'installation', repositoryNames: ['repo'] });
});

test('a head retargeted to another base, and back, gets a fresh full review each time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'retarget-'));
  const HEAD = 'a'.repeat(40);
  const cfg = { vaultPath: root, review: { workspaceDir: join(root, 'workspaces'), maxConcurrent: 4, maxConcurrentPerRepo: 2, maxRounds: 10 },
    github: { tokenEnv: 'TEST_UNUSED' }, models: { embedder: null }, limits: { dailyReviews: 0, dailyTokens: 0 }, store: { backend: 'sqlite' } } as ReviewerConfig;
  let base = 'main';
  const auth = { login: 'reviewer', token: async () => 'unused', octokit: {
    pulls: { get: async () => ({ data: { head: { sha: HEAD }, base: { ref: base, repo: { default_branch: 'main' } }, state: 'open', draft: false, html_url: 'https://example.test/pr', user: { login: 'author' }, author_association: 'NONE' } }), listReviews: () => {} },
    paginate: async () => [],
  } } as unknown as GithubAuth;
  const full: Array<boolean | undefined> = [];
  const runReview = async (o: any) => { full.push(o.fullReview); return { ...unreviewedOutcome('ran', HEAD), ranModel: true, terminal: 'skip_review', inspections: 1 } as never; };
  try {
    await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview });
    assert.match((await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview })).result, /already reviewed/);
    base = 'dev';
    await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview });
    base = 'main';
    await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview });
    assert.deepEqual(full, [undefined, true, true], 'each base change reviews the head again, in full');
    assert.match((await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview })).result, /already reviewed/);
    // A webhook-reported retarget counts even with no recorded base (a head reviewed before the record existed).
    await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview, retarget: true });
    assert.equal(full.at(-1), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a retarget that comes with a push, or after a failed run, is still a full review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'retarget-push-'));
  const cfg = { vaultPath: root, review: { workspaceDir: join(root, 'workspaces'), maxConcurrent: 4, maxConcurrentPerRepo: 2, maxRounds: 10 },
    github: { tokenEnv: 'TEST_UNUSED' }, models: { embedder: null }, limits: { dailyReviews: 0, dailyTokens: 0 }, store: { backend: 'sqlite' } } as ReviewerConfig;
  let base = 'dev', head = 'a'.repeat(40);
  const auth = { login: 'reviewer', token: async () => 'unused', octokit: {
    pulls: { get: async () => ({ data: { head: { sha: head }, base: { ref: base, repo: { default_branch: 'main' } }, state: 'open', draft: false, html_url: 'https://example.test/pr', user: { login: 'author' }, author_association: 'NONE' } }), listReviews: () => {} },
    paginate: async () => [],
  } } as unknown as GithubAuth;
  const full: Array<boolean | undefined> = [];
  let fail = false;
  const runReview = async (o: any) => { full.push(o.fullReview); if (fail) throw new Error('model down'); return { ...unreviewedOutcome('ran', head), ranModel: true, terminal: 'skip_review', inspections: 1 } as never; };
  try {
    await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview });
    head = 'b'.repeat(40); base = 'main';
    fail = true;
    await assert.rejects(reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview }));
    fail = false;
    await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview });
    assert.deepEqual(full, [undefined, true, true], 'the new head on the new base is reviewed in full, and the retry after a failure too');
    head = 'c'.repeat(40);
    await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview });
    assert.equal(full.at(-1), undefined, 'once reviewed against main, a later push is an ordinary re-review');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
