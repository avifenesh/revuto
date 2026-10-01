/**
 * Codex CLI runner contract tests. A fake `codex` executable checks that revuto
 * starts Codex on Bedrock with no user config, no shell, a read-only sandbox, a
 * private CODEX_HOME, only the guarded revuto MCP server and a strict output
 * schema, and that the JSON event stream maps onto the native runner contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAgyReviewPrompt, probeAgy, runAgyCli, runAgyReview } from '../agents/common/src/agy-review.js';
import { CODEX_REVIEW_SCHEMA, codexEnvironment, normalizeCodexEvents } from '../agents/common/src/codex-review.js';
import type { ReviewerConfig } from '../agents/common/src/config.js';
import { ModelRefusalError } from '../agents/common/src/refusal.js';
import type { PrContext } from '../agents/common/src/workspace.js';

function fakeCodex(dir: string): string {
  const command = join(dir, 'codex-fake.mjs');
  writeFileSync(command, `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const value = (flag) => args[args.indexOf(flag) + 1];
const configs = args.flatMap((a, i) => args[i - 1] === '-c' ? [a] : []);
writeFileSync(process.argv[1] + '.last', JSON.stringify({ args, prompt, env: process.env, schema: args.includes('--output-schema') ? readFileSync(value('--output-schema'), 'utf8') : null }));
assert.equal(args[0], 'exec');
assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules') && args.includes('--ephemeral') && args.includes('--json'));
assert.equal(value('--disable'), 'shell_tool');
assert.equal(value('--sandbox'), 'read-only');
assert.equal(value('-m'), 'openai.gpt-6.1-sol');
assert.equal(args.at(-1), '-');
assert.ok(configs.includes('model_provider="amazon-bedrock"'));
assert.ok(configs.includes('model_providers.amazon-bedrock.aws.region="us-east-1"'));
assert.ok(configs.includes('approval_policy="never"'));
assert.ok(existsSync(process.env.CODEX_HOME));
console.log('2026-10-01T00:00:00Z ERROR rmcp::transport::worker: a log line that is not JSON');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'a config warning' } }));
if (prompt.includes('AGY_REVUTO_DOCTOR_OK')) {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'AGY_REVUTO_DOCTOR_OK' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } }));
  process.exit(0);
}
const calls = prompt.includes('runaway') ? 5 : 2;
for (let i = 0; i < calls; i++) {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'revuto', tool: i === 0 ? 'pr_diff' : 'read', arguments: {}, result: { content: [{ type: 'text', text: 'evidence ' + i }] }, error: null, status: 'completed' } }));
}
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'revuto', tool: 'grep', arguments: {}, result: { content: [{ type: 'text', text: 'ERROR: bad pattern' }] }, error: null, status: 'failed' } }));
if (prompt.includes('policy-turn')) {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'This request was declined', codex_error_info: 'cyber_policy' } }));
  process.exit(1);
}
if (prompt.includes('declined-text')) {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: "I'm sorry, but I can't help with reviewing this." } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }));
  process.exit(0);
}
if (prompt.includes('fail-turn')) {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }));
  process.exit(1);
}
const findings = prompt.includes('with-findings');
const verdict = findings
  ? { decision: 'post_review', reason: 'one concern', body: 'Summary', comments: [{ path: 'src/file.ts', line: 3, side: null, start_line: null, start_side: null, body: 'Evidence-backed concern' }] }
  : { decision: 'skip_review', reason: 'no concerns', body: '', comments: [] };
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(verdict) } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7 } }));
`);
  chmodSync(command, 0o755);
  return command;
}

function context(workspacePath: string, body = 'PR body'): PrContext {
  return {
    owner: 'owner', repo: 'repo', prNumber: 7,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40),
    headRef: 'feature', baseRef: 'main', author: 'author', title: 'Test PR', body, state: 'open',
    additions: 1, deletions: 1, changedFiles: 1, fileList: ['src/file.ts'],
    existingReviews: [], existingReviewComments: [], existingIssueComments: [],
    workspacePath, diffRefSpec: `${'c'.repeat(40)}..${'a'.repeat(40)}`,
  };
}

test('Codex runs on Bedrock with no user config, no shell and only the revuto MCP server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-codex-test-'));
  const command = fakeCodex(dir);
  const spec = { baseURL: 'codex://bedrock', api: 'codex' as const, model: 'openai.gpt-6.1-sol', reasoningEffort: 'high' as const, command };
  const previous = { gh: process.env.GH_TOKEN, aws: process.env.AWS_BEARER_TOKEN_BEDROCK };
  process.env.GH_TOKEN = 'must-not-leak';
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'bedrock-token';
  try {
    const run = await runAgyCli({ spec, cwd: dir, prompt: 'review', schema: CODEX_REVIEW_SCHEMA, diffRange: context(dir).diffRefSpec });
    const last = JSON.parse(readFileSync(command + '.last', 'utf8'));
    assert.equal(last.prompt, 'review', 'the prompt goes over stdin');
    assert.ok(last.args.includes('model_reasoning_effort="high"'));
    assert.ok(last.args.some((a: string) => a.startsWith('mcp_servers.revuto.command=')));
    const mcpArgs = last.args.find((a: string) => a.startsWith('mcp_servers.revuto.args='));
    assert.match(mcpArgs, /claude-review-mcp\.js/);
    assert.ok(mcpArgs.includes(context(dir).diffRefSpec), 'the MCP server gets the fixed diff range');
    assert.ok(last.args.includes('model_context_window=900000'));
    assert.ok(last.args.includes('model_auto_compact_token_limit=250000'));
    assert.deepEqual(JSON.parse(last.schema), JSON.parse(CODEX_REVIEW_SCHEMA), 'the strict schema is written to a file');
    assert.equal(last.env.GH_TOKEN, undefined, 'no GitHub credentials reach Codex');
    assert.equal(last.env.AWS_BEARER_TOKEN_BEDROCK, 'bedrock-token');
    assert.match(last.env.CODEX_HOME, /revuto-codex-/);
    assert.equal(existsSync(last.env.CODEX_HOME), false, 'the private CODEX_HOME is removed after the run');
    // Each run's own home is checked, not tmpdir as a whole: a live daemon on the
    // same host creates and removes its own revuto-codex-* directories.
    const homeOfLastRun = () => JSON.parse(readFileSync(command + '.last', 'utf8')).env.CODEX_HOME as string;

    assert.equal(run.result.status, 'SUCCESS');
    assert.equal(run.result.conversation_id, 'thread-1');
    assert.equal(run.inspections, 2);
    assert.equal(run.toolErrors, 1);
    assert.deepEqual(run.toolSteps.map((s) => s.name), ['mcp__revuto__pr_diff', 'mcp__revuto__read', 'mcp__revuto__grep']);
    assert.equal(run.result.usage?.total_tokens, 107);
    assert.deepEqual(run.result.structured_output, { decision: 'skip_review', reason: 'no concerns', body: '', comments: [] });

    await assert.rejects(runAgyCli({ spec, cwd: dir, prompt: 'runaway', maxSteps: 3 }), /exceeded review\.maxSteps \(3 tool calls\)/);
    assert.equal(existsSync(homeOfLastRun()), false, 'a run stopped at the step limit cleans up');
    await assert.rejects(runAgyCli({ spec, cwd: dir, prompt: 'fail-turn' }), /Codex CLI exited with status 1: stream disconnected/);
    assert.equal(existsSync(homeOfLastRun()), false, 'a failed turn cleans up');
    await assert.rejects(runAgyCli({ spec, cwd: dir, prompt: 'review', maxSteps: 0 }), /positive integer/);
    await assert.rejects(runAgyCli({ spec, cwd: dir, prompt: 'policy-turn' }), (err: unknown) => err instanceof ModelRefusalError && err.category === 'cyber_policy');
    await assert.rejects(runAgyCli({ spec, cwd: dir, prompt: 'declined-text' }), (err: unknown) => err instanceof ModelRefusalError && err.category === 'declined');
  } finally {
    if (previous.gh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous.gh;
    if (previous.aws === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK; else process.env.AWS_BEARER_TOKEN_BEDROCK = previous.aws;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex review posts through revuto with the null comment fields dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-codex-test-'));
  const command = fakeCodex(dir);
  const spec = { name: 'codex-sol', baseURL: 'codex://bedrock', api: 'codex' as const, model: 'openai.gpt-6.1-sol', reasoningEffort: 'medium' as const, command };
  const posted: unknown[] = [];
  const octokit = { pulls: { createReview: async (review: unknown) => { posted.push(review); return { data: { id: 1, html_url: 'https://example/review/1' } }; } } };
  const config = { vaultPath: dir, models: { review: spec }, review: { maxSteps: 150 }, limits: { maxOutputTokens: {} } } as unknown as ReviewerConfig;
  try {
    const outcome = await runAgyReview({ config, ctx: context(dir, 'with-findings'), octokit: octokit as never, token: async () => 'unused', skillMarkdown: '', startedAt: new Date() });
    assert.equal(outcome.terminal, 'post_review');
    assert.equal(outcome.hasFindings, true);
    assert.equal(outcome.model, 'codex-sol');
    const review = posted[0] as { comments: Array<Record<string, unknown>> };
    assert.equal(review.comments.length, 1);
    assert.deepEqual(Object.keys(review.comments[0]).sort(), ['body', 'line', 'path']);
    assert.match(String(review.comments[0].body), /Evidence-backed concern/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the explicit Codex doctor probe runs at low effort with no MCP server and no schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-codex-test-'));
  const command = fakeCodex(dir);
  try {
    const spec = { baseURL: 'codex://bedrock', api: 'codex' as const, model: 'openai.gpt-6.1-sol', reasoningEffort: 'high' as const, command };
    const run = await probeAgy(spec, dir);
    assert.equal(run.result.response, 'AGY_REVUTO_DOCTOR_OK');
    const last = JSON.parse(readFileSync(command + '.last', 'utf8'));
    assert.ok(last.args.includes('model_reasoning_effort="low"'), 'the probe runs at low effort');
    assert.ok(!last.args.some((a: string) => a.startsWith('mcp_servers.')), 'no MCP server on the probe');
    assert.equal(last.schema, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex prompt names only the revuto MCP tools', () => {
  const prompt = buildAgyReviewPrompt(context('/ws'), '', 'codex');
  assert.match(prompt, /inside Codex CLI/);
  assert.match(prompt, /pr_diff/);
  assert.match(prompt, /There is no shell, network, or Git access/);
  assert.match(prompt, /set side, start_line and start_side to null/);
  assert.doesNotMatch(prompt, /Antigravity|mcp__revuto__/);
});

test('Codex events map to tool steps, failures and a parsed verdict', () => {
  const state = {};
  assert.deepEqual(normalizeCodexEvents({ type: 'thread.started', thread_id: 't' }, state), []);
  assert.deepEqual(normalizeCodexEvents({ type: 'error', message: 'Reconnecting... 1/5' }, state), []);
  const [failed] = normalizeCodexEvents({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'revuto', tool: 'read', status: 'failed', error: { message: 'denied' }, result: null } }, state);
  assert.deepEqual(failed, { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'mcp__revuto__read', tool_info: { output: '', error: { message: 'denied' } } } });
  const [other] = normalizeCodexEvents({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'elsewhere', tool: 'x', status: 'completed', result: { content: [] } } }, state);
  assert.equal((other.step_update as { tool_name: string }).tool_name, 'elsewhere.x');
  normalizeCodexEvents({ type: 'item.completed', item: { type: 'agent_message', text: 'not json' } }, state);
  const [result] = normalizeCodexEvents({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }, state);
  assert.equal((result.result as { structured_output: unknown }).structured_output, undefined, 'a non-JSON final message is no verdict');
  const [failedTurn] = normalizeCodexEvents({ type: 'turn.failed', error: { message: 'quota' } }, state);
  assert.deepEqual(failedTurn, { event: 'result', result: { status: 'ERROR', conversation_id: 't', error: 'quota' } }, 'an ordinary failure is no refusal');
  const [policy] = normalizeCodexEvents({ type: 'turn.failed', error: { message: 'Your request was flagged by our safety system' } }, state);
  assert.deepEqual((policy.result as { refusal: unknown }).refusal, { category: 'policy' });
  for (const message of ['connect ECONNREFUSED 127.0.0.1:443', 'Connection refused (os error 111)', 'stream disconnected: invariant violation in decoder', 'feature flagged off for this account']) {
    const [transport] = normalizeCodexEvents({ type: 'turn.failed', error: { message } }, state);
    assert.equal((transport.result as { refusal?: unknown }).refusal, undefined, `"${message}" is not a refusal`);
  }
  for (const message of ['This request violates our usage policies', 'The prompt was refused by the safety system', 'Content flagged by the moderation check']) {
    const [declined] = normalizeCodexEvents({ type: 'turn.failed', error: { message } }, state);
    assert.deepEqual((declined.result as { refusal: unknown }).refusal, { category: 'policy' }, `"${message}" is a refusal`);
  }
  normalizeCodexEvents({ type: 'item.completed', item: { type: 'agent_message', text: 'I cannot review code that bypasses login checks.' } }, state);
  const [declined] = normalizeCodexEvents({ type: 'turn.completed', usage: {} }, state);
  assert.deepEqual((declined.result as { refusal: unknown }).refusal, { category: 'declined' });
  normalizeCodexEvents({ type: 'item.completed', item: { type: 'agent_message', text: 'The schema output was not produced.' } }, state);
  const [notRefusal] = normalizeCodexEvents({ type: 'turn.completed', usage: {} }, state);
  assert.equal((notRefusal.result as { refusal?: unknown }).refusal, undefined, 'a malformed verdict is not a refusal');
});

test('Codex environment carries Bedrock credentials and nothing else sensitive', () => {
  const env = codexEnvironment('/tmp/home', { HOME: '/h', PATH: '/bin', GH_TOKEN: 'x', OPENAI_API_KEY: 'y', AWS_BEARER_TOKEN_BEDROCK: 'z', AWS_PROFILE: 'p' });
  assert.deepEqual(env, { CODEX_HOME: '/tmp/home', HOME: '/h', PATH: '/bin', AWS_BEARER_TOKEN_BEDROCK: 'z', AWS_PROFILE: 'p' });
});
