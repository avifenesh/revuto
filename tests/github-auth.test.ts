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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildGhApiReadTool, type GhToolsDeps } from '../agents/common/src/tools/gh.js';
import { getOctokit } from '../agents/common/src/github-auth.js';

/** A `gh` on PATH that reports the token it was handed, so this needs no network. */
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-gh-'));
  const bin = join(dir, 'gh');
  writeFileSync(bin, '#!/bin/sh\nprintf %s "$GH_TOKEN"\n');
  chmodSync(bin, 0o755);
  return dir;
}

test('gh_api_read passes the current token to the subprocess, not the one it started with', async () => {
  const dir = fakeGh();
  const path = process.env.PATH;
  try {
    process.env.PATH = dir;
    let issued = 0;
    const gh = buildGhApiReadTool({
      token: async () => `token-${++issued}`,
      ctx: {},
      octokit: {},
    } as unknown as GhToolsDeps);

    assert.equal(await gh.callback({ path: 'repos/o/r/pulls/1' }), 'token-1');
    // Same tool object, a later call: a captured token would replay 'token-1'
    // here, which is the expired-credential failure this guards against.
    assert.equal(await gh.callback({ path: 'repos/o/r/pulls/1/files' }), 'token-2');
    assert.equal(issued, 2, 'one resolve per call');
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a personal token is served through the same getter', async () => {
  process.env.REVUTO_TEST_TOKEN = 'pat-abc';
  const auth = getOctokit({ tokenEnv: 'REVUTO_TEST_TOKEN' });
  assert.equal(typeof auth.token, 'function', 'token is resolved, never a captured string');
  assert.equal(await auth.token(), 'pat-abc');
  assert.equal(await auth.token(), 'pat-abc', 'stable across calls');
});
