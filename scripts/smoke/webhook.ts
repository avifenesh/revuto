/**
 * Deterministic GitHub App webhook smoke. No GitHub or model calls.
 *
 * Covers the published GitHub HMAC vector, HTTP signature enforcement,
 * pull_request action/draft filtering, immediate acceptance, background
 * dispatch, check-run outcome mapping, and clean App approvals.
 *
 *   npx tsx scripts/smoke/webhook.ts
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReviewerConfig } from '../../agents/common/src/config.js';
import type { GithubAuth } from '../../agents/common/src/github-auth.js';
import { reviewOnePr } from '../../daemon/src/jobs.js';
import {
  createWebhookServer,
  runForRegisteredRepo,
  verifyWebhookSignature,
  type PullRequestWebhook,
} from '../../daemon/src/github-webhook.js';
import {
  checkResultForOutcome,
  completeReviewCheck,
  type ReviewCheckTarget,
} from '../../daemon/src/review-check.js';
import { readReviewer, removeReviewer, writeReviewer } from '../../daemon/src/reviewers.js';

const publishedSecret = "It's a Secret to Everybody";
const publishedPayload = 'Hello, World!';
const publishedSignature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
assert.equal(verifyWebhookSignature(publishedPayload, publishedSecret, publishedSignature), true, 'GitHub published HMAC vector passes');
assert.equal(verifyWebhookSignature(publishedPayload, publishedSecret, publishedSignature.replace(/.$/, '0')), false, 'modified signature fails');
assert.equal(verifyWebhookSignature(publishedPayload, publishedSecret, undefined), false, 'missing signature fails');

const m = { baseURL: 'http://x/v1', model: 'm' };
const vault = mkdtempSync(join(tmpdir(), 'revuto-webhook-smoke-'));
const config: ReviewerConfig = {
  vaultPath: vault,
  github: {
    tokenEnv: 'GH_TOKEN',
    app: {
      appId: 1234,
      privateKeyPath: join(vault, 'unused-revuto-app.pem'),
      webhookSecretEnv: 'REVUTO_TEST_WEBHOOK_SECRET',
      host: '127.0.0.1',
      port: 8787,
      path: '/github/webhook',
      allowedOwners: ['octo'],
      checkName: 'revuto-review',
    },
  },
  models: { review: m, curator: m, distill: m, embedder: null },
  schedules: { review: '*/12 * * * *', learn: '0 */4 * * *', decay: '0 3 * * *' },
  review: { maxSteps: 1, allowWrite: false, workspaceDir: join(vault, 'workspaces') },
  limits: { maxOutputTokens: { review: 1, curator: 1, distill: 1 }, dailyReviews: 0, learnBatch: 0, dailyLearn: 0, dailyTokens: 0 },
  store: { backend: 'sqlite', surreal: { url: '', namespace: 'reviewer' } },
};

const secret = 'webhook-smoke-secret';
let resolveProcessed: ((event: PullRequestWebhook) => void) | undefined;
const processed = new Promise<PullRequestWebhook>((resolve) => {
  resolveProcessed = resolve;
});
let processCount = 0;
const server = createWebhookServer(config, {
  secret,
  processPullRequest: async (_config, event) => {
    processCount++;
    resolveProcessed?.(event);
  },
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}`;

function signature(body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function post(eventName: string, payload: unknown, signed = true): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${baseUrl}/github/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': eventName,
      'x-hub-signature-256': signed ? signature(body) : 'sha256=' + '0'.repeat(64),
    },
    body,
  });
}

const event: PullRequestWebhook = {
  action: 'opened',
  number: 42,
  installation: { id: 99 },
  repository: {
    full_name: 'octo/demo',
    html_url: 'https://github.com/octo/demo',
    owner: { login: 'octo' },
  },
  pull_request: {
    draft: false,
    html_url: 'https://github.com/octo/demo/pull/42',
    head: { sha: 'a'.repeat(40) },
  },
};

const health = await fetch(`${baseUrl}/healthz`);
assert.equal(health.status, 200, 'health endpoint is available');

const badSignature = await post('pull_request', event, false);
assert.equal(badSignature.status, 401, 'invalid signature is rejected');
assert.equal(processCount, 0, 'invalid signature does not dispatch');

const ping = await post('ping', { zen: 'Keep it logically awesome.' });
assert.equal(ping.status, 202, 'non-PR App event is acknowledged');
assert.equal(processCount, 0, 'non-PR App event does not dispatch');

const edited = await post('pull_request', { ...event, action: 'edited' });
assert.equal(edited.status, 202, 'irrelevant PR action is acknowledged');
assert.equal(await edited.text(), 'ignored\n', 'irrelevant PR action is identified as ignored');
assert.equal(processCount, 0, 'irrelevant PR action does not dispatch');

const draft = await post('pull_request', { ...event, pull_request: { ...event.pull_request, draft: true } });
assert.equal(draft.status, 202, 'draft PR is acknowledged');
assert.equal(processCount, 0, 'draft PR does not dispatch');

const unregistered = await post('pull_request', event);
assert.equal(unregistered.status, 202, 'unregistered repo is acknowledged');
assert.equal(await unregistered.text(), 'ignored\n', 'unregistered repo is identified as ignored');
assert.equal(processCount, 0, 'unregistered repo does not dispatch');

writeReviewer(config, { repo: event.repository.full_name, botLogin: 'revuto-review[bot]' });
assert.throws(
  () => writeReviewer(config, { repo: 'octo/demo/extra' }),
  /expected owner\/name/,
  'registration requires an exact owner/repo slug',
);
writeFileSync(
  join(vault, 'reviewers', 'octo__demo.md'),
  '---\nrepo: octo/demo/extra\n---\n',
  'utf8',
);
assert.equal(
  readReviewer(config, event.repository.full_name),
  null,
  'a colliding note whose stored repo differs is not registered',
);
writeReviewer(config, { repo: event.repository.full_name, botLogin: 'revuto-review[bot]' });
const accepted = await post('pull_request', event);
assert.equal(accepted.status, 202, 'reviewable PR is accepted immediately');
assert.equal(await accepted.text(), 'accepted\n', 'reviewable PR response is explicit');
const dispatched = await Promise.race([
  processed,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for background dispatch')), 2_000)),
]);
assert.equal(dispatched.number, 42, 'accepted PR dispatches in the background');
assert.equal(processCount, 1, 'accepted PR dispatches once');

assert.equal(removeReviewer(config, event.repository.full_name), true, 'registered repo is removed');
let removedRepoRan = false;
const removedRepoResult = await runForRegisteredRepo(config, event.repository.full_name, async () => {
  removedRepoRan = true;
  return 'reviewed';
});
assert.equal(removedRepoResult, null, 'a repo removed while queued is skipped');
assert.equal(removedRepoRan, false, 'removal prevents the queued review callback from running');

writeReviewer(config, { repo: event.repository.full_name, botLogin: 'revuto-review[bot]' });
const raceHeadSha = 'b'.repeat(40);
const raceAuth = {
  token: 'installation-token',
  login: 'revuto-review[bot]',
  octokit: {
    pulls: {
      get: async () => {
        assert.equal(
          removeReviewer(config, event.repository.full_name),
          true,
          'repo is removed while reviewOnePr awaits the PR',
        );
        return { data: { draft: false, head: { sha: raceHeadSha } } };
      },
    },
  },
} as unknown as GithubAuth;
const removedDuringReview = await reviewOnePr(config, event.repository.full_name, event.number, {
  githubAuth: raceAuth,
  registeredOnly: true,
});
assert.equal(removedDuringReview.terminal, 'skip_review', 'webhook review skips a repo removed during setup');
assert.equal(removedDuringReview.headSha, raceHeadSha, 'the skip result identifies the fetched PR head');
assert.equal(readReviewer(config, event.repository.full_name), null, 'webhook review does not re-register the removed repo');

assert.equal(checkResultForOutcome({
  terminal: 'skip_review', result: '', headSha: 'a', steps: 1, tokens: 1,
}).conclusion, 'success', 'clean review passes the check');
assert.equal(checkResultForOutcome({
  terminal: 'post_review', result: '', headSha: 'a', steps: 1, tokens: 1,
}).conclusion, 'failure', 'posted findings fail the check');
assert.equal(checkResultForOutcome({
  terminal: 'none', result: '', headSha: 'a', steps: 1, tokens: 1,
}).conclusion, 'failure', 'missing terminal decision fails the check');

const reviewCalls: Array<Record<string, unknown>> = [];
const checkCalls: Array<Record<string, unknown>> = [];
const checkAuth = {
  token: 'installation-token',
  login: 'revuto-review[bot]',
  octokit: {
    pulls: {
      createReview: async (input: Record<string, unknown>) => {
        reviewCalls.push(input);
        return { data: { id: 1 } };
      },
    },
    checks: {
      update: async (input: Record<string, unknown>) => {
        checkCalls.push(input);
        return { data: { id: input.check_run_id } };
      },
    },
  },
} as unknown as GithubAuth;
const checkTarget: ReviewCheckTarget = {
  repo: 'octo/demo',
  prNumber: 42,
  headSha: 'c'.repeat(40),
  detailsUrl: 'https://github.com/octo/demo/pull/42',
};
await completeReviewCheck(
  checkAuth,
  config.github.app!,
  checkTarget,
  100,
  checkResultForOutcome({ terminal: 'skip_review', result: '', headSha: checkTarget.headSha, steps: 1, tokens: 1 }),
);
assert.equal(reviewCalls.length, 1, 'clean review submits one App review');
assert.deepEqual(
  {
    owner: reviewCalls[0]?.owner,
    repo: reviewCalls[0]?.repo,
    pull_number: reviewCalls[0]?.pull_number,
    commit_id: reviewCalls[0]?.commit_id,
    event: reviewCalls[0]?.event,
  },
  {
    owner: 'octo',
    repo: 'demo',
    pull_number: 42,
    commit_id: checkTarget.headSha,
    event: 'APPROVE',
  },
  'clean App approval is pinned to the reviewed head',
);
assert.match(String(reviewCalls[0]?.body), /revuto-signed/, 'clean App approval is visibly signed');
assert.equal(checkCalls[0]?.conclusion, 'success', 'clean approval completes the check successfully');

await completeReviewCheck(
  checkAuth,
  config.github.app!,
  checkTarget,
  101,
  checkResultForOutcome({ terminal: 'post_review', result: '', headSha: checkTarget.headSha, steps: 1, tokens: 1 }),
);
assert.equal(reviewCalls.length, 1, 'a findings result does not submit an approval');
assert.equal(checkCalls[1]?.conclusion, 'failure', 'findings still fail the App check');

await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
rmSync(vault, { recursive: true, force: true });
console.log('PASS: GitHub webhook HMAC + HTTP filtering/dispatch + review checks/approvals');
