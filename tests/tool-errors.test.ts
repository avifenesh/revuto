/**
 * Every tool surface has to report failure as a string starting with `ERROR`.
 * That string is the only thing separating "inspected the diff" from "the tool
 * surface was broken": `summarizeReviewSteps` counts anything else as a
 * successful inspection, and the check gate approves a skip that inspected
 * something. `git` and `gh api` used to return bare failure text, so a run whose
 * every call failed still looked inspected and still got a green check.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildGitTool } from '../agents/common/src/tools/git.js';
import { buildGhApiReadTool, buildPostReviewTool, type GhToolsDeps } from '../agents/common/src/tools/gh.js';
import { isToolErrorOutput } from '../agents/common/src/trace.js';
import { summarizeReviewSteps } from '../agents/common/src/run-agent.js';

/** A one-commit repo, so git calls have something real to succeed or fail against. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-tools-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'main.rs'), 'fn main() {}\n');
  git('add', 'main.rs');
  git('commit', '-qm', 'first');
  return dir;
}

const gitCall = (root: string, args: string[]) =>
  buildGitTool({ workspaceRoot: root }).callback({ args }) as Promise<string>;

/** What the engine makes of a single tool result. */
const asStep = (toolName: string, output: unknown) => summarizeReviewSteps([{ toolResults: [{ toolName, output }] }]);

test('a git call that fails is reported with the ERROR prefix and does not count as inspection', async () => {
  const dir = repo();
  try {
    const out = await gitCall(dir, ['show', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
    assert.equal(isToolErrorOutput(out), true, `expected an ERROR result, got: ${out.slice(0, 200)}`);
    const s = asStep('git', out);
    assert.equal(s.inspections, 0);
    assert.equal(s.toolErrors, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a git grep with no match is an answer, not a failure', async () => {
  const dir = repo();
  try {
    // git overloads exit 1 for "nothing matched". Reporting that as ERROR would
    // undercount inspections and fail the check on a review that did its job.
    const out = await gitCall(dir, ['grep', 'nothing-here-at-all']);
    assert.equal(isToolErrorOutput(out), false, `expected a plain result, got: ${out.slice(0, 200)}`);
    assert.match(out, /no results/);
    assert.equal(asStep('git', out).inspections, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a git call that works counts as inspection', async () => {
  const dir = repo();
  try {
    const out = await gitCall(dir, ['log', '--oneline', '-1']);
    assert.equal(isToolErrorOutput(out), false);
    assert.match(out, /first/);
    assert.equal(asStep('git', out).inspections, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an off-allowlist git subcommand is an ERROR', async () => {
  const dir = repo();
  try {
    assert.equal(isToolErrorOutput(await gitCall(dir, ['push', 'origin', 'main'])), true);
    assert.equal(isToolErrorOutput(await gitCall(dir, ['log', '--exec=touch /tmp/x'])), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an off-allowlist gh api path is an ERROR', async () => {
  const gh = buildGhApiReadTool({ token: async () => 'unused', ctx: {}, octokit: {} } as unknown as GhToolsDeps);
  const out = (await gh.callback({ path: 'repos/o/r/pulls/1/merge' })) as string;
  assert.equal(isToolErrorOutput(out), true);
  assert.equal(asStep('gh_api_read', out).inspections, 0);
});

test('post_review refuses a review with nothing anchored, and reports what it posted', async () => {
  // agent-sh/agent-workspace-linux#70: a clean review went out through post_review
  // with an empty `comments`, and the check reported "posted one or more findings" on
  // a pull request that had none. Nothing downstream can tell a "nothing to flag"
  // body from one carrying concerns, so the empty post is refused here instead of
  // being guessed at afterwards — the clean path is skip_review.
  const posts: unknown[] = [];
  const deps = {
    token: async () => 'unused',
    ctx: { owner: 'agent-sh', repo: 'agent-workspace-linux', prNumber: 70, headSha: 'b851423' },
    octokit: {
      pulls: {
        createReview: async (args: unknown) => {
          posts.push(args);
          return { data: { id: 1, html_url: 'https://example.invalid/pull/70#r1' } };
        },
      },
    },
  } as unknown as GhToolsDeps;
  const post = buildPostReviewTool(deps);

  const refused = (await post.callback({ body: 'Clean change; no inline comments.', comments: [] })) as string;
  assert.equal(isToolErrorOutput(refused), true, `expected an ERROR result, got: ${refused.slice(0, 200)}`);
  assert.match(refused, /skip_review/);
  assert.equal(posts.length, 0, 'a refused post must not reach the API');
  const refusedStep = asStep('post_review', refused);
  assert.equal(refusedStep.hasFindings, false);
  // The refusal dropped nothing, so it is not a lost review: the model is expected
  // to follow it with skip_review, and that has to stay a passing clean decision.
  assert.equal(refusedStep.postFailures, 0);

  const posted = (await post.callback({
    body: '',
    comments: [{ path: 'src/server.rs', line: 3137, body: 'Non-blocking: name the TTL.' }],
  })) as string;
  assert.equal(isToolErrorOutput(posted), false, `expected a posted result, got: ${posted.slice(0, 200)}`);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posted).inline_comments, 1);
  assert.equal(asStep('post_review', posted).hasFindings, true);
});

test('a binary that cannot be spawned fails the call instead of taking the process down', async () => {
  const dir = repo();
  const path = process.env.PATH;
  try {
    // No PATH, no `git` and no `gh`: spawn raises ENOENT. An unhandled 'error'
    // event on the child would kill the daemon mid-review, and the review engine
    // has to see these as failed calls, not as inspection.
    process.env.PATH = '';
    const gitOut = await gitCall(dir, ['log', '--oneline', '-1']);
    assert.equal(isToolErrorOutput(gitOut), true, `expected an ERROR result, got: ${gitOut.slice(0, 200)}`);

    const gh = buildGhApiReadTool({ token: async () => 'unused', ctx: {}, octokit: {} } as unknown as GhToolsDeps);
    const ghOut = (await gh.callback({ path: 'repos/o/r/pulls/1' })) as string;
    assert.equal(isToolErrorOutput(ghOut), true, `expected an ERROR result, got: ${ghOut.slice(0, 200)}`);

    // The whole point: a run made only of these is not a reviewed run.
    const s = summarizeReviewSteps([
      { toolResults: [{ toolName: 'git', output: gitOut }, { toolName: 'gh_api_read', output: ghOut }] },
      { toolResults: [{ toolName: 'skip_review', output: '{"skipped":true}' }] },
    ]);
    assert.equal(s.inspections, 0);
    assert.equal(s.toolErrors, 2);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});
