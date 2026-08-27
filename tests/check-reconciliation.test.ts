import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReviewerConfig } from '../agents/common/src/config.js';
import type { GithubAuth } from '../agents/common/src/github-auth.js';
import { reconcileStaleReviewChecks } from '../daemon/src/check-reconciliation.js';

const config = {
  github: {
    app: {
      appId: 1234,
      checkName: 'revuto-review',
      allowedOwners: ['octo'],
    },
  },
} as unknown as ReviewerConfig;

test('startup reconciliation fails only Revuto-owned in-progress checks', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const pullsList = async () => undefined;
  const checksListForRef = async () => undefined;
  const auth = {
    octokit: {
      pulls: { list: pullsList },
      checks: {
        listForRef: checksListForRef,
        update: async (input: Record<string, unknown>) => {
          updates.push(input);
          return { data: { id: input.check_run_id } };
        },
      },
      paginate: async (route: unknown) => {
        if (route === pullsList) {
          return [{ head: { sha: 'a'.repeat(40) }, html_url: 'https://github.com/octo/demo/pull/42' }];
        }
        return [
          { id: 10, name: 'revuto-review', status: 'in_progress', app: { id: 1234 } },
          { id: 11, name: 'revuto-review', status: 'completed', app: { id: 1234 } },
          { id: 12, name: 'revuto-review', status: 'in_progress', app: { id: 9999 } },
          { id: 13, name: 'other-check', status: 'in_progress', app: { id: 1234 } },
        ];
      },
    },
    token: async () => 'token',
  } as unknown as GithubAuth;

  const result = await reconcileStaleReviewChecks(config, {
    repos: ['octo/demo'],
    authForRepo: async () => auth,
  });

  assert.deepEqual(result, { completed: 1, failedRepos: 0 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.check_run_id, 10);
  assert.equal(updates[0]?.status, 'completed');
  assert.equal(updates[0]?.conclusion, 'failure');
  assert.match(String((updates[0]?.output as Record<string, unknown>).summary), /Retry the review/);
});

test('startup reconciliation is disabled without GitHub App configuration', async () => {
  const result = await reconcileStaleReviewChecks({ github: {} } as unknown as ReviewerConfig, {
    repos: ['octo/demo'],
    authForRepo: async () => { throw new Error('must not authenticate'); },
  });
  assert.deepEqual(result, { completed: 0, failedRepos: 0 });
});
