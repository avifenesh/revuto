/**
 * Converse adapter rules for Claude Opus 5.5 / Fable 5.1: no forced tool choice,
 * no sampling params, effort default medium, signed reasoning replayed in order,
 * refusals handed to the next model, ConverseStream aggregation.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';

import { buildConverseModel, decodeEventStreamFrames, CONVERSE_METADATA_KEY, isAnthropicModelId } from '../agents/common/src/converse-model.js';
import { FallbackLanguageModel } from '../agents/common/src/model.js';
import { ModelRefusalError } from '../agents/common/src/refusal.js';
import { refusalFallback } from '../agents/common/src/run-agent.js';
import type { ModelSpec } from '../agents/common/src/config.js';

const crc32 = (zlib as unknown as { crc32: (b: Uint8Array) => number }).crc32;

function frame(headers: Record<string, string>, payload: unknown): Buffer {
  const headerBufs = Object.entries(headers).map(([name, value]) => {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    out.writeUInt8(n.length, 0);
    n.copy(out, 1);
    out.writeUInt8(7, 1 + n.length);
    out.writeUInt16BE(v.length, 2 + n.length);
    v.copy(out, 4 + n.length);
    return out;
  });
  const h = Buffer.concat(headerBufs);
  const p = Buffer.from(JSON.stringify(payload), 'utf8');
  const total = 12 + h.length + p.length + 4;
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(h.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude), 0);
  const body = Buffer.concat([prelude, preludeCrc, h, p]);
  const msgCrc = Buffer.alloc(4);
  msgCrc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([body, msgCrc]);
}

const event = (type: string, payload: unknown): Buffer => frame({ ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' }, payload);

type Block = { text?: string; reasoning?: { text: string; signature: string }; tool?: { id: string; name: string; input: unknown } };

function streamOf(blocks: Block[], stopReason: string, extra?: unknown): Buffer {
  const frames: Buffer[] = [event('messageStart', { role: 'assistant' })];
  blocks.forEach((b, i) => {
    if (b.tool) frames.push(event('contentBlockStart', { contentBlockIndex: i, start: { toolUse: { toolUseId: b.tool.id, name: b.tool.name } } }));
    if (b.reasoning) {
      frames.push(event('contentBlockDelta', { contentBlockIndex: i, delta: { reasoningContent: { text: b.reasoning.text } } }));
      frames.push(event('contentBlockDelta', { contentBlockIndex: i, delta: { reasoningContent: { signature: b.reasoning.signature } } }));
    }
    if (b.text !== undefined) {
      frames.push(event('contentBlockDelta', { contentBlockIndex: i, delta: { text: b.text.slice(0, 2) } }));
      frames.push(event('contentBlockDelta', { contentBlockIndex: i, delta: { text: b.text.slice(2) } }));
    }
    if (b.tool) {
      const json = JSON.stringify(b.tool.input);
      frames.push(event('contentBlockDelta', { contentBlockIndex: i, delta: { toolUse: { input: json.slice(0, 3) } } }));
      frames.push(event('contentBlockDelta', { contentBlockIndex: i, delta: { toolUse: { input: json.slice(3) } } }));
    }
    frames.push(event('contentBlockStop', { contentBlockIndex: i }));
  });
  frames.push(event('messageStop', { stopReason, ...(extra ? { additionalModelResponseFields: extra } : {}) }));
  frames.push(event('metadata', { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }));
  return Buffer.concat(frames);
}

type Captured = { url: string; body: any };

function mockFetch(responses: Buffer[]): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error('no more mock responses');
    // Split into odd-sized chunks so frames straddle reads.
    const chunks: Buffer[] = [];
    for (let i = 0; i < next.length; i += 37) chunks.push(next.subarray(i, i + 37));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const claudeSpec: ModelSpec = {
  name: 'bedrock-converse',
  baseURL: 'https://bedrock-runtime.us-east-2.amazonaws.com',
  model: 'global.anthropic.claude-opus-5-5',
  api: 'converse',
  auth: 'bearer',
  apiKeyEnv: 'REVUTO_TEST_BEDROCK_KEY',
};
process.env.REVUTO_TEST_BEDROCK_KEY = 'test-key';

const tools = [
  { type: 'function', name: 'post_review', description: 'post', inputSchema: { type: 'object', properties: { body: { type: 'string' } }, additionalProperties: false } },
  { type: 'function', name: 'skip_review', description: 'skip', inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, additionalProperties: false } },
];

test('isAnthropicModelId matches Bedrock Claude ids and profiles only', () => {
  assert.ok(isAnthropicModelId('global.anthropic.claude-opus-5-5'));
  assert.ok(isAnthropicModelId('us.anthropic.claude-fable-5-1'));
  assert.ok(isAnthropicModelId('arn:aws:bedrock:us-east-2:1:inference-profile/global.anthropic.claude-opus-5-5'));
  assert.ok(!isAnthropicModelId('openai.gpt-6-sol'));
});

test('Claude on Converse: required tool choice goes out as auto, no sampling params, effort medium, one retry naming the tools', async () => {
  const mock = mockFetch([
    streamOf([{ text: 'I think it is fine.' }], 'end_turn'),
    streamOf([{ tool: { id: 't1', name: 'skip_review', input: { reason: 'clean' } } }], 'tool_use'),
  ]);
  try {
    const model = buildConverseModel(claudeSpec) as any;
    const result = await model.doGenerate({
      prompt: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'review' }] }],
      tools,
      toolChoice: { type: 'required' },
      temperature: 0.2,
      topP: 0.9,
    });
    assert.equal(mock.calls.length, 2);
    const first = mock.calls[0];
    assert.match(first.url, /\/model\/global\.anthropic\.claude-opus-5-5\/converse-stream$/);
    assert.deepEqual(first.body.toolConfig.toolChoice, { auto: {} });
    assert.equal(first.body.inferenceConfig.temperature, undefined);
    assert.equal(first.body.inferenceConfig.topP, undefined);
    assert.equal(first.body.inferenceConfig.maxTokens, 128000);
    assert.deepEqual(first.body.additionalModelRequestFields, { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
    // Retry appends the answer and a reminder; the earlier prefix is unchanged.
    const retry = mock.calls[1].body;
    assert.deepEqual(retry.messages.slice(0, first.body.messages.length), first.body.messages);
    assert.equal(retry.messages.at(-2).role, 'assistant');
    assert.match(retry.messages.at(-1).content[0].text, /`post_review`, `skip_review`/);
    const call = result.content.find((p: any) => p.type === 'tool-call');
    assert.equal(call.toolName, 'skip_review');
    assert.deepEqual(JSON.parse(call.input), { reason: 'clean' });
    assert.equal(result.usage.inputTokens.total, 20);
  } finally {
    mock.restore();
  }
});

test('non-Claude Converse models keep the forced tool choice and sampling params', async () => {
  const mock = mockFetch([streamOf([{ tool: { id: 't1', name: 'skip_review', input: {} } }], 'tool_use')]);
  try {
    const model = buildConverseModel({ ...claudeSpec, model: 'us.amazon.nova-pro-v1:0' }) as any;
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools, toolChoice: { type: 'required' }, temperature: 0.2 });
    assert.deepEqual(mock.calls[0].body.toolConfig.toolChoice, { any: {} });
    assert.equal(mock.calls[0].body.inferenceConfig.temperature, 0.2);
    assert.equal(mock.calls[0].body.additionalModelRequestFields, undefined);
  } finally {
    mock.restore();
  }
});

test('signed reasoning comes back as a reasoning part and is replayed verbatim, before toolUse, not in text', async () => {
  const mock = mockFetch([
    streamOf([{ reasoning: { text: '', signature: 'sig-abc' } }, { text: 'Checking.' }, { tool: { id: 't1', name: 'post_review', input: { body: 'b' } } }], 'tool_use'),
    streamOf([{ text: 'done' }], 'end_turn'),
  ]);
  try {
    const model = buildConverseModel(claudeSpec) as any;
    const first = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools, toolChoice: { type: 'auto' } });
    assert.deepEqual(first.content.map((p: any) => p.type), ['reasoning', 'text', 'tool-call']);
    assert.deepEqual(first.content[0].providerMetadata, { [CONVERSE_METADATA_KEY]: { signature: 'sig-abc' } });

    // Replay the turn the way the AI SDK does: providerMetadata becomes providerOptions.
    const assistant = first.content.map((p: any) => (p.type === 'reasoning' ? { type: 'reasoning', text: p.text, providerOptions: p.providerMetadata } : p));
    await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [...assistant, { type: 'reasoning', text: 'unsigned from another model' }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'post_review', output: { type: 'text', value: 'ok' } }] },
      ],
      tools,
    });
    const replayed = mock.calls[1].body.messages[1];
    assert.equal(replayed.role, 'assistant');
    assert.deepEqual(replayed.content[0], { reasoningContent: { reasoningText: { text: '', signature: 'sig-abc' } } });
    assert.deepEqual(replayed.content[1], { text: 'Checking.' });
    assert.equal(replayed.content[2].toolUse.name, 'post_review');
    assert.equal(replayed.content.length, 3, 'unsigned reasoning is dropped, not folded into text');
  } finally {
    mock.restore();
  }
});

test('a refusal throws ModelRefusalError with the category and FallbackLanguageModel moves on', async () => {
  const mock = mockFetch([streamOf([], 'refusal', { stop_details: { category: 'cyber' } })]);
  try {
    const refusing = buildConverseModel(claudeSpec) as any;
    const next = {
      specificationVersion: 'v4', provider: 'next', modelId: 'next-id', supportedUrls: {},
      doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop' }, usage: {}, warnings: [] }),
      doStream: async () => { throw new Error('no'); },
    };
    const fallback = new FallbackLanguageModel([refusing, next as any]);
    const out = await fallback.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] } as any);
    assert.equal((out.content[0] as any).text, 'ok');
    assert.equal(fallback.getActiveIndex(), 0, 'a refusal does not demote the primary');
  } finally {
    mock.restore();
  }
  const alone = mockFetch([streamOf([], 'refusal', { stop_details: { category: 'bio' } })]);
  try {
    await assert.rejects((buildConverseModel(claudeSpec) as any).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
      (err: unknown) => err instanceof ModelRefusalError && err.category === 'bio');
  } finally {
    alone.restore();
  }
});

test('stream exceptions surface with their type', () => {
  const buf = frame({ ':message-type': 'exception', ':exception-type': 'validationException' }, { message: 'bad' });
  const { frames, rest } = decodeEventStreamFrames(buf);
  assert.equal(rest.length, 0);
  assert.equal(frames[0].headers[':exception-type'], 'validationException');
});

test('refusalFallback picks the next model and keeps the rest of the chain', () => {
  const b: ModelSpec = { baseURL: 'x', model: 'b' };
  const c: ModelSpec = { baseURL: 'x', model: 'c' };
  const spec: ModelSpec = { baseURL: 'claude-cli://local', model: 'a', api: 'claude', fallbacks: [b, c] };
  assert.deepEqual(refusalFallback(spec, new ModelRefusalError('a', 'cyber')), { ...b, fallbacks: [c] });
  assert.equal(refusalFallback(spec, new ModelRefusalError('a', 'reasoning_extraction')), undefined);
  assert.equal(refusalFallback(spec, new Error('boom')), undefined);
  assert.equal(refusalFallback({ ...spec, fallbacks: [] }, new ModelRefusalError('a', 'cyber')), undefined);
});
