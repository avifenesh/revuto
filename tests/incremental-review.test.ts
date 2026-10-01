/**
 * Re-reviews: revuto finds its last reviewed head, keeps the range only when
 * that head is still an ancestor, limits the changes to the PR's files, routes
 * by their size and gives the reviewer a new_changes tool and a re-review note.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findIncrementalReview, lastReviewedHead, parseNumstat, REVUTO_SIGNATURE_MARK } from '../agents/common/src/incremental.js';
import { chooseReviewModel, routeInputFor } from '../agents/common/src/review-routing.js';
import { claudeInspectionTools } from '../agents/common/src/claude-review-mcp.js';
import { buildAgyReviewPrompt, renderReReview } from '../agents/common/src/agy-review.js';
import { DEFAULT_SMALL_REVIEW, type ModelSpec, type ReviewerConfig } from '../agents/common/src/config.js';
import type { PrContext } from '../agents/common/src/workspace.js';

const signed = `${REVUTO_SIGNATURE_MARK}\n*This is an auto review done by revuto.*`;
const sha = (c: string) => c.repeat(40);

test('the last reviewed head is revuto\'s newest signed review on another head', () => {
  const reviews = [
    { commitId: sha('a'), body: signed, submittedAt: '2026-10-01T08:00:00Z' },
    { commitId: sha('b'), body: signed, submittedAt: '2026-10-01T09:00:00Z' },
    { commitId: sha('c'), body: 'a human review', submittedAt: '2026-10-01T10:00:00Z' },
    { commitId: sha('d'), body: signed, submittedAt: '2026-10-01T11:00:00Z' },
    { commitId: 'not-a-sha', body: signed, submittedAt: '2026-10-01T12:00:00Z' },
  ];
  assert.equal(lastReviewedHead(reviews, sha('e')), sha('d'));
  assert.equal(lastReviewedHead(reviews, sha('d')), sha('b'), 'a review of the current head does not count');
  assert.equal(lastReviewedHead([{ commitId: sha('a'), body: 'unsigned' }], sha('e')), undefined);
  assert.deepEqual(parseNumstat('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n\n'), [
    { path: 'src/a.ts', additions: 3, deletions: 1 }, { path: 'logo.png', additions: 0, deletions: 0 },
  ]);
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'revuto-incremental-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.test'); git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', root);
  const commit = (file: string, text: string, message: string) => { writeFileSync(join(root, file), text); git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  return { root, git, commit, run: async (args: string[]) => git(...args) };
}

test('a re-review covers only the PR files changed since the last reviewed head', async () => {
  const r = repo();
  try {
    const base = r.commit('main.ts', 'main 1\n', 'base');
    r.git('checkout', '-qb', 'feature');
    const reviewed = r.commit('src.ts', 'one\n', 'first PR commit');
    r.git('checkout', '-q', 'main'); r.commit('main.ts', 'main 1\nmain 2\nmain 3\n', 'main moves on');
    r.git('checkout', '-q', 'feature'); r.git('merge', '-q', '--no-edit', 'main');
    const head = r.commit('src.ts', 'one\ntwo\nthree\n', 'second PR commit');
    const inc = await findIncrementalReview({
      reviews: [{ commitId: reviewed, body: signed, submittedAt: '2026-10-01T08:00:00Z' }],
      headSha: head, prFiles: ['src.ts'], changedFiles: 1, git: r.run,
    });
    assert.equal(inc?.fromSha, reviewed);
    assert.equal(inc?.range, `${reviewed}..${head}`);
    assert.deepEqual(inc?.fileChanges, [{ path: 'src.ts', additions: 2, deletions: 0 }], 'the merge from main is not new PR work');

    // the new_changes tool shows the same, and pr_diff still shows the whole PR
    // the PR range starts at the merge base, which the merge from main moved to main's tip
    const mergeBase = r.git('merge-base', head, 'main');
    assert.notEqual(mergeBase, base);
    const tools = await claudeInspectionTools(r.root, `${mergeBase}..${head}`, inc!.range);
    const newChanges = tools.find((t) => t.name === 'new_changes')!;
    const page = JSON.parse(String(await newChanges.callback({ mode: 'stat' })));
    assert.equal(page.text.trim(), '2\t0\tsrc.ts');
    assert.doesNotMatch(String(await newChanges.callback({})), /main 2/);
    await assert.rejects(async () => newChanges.callback({ path: '../x' }), /Invalid re-review diff path/);
    assert.match(String(await tools.find((t) => t.name === 'pr_diff')!.callback({ path: 'src.ts' })), /\+one/);
    await assert.rejects(claudeInspectionTools(r.root, `${mergeBase}..${head}`, 'HEAD~1..HEAD'), /Invalid immutable re-review range/);

    // a force-push that rewrote the reviewed head means a full review
    r.git('checkout', '-q', '--orphan', 'rewritten'); r.git('rm', '-rqf', '.');
    const rewritten = r.commit('src.ts', 'other\n', 'rewritten history');
    assert.equal(await findIncrementalReview({ reviews: [{ commitId: reviewed, body: signed }], headSha: rewritten, prFiles: ['src.ts'], changedFiles: 1, git: r.run }), undefined);
    // so does a file list cut at one page, or no earlier revuto review
    assert.equal(await findIncrementalReview({ reviews: [{ commitId: reviewed, body: signed }], headSha: head, prFiles: ['src.ts'], changedFiles: 150, git: r.run }), undefined);
    assert.equal(await findIncrementalReview({ reviews: [], headSha: head, prFiles: ['src.ts'], changedFiles: 1, git: r.run }), undefined);
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

test('the re-review note names the range, the files and how to read them', () => {
  const inc = { fromSha: sha('d'), range: `${sha('d')}..${sha('a')}`, fileChanges: [{ path: 'src.ts', additions: 2, deletions: 1 }] };
  assert.equal(renderReReview(context(), 'mcp'), '');
  const mcp = renderReReview(context(inc), 'mcp');
  assert.match(mcp, /## Re-review/); assert.match(mcp, new RegExp(`reviewed this PR at ${sha('d')}`));
  assert.match(mcp, /- src\.ts \(\+2 \/ -1\)/); assert.match(mcp, /new_changes tool/); assert.match(mcp, /Do not post an earlier finding again/);
  assert.match(renderReReview(context(inc), 'git'), new RegExp(`git diff ${sha('d')}\\.\\.${sha('a')}`));
  assert.match(buildAgyReviewPrompt(context(inc), '', 'codex'), /new_changes, which returns what changed since the last review/);
  assert.doesNotMatch(buildAgyReviewPrompt(context(), '', 'codex'), /new_changes/);
  assert.match(buildAgyReviewPrompt(context(inc), '', 'claude'), /mcp__revuto__new_changes/);
});
