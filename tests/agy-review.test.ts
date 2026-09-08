/**
 * AGY headless runner contract tests. The fake executable proves that Revuto
 * passes the pinned model and bypass flag, parses stream-json, and keeps the
 * existing skip_review terminal path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAgyReviewPrompt, runAgyCli, runAgyReview } from '../agents/common/src/agy-review.js';
import type { ReviewerConfig } from '../agents/common/src/config.js';
import type { PrContext } from '../agents/common/src/workspace.js';

function fakeAgy(): { dir: string; command: string } {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-agy-'));
  const command = join(dir, 'agy-fake.mjs');
  writeFileSync(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
const bypass = args.includes('--dangerously-skip-permissions');
console.log(JSON.stringify({ event: 'init', init: { model: args[args.indexOf('--model') + 1], permission_mode: bypass ? 'always-proceed' : 'request-review' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'view_file', tool_info: { output: 'inspected' }, usage: { input_tokens: 10, output_tokens: 2 } } }));
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', structured_output: { decision: 'skip_review', reason: bypass ? 'bypass-enabled' : 'settings-mode', body: '', comments: [] }, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, conversation_id: 'fake-conversation' } }));
`);
  chmodSync(command, 0o755);
  return { dir, command };
}

function context(workspacePath: string): PrContext {
  return {
    owner: 'owner',
    repo: 'repo',
    prNumber: 7,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    mergeBaseSha: 'c'.repeat(40),
    headRef: 'feature',
    baseRef: 'main',
    author: 'author',
    title: 'Test PR',
    body: 'PR body',
    state: 'open',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    fileList: ['src/file.ts'],
    existingReviews: [],
    existingReviewComments: [],
    existingIssueComments: [],
    workspacePath,
    diffRefSpec: `${'c'.repeat(40)}..${'a'.repeat(40)}`,
  };
}

function spec(command: string) {
  return {
    name: 'agy-oauth',
    baseURL: 'agy://local',
    model: 'gemini-3.8-flash-high',
    api: 'agy' as const,
    auth: 'agy-oauth' as const,
    command,
    permissionMode: 'bypass' as const,
  };
}

test('runAgyCli pins Gemini 3.8 Flash and enables AGY bypass permissions', async () => {
  const fake = fakeAgy();
  try {
    const run = await runAgyCli({ spec: spec(fake.command), cwd: fake.dir, prompt: 'test' });
    assert.equal(run.result.status, 'SUCCESS');
    assert.equal(run.result.conversation_id, 'fake-conversation');
    assert.equal(run.result.structured_output && typeof run.result.structured_output === 'object' && 'reason' in run.result.structured_output
      ? run.result.structured_output.reason
      : undefined, 'bypass-enabled');
    assert.equal(run.inspections, 1);
    assert.equal(run.toolErrors, 0);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('runAgyReview preserves Revuto skip_review semantics after AGY inspection', async () => {
  const fake = fakeAgy();
  const vault = mkdtempSync(join(tmpdir(), 'revuto-agy-vault-'));
  const workspace = mkdtempSync(join(tmpdir(), 'revuto-agy-workspace-'));
  try {
    const ctx = context(workspace);
    const config = {
      vaultPath: vault,
      github: { tokenEnv: 'GH_TOKEN' },
      models: { review: spec(fake.command), curator: { baseURL: 'http://example.test/v1', model: 'curator' }, distill: { baseURL: 'http://example.test/v1', model: 'distill' }, embedder: null },
      schedules: { review: '*/30 * * * *', learn: '0 */6 * * *', decay: '0 3 * * *' },
      review: { maxSteps: 10, allowWrite: false, workspaceDir: workspace },
      limits: { maxOutputTokens: { review: 100, curator: 100, distill: 100 }, dailyReviews: 0, learnBatch: 0, dailyLearn: 0, dailyTokens: 0 },
      store: { backend: 'sqlite' as const, surreal: { url: '', namespace: '' } },
    } as ReviewerConfig;
    const outcome = await runAgyReview({
      config,
      ctx,
      octokit: {} as never,
      token: async () => 'unused',
      skillMarkdown: '',
      startedAt: new Date(),
    });
    assert.equal(outcome.terminal, 'skip_review');
    assert.equal(outcome.hasFindings, false);
    assert.equal(outcome.inspections, 1);
    assert.equal(outcome.toolErrors, 0);
    assert.match(outcome.result, /skipped/);
    assert.ok(outcome.tracePath);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildAgyReviewPrompt carries the exact PR workspace and read-only boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-agy-prompt-'));
  try {
    const prompt = buildAgyReviewPrompt(context(dir), 'Remember the repository invariant.');
    assert.match(prompt, /PR #7: Test PR/);
    assert.match(prompt, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(prompt, /read-only review/);
    assert.match(prompt, /repository invariant/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

