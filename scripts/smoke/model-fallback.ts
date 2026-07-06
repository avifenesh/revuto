/**
 * Smoke for runtime model fallback:
 *  - primary chat endpoint fails;
 *  - fallback chat endpoint completes through the normal AI SDK path.
 *
 *   npx tsx scripts/smoke/model-fallback.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateText } from 'ai';

import { buildChatModel } from '../../agents/common/src/model.js';
import { startFakeOpenAI } from './fake-openai.js';

const failing = await new Promise<{ url: string; calls(): number; close(): Promise<void> }>((resolve) => {
  let calls = 0;
  const server = createServer((_, res) => {
    calls++;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'primary down' } }));
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    resolve({
      url: `http://127.0.0.1:${port}/v1`,
      calls: () => calls,
      close: () => new Promise<void>((done) => server.close(() => done())),
    });
  });
});
const fallback = await startFakeOpenAI(() => ({ text: 'fallback-ok' }));

try {
  const result = await generateText({
    model: buildChatModel({
      baseURL: failing.url,
      model: 'primary',
      fallbacks: [{ baseURL: fallback.url, model: 'fallback' }],
    }),
    prompt: 'ping',
    maxOutputTokens: 16,
  });
  assert.equal(result.text, 'fallback-ok');
  assert.equal(failing.calls(), 1, 'primary called once');
  assert.equal(fallback.getCalls(), 1, 'fallback called once');
} finally {
  await failing.close();
  await fallback.close();
}

console.log('PASS: failed primary chat model falls back to the next configured model');
