/**
 * The auth contract a long review depends on: a token is resolved at the moment
 * it is used, not captured when the job starts.
 *
 * An installation token lives 60 minutes (@octokit/auth-app caches it for 59)
 * while a review runs for tens of minutes. Freezing one into the tool deps meant
 * a run that claimed a head late in a cached token's life reached its
 * `post_review` holding a dead credential - 401 "Bad credentials" after every
 * model token was already paid for, with the verdict written nowhere but the
 * local trace.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getOctokit } from '../agents/common/src/github-auth.js';

test('a personal token is served through the same getter', async () => {
  process.env.REVUTO_TEST_TOKEN = 'pat-abc';
  const auth = getOctokit({ tokenEnv: 'REVUTO_TEST_TOKEN' });
  assert.equal(typeof auth.token, 'function', 'token is resolved, never a captured string');
  assert.equal(await auth.token(), 'pat-abc');
  assert.equal(await auth.token(), 'pat-abc', 'stable across calls');
});
