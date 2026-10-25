/**
 * Reviewer sandbox contracts: what a reviewer can touch, what counts as having
 * inspected a PR, and what revuto lets out to GitHub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { redactSecrets, sanitizeOutbound } from '../agents/common/src/outbound.js';
import { buildPostIssueCommentTool, buildPostReviewTool, type GhToolsDeps } from '../agents/common/src/tools/gh.js';
import { assembleCommonTools } from '../agents/common/src/tools/index.js';
import { agyEnvironment, runAgyCli } from '../agents/common/src/agy-review.js';
import { CODEX_DISABLED_FEATURES, codexExecArgs, normalizeCodexEvents } from '../agents/common/src/codex-review.js';
import { publicErrorText } from '../daemon/src/review-check.js';
import { rgScopeFlags } from '../agents/common/src/rg-scope.js';
import type { PrContext } from '../agents/common/src/workspace.js';

const SECRET = 'ghp_' + 'A'.repeat(36);

test('outbound text loses mentions, HTML, remote images and ChatOps lines, but code stays', () => {
  const out = sanitizeOutbound([
    'cc @maintainer and @org/team',
    '<!-- revuto-signed --> <img src=https://evil/x.png> ![pixel](https://evil/p.gif)',
    '/approve',
    '  /merge now',
    '```ts',
    'const x = a @b; // <div>',
    '```',
    'inline `@keep <b>` here',
  ].join('\n'));
  assert.doesNotMatch(out, /(^|\s)@maintainer/, 'a mention no longer notifies');
  assert.match(out, /@\u200Bmaintainer/);
  assert.doesNotMatch(out, /<!--|<img/, 'no raw HTML or hidden comment, so the revuto marker cannot be forged');
  assert.doesNotMatch(out, /!\[pixel\]/, 'a remote image becomes a link');
  assert.doesNotMatch(out, /^\s*\/(approve|merge)/m, 'no line starts a slash command');
  assert.match(out, /const x = a @b; \/\/ <div>/, 'fenced code is unchanged');
  assert.match(out, /`@keep <b>`/, 'inline code is unchanged');
});

test('secrets are redacted everywhere, code blocks included', () => {
  const env = { GH_TOKEN: 'live-token-value-123456', HOME: '/home/someone-long-name', SHORT_KEY: 'abc' };
  const out = sanitizeOutbound(`token ${SECRET}\n\`\`\`\nexport GH_TOKEN=live-token-value-123456\n\`\`\``, env);
  assert.doesNotMatch(out, /ghp_A{36}/);
  assert.doesNotMatch(out, /live-token-value-123456/);
  assert.equal(redactSecrets('HOME is /home/someone-long-name', env), 'HOME is /home/someone-long-name', 'only credential-named variables are secrets');
  assert.match(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), /^\[redacted\]$/);
});

function fakeOctokit() {
  const reviews: any[] = [], comments: any[] = [];
  return {
    reviews, comments,
    octokit: {
      pulls: { createReview: async (r: any) => { reviews.push(r); return { data: { id: reviews.length, html_url: 'u' } }; } },
      issues: { createComment: async (c: any) => { comments.push(c); return { data: { id: comments.length, html_url: 'u' } }; } },
    },
  };
}

const ctx = { owner: 'o', repo: 'r', prNumber: 7, headSha: 'a'.repeat(40) } as unknown as PrContext;

test('post_review posts once, sanitized, with a bounded comment count', async () => {
  const gh = fakeOctokit();
  const deps = { ctx, octokit: gh.octokit, token: async () => 't' } as unknown as GhToolsDeps;
  const post = buildPostReviewTool(deps);
  const comment = { path: 'a.ts', line: 1, body: `leak ${SECRET} @someone` };
  const both = await Promise.all([post.callback({ body: 'sum', comments: [comment] } as never), post.callback({ body: 'again', comments: [comment] } as never)]);
  assert.equal(gh.reviews.length, 1, 'two calls in one step still post one review');
  assert.match(String(both[1]), /already posted/);
  assert.doesNotMatch(JSON.stringify(gh.reviews[0]), /ghp_A{36}|[^\u200B]@someone/);
  const many = buildPostReviewTool(deps);
  assert.match(String(await many.callback({ body: '', comments: Array.from({ length: 51 }, () => comment) } as never)), /at most 50/);
  const issue = buildPostIssueCommentTool(deps);
  await issue.callback({ body: 'one' } as never);
  assert.match(String(await issue.callback({ body: 'two' } as never)), /one issue comment per run/);
  assert.equal(gh.comments.length, 1);
});

test('the HTTP reviewer gets only guarded inspection tools and the posting tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revuto-http-tools-'));
  try {
    const tools = await assembleCommonTools({ ctx: { ...ctx, workspacePath: root, diffRefSpec: `${'c'.repeat(40)}..${'a'.repeat(40)}` } as PrContext, octokit: {} as never, token: async () => 't' });
    assert.deepEqual(tools.map((t) => t.name).sort(), ['glob', 'grep', 'post_issue_comment', 'post_review', 'pr_diff', 'read', 'skip_review']);
    const withWrite = await assembleCommonTools({ ctx: { ...ctx, workspacePath: root, diffRefSpec: `${'c'.repeat(40)}..${'a'.repeat(40)}` } as PrContext, octokit: {} as never, token: async () => 't', allowWrite: true });
    assert.ok(withWrite.some((t) => t.name === 'write') && !withWrite.some((t) => /bash|git|lsp|gh_api/.test(t.name)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AGY runs with a private home and no daemon credentials', async () => {
  const env = agyEnvironment('/private', '/work', { HOME: '/home/op', PATH: '/bin', GH_TOKEN: 'x', AWS_BEARER_TOKEN_BEDROCK: 'y', REVUTO_GITHUB_WEBHOOK_SECRET: 'z', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus' });
  assert.equal(env.HOME, '/private');
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/bus', 'the keyring login stays reachable');
  for (const key of ['GH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'REVUTO_GITHUB_WEBHOOK_SECRET']) assert.equal(env[key], undefined, key);

  const dir = mkdtempSync(join(tmpdir(), 'revuto-agy-iso-'));
  const command = join(dir, 'agy-fake.mjs');
  writeFileSync(command, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const settings = process.env.HOME + '/.gemini/antigravity-cli/settings.json';
writeFileSync(process.argv[1] + '.last', JSON.stringify({ args: process.argv.slice(2), env: process.env, settings: existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : null }));
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }));
`);
  chmodSync(command, 0o755);
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'must-not-leak';
  try {
    await runAgyCli({ spec: { baseURL: 'agy://local', api: 'agy', auth: 'agy-oauth', model: 'gemini', command }, cwd: dir, prompt: 'p' }).catch(() => undefined);
    const last = JSON.parse(readFileSync(command + '.last', 'utf8'));
    assert.equal(last.env.GH_TOKEN, undefined);
    assert.notEqual(last.env.HOME, homedir());
    assert.deepEqual(last.settings, { toolPermission: 'always-proceed', allowNonWorkspaceAccess: false, trustedWorkspaces: [] });
    assert.ok(last.args.includes('--sandbox'));
    assert.equal(existsSync(last.env.HOME), false, 'the private home is removed after the run');
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex runs with extra tools off, one thread, and counts every tool item as a step', () => {
  const args = codexExecArgs({ spec: { baseURL: 'codex://bedrock', api: 'codex', model: 'openai.gpt-6.1-sol' }, cwd: '.' });
  const configs = args.filter((_, i) => args[i - 1] === '-c');
  for (const f of ['view_image', 'multi_agent', 'code_mode_host', 'memories', 'hooks']) assert.ok(CODEX_DISABLED_FEATURES.includes(f as never) && configs.includes(`features.${f}=false`), f);
  assert.ok(configs.includes('agents.max_concurrent_threads_per_session=1') && configs.includes('agents.max_depth=0'));
  const [step] = normalizeCodexEvents({ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'spawn_agent' } }, {});
  assert.equal((step as any).step_update.step_type, 'tool', 'a sub-agent call is a tool call for review.maxSteps');
  assert.deepEqual(normalizeCodexEvents({ type: 'item.completed', item: { type: 'reasoning', text: 'x' } }, {}), []);
});

test('public check errors are short and carry no credentials, ARNs, account ids or home paths', () => {
  const text = publicErrorText([
    `AccessDenied: arn:aws:iam::123456789012:role/x is not authorized`,
    `at ${homedir()}/projects/revuto/dist/x.js:1`,
    `token ${SECRET}`,
    ...Array.from({ length: 20 }, (_, i) => `stderr line ${i} ${'y'.repeat(400)}`),
  ].join('\n'));
  assert.doesNotMatch(text, /123456789012|arn:aws|ghp_A{36}/);
  assert.ok(!text.includes(homedir()));
  assert.match(text, /more lines in the daemon log/);
  assert.ok(text.split('\n').every((l) => l.length <= 302));
});

test('a PR cannot hide its own files from search with .ignore or .rgignore', () => {
  assert.ok(rgScopeFlags('/nonexistent').includes('--no-ignore-dot'));
  assert.ok(readFileSync(join(import.meta.dirname, '..', 'agents', 'common', 'rg', 'scope.rc'), 'utf8').includes('--no-ignore-dot'));
});
