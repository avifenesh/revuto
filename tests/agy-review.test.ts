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

import { buildAgyReviewPrompt, normalizeClaudeEvents, runAgyCli, runAgyReview } from '../agents/common/src/agy-review.js';
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

test('Claude print mode pins Opus and preserves read-only inspection and structured output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-claude-'));
  const command = join(dir, 'claude-fake.mjs');
  writeFileSync(command, `#!/usr/bin/env node
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(args[0], '-p');
assert.equal(args[args.indexOf('--model') + 1], 'global.anthropic.claude-opus-5[1m]');
assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
assert.equal(args[args.indexOf('--tools') + 1], '');
assert.equal(args[args.indexOf('--setting-sources') + 1], '');
assert.ok(args.includes('--restricted'));
assert.deepEqual(Object.keys(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers), ['revuto']);
assert.ok(args.includes('--bare') && args.includes('--verbose') && args.includes('--strict-mcp-config'));
assert.ok(!args.includes('--print-timeout') && !args.includes('--dangerously-skip-permissions'));
console.log(JSON.stringify({type:'system', subtype:'init', model:'global.anthropic.claude-opus-5[1m]'}));
if (!args[1].includes('terminal-only')) {
  console.log(JSON.stringify({type:'assistant', message:{content:[{type:'tool_use',id:'read-1',name:'mcp__revuto__read'}]}}));
  console.log(JSON.stringify({type:'user', message:{content:[{type:'tool_result',tool_use_id:'read-1',content:'actual file contents'}]}}));
}
console.log(JSON.stringify({type:'assistant', message:{content:[{type:'tool_use',id:'schema-1',name:'StructuredOutput'}]}}));
console.log(JSON.stringify({type:'user', message:{content:[{type:'tool_result',tool_use_id:'schema-1',content:'verdict accepted'}]}}));
console.log(JSON.stringify({type:'result',subtype:args[1]==='fail'?'error_during_execution':'success',is_error:args[1]==='fail',result:'ok',structured_output:{decision:'skip_review',reason:'no concerns',body:'',comments:[]},usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:20}}));
`);
  chmodSync(command, 0o755);
  const model = { baseURL: 'claude-cli://local', api: 'claude' as const, auth: 'none' as const,
    command, model: 'global.anthropic.claude-opus-5[1m]', permissionMode: 'bypass' as const };
  try {
    const result = await runAgyCli({spec:model,cwd:dir,prompt:'review'});
    assert.equal(result.result.status, 'SUCCESS');
    assert.equal(result.result.usage?.total_tokens, 32);
    assert.equal(result.inspections, 1);
    assert.equal(result.toolSteps[0]?.name, 'mcp__revuto__read');
    assert.deepEqual(result.result.structured_output, {decision:'skip_review',reason:'no concerns',body:'',comments:[]});
    await assert.rejects(runAgyCli({spec:model,cwd:dir,prompt:'fail'}), /run failed/);
    const noInspection = await runAgyCli({spec:model,cwd:dir,prompt:'terminal-only'});
    assert.equal(noInspection.inspections, 0);
    await assert.rejects(runAgyReview({
      config: {vaultPath:dir,models:{review:model}} as ReviewerConfig,
      ctx: {...context(dir),body:'terminal-only'}, octokit:{} as never,
      token:async ()=>'unused',skillMarkdown:'',startedAt:new Date(),
    }), /without inspecting repository evidence/);
  } finally {
    rmSync(dir, {recursive:true,force:true});
  }
});

test('Claude stream keeps multiple tool results and permission failures distinct', () => {
  const names = new Map([['a','Read'],['b','Bash']]);
  const events = normalizeClaudeEvents({type:'user',message:{content:[
    {type:'tool_result',tool_use_id:'a',content:'source'},
    {type:'tool_result',tool_use_id:'b',content:'permission denied',is_error:true},
  ]}},names);
  assert.equal(events.length,2);
  assert.deepEqual(events[1], {event:'step_update',step_update:{step_type:'tool',tool_name:'Bash',tool_info:{output:'permission denied',error:'permission denied'}}});
  assert.equal(names.size,0);
  assert.deepEqual(normalizeClaudeEvents({type:'rate_limit_event'},names),[]);
});
