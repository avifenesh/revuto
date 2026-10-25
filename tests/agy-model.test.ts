import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from 'ai';
import { buildChatModel } from '../agents/common/src/model.js';
import { runCurator } from '../agents/curator/src/run-curator.js';
import type { ModelSpec, ReviewerConfig } from '../agents/common/src/config.js';
import { startFakeOpenAI } from '../scripts/smoke/fake-openai.js';

function fakeAgy(fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-agy-model-'));
  const command = join(dir, 'agy.mjs');
  writeFileSync(command, `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
assert.equal(args[args.indexOf('--model') + 1], 'gemini-4-argon-high');
assert.equal(args[args.indexOf('--mode') + 1], 'plan');
assert.ok(args.includes('--disable-slash-commands'));
assert.ok(!args.includes('--dangerously-skip-permissions'));
if (${fail}) { console.error('AGY unavailable'); process.exit(1); }
assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
const message = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(message.event, 'user');
const request = JSON.parse(message.message.content.split('\\nREVUTO_REQUEST_JSON\\n')[1]);
const history = request.prompt;
const toolResults = history.filter(m => m.role === 'tool');
const output = !request.tools.length ? {text:'Textbook from Gemini', toolCalls:[]}
  : !toolResults.length ? {text:'', toolCalls:[{name:'list_concerns', input:{area_bucket:'src'}}]}
  : {text:'', toolCalls:[{name:'curator_done', input:{decision:'noop', summary:'No durable concern; none touched.'}}]};
if (toolResults.length) assert.match(JSON.stringify(toolResults), /records/);
// AGY delivers the structured answer through its finish tool; a run_command would be real native use.
const { existsSync } = await import('node:fs');
const tool = existsSync(process.argv[1] + '.tool') ? readFileSync(process.argv[1] + '.tool', 'utf8') : 'finish';
console.log(JSON.stringify({event:'step_update',step_update:{step_type:'tool',tool_name:tool,tool_info:{output:'done'}}}));
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',structured_output:output,usage:{input_tokens:10,output_tokens:2,total_tokens:12}}}));
`, { mode: 0o755 });
  const spec: ModelSpec = { api: 'agy', auth: 'agy-oauth', baseURL: 'agy://local', model: 'gemini-4-argon-high', command };
  return { dir, spec };
}

const approveAll = async () => ({ approve: true, reason: 'test', tokens: 0 });

function curatorConfig(spec: ModelSpec): ReviewerConfig {
  return { models: { curator: spec }, limits: { maxOutputTokens: { curator: 1024 } } } as ReviewerConfig;
}

test('AGY curator executes local tools and receives their results before finishing', async () => {
  const fake = fakeAgy();
  let lists = 0;
  try {
    const outcome = await runCurator({
      config: curatorConfig(fake.spec),
      store: { listConcerns: async () => { lists++; return []; } } as never,
      embedder: null,
      feedback: { feedbackId: 'test', kind: 'review_comment', body: 'Looks good.', repo: 'owner/repo', prNumber: 1, touchedFiles: ['src/a.ts'] },
      guard: approveAll,
    });
    assert.equal(lists, 1);
    assert.equal(outcome.decision, 'noop');
    assert.match(outcome.summary, /No durable concern/);
    assert.equal(outcome.tokens, 24);
  } finally { rmSync(fake.dir, { recursive: true, force: true }); }
});

test('AGY curator falls back to an HTTP model when the CLI fails', async () => {
  const fake = fakeAgy(true);
  const http = await startFakeOpenAI(() => ({ tool: 'curator_done', args: { decision: 'noop', summary: 'Fallback handled feedback; none touched.' } }));
  try {
    const outcome = await runCurator({
      config: curatorConfig({ ...fake.spec, fallbacks: [{ baseURL: http.url, model: 'glm-fallback' }] }),
      store: {} as never, embedder: null,
      feedback: { feedbackId: 'test', kind: 'review_comment', body: 'Looks good.', repo: 'owner/repo', prNumber: 1, touchedFiles: [] },
      guard: approveAll,
    });
    assert.equal(outcome.decision, 'noop');
    assert.match(outcome.summary, /Fallback handled/);
    assert.equal(http.getCalls(), 1);
  } finally { await http.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('AGY can compose text for curator textbook initialization', async () => {
  const fake = fakeAgy();
  try {
    const result = await generateText({ model: buildChatModel(fake.spec), prompt: 'Compose a textbook. ' + 'x'.repeat(140 * 1024) });
    assert.equal(result.text, 'Textbook from Gemini');
  } finally { rmSync(fake.dir, { recursive: true, force: true }); }
});

test('AGY finish delivers the answer; any other native tool fails the completion', async () => {
  const fake = fakeAgy();
  try {
    writeFileSync(join(fake.dir, 'agy.mjs.tool'), 'run_command');
    await assert.rejects(runCurator({
      config: curatorConfig(fake.spec),
      store: { listConcerns: async () => [] } as never,
      embedder: null,
      feedback: { feedbackId: 'test', kind: 'review_comment', body: 'Looks good.', repo: 'owner/repo', prNumber: 1, touchedFiles: [] },
      guard: approveAll,
    }), /native tools \(run_command\)/);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
