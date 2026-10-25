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

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubAuthForRepo } from '../agents/common/src/github-auth.js';

/** A fake GitHub API: the App endpoints, one installation, and a /user that must not be needed. */
function fakeGithub(opts: { installed: boolean }) {
  const calls: Array<{ method: string; path: string; auth: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    calls.push({ method, path: url.pathname, auth });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/installation')) return opts.installed ? json(200, { id: 42 }) : json(404, { message: 'Not Found' });
    if (url.pathname === '/app/installations/42/access_tokens') {
      return json(201, { token: 'ghs_installation', expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { pull_requests: 'write' }, repository_selection: 'selected' });
    }
    if (url.pathname === '/app') return json(200, { slug: 'revuto-test', id: 1 });
    if (url.pathname === '/user') return json(403, { message: 'Resource not accessible by integration' });
    if (url.pathname.startsWith('/repos/')) return json(200, { ok: true });
    return json(500, { message: `unexpected ${method} ${url.pathname}` });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function appConfig(appId: number, allowedOwners: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-app-auth-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPath = join(dir, 'app.pem');
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  return { dir, app: { appId, privateKeyPath, allowedOwners } as never };
}

test('a repo the App serves uses its installation token and never the personal token', async () => {
  const { dir, app } = appConfig(9001, ['owner']);
  const github = fakeGithub({ installed: true });
  process.env.REVUTO_TEST_TOKEN = 'pat-must-not-be-used';
  try {
    const auth = await githubAuthForRepo({ tokenEnv: 'REVUTO_TEST_TOKEN', app }, 'owner/repo');
    assert.equal(await auth.token(), 'ghs_installation');
    await auth.octokit.request('GET /repos/{owner}/{repo}', { owner: 'owner', repo: 'repo' });
    const repoCall = github.calls.find((c) => c.path === '/repos/owner/repo');
    assert.equal(repoCall?.auth, 'token ghs_installation');
    assert.ok(github.calls.every((c) => !c.auth.includes('pat-must-not-be-used')), 'the personal token is never sent');
    assert.ok(!github.calls.some((c) => c.path === '/user'));
  } finally {
    github.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repo outside the App falls back to the personal token', async () => {
  const { dir, app } = appConfig(9002, ['someone-else']);
  const github = fakeGithub({ installed: true });
  process.env.REVUTO_TEST_TOKEN = 'pat-outside';
  try {
    const auth = await githubAuthForRepo({ tokenEnv: 'REVUTO_TEST_TOKEN', app }, 'owner/repo');
    // getOctokit caches the personal token for the process, so compare with it.
    assert.equal(auth, getOctokit({ tokenEnv: 'REVUTO_TEST_TOKEN' }));
    assert.ok(!github.calls.some((c) => c.path.startsWith('/app')), 'the App is not asked');
  } finally {
    github.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an allowed owner without an installation on the repo falls back to the personal token', async () => {
  const { dir, app } = appConfig(9003, ['owner']);
  const github = fakeGithub({ installed: false });
  process.env.REVUTO_TEST_TOKEN = 'pat-not-installed';
  try {
    const auth = await githubAuthForRepo({ tokenEnv: 'REVUTO_TEST_TOKEN', app }, 'owner/other');
    assert.equal(auth, getOctokit({ tokenEnv: 'REVUTO_TEST_TOKEN' }));
    assert.ok(github.calls.some((c) => c.path === '/repos/owner/other/installation'), 'the App was asked first');
  } finally {
    github.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { reviewerIdentities } from '../daemon/src/jobs.js';

test("with the App, revuto's own logins come from the App, not from /user", async () => {
  const { dir, app } = appConfig(9004, ['owner']);
  const github = fakeGithub({ installed: true });
  try {
    const config = { github: { tokenEnv: 'REVUTO_TEST_TOKEN', app } } as never;
    const auth = await githubAuthForRepo({ tokenEnv: 'REVUTO_TEST_TOKEN', app }, 'owner/repo');
    const logins = await reviewerIdentities(config, { repo: 'owner/repo', botLogin: 'old-pat-user' }, auth);
    assert.ok(logins.includes('revuto-test[bot]'), JSON.stringify(logins));
    assert.ok(logins.includes('old-pat-user'), 'reviews posted under the registered login still count');
    assert.ok(!github.calls.some((c) => c.path === '/user'));
  } finally {
    github.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
