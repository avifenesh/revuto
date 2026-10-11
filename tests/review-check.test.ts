import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GithubAppConfig } from '../agents/common/src/config.js';
import type { GithubAuth } from '../agents/common/src/github-auth.js';
import { completeReviewCheck, type ReviewCheckTarget } from '../daemon/src/review-check.js';

const app = { checkName: 'revuto-review' } as unknown as GithubAppConfig;
const target: ReviewCheckTarget = {
  repo: 'octo/demo', prNumber: 7, headSha: 'a'.repeat(40), detailsUrl: 'https://github.com/octo/demo/pull/7',
};
const failure = { conclusion: 'failure', title: 'Revuto found issues', summary: 'one finding' } as const;

function authWithUpdates(errors: Array<{ status: number } | undefined>) {
  const calls: number[] = [];
  const auth = {
    octokit: {
      checks: {
        update: async (input: { check_run_id: number }) => {
          calls.push(input.check_run_id);
          const err = errors.shift();
          if (err) throw Object.assign(new Error('Not Found'), err);
          return { data: {} };
        },
      },
    },
  } as unknown as GithubAuth;
  return { auth, calls };
}

test('a check run that GitHub does not see yet is completed on retry', async () => {
  const { auth, calls } = authWithUpdates([{ status: 404 }, { status: 404 }]);
  await completeReviewCheck(auth, app, target, 42, failure, { updateRetryDelaysMs: [0, 0, 0] });
  assert.deepEqual(calls, [42, 42, 42]);
});

test('a check update keeps failing on a persistent 404 and never retries other errors', async () => {
  const missing = authWithUpdates([{ status: 404 }, { status: 404 }, { status: 404 }]);
  await assert.rejects(completeReviewCheck(missing.auth, app, target, 42, failure, { updateRetryDelaysMs: [0, 0] }), /Not Found/);
  assert.equal(missing.calls.length, 3);
  const denied = authWithUpdates([{ status: 403 }]);
  await assert.rejects(completeReviewCheck(denied.auth, app, target, 42, failure, { updateRetryDelaysMs: [0, 0] }));
  assert.equal(denied.calls.length, 1);
});
