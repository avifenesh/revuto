/**
 * Smoke for the OpenAI-compatible Responses adapter:
 *  - sends /v1/responses, not /chat/completions;
 *  - preserves tool loops through AI SDK generateText;
 *  - sets reasoning.effort;
 *  - supports both bearer-key auth and AWS default credential SigV4 auth.
 *
 *   npx tsx scripts/smoke/responses.ts
 */
import assert from 'node:assert/strict';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

import type { ModelSpec } from '../../agents/common/src/config.js';
import { buildChatModel } from '../../agents/common/src/model.js';
import { startFakeOpenAI } from './fake-openai.js';

const runToolLoop = async (spec: ModelSpec) => {
  const srv = await startFakeOpenAI((toolResults) =>
    toolResults === 0 ? { tool: 'record', args: { ok: true } } : { text: 'done' });
  try {
    let executions = 0;
    const result = await generateText({
      model: buildChatModel({ ...spec, baseURL: srv.url }),
      prompt: 'please call the tool',
      tools: {
        record: tool({
          description: 'Record a boolean.',
          inputSchema: z.object({ ok: z.boolean() }),
          execute: async ({ ok }) => {
            executions++;
            return { observed: ok };
          },
        }),
      },
      stopWhen: stepCountIs(3),
      maxOutputTokens: 32,
    });
    return { srv, result, executions };
  } catch (err) {
    await srv.close();
    throw err;
  }
};

process.env.BEDROCK_API_KEY = 'bedrock-test-key';
const bearer = await runToolLoop({
  name: 'bedrock-mantle',
  baseURL: 'replaced-by-test',
  model: 'openai.gpt-5.5',
  api: 'responses',
  reasoningEffort: 'xhigh',
  auth: 'auto',
  apiKeyEnv: 'BEDROCK_API_KEY',
  awsRegion: 'us-east-2',
});
assert.equal(bearer.result.text, 'done');
assert.equal(bearer.executions, 1);
assert.equal(bearer.srv.getCalls(), 2, 'tool loop makes one tool call turn and one final text turn');
assert.ok(bearer.srv.getPaths().every((p) => p.endsWith('/responses')), 'bearer auth uses /responses for every turn');
assert.equal((bearer.srv.getHeaders()[0]?.authorization), 'Bearer bedrock-test-key');
const firstBearerBody = bearer.srv.getBodies()[0] as any;
assert.equal(firstBearerBody.model, 'openai.gpt-5.5');
assert.equal(firstBearerBody.store, false);
assert.equal(firstBearerBody.reasoning.effort, 'xhigh');
assert.equal(firstBearerBody.tools[0].type, 'function');
assert.equal(firstBearerBody.tool_choice, 'auto');
await bearer.srv.close();

delete process.env.BEDROCK_API_KEY;
process.env.AWS_ACCESS_KEY_ID = 'AKIATESTKEY';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
process.env.AWS_SESSION_TOKEN = 'test-token';
const signed = await runToolLoop({
  name: 'bedrock-mantle',
  baseURL: 'replaced-by-test',
  model: 'openai.gpt-5.5',
  api: 'responses',
  reasoningEffort: 'xhigh',
  auth: 'aws',
  apiKeyEnv: 'BEDROCK_API_KEY',
  awsRegion: 'us-east-2',
});
assert.equal(signed.result.text, 'done');
assert.equal(signed.executions, 1);
assert.ok(signed.srv.getPaths().every((p) => p.endsWith('/responses')), 'AWS signing uses /responses for every turn');
assert.match(String(signed.srv.getHeaders()[0]?.authorization), /^AWS4-HMAC-SHA256 /);
assert.match(String(signed.srv.getHeaders()[0]?.authorization), /SignedHeaders=[^,]*host/);
assert.equal(signed.srv.getHeaders()[0]?.['x-amz-security-token'], 'test-token');
await signed.srv.close();

console.log('PASS: responses adapter uses /responses, xhigh reasoning, tool loops, bearer auth, and AWS SigV4 auth');
