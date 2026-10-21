import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewerConfig } from '../agents/common/src/config.js';
import type { GithubAuth } from '../agents/common/src/github-auth.js';
import { unreviewedOutcome, type ReviewOutcome } from '../agents/common/src/run-agent.js';
import { openStore } from '../agents/common/src/store/open.js';
import { withReviewHeading } from '../agents/common/src/tools/gh.js';
import { reviewOnePr } from '../daemon/src/jobs.js';
import { checkResultForOutcome, finalReviewCheckResult, REVIEW_EXIT, reviewExitCode } from '../daemon/src/review-check.js';
import { counterKey, FINAL_REVIEW_HEADING, reserveReviewBudget, type ReviewBudgetRequest } from '../daemon/src/review-rounds.js';

function counters() {
  const values = new Map<string, number>();
  return { values, getCounter: async (key: string) => values.get(key) ?? 0,
    incrCounter: async (key: string, by = 1) => { const n = (values.get(key) ?? 0) + by; values.set(key, n); return n; } };
}

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const DAY = '2026-10-21';

function request(over: Partial<ReviewBudgetRequest> = {}): ReviewBudgetRequest {
  return { prNumber: 7, headSha: HEAD_A, maxRounds: 2, final: true, day: DAY, historical: async () => 0, ...over };
}

/** Spend both rounds of a 2-round PR. */
async function capped(store: ReturnType<typeof counters>): Promise<void> {
  for (let n = 1; n <= 2; n++) assert.equal((await reserveReviewBudget(store, request({ final: false }))).allowed, true);
  assert.equal((await reserveReviewBudget(store, request({ final: false }))).allowed, false);
}

test('A final review is allowed once per head past the round cap', async () => {
  const store = counters();
  await capped(store);
  const first = await reserveReviewBudget(store, request());
  assert.equal(first.allowed, true);
  assert.equal(first.final, true);
  assert.match(first.reason, /Final review of PR #7 at aaaaaaa/);
  assert.equal(store.values.get('review-rounds:7'), 2, 'the final review spends no round');
  assert.equal(store.values.get(`final-review:7:${HEAD_A}`), 1);
});

test('A second final review at the same head is refused with a clear reason', async () => {
  const store = counters();
  await capped(store);
  assert.equal((await reserveReviewBudget(store, request())).allowed, true);
  const second = await reserveReviewBudget(store, request());
  assert.equal(second.allowed, false);
  assert.equal(second.final, true);
  assert.equal(second.daily, false);
  assert.match(second.reason, /already had its final review at aaaaaaa/);
  assert.match(second.reason, /push a new head/);
  assert.equal(checkResultForOutcome(unreviewedOutcome(second.reason, HEAD_A)).conclusion, 'failure');
});

test('A new head gets its own final review', async () => {
  const store = counters();
  await capped(store);
  assert.equal((await reserveReviewBudget(store, request())).allowed, true);
  assert.equal((await reserveReviewBudget(store, request())).allowed, false);
  const next = await reserveReviewBudget(store, request({ headSha: HEAD_B }));
  assert.equal(next.allowed, true);
  assert.equal(next.final, true);
  assert.equal((await reserveReviewBudget(store, request({ headSha: HEAD_B }))).allowed, false);
});

test('A final review still respects the daily review and token limits and spends nothing when refused', async () => {
  const store = counters();
  await capped(store);
  store.values.set(counterKey('reviews', DAY), 5);
  const reviews = await reserveReviewBudget(store, request({ dailyReviews: 5 }));
  assert.deepEqual([reviews.allowed, reviews.daily, reviews.reason], [false, true, 'Daily review limit reached']);
  store.values.set(counterKey('tokens', DAY), 1000);
  const tokens = await reserveReviewBudget(store, request({ dailyReviews: 10, dailyTokens: 1000 }));
  assert.deepEqual([tokens.allowed, tokens.daily, tokens.reason], [false, true, 'Daily token limit reached']);
  assert.equal(store.values.has(`final-review:7:${HEAD_A}`), false, 'a refused final review is not spent');
  // Once the day has room, the head still has its final review, and it counts toward the day.
  const allowed = await reserveReviewBudget(store, request({ dailyReviews: 10, dailyTokens: 2000 }));
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.final, true);
  assert.equal(store.values.get(counterKey('reviews', DAY)), 6);
});

test('Below the cap a final review is a normal round and spends it', async () => {
  const store = counters();
  const first = await reserveReviewBudget(store, request());
  assert.deepEqual(first, { allowed: true, round: 1, reason: 'Review round 1/2', final: false, daily: false });
  assert.equal(store.values.get('review-rounds:7'), 1);
  assert.equal(store.values.has(`final-review:7:${HEAD_A}`), false);
  // The last round goes the same way; only after it does --final reach past the cap.
  assert.equal((await reserveReviewBudget(store, request())).final, false);
  assert.equal((await reserveReviewBudget(store, request())).final, true);
});

test('Final review labels the check, the summary heading and the approval body', () => {
  const ran = { ...unreviewedOutcome('', HEAD_A), ranModel: true, inspections: 3, steps: 4 } satisfies ReviewOutcome;
  const passed = finalReviewCheckResult(checkResultForOutcome(ran));
  assert.equal(passed.conclusion, 'success');
  assert.equal(passed.title, `${FINAL_REVIEW_HEADING}: review passed`);
  assert.match(passed.summary, /requested after the round cap/);
  const concerns = finalReviewCheckResult(checkResultForOutcome({ ...ran, terminal: 'post_review', hasFindings: true }));
  assert.equal(concerns.conclusion, 'failure');
  assert.equal(concerns.title, `${FINAL_REVIEW_HEADING}: found review concerns`);
  assert.equal(withReviewHeading('one finding', FINAL_REVIEW_HEADING), `**${FINAL_REVIEW_HEADING}**\n\none finding`);
  assert.equal(withReviewHeading('one finding'), 'one finding');
});

test('revuto review exit codes separate passed, concerns, not run and failed', () => {
  const ran = { ...unreviewedOutcome('', HEAD_A), ranModel: true, inspections: 3, steps: 4 } satisfies ReviewOutcome;
  assert.equal(reviewExitCode(ran), REVIEW_EXIT.passed);
  assert.equal(reviewExitCode({ ...ran, terminal: 'post_review', hasFindings: true }), REVIEW_EXIT.concerns);
  assert.equal(reviewExitCode(unreviewedOutcome('PR #7 reached the 2-round review limit', HEAD_A)), REVIEW_EXIT.notRun);
  assert.equal(reviewExitCode({ ...ran, terminal: 'none' }), REVIEW_EXIT.failed);
  assert.equal(reviewExitCode({ ...ran, terminal: 'post_review', hasFindings: true, postFailures: 1 }), REVIEW_EXIT.failed);
  assert.equal(reviewExitCode({ ...ran, inspections: 0 }), REVIEW_EXIT.failed);
  assert.deepEqual(new Set(Object.values(REVIEW_EXIT)).size, 4);
});

test('--final reaches past the done marker of a capped head, and only there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'final-review-'));
  const cfg = { vaultPath: root, review: { workspaceDir: join(root, 'workspaces'), maxConcurrent: 4, maxConcurrentPerRepo: 2, maxRounds: 2 },
    github: { tokenEnv: 'TEST_UNUSED' }, models: { embedder: null }, limits: { dailyReviews: 0, dailyTokens: 0 }, store: { backend: 'sqlite' } } as ReviewerConfig;
  let signed = 2;
  const auth = { login: 'reviewer', token: async () => 'unused', octokit: {
    pulls: { get: async () => ({ data: { head: { sha: HEAD_A }, state: 'open', draft: false, html_url: 'https://example.test/pr' } }), listReviews: () => {} },
    paginate: async () => Array.from({ length: signed }, (_, i) => ({ id: i + 1, submitted_at: 'now', user: { login: 'reviewer' }, body: '<!-- revuto-signed -->' })),
  } } as unknown as GithubAuth;
  try {
    // The daemon reaches the head after the cap: refused, and the head is marked done.
    const daemon = await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth });
    assert.match(daemon.result, /2-round review limit/);
    assert.match((await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth })).result, /already reviewed or is currently being reviewed/);

    // The head's final review was already spent: --final gets past the done marker
    // to the final-review reservation, which refuses it clearly.
    const store = await openStore(cfg, 'a/repo');
    try { await store.incrCounter(`final-review:7:${HEAD_A}`); } finally { await store.close(); }
    const final = await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, final: true });
    assert.equal(final.ranModel, false);
    assert.match(final.result, /already had its final review at aaaaaaa/);
    assert.equal(reviewExitCode(final), REVIEW_EXIT.notRun);
    // The final claim is now done too.
    assert.match((await reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, final: true })).result, /already had its final review/);
  } finally { rmSync(root, { recursive: true, force: true }); }

  // Below the cap, a reviewed head stays reviewed: --final does not re-run it.
  const below = mkdtempSync(join(tmpdir(), 'final-review-below-'));
  try {
    signed = 0;
    const cfgBelow = { ...cfg, vaultPath: below, review: { ...cfg.review, workspaceDir: join(below, 'workspaces') } } as ReviewerConfig;
    const store = await openStore(cfgBelow, 'a/repo');
    try { await store.mark(`a/repo#7@${HEAD_A}`); } finally { await store.close(); }
    const result = await reviewOnePr(cfgBelow, 'a/repo', 7, { githubAuth: auth, final: true });
    assert.match(result.result, /already reviewed or is currently being reviewed/);
  } finally { rmSync(below, { recursive: true, force: true }); }
});
