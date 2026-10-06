import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { GithubAppConfig, ReviewerConfig } from '../agents/common/src/config.js';
import type { GithubAuth } from '../agents/common/src/github-auth.js';
import type { KnowledgeStore } from '../agents/common/src/store/store.js';
import { unreviewedOutcome } from '../agents/common/src/run-agent.js';
import { pollReviewCandidates, STALLED_SUITE_AGE_MS } from '../daemon/src/poller.js';
import { reviewRepo } from '../daemon/src/jobs.js';

const now = Date.now();
const old = new Date(now - 60 * 60_000).toISOString();
const recent = new Date(now).toISOString();
const app = { appId: 1234, allowedOwners: ['octo'] } as unknown as GithubAppConfig;

function fixture() {
  const pulls = Array.from({ length: 8 }, (_, index) => ({
    number: index + 1, updated_at: index === 0 ? recent : old,
    user: { login: 'human' }, head: { sha: `head-${index + 1}` }, draft: index === 7,
  }));
  const suite = (n: number, extra: Record<string, unknown> = {}) => ({
    id: n, app: { id: 1234 }, head_sha: `head-${n}`, status: 'queued', created_at: old, ...extra,
  });
  const suites = new Map([
    ['head-2', [suite(2)]],
    ['head-3', [suite(3, { created_at: recent })]],
    ['head-4', [suite(4)]],
    ['head-5', [suite(5, { app: { id: 9999 } })]],
    ['head-6', [suite(6, { status: 'completed' })]],
    ['head-7', [suite(7, { head_sha: 'obsolete' })]],
    ['head-8', [suite(8)]],
  ]);
  const checked: number[] = [];
  const refs: string[] = [];
  const listSuitesForRef = () => {};
  const octokit = {
    pulls: { list: async () => ({ data: pulls }) },
    checks: {
      listSuitesForRef,
      listForSuite: async ({ check_suite_id, filter }: { check_suite_id: number; filter: string }) => {
        assert.equal(filter, 'all');
        checked.push(check_suite_id);
        return { data: { total_count: check_suite_id === 4 ? 1 : 0, check_runs: [] } };
      },
    },
    paginate: async (route: unknown, params: { ref: string }) => {
      assert.equal(route, listSuitesForRef);
      refs.push(params.ref);
      return suites.get(params.ref) ?? [];
    },
  } as unknown as Octokit;
  return { octokit, checked, refs, suites, pulls };
}

test('candidate discovery rescues only old, empty, queued suites belonging to Revuto on the current head', async () => {
  const f = fixture();
  const result = await pollReviewCandidates(f.octokit, 'octo/demo', new Date(now - 30 * 60_000).toISOString(), app, now);
  assert.deepEqual(result.map((pull) => pull.number), [1, 2]);
  assert.deepEqual(f.checked, [2, 4]);
  assert.ok(!f.refs.includes('head-1'));
  assert.ok(!f.refs.includes('head-8'));
});

test('ordinary non-App polling remains a cursor delta and never calls Checks APIs', async () => {
  const f = fixture();
  const result = await pollReviewCandidates(f.octokit, 'octo/demo', new Date(now - 30 * 60_000).toISOString());
  assert.deepEqual(result.map((pull) => pull.number), [1]);
  assert.deepEqual(f.refs, []);
});

test('suite age must reach five minutes, and a queued suite with existing runs is not rescued', async () => {
  const f = fixture();
  f.suites.set('head-2', [{
    id: 2, app: { id: 1234 }, head_sha: 'head-2', status: 'queued',
    created_at: new Date(now - STALLED_SUITE_AGE_MS + 1).toISOString(),
  }]);
  assert.deepEqual((await pollReviewCandidates(f.octokit, 'octo/demo', recent, app, now)).map((pull) => pull.number), []);
  assert.deepEqual(f.checked, [4]);
  f.suites.get('head-2')![0].created_at = new Date(now - STALLED_SUITE_AGE_MS).toISOString();
  assert.deepEqual((await pollReviewCandidates(f.octokit, 'octo/demo', recent, app, now)).map((pull) => pull.number), [2]);
});

test('scheduled review admits a stalled head older than the cursor, including initial cursor setup', async () => {
  const root = join(homedir(), '.cache');
  mkdirSync(root, { recursive: true });
  const vaultPath = mkdtempSync(join(root, 'revuto-stalled-review-test-'));
  const config = { vaultPath, github: { app } } as ReviewerConfig;
  try {
    for (const cursor of [new Date(now + 1000).toISOString(), null]) {
      const f = fixture();
      const reviews: Array<[number, string | undefined]> = [];
      const cursors: string[] = [];
      let closed = false;
      const store = {
        getCursor: async () => cursor,
        setCursor: async (_name: string, value: string) => { cursors.push(value); },
        close: async () => { closed = true; },
      } as unknown as KnowledgeStore;
      const result = await reviewRepo(config, { repo: 'octo/demo' }, {}, {
        githubAuth: { octokit: f.octokit } as GithubAuth,
        openStore: async () => store,
        reviewOnePr: async (_config, _repo, number, opts) => {
          reviews.push([number, opts?.expectedHeadSha]);
          return { ...unreviewedOutcome('reviewed', `head-${number}`), ranModel: true };
        },
      });
      assert.deepEqual(reviews, [[2, 'head-2']]);
      assert.equal(result.reviewed, 1);
      assert.equal(cursors.length, 1);
      assert.equal(closed, true);
      assert.equal(result.initialized, cursor === null ? true : undefined);
    }
  } finally {
    rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('a rescued head stays eligible after a budget deferral or error creates a check run', async () => {
  const root = join(homedir(), '.cache');
  mkdirSync(root, { recursive: true });
  const vaultPath = mkdtempSync(join(root, 'revuto-stalled-retry-test-'));
  const config = { vaultPath, github: { app } } as ReviewerConfig;
  try {
    for (const failure of ['budget', 'error']) {
      const f = fixture();
      const pull = f.pulls[1];
      f.pulls.splice(0, f.pulls.length, pull);
      let cursor = new Date(now + 1000).toISOString();
      let attempts = 0;
      const store = {
        getCursor: async () => cursor,
        setCursor: async (_name: string, value: string) => { cursor = value; },
        close: async () => {},
      } as unknown as KnowledgeStore;
      const deps = {
        githubAuth: { octokit: f.octokit } as GithubAuth,
        openStore: async () => store,
        reviewOnePr: async () => {
          attempts++;
          f.suites.get('head-2')![0].status = 'completed';
          if (attempts === 1) {
            if (failure === 'error') throw new Error('transient review failure');
            return unreviewedOutcome('Daily review limit reached', 'head-2');
          }
          return { ...unreviewedOutcome('reviewed', 'head-2'), ranModel: true };
        },
      };
      const first = reviewRepo(config, { repo: 'octo/demo' }, {}, deps);
      if (failure === 'error') await assert.rejects(first, /1 review\(s\) failed/);
      else assert.equal((await first).reviewed, 0);
      assert.ok(Date.parse(cursor) < Date.parse(pull.updated_at));
      const second = await reviewRepo(config, { repo: 'octo/demo' }, {}, deps);
      assert.equal(second.reviewed, 1);
      assert.equal(attempts, 2);
      assert.equal(f.checked.length, 1, 'second attempt comes from delta discovery, not the now non-empty suite');
    }
  } finally {
    rmSync(vaultPath, { recursive: true, force: true });
  }
});
