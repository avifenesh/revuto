/**
 * Tests for FallbackLanguageModel:
 * - Falls back to secondary model when primary fails
 * - Demotes dead primary after consecutive failures so subsequent calls do not pay the failing call
 * - Throws when all fallbacks fail
 * - Re-throws AbortError immediately
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';

import { FallbackLanguageModel } from '../agents/common/src/model.js';

function createMockModel(name: string, handler: (options: LanguageModelV4CallOptions) => Promise<LanguageModelV4GenerateResult>): LanguageModelV4 & { calls: number } {
  let callCount = 0;
  return {
    specificationVersion: 'v4',
    provider: name,
    modelId: `${name}-id`,
    supportedUrls: {},
    get calls() {
      return callCount;
    },
    async doGenerate(options: LanguageModelV4CallOptions) {
      callCount++;
      return handler(options);
    },
    async doStream() {
      callCount++;
      throw new Error('doStream not implemented');
    },
  };
}

const dummyResult: LanguageModelV4GenerateResult = {
  warnings: [],
  content: [{ type: 'text', text: 'ok' }],
  finishReason: { unified: 'stop', raw: 'stop' } as any,
  usage: {
    inputTokens: { total: 10, prompt: 10 },
    outputTokens: { total: 5, completion: 5 },
  } as any,
};

const dummyOptions: LanguageModelV4CallOptions = {
  mode: { type: 'regular' },
  warnings: [],
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
} as any;

test('FallbackLanguageModel tries fallback when primary fails', async () => {
  const primary = createMockModel('primary', async () => {
    throw new Error('primary 401 unauthorized');
  });
  const fallback = createMockModel('fallback', async () => dummyResult);

  const model = new FallbackLanguageModel([primary, fallback]);
  const result = await model.doGenerate(dummyOptions);

  assert.equal((result.content[0] as { text: string }).text, 'ok');
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 1);
});

test('FallbackLanguageModel demotes dead primary after 2 consecutive failures', async () => {
  const primary = createMockModel('primary', async () => {
    throw new Error('quota exhausted');
  });
  const fallback = createMockModel('fallback', async () => dummyResult);

  const model = new FallbackLanguageModel([primary, fallback]);

  // Turn 1: primary fails (1 failure), fallback succeeds
  await model.doGenerate(dummyOptions);
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 1);
  assert.equal(model.getActiveIndex(), 0);

  // Turn 2: primary fails again (2 failures -> threshold reached -> demoted to index 1)
  await model.doGenerate(dummyOptions);
  assert.equal(primary.calls, 2);
  assert.equal(fallback.calls, 2);
  assert.equal(model.getActiveIndex(), 1);

  // Turn 3: primary is skipped completely, goes straight to fallback
  await model.doGenerate(dummyOptions);
  assert.equal(primary.calls, 2, 'primary should not be called on turn 3 after demotion');
  assert.equal(fallback.calls, 3);
});

test('FallbackLanguageModel throws when all models fail', async () => {
  const primary = createMockModel('primary', async () => {
    throw new Error('primary down');
  });
  const fallback = createMockModel('fallback', async () => {
    throw new Error('fallback down');
  });

  const model = new FallbackLanguageModel([primary, fallback]);
  await assert.rejects(
    () => model.doGenerate(dummyOptions),
    /all model fallbacks failed: primary\/primary-id: primary down \| fallback\/fallback-id: fallback down/,
  );
});

test('FallbackLanguageModel immediately re-throws AbortError without trying fallback', async () => {
  const primary = createMockModel('primary', async () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  });
  const fallback = createMockModel('fallback', async () => dummyResult);

  const model = new FallbackLanguageModel([primary, fallback]);
  await assert.rejects(
    () => model.doGenerate(dummyOptions),
    (err: any) => err.name === 'AbortError',
  );
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 0, 'fallback should never be called on abort');
});
