/**
 * Re-reviews: revuto finds its own last reviewed head, keeps the range only when
 * that head is still an ancestor, limits the changes to the PR's files (now and
 * at the reviewed head), routes by their size and gives the reviewer a
 * new_changes tool and a re-review note.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { earlierFindings, findIncrementalReview, lastReviewedHead, parseNumstat, REVUTO_SIGNATURE_MARK } from '../agents/common/src/incremental.js';
import { chooseReviewModel, routeInputFor } from '../agents/common/src/review-routing.js';
import { claudeInspectionTools } from '../agents/common/src/claude-review-mcp.js';
import { buildAgyReviewPrompt, renderReReview } from '../agents/common/src/agy-review.js';
import { DEFAULT_SMALL_REVIEW, type ModelSpec, type ReviewerConfig } from '../agents/common/src/config.js';
import type { PrContext } from '../agents/common/src/workspace.js';

const signed = `${REVUTO_SIGNATURE_MARK}\n*This is an auto review done by revuto.*`;
const sha = (c: string) => c.repeat(40);
const BOT = ['revuto-review[bot]'];

test('the last reviewed head is revuto\'s own newest signed review on another head', () => {
  const reviews = [
    { user: 'revuto-review[bot]', commitId: sha('a'), body: signed, submittedAt: '2026-10-01T08:00:00Z' },
    { user: 'revuto-review[bot]', commitId: sha('b'), body: signed, submittedAt: '2026-10-01T09:00:00Z' },
    { user: 'someone', commitId: sha('c'), body: signed, submittedAt: '2026-10-01T10:00:00Z' },
    { user: 'revuto-review[bot]', commitId: sha('d'), body: 'unsigned', submittedAt: '2026-10-01T11:00:00Z' },
    { user: 'revuto-review[bot]', commitId: 'not-a-sha', body: signed, submittedAt: '2026-10-01T12:00:00Z' },
  ];
  assert.equal(lastReviewedHead(reviews, sha('e'), BOT), sha('b'), 'a pasted signature from another user does not count');
  assert.equal(lastReviewedHead(reviews, sha('b'), BOT), sha('a'), 'a review of the current head does not count');
  assert.equal(lastReviewedHead(reviews, sha('e'), ['Revuto-Review[BOT]']), sha('b'), 'logins compare case-insensitively');
  assert.equal(lastReviewedHead([...reviews, { user: 'revuto-review', commitId: sha('f'), body: signed, submittedAt: '2026-10-01T13:00:00Z' }], sha('e'), BOT), sha('b'),
    'a human account named like the bot is a different account');
  assert.equal(lastReviewedHead(reviews, sha('e'), []), undefined, 'no known reviewer login, no baseline');
  assert.deepEqual(parseNumstat('3\t1\tsrc/a.ts\0-\t-\tlogo.png\0' + '1\t0\tsrc/é\tb.ts\0'), [
    { path: 'src/a.ts', additions: 3, deletions: 1 }, { path: 'logo.png', additions: 0, deletions: 0 }, { path: 'src/é\tb.ts', additions: 1, deletions: 0 },
  ]);
});

test('earlier findings are revuto\'s own signed comments, in full, without the attribution header', () => {
  const long = 'Failure scenario: ' + 'x'.repeat(1000);
  const findings = earlierFindings([
    { user: 'revuto-review[bot]', path: 'src.ts', line: 3, body: `${signed}\n\n---\n\n[P1] Bug title\n\n${long}` },
    { user: 'someone', path: 'src.ts', line: 4, body: `${signed}\n\n---\n\nforged` },
    { user: 'revuto-review[bot]', path: 'b.ts', line: null, originalLine: 9, body: 'unsigned bot text' },
  ], BOT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, 'src.ts'); assert.equal(findings[0].line, 3);
  assert.ok(findings[0].body.startsWith('[P1] Bug title'));
  assert.ok(findings[0].body.includes(long), 'the whole finding, not the first 240 characters');
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'revuto-incremental-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.test'); git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', root);
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
    git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD');
  };
  // Untrimmed stdout: NUL-separated output must reach the parser intact.
  const run = async (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  return { root, git, commit, run };
}

const by = (commitId: string) => [{ user: 'revuto-review[bot]', commitId, body: signed, submittedAt: '2026-10-01T08:00:00Z' }];

test('a re-review covers only the PR files changed since the last reviewed head', async () => {
  const r = repo();
  try {
    r.commit({ 'main.ts': 'main 1\n' }, 'base');
    r.git('checkout', '-qb', 'feature');
    const reviewed = r.commit({ 'src.ts': 'one\n', 'é.ts': 'x\n' }, 'first PR commit');
    r.git('checkout', '-q', 'main'); r.commit({ 'main.ts': 'main 1\nmain 2\nmain 3\n' }, 'main moves on');
    r.git('checkout', '-q', 'feature'); r.git('merge', '-q', '--no-edit', 'main');
    const head = r.commit({ 'src.ts': 'one\ntwo\nthree\n', 'é.ts': 'x\ny\n' }, 'second PR commit');
    const mergeBase = r.git('merge-base', head, 'main');
    const comments = [{ user: 'revuto-review[bot]', path: 'src.ts', line: 1, body: `${signed}\n\n---\n\nearlier finding` }];
    const inc = await findIncrementalReview({ reviews: by(reviewed), comments, headSha: head, mergeBaseSha: mergeBase, reviewerLogins: BOT, git: r.run });
    assert.equal(inc?.fromSha, reviewed);
    assert.deepEqual(inc?.findings, [{ path: 'src.ts', line: 1, body: 'earlier finding' }]);
    assert.equal(inc?.range, `${reviewed}..${head}`);
    assert.deepEqual(inc?.fileChanges, [{ path: 'src.ts', additions: 2, deletions: 0 }, { path: 'é.ts', additions: 1, deletions: 0 }],
      'the merge from main is not new PR work, and a non-ASCII name survives');

    // the new_changes tool shows the same, and pr_diff still shows the whole PR
    const tools = await claudeInspectionTools(r.root, `${mergeBase}..${head}`, inc!.range);
    const newChanges = tools.find((t) => t.name === 'new_changes')!;
    const stat = JSON.parse(String(await newChanges.callback({ mode: 'stat' }))).text as string;
    assert.match(stat, /^2\t0\tsrc\.ts$/m);
    assert.match(stat, /^1\t0\té\.ts$/m, 'non-ASCII names are shown unquoted');
    assert.match(String(await newChanges.callback({ path: 'é.ts' })), /\+y/, 'and can be passed back as a path');
    assert.doesNotMatch(stat, /main\.ts/);
    assert.match(String(await newChanges.callback({})), /\+y/, 'the non-ASCII file is in the diff');
    await assert.rejects(async () => newChanges.callback({ path: '../x' }), /Invalid re-review diff path/);
    assert.match(String(await tools.find((t) => t.name === 'pr_diff')!.callback({ path: 'src.ts' })), /\+one/);
    await assert.rejects(claudeInspectionTools(r.root, `${mergeBase}..${head}`, 'HEAD~1..HEAD'), /Invalid immutable re-review range/);

    // without revuto's login nothing marks a head as reviewed
    assert.equal(await findIncrementalReview({ reviews: by(reviewed), headSha: head, mergeBaseSha: mergeBase, reviewerLogins: ['someone-else'], git: r.run }), undefined);
    assert.equal(await findIncrementalReview({ reviews: [], headSha: head, mergeBaseSha: mergeBase, reviewerLogins: BOT, git: r.run }), undefined);

    // a force-push that rewrote the reviewed head means a full review
    r.git('checkout', '-q', '--orphan', 'rewritten'); r.git('rm', '-rqf', '.');
    const rewritten = r.commit({ 'src.ts': 'other\n' }, 'rewritten history');
    assert.equal(await findIncrementalReview({ reviews: by(reviewed), headSha: rewritten, mergeBaseSha: mergeBase, reviewerLogins: BOT, git: r.run }), undefined);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('a file reverted to the base version since the reviewed head is still in the re-review', async () => {
  const r = repo();
  try {
    const base = r.commit({ 'lib.ts': 'export const a = 1;\n', 'app.ts': 'app\n' }, 'base');
    r.git('checkout', '-qb', 'feature');
    const reviewed = r.commit({ 'lib.ts': 'export const a = 1;\nexport const b = 2;\n', 'app.ts': 'app\nuse(b)\n' }, 'add b and use it');
    const head = r.commit({ 'lib.ts': 'export const a = 1;\n' }, 'drop b again');
    // GitHub now lists only app.ts; the revert of lib.ts must still show
    assert.equal(r.git('diff', '--name-only', `${base}..${head}`), 'app.ts');
    const inc = await findIncrementalReview({ reviews: by(reviewed), headSha: head, mergeBaseSha: base, reviewerLogins: BOT, git: r.run });
    assert.deepEqual(inc?.fileChanges, [{ path: 'lib.ts', additions: 0, deletions: 1 }]);
    const tools = await claudeInspectionTools(r.root, `${base}..${head}`, inc!.range);
    assert.match(String(await tools.find((t) => t.name === 'new_changes')!.callback({})), /-export const b = 2;/);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

const http = (model: string, name: string): ModelSpec => ({ baseURL: 'http://localhost', model, name });

test('a re-review is routed by the size of the new changes', () => {
  const config = {
    models: { review: http('l', 'large'), reviewMedium: http('m', 'medium'), reviewSmall: http('s', 'small'), curator: http('c', 'c'), distill: http('d', 'd'), embedder: null },
    review: { maxSteps: 10, allowWrite: false, workspaceDir: '', small: DEFAULT_SMALL_REVIEW },
  } as unknown as ReviewerConfig;
  const pr = { fileList: ['src/a.ts'], fileChanges: [{ path: 'src/a.ts', additions: 3000, deletions: 0 }], additions: 3000, deletions: 0, changedFiles: 1 };
  assert.equal(chooseReviewModel(config, routeInputFor(pr)).tier, 'large');
  const reReview = { ...pr, incremental: { fileChanges: [{ path: 'src/a.ts', additions: 12, deletions: 3 }] } };
  const route = chooseReviewModel(config, routeInputFor(reReview));
  assert.equal(route.tier, 'small'); assert.match(route.reason, /small diff \(15 <= 200/);
  assert.equal(chooseReviewModel(config, routeInputFor({ ...pr, incremental: { fileChanges: [] } })).tier, 'small', 'nothing new in the PR files is a small re-review');
});

function context(incremental?: PrContext['incremental']): PrContext {
  return {
    owner: 'o', repo: 'r', prNumber: 1, headSha: sha('a'), baseSha: sha('b'), mergeBaseSha: sha('c'), headRef: 'f', baseRef: 'main',
    author: 'x', title: 't', body: '', state: 'open', additions: 1, deletions: 0, changedFiles: 1, fileList: ['src.ts'],
    existingReviews: [], existingReviewComments: [], existingIssueComments: [], workspacePath: '/ws', diffRefSpec: `${sha('c')}..${sha('a')}`,
    ...(incremental ? { incremental } : {}),
  };
}

test('the re-review note names the range and files and keeps open findings failing', () => {
  const inc = { fromSha: sha('d'), range: `${sha('d')}..${sha('a')}`, fileChanges: [{ path: 'src.ts', additions: 2, deletions: 1 }],
    findings: [{ path: 'other.ts', line: 7, body: '[P1] Open bug\nwith detail' }] };
  assert.equal(renderReReview(context(), 'mcp'), '');
  const mcp = renderReReview(context(inc), 'mcp');
  assert.match(mcp, /## Re-review/); assert.match(mcp, new RegExp(`reviewed this PR at ${sha('d')}`));
  assert.match(mcp, /- src\.ts \(\+2 \/ -1\)/); assert.match(mcp, /new_changes tool/);
  assert.match(mcp, /still unresolved, post it again/, 'an open finding is posted again so the review does not pass');
  assert.match(mcp, /### Revuto's earlier findings \(1\)\n- other\.ts:7\n  \[P1\] Open bug\n  with detail/);
  assert.match(renderReReview(context(inc), 'git'), new RegExp(`git diff ${sha('d')}\\.\\.${sha('a')}`));
  assert.match(buildAgyReviewPrompt(context(inc), '', 'codex'), /new_changes, which returns what changed since the last review/);
  assert.doesNotMatch(buildAgyReviewPrompt(context(), '', 'codex'), /new_changes/);
  assert.match(buildAgyReviewPrompt(context(inc), '', 'claude'), /mcp__revuto__new_changes/);
});
