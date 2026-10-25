/**
 * Codex CLI runner contract tests. A fake `codex` executable checks that revuto
 * starts Codex on Bedrock with no user config, no shell, a read-only sandbox, a
 * private CODEX_HOME, only the guarded revuto MCP server and a strict output
 * schema, and that the JSON event stream maps onto the native runner contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { agyReviewSchema, buildAgyReviewPrompt, nativeCommand, NativeStepLimitError, normalizeClaudeEvents, probeAgy, renderEscalation, ReviewEscalation, runAgyCli, runAgyReview } from '../agents/common/src/agy-review.js';
import { escalationReason, shadowRecord, shouldShadow, writeShadowRecord } from '../agents/common/src/run-agent.js';
import { CODEX_REVIEW_SCHEMA, codexEnvironment, codexReviewSchema, normalizeCodexEvents, revutoCodexHome } from '../agents/common/src/codex-review.js';
import type { ReviewerConfig } from '../agents/common/src/config.js';
import { ModelRefusalError } from '../agents/common/src/refusal.js';
import type { PrContext } from '../agents/common/src/workspace.js';

function fakeCodex(dir: string): string {
  const command = join(dir, 'codex-fake.mjs');
  writeFileSync(command, `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const configs = args.flatMap((a, i) => args[i - 1] === '-c' ? [a] : []);
if (args[0] === 'debug' && args[1] === 'models') {
  writeFileSync(process.argv[1] + '.catalog', JSON.stringify({ args, env: process.env }));
  if (existsSync(process.argv[1] + '.fail-catalog')) { console.error('catalog refresh failed'); process.exit(1); }
  console.log('a log line before the catalog');
  console.log(JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', tool_mode: 'code_mode_only', multi_agent_version: 'v2', supports_search_tool: true, apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock'], context_window: 272000 }] }));
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8');
const catalog = configs.find((c) => c.startsWith('model_catalog_json='));
assert.ok(catalog, 'every run loads the restricted catalog');
writeFileSync(process.argv[1] + '.last', JSON.stringify({ args, prompt, env: process.env, catalog: readFileSync(JSON.parse(catalog.slice('model_catalog_json='.length)), 'utf8'), schema: args.includes('--output-schema') ? readFileSync(value('--output-schema'), 'utf8') : null }));
assert.ok(configs.includes('tools.experimental_request_user_input.enabled=false'));
assert.equal(args[0], 'exec');
assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules') && args.includes('--ephemeral') && args.includes('--json'));
assert.equal(value('--disable'), 'shell_tool');
assert.equal(value('--sandbox'), 'read-only');
assert.ok(['openai.gpt-6.1-sol', 'gpt-6.1-sol'].includes(value('-m')));
assert.equal(args.at(-1), '-');
if (value('-m') === 'gpt-6.1-sol') {
  assert.ok(configs.includes('model_provider="openai"'));
  assert.ok(!configs.some((c) => c.startsWith('model_providers.amazon-bedrock') || c.startsWith('model_context_window=')));
} else {
  assert.ok(configs.includes('model_provider="amazon-bedrock"'));
  assert.ok(configs.includes('model_providers.amazon-bedrock.aws.region="us-east-1"'));
}
assert.ok(configs.includes('approval_policy="never"'));
assert.ok(configs.includes('project_doc_max_bytes=0'), 'the checkout AGENTS.md stays out');
assert.ok(configs.includes('skills.include_instructions=false'), 'checkout and HOME skills stay out');
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
if (prompt.includes('escalate-me')) {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ decision: 'escalate', reason: 'lock ordering across reap needs a deeper look', body: '', comments: [] }) } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 2 } }));
  process.exit(0);
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
    assert.deepEqual(JSON.parse(last.catalog).models, [{ slug: 'gpt-6.1-sol', tool_mode: 'direct', multi_agent_version: 'disabled', supports_search_tool: false, apply_patch_tool_type: null, experimental_supported_tools: [], context_window: 272000 }],
      'code mode, sub-agents, tool search, apply_patch and experimental tools are off for every model');
    const catalogRun = JSON.parse(readFileSync(command + '.catalog', 'utf8'));
    assert.deepEqual(catalogRun.args, ['debug', 'models', '-c', 'model_provider="amazon-bedrock"', '-c', 'model_providers.amazon-bedrock.aws.region="us-east-1"']);
    assert.equal(catalogRun.env.CODEX_HOME, last.env.CODEX_HOME, 'the catalog comes from the same home as the run');
    assert.equal(catalogRun.env.GH_TOKEN, undefined);
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
    rmSync(command + '.last');
    writeFileSync(command + '.fail-catalog', '');
    await assert.rejects(runAgyCli({ spec, cwd: dir, prompt: 'review' }), /Codex CLI model catalog unavailable/);
    assert.equal(existsSync(command + '.last'), false, 'no review runs without the restricted catalog');
  } finally {
    if (previous.gh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous.gh;
    if (previous.aws === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK; else process.env.AWS_BEARER_TOKEN_BEDROCK = previous.aws;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a relative CLI path resolves against the daemon, never the PR checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-codex-test-'));
  const checkout = join(dir, 'checkout');
  mkdirSync(checkout);
  const command = fakeCodex(dir);
  const rel = relative(process.cwd(), command);
  assert.ok(rel.includes('/') && !rel.startsWith('/'));
  assert.equal(nativeCommand({ baseURL: 'codex://bedrock', api: 'codex', model: 'm', command: rel }), command);
  assert.equal(nativeCommand({ baseURL: 'codex://bedrock', api: 'codex', model: 'm', command: 'codex' }), 'codex', 'a bare name still goes through PATH');
  const aws = process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'bedrock-token';
  try {
    const run = await runAgyCli({ spec: { baseURL: 'codex://bedrock', api: 'codex', model: 'openai.gpt-6.1-sol', command: rel }, cwd: checkout, prompt: 'review', schema: CODEX_REVIEW_SCHEMA });
    assert.equal(run.result.status, 'SUCCESS', 'the catalog and the review both find the operator\'s CLI');
  } finally {
    if (aws === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK; else process.env.AWS_BEARER_TOKEN_BEDROCK = aws;
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

test('Codex environment carries only its provider credentials', () => {
  const env = { HOME: '/h', PATH: '/bin', GH_TOKEN: 'x', OPENAI_API_KEY: 'y', TEAM_OPENAI_KEY: 't', AWS_BEARER_TOKEN_BEDROCK: 'z', AWS_PROFILE: 'p' };
  const bedrock = { baseURL: 'codex://bedrock', api: 'codex' as const, model: 'openai.gpt-6.1-sol' };
  assert.deepEqual(codexEnvironment('/tmp/home', bedrock, env), { CODEX_HOME: '/tmp/home', HOME: '/h', PATH: '/bin', AWS_BEARER_TOKEN_BEDROCK: 'z', AWS_PROFILE: 'p',
    AWS_CONFIG_FILE: '/h/.aws/config', AWS_SHARED_CREDENTIALS_FILE: '/h/.aws/credentials' });
  const scratch = codexEnvironment('/tmp/home', bedrock, env, '/scratch');
  assert.equal(scratch.HOME, '/scratch', 'Codex never sees the operator HOME (~/.agents skills, dotfiles)');
  assert.equal(scratch.AWS_SHARED_CREDENTIALS_FILE, '/h/.aws/credentials', 'but the AWS files stay the real ones');
  const apiKey = { baseURL: 'codex://openai', api: 'codex' as const, auth: 'bearer' as const, model: 'gpt-6.1-sol' };
  assert.deepEqual(codexEnvironment('/tmp/home', apiKey, env), { CODEX_HOME: '/tmp/home', HOME: '/h', PATH: '/bin', CODEX_API_KEY: 'y' });
  assert.equal(codexEnvironment('/tmp/home', { ...apiKey, apiKeyEnv: 'TEAM_OPENAI_KEY' }, env).CODEX_API_KEY, 't');
  assert.throws(() => codexEnvironment('/tmp/home', apiKey, { HOME: '/h' }), /needs an API key in its apiKeyEnv variable/);
  const login = { ...apiKey, auth: 'subscription' as const };
  assert.deepEqual(codexEnvironment('/login', login, env), { CODEX_HOME: '/login', HOME: '/h', PATH: '/bin' });
  assert.equal(revutoCodexHome({ HOME: '/h' }), '/h/.config/revuto/codex');
  assert.equal(revutoCodexHome({ HOME: '/h', REVUTO_CODEX_HOME: '/srv/codex' }), '/srv/codex');
  assert.equal(revutoCodexHome({ HOME: '/h', REVUTO_CODEX_HOME: 'rel/codex' }), join(process.cwd(), 'rel/codex'));
});

test('Codex on OpenAI runs on an API key in a private home, or on revuto\'s own ChatGPT login home', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-codex-openai-'));
  const command = fakeCodex(dir);
  const keys = ['OPENAI_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'REVUTO_CODEX_HOME'] as const;
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const last = () => JSON.parse(readFileSync(command + '.last', 'utf8'));
  process.env.OPENAI_API_KEY = 'openai-key';
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'bedrock-token';
  try {
    const apiKey = { baseURL: 'codex://openai', api: 'codex' as const, auth: 'bearer' as const, model: 'gpt-6.1-sol', command };
    const run = await runAgyCli({ spec: apiKey, cwd: dir, prompt: 'review', schema: CODEX_REVIEW_SCHEMA });
    assert.equal(run.result.status, 'SUCCESS');
    assert.equal(last().env.CODEX_API_KEY, 'openai-key');
    assert.equal(last().env.AWS_BEARER_TOKEN_BEDROCK, undefined, 'Bedrock credentials stay off the OpenAI route');
    assert.match(last().env.CODEX_HOME, /revuto-codex-/);
    assert.equal(existsSync(last().env.CODEX_HOME), false, 'the API-key run home is removed');
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(runAgyCli({ spec: apiKey, cwd: dir, prompt: 'review' }), /needs an API key in its apiKeyEnv variable/);

    const loginHome = join(dir, 'login-home');
    process.env.REVUTO_CODEX_HOME = loginHome;
    const login = { ...apiKey, auth: 'subscription' as const };
    await assert.rejects(runAgyCli({ spec: login, cwd: dir, prompt: 'review' }), /ChatGPT login not found in .*login-home: run `mkdir -p .*login-home && CODEX_HOME=.* codex login`/);
    mkdirSync(loginHome);
    writeFileSync(join(loginHome, 'auth.json'), '{}');
    await runAgyCli({ spec: login, cwd: dir, prompt: 'review', schema: CODEX_REVIEW_SCHEMA });
    assert.equal(last().env.CODEX_HOME, loginHome);
    assert.equal(last().env.CODEX_API_KEY, undefined);
    assert.ok(existsSync(join(loginHome, 'auth.json')), 'the login home survives the run');
    assert.ok(last().schema, 'the schema still goes through a temporary file');
  } finally {
    for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cheap tier escalates on request or on its step budget, carrying its cost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-codex-test-'));
  const command = fakeCodex(dir);
  const spec = { name: 'codex-sol', baseURL: 'codex://bedrock', api: 'codex' as const, model: 'openai.gpt-6.1-sol', reasoningEffort: 'medium' as const, command };
  const config = (maxSteps: number) => ({ vaultPath: dir, models: { review: spec }, review: { maxSteps }, limits: { maxOutputTokens: {} } }) as unknown as ReviewerConfig;
  const run = (body: string, allowEscalation: boolean, maxSteps = 150) => runAgyReview({ config: config(maxSteps), ctx: context(dir, body), octokit: {} as never,
    token: async () => 'unused', skillMarkdown: '', startedAt: new Date(), allowEscalation });
  try {
    await assert.rejects(run('escalate-me', true), (err: unknown) => err instanceof ReviewEscalation && err.reason === 'lock ordering across reap needs a deeper look' && err.tokens === 42 && err.steps > 0);
    const last = JSON.parse(readFileSync(command + '.last', 'utf8'));
    assert.deepEqual(JSON.parse(last.schema).properties.decision.enum, ['post_review', 'skip_review', 'escalate'], 'the escalate option is in the schema');
    assert.match(last.prompt, /## Escalation/);
    await assert.rejects(run('escalate-me', false), /escalate is not available on this tier/);
    await assert.rejects(run('runaway', true, 3), (err: unknown) => err instanceof ReviewEscalation && err.reason === 'ran out of review steps');
    await assert.rejects(run('runaway', false, 3), (err: unknown) => !(err instanceof ReviewEscalation) && /exceeded review\.maxSteps/.test(String(err)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the escalate option exists only where escalation is allowed, and the large tier gets the note', () => {
  assert.deepEqual(JSON.parse(codexReviewSchema()).properties.decision.enum, ['post_review', 'skip_review']);
  assert.deepEqual(JSON.parse(agyReviewSchema(true)).properties.decision.enum, ['post_review', 'skip_review', 'escalate']);
  assert.equal(renderEscalation(), '');
  assert.match(renderEscalation({ allow: true }), /set decision to escalate/);
  const note = renderEscalation({ note: 'needs a look at the retry path' });
  assert.match(note, /## Escalated review\nA first-pass reviewer on a smaller tier handed this PR to you, with this reason:\n<<<UNTRUSTED-[0-9a-f]{24}>>>\nneeds a look at the retry path\n<<<END-UNTRUSTED-/);
  assert.doesNotMatch(buildAgyReviewPrompt(context('/ws'), '', 'codex'), /## Escalation/);
});

test('a Claude turn-limit stop keeps its subtype, its cost, and escalates on a cheap tier', async () => {
  const [limit] = normalizeClaudeEvents({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], usage: { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 100 } }, new Map());
  const r = limit.result as { status: string; error: string; limit?: boolean; usage: { total_tokens: number } };
  assert.equal(r.status, 'ERROR'); assert.equal(r.limit, true); assert.equal(r.error, 'error_max_turns: []'); assert.equal(r.usage.total_tokens, 135);
  const [other] = normalizeClaudeEvents({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }, new Map());
  assert.equal((other.result as { limit?: boolean }).limit, undefined);

  const dir = mkdtempSync(join(tmpdir(), 'revuto-claude-limit-'));
  const command = join(dir, 'claude-fake.mjs');
  writeFileSync(command, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'mcp__revuto__read' }] } }));
console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'file' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], usage: { input_tokens: 30, output_tokens: 5 } }));
// Claude Code exits non-zero on a turn-limit stop; the result decides, not the status.
process.exit(1);
`);
  chmodSync(command, 0o755);
  const spec = { baseURL: 'claude-cli://local', api: 'claude' as const, auth: 'none' as const, command, model: 'global.anthropic.claude-opus-5-5[1m]' };
  try {
    await assert.rejects(runAgyCli({ spec, cwd: dir, prompt: 'x' }), (err: unknown) => err instanceof NativeStepLimitError && err.tokens === 35 && err.steps > 0);
    const config = { vaultPath: dir, models: { review: spec }, review: { maxSteps: 5 }, limits: { maxOutputTokens: {} } } as unknown as ReviewerConfig;
    await assert.rejects(runAgyReview({ config, ctx: context(dir), octokit: {} as never, token: async () => 'unused', skillMarkdown: '', startedAt: new Date(), allowEscalation: true }),
      (err: unknown) => err instanceof ReviewEscalation && err.reason === 'ran out of review steps' && err.tokens === 35);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an HTTP pass escalates only through a successful escalate_review call with a reason', () => {
  assert.equal(escalationReason([{ toolResults: [{ toolName: 'read', input: {}, output: 'x' }] }]), undefined);
  assert.equal(escalationReason([{ toolResults: [{ toolName: 'escalate_review', input: { reason: ' retry path ' }, output: '{"ok":true}' }] }]), 'retry path');
  assert.equal(escalationReason([{ toolResults: [{ toolName: 'escalate_review', input: { reason: 'x' }, output: 'ERROR: failed' }] }]), undefined);
  assert.equal(escalationReason([{ toolResults: [{ toolName: 'escalate_review', input: {}, output: '{"ok":true}' }] }]), undefined);
  assert.match(renderEscalation({ allow: true, via: 'tool' }), /call escalate_review with a reason/);
});

test('a shadow run returns the verdict and posts nothing; the record says whether the tiers agree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-shadow-'));
  const command = fakeCodex(dir);
  const spec = { name: 'large', baseURL: 'codex://bedrock', api: 'codex' as const, model: 'openai.gpt-6.1-sol', command };
  const config = { vaultPath: dir, models: { review: spec }, review: { maxSteps: 150 }, limits: { maxOutputTokens: {} } } as unknown as ReviewerConfig;
  const octokit = { pulls: { createReview: async () => { throw new Error('a shadow run must not post'); } } };
  try {
    const shadow = await runAgyReview({ config, ctx: context(dir, 'with-findings'), octokit: octokit as never, token: async () => 'unused', skillMarkdown: '', startedAt: new Date(), dryRun: true });
    assert.equal(shadow.terminal, 'post_review'); assert.equal(shadow.postFailures, 0);
    const cheap = { terminal: 'skip_review' as const, hasFindings: false, result: '', headSha: 'h', steps: 3, tokens: 100, inspections: 2, toolErrors: 0, postFailures: 0, forcedTerminal: false, ranModel: true, model: 'small' };
    const record = shadowRecord({ repo: 'o/r', prNumber: 7, headSha: 'h', tier: 'small', cheap, large: shadow });
    assert.equal(record.agree, false, 'the small tier passed what the large tier flagged');
    assert.deepEqual(record.large.comments, [{ path: 'src/file.ts', line: 3 }]);
    assert.equal(record.cheap.tokens, 100);
    assert.equal(shadowRecord({ repo: 'o/r', prNumber: 7, headSha: 'h', tier: 'small', cheap: { ...cheap, hasFindings: true }, large: shadow }).agree, true);
    const file = writeShadowRecord(dir, record);
    assert.match(file, /\.shadow\/\d{4}-\d{2}\.jsonl$/);
    writeShadowRecord(dir, record);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2, 'records append');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(shouldShadow(0, () => 0), false);
  assert.equal(shouldShadow(0.05, () => 0.04), true);
  assert.equal(shouldShadow(0.05, () => 0.05), false);
});
